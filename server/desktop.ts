/**
 * The desktop relay: a machine somewhere, controllable from here.
 *
 * This is the one capability that cannot live in the server process. Autora
 * usually runs in a container on a box in a cupboard; the screen worth
 * controlling is the one in front of the person. So the relay runs *there* and
 * dials *in* -- a websocket out to `/ws/desktop-relay`, which means nothing has
 * to be opened up on the desktop's side and no address has to be guessed from
 * this end.
 *
 * One relay at a time, deliberately. Two machines answering "click at 400,300"
 * is not a feature, and picking between them would be a whole UI. A second
 * connection displaces the first and the first is told why.
 *
 * The protocol is small enough to read in one sitting. Relay to server:
 *
 *   {"type":"hello","platform":"Darwin-14.2","screen":{"w":2560,"h":1440},
 *    "can_control":true}
 *   {"type":"frame","mime":"image/jpeg","data":"<base64>"}
 *   {"type":"result","id":"a7","ok":true,"data":{...}}
 *
 * Server to relay:
 *
 *   {"type":"stream","on":true,"fps":2}
 *   {"type":"action","id":"a7","action":"click","x":400,"y":300,"button":"left"}
 *
 * Every action carries an id and is answered by exactly one result with that
 * id, so a slow screenshot cannot be mistaken for the answer to the click that
 * came after it.
 */

import type { WebSocket } from "ws";

/** How long to wait for a relay to answer one action before giving up. A
    screenshot on a busy machine can take a second or two; beyond ten the relay
    is wedged and saying so beats hanging the turn. */
const ACTION_TIMEOUT_MS = 10_000;

/** Frames per second asked of the relay while somebody is watching. Screen
    capture over a home connection is the constraint, not the agent. */
const RELAY_FPS = 2;

export interface RelayStatus {
  connected: boolean;
  platform: string | null;
  screen: { w: number | null; h: number | null };
  since: number | null;
  /** False when the relay can capture the screen but not drive it -- macOS
      without Accessibility permission, which is common enough to name. */
  canControl: boolean;
  /** Why there is no relay, when the reason is known. */
  detail: string | null;
}

export interface RelayResult {
  ok: boolean;
  data?: Record<string, any>;
  error?: string;
}

type Pending = {
  resolve: (value: RelayResult) => void;
  timer: NodeJS.Timeout;
};

/** Where desktop frames go. Set by the server; there is one subscriber, the
    session currently using the desktop. */
type FrameSink = ((base64: string, mime: string) => void) | null;

let socket: WebSocket | null = null;
let info: RelayStatus = {
  connected: false,
  platform: null,
  screen: { w: null, h: null },
  since: null,
  canControl: false,
  detail: null,
};

const pending = new Map<string, Pending>();
let sink: FrameSink = null;
let nextId = 1;

/** The relay's own view of itself, for `/api/relay` and the settings card. */
export function relayStatus(): RelayStatus {
  return { ...info, screen: { ...info.screen } };
}

export function relayConnected(): boolean {
  return Boolean(socket) && info.connected;
}

/**
 * Point the frame feed somewhere, or nowhere.
 *
 * Capture is only asked for while there is somewhere to put it: a relay left
 * running on a laptop should not be shipping JPEGs across the internet because
 * a browser tab was open three hours ago.
 */
export function watchDesktop(next: FrameSink) {
  sink = next;
  stream(Boolean(next));
}

function stream(on: boolean) {
  if (!socket) return;
  send({ type: "stream", on, fps: RELAY_FPS });
}

function send(message: Record<string, unknown>) {
  if (!socket) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The close handler will clean up; nothing useful to do here.
  }
}

/**
 * Ask the relay to do one thing, and wait for its answer.
 *
 * Rejects rather than throwing a bare string so the tool layer can put a
 * readable sentence in the thread: "no desktop is connected" is a setup
 * problem with a fix, and is worth distinguishing from a click that was
 * attempted and failed.
 */
export function relayAction(
  action: string,
  args: Record<string, unknown> = {},
): Promise<RelayResult> {
  if (!socket || !info.connected) {
    return Promise.resolve({
      ok: false,
      error:
        "No desktop relay is connected. Run the relay on the machine you want " +
        "to control -- Settings has the three commands.",
    });
  }
  if (!info.canControl && action !== "screenshot") {
    return Promise.resolve({
      ok: false,
      error:
        `The relay on ${info.platform ?? "that machine"} can capture the ` +
        "screen but is not permitted to control it. On macOS: System Settings " +
        "> Privacy & Security > Accessibility, and tick the terminal it was " +
        "started from.",
    });
  }

  const id = `a${nextId++}`;
  return new Promise<RelayResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({
        ok: false,
        error: `The desktop relay did not answer within ${
          ACTION_TIMEOUT_MS / 1000}s.`,
      });
    }, ACTION_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, timer });
    send({ type: "action", id, action, ...args });
  });
}

/**
 * Take over a newly connected relay.
 *
 * Called from the websocket upgrade path. Everything about the relay -- what
 * machine it is, how big its screen is, whether it may click -- arrives in its
 * `hello`, so until that lands the connection is open but not yet usable.
 */
export function attachRelay(ws: WebSocket, onChange: () => void) {
  if (socket && socket !== ws) {
    // Displace the old one, and say so on the way out rather than dropping it
    // silently -- a relay that stops working for no visible reason is a
    // half-hour of confusion.
    try {
      socket.send(JSON.stringify({
        type: "bye",
        reason: "Another relay connected to this Autora.",
      }));
      socket.close();
    } catch {
      // Already gone.
    }
  }

  socket = ws;
  info = {
    connected: false,
    platform: null,
    screen: { w: null, h: null },
    since: null,
    canControl: false,
    detail: "A relay is connecting…",
  };

  ws.on("message", (raw: any) => {
    let message: any;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === "hello") {
      info = {
        connected: true,
        platform: typeof message.platform === "string" ? message.platform : null,
        screen: {
          w: Number(message.screen?.w) || null,
          h: Number(message.screen?.h) || null,
        },
        since: Math.floor(Date.now() / 1000),
        // Absent means yes: an older relay that does not report the field can
        // still click, and assuming otherwise would disable a working setup.
        canControl: message.can_control !== false,
        detail: null,
      };
      // A watcher may have been waiting since before this relay existed.
      stream(Boolean(sink));
      onChange();
      return;
    }

    if (message.type === "frame") {
      if (typeof message.data !== "string") return;
      sink?.(message.data, typeof message.mime === "string" ? message.mime : "image/jpeg");
      return;
    }

    if (message.type === "result") {
      const waiting = pending.get(String(message.id));
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(String(message.id));
      waiting.resolve({
        ok: message.ok !== false,
        data: message.data && typeof message.data === "object" ? message.data : undefined,
        error: typeof message.error === "string" ? message.error : undefined,
      });
      return;
    }

    if (message.type === "screen") {
      // The screen can change under a running relay -- a monitor unplugged, a
      // resolution changed. Coordinates the agent read a moment ago would
      // otherwise silently refer to a screen that no longer exists.
      info.screen = {
        w: Number(message.w) || info.screen.w,
        h: Number(message.h) || info.screen.h,
      };
      onChange();
    }
  });

  const gone = (detail: string) => {
    if (socket !== ws) return;
    socket = null;
    info = {
      connected: false,
      platform: null,
      screen: { w: null, h: null },
      since: null,
      canControl: false,
      detail,
    };
    // Anything still waiting will never be answered now.
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, error: "The desktop relay disconnected." });
      pending.delete(id);
    }
    onChange();
  };

  ws.on("close", () => gone("The relay disconnected."));
  ws.on("error", (err: any) => gone(`The relay connection failed: ${err?.message ?? err}`));
}

/**
 * The relay client, served from the app it connects back to.
 *
 * Handed out by `GET /relay.py` with this server's own websocket address
 * already baked in, because the alternative is a placeholder somebody has to
 * find and replace, and getting that wrong looks exactly like the feature
 * being broken.
 *
 * Kept deliberately plain: three pip packages that exist on every platform, no
 * Autora imports, and readable start to finish by whoever is being asked to
 * run it on their own machine. Nobody should have to take a remote-control
 * agent on faith.
 */
export function relayClientSource(wsUrl: string): string {
  return `#!/usr/bin/env python3
"""
Autora desktop relay.

Runs on the machine you want the agent to control and connects out to Autora
at:

    ${wsUrl}

It does three things and nothing else: it sends pictures of your screen while
somebody is watching, it performs clicks and keystrokes Autora asks for, and it
stops when you close it (Ctrl-C). It has no Autora imports and opens no ports.

    pip install websockets mss pyautogui pillow
    python relay.py

To reach a different address, give it: \`python relay.py 192.168.1.5:8817\`
(host:port, http://..., https://... and ws://... all work). Over https with
Autora's own certificate, either install the certificate from /autora-ca.crt
on this machine or add --insecure.

Nothing is sent until Autora asks for it, and it only asks while a session is
actually looking at the desktop.
"""

import asyncio
import base64
import io
import json
import platform
import ssl
import sys


def relay_url(address):
    """Any form of the server's address, as the relay's websocket URL."""
    text = address.strip().rstrip("/")
    if text.startswith("https://"):
        text = "wss://" + text[len("https://"):]
    elif text.startswith("http://"):
        text = "ws://" + text[len("http://"):]
    elif "://" not in text:
        text = "ws://" + text
    if "/ws/" not in text:
        text += "/ws/desktop-relay"
    return text


WS_URL = "${wsUrl}"
INSECURE = "--insecure" in sys.argv[1:]
for arg in sys.argv[1:]:
    if not arg.startswith("-"):
        WS_URL = relay_url(arg)


def connect_options():
    """Certificate checking stays on unless --insecure asked otherwise."""
    if INSECURE and WS_URL.startswith("wss://"):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return {"ssl": context}
    return {}

try:
    import websockets
except ImportError:
    sys.exit("Missing websockets. Run: pip install websockets mss pyautogui pillow")

try:
    import mss
    from PIL import Image
except ImportError:
    sys.exit("Missing mss/pillow. Run: pip install websockets mss pyautogui pillow")

# Control is optional: screen capture alone is useful, and on a locked-down
# macOS it is all you get until Accessibility is granted. Better to connect and
# say so than to refuse to start.
try:
    import pyautogui

    pyautogui.FAILSAFE = False
    CAN_CONTROL = True
except Exception as err:  # noqa: BLE001 -- any import problem means no control
    print(f"[relay] input control unavailable: {err}")
    CAN_CONTROL = False

JPEG_QUALITY = 55
MAX_WIDTH = 1280

streaming = False
stream_fps = 2


def grab():
    """One JPEG of the primary screen, and the screen's real size."""
    with mss.mss() as sct:
        # Monitor 0 is the union of all screens; 1 is the primary one, which is
        # what a single coordinate space should mean.
        monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
        shot = sct.grab(monitor)
        image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    width, height = image.size
    if width > MAX_WIDTH:
        image = image.resize(
            (MAX_WIDTH, round(height * MAX_WIDTH / width)), Image.LANCZOS
        )
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return base64.b64encode(buffer.getvalue()).decode("ascii"), width, height


def screen_size():
    with mss.mss() as sct:
        monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
        return monitor["width"], monitor["height"]


def perform(action, message):
    """Do one thing Autora asked for. Returns a dict, or raises."""
    if action == "screenshot":
        data, width, height = grab()
        return {"image": data, "mime": "image/jpeg", "w": width, "h": height}

    if not CAN_CONTROL:
        raise RuntimeError(
            "This relay can see the screen but not control it. On macOS grant "
            "Accessibility to the terminal you started it from."
        )

    if action == "move":
        pyautogui.moveTo(int(message["x"]), int(message["y"]), duration=0.15)
        return {"x": int(message["x"]), "y": int(message["y"])}

    if action in ("click", "double_click", "right_click"):
        x, y = message.get("x"), message.get("y")
        if x is not None and y is not None:
            pyautogui.moveTo(int(x), int(y), duration=0.15)
        button = "right" if action == "right_click" else message.get("button", "left")
        clicks = 2 if action == "double_click" else 1
        pyautogui.click(button=button, clicks=clicks, interval=0.08)
        return {"clicked": action, "x": x, "y": y}

    if action == "type":
        # A per-character interval, because a great many native text fields
        # drop input pasted faster than a person could plausibly type.
        pyautogui.write(str(message.get("text", "")), interval=0.012)
        return {"typed": len(str(message.get("text", "")))}

    if action == "key":
        keys = message.get("keys") or []
        if isinstance(keys, str):
            keys = [keys]
        for combo in keys:
            parts = [p.strip() for p in str(combo).split("+") if p.strip()]
            if len(parts) > 1:
                pyautogui.hotkey(*parts)
            elif parts:
                pyautogui.press(parts[0])
        return {"keys": keys}

    if action == "scroll":
        pyautogui.scroll(int(message.get("dy", -400)))
        return {"dy": int(message.get("dy", -400))}

    if action == "drag":
        pyautogui.moveTo(int(message["x"]), int(message["y"]), duration=0.15)
        pyautogui.dragTo(
            int(message["to_x"]), int(message["to_y"]), duration=0.35, button="left"
        )
        return {"dragged": True}

    raise RuntimeError(f"Unknown action: {action}")


async def pump(ws):
    """Send frames while Autora is watching, and nothing while it is not."""
    while True:
        if streaming:
            try:
                data, _, _ = grab()
                await ws.send(json.dumps({
                    "type": "frame", "mime": "image/jpeg", "data": data,
                }))
            except Exception as err:  # noqa: BLE001 -- a bad frame is not fatal
                print(f"[relay] capture failed: {err}")
            await asyncio.sleep(1 / max(1, stream_fps))
        else:
            await asyncio.sleep(0.25)


async def serve(ws):
    global streaming, stream_fps

    width, height = screen_size()
    await ws.send(json.dumps({
        "type": "hello",
        "platform": f"{platform.system()}-{platform.release()}",
        "screen": {"w": width, "h": height},
        "can_control": CAN_CONTROL,
    }))
    print(f"[relay] connected -- {width}x{height}, control={CAN_CONTROL}")

    feeder = asyncio.create_task(pump(ws))
    try:
        async for raw in ws:
            try:
                message = json.loads(raw)
            except ValueError:
                continue

            kind = message.get("type")
            if kind == "stream":
                streaming = bool(message.get("on"))
                stream_fps = int(message.get("fps") or 2)
                continue
            if kind == "bye":
                print(f"[relay] {message.get('reason', 'closed by Autora')}")
                return
            if kind != "action":
                continue

            # Blocking input calls would stall the frame feed and the socket's
            # own keepalives, so they run off the event loop.
            try:
                data = await asyncio.get_running_loop().run_in_executor(
                    None, perform, message.get("action"), message
                )
                reply = {"type": "result", "id": message.get("id"), "ok": True,
                         "data": data}
            except Exception as err:  # noqa: BLE001 -- report, never die
                reply = {"type": "result", "id": message.get("id"), "ok": False,
                         "error": str(err)}
            await ws.send(json.dumps(reply))
    finally:
        feeder.cancel()


async def main():
    delay = 1
    while True:
        try:
            # max_size lifted for inbound control messages; frames go the other
            # way. ping_keepalive lets a NAT-ed home connection stay up.
            async with websockets.connect(
                WS_URL, max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20,
                **connect_options()
            ) as ws:
                delay = 1
                await serve(ws)
        except KeyboardInterrupt:
            return
        except Exception as err:  # noqa: BLE001 -- reconnect, don't exit
            print(f"[relay] {err}; retrying in {delay}s")
        await asyncio.sleep(delay)
        delay = min(delay * 2, 30)


if __name__ == "__main__":
    print(f"[relay] Autora desktop relay -> {WS_URL}")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\\n[relay] stopped")
`;
}
