"""Desktop relay — run this on the machine you want the agent to control.

The quickest way to get this file
---------------------------------
It is served by the Autora server you want to connect to, with the address
already filled in, so there is nothing to type and nothing to install first:

    # Windows (PowerShell)
    curl.exe -O http://YOUR-SERVER:8817/relay.py
    py -m pip install websockets mss pyautogui pillow
    py relay.py

    # macOS / Linux
    curl -O http://YOUR-SERVER:8817/relay.py
    python3 -m pip install websockets mss pyautogui pillow
    python3 relay.py

`python -m autora.relay` works too, but only where Autora itself is installed.
If that is your server and not the machine with the screen, download the file
above instead -- the relay is a single file and deliberately has no Autora
imports, so it runs anywhere Python does.

Usage
-----
    python relay.py                        # server baked in by the download
    python relay.py 192.168.1.100:8817     # or say where it is
    python relay.py http://box.local:8817  # http/https are accepted too
    python relay.py wss://box.ts.net --insecure   # self-signed https

The relay connects OUT to the Autora server — no inbound port is opened on
this machine, so corporate firewalls that block inbound connections are not
a problem.  All traffic stays on your local network.

Platform notes
--------------
macOS   — screen capture works automatically.  For mouse/keyboard control,
          open System Settings → Privacy & Security → Accessibility and tick
          your Terminal app.  This is a standard macOS user-level permission
          (the same thing screen readers require) and is fully reversible.

Windows — no special permissions needed; your normal user account is enough.
          If a UAC prompt appears, choose "No" — the relay does not need it.

Linux   — requires an X display.  On Wayland, install the XWayland package
          so pyautogui can reach the X server (most distros include it).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import platform
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Any

#: Where to connect when no server is given on the command line.
#:
#: A copy downloaded from a running server has this filled in with that
#: server's address (see `GET /relay.py`), which is the whole point: the person
#: running the relay is usually on a different machine from the one they are
#: reading the docs on, and retyping an address is where this goes wrong.
DEFAULT_SERVER = ""

#: The port `autora up` listens on unless told otherwise.
DEFAULT_PORT = 8817

#: The path on the server that accepts relay connections.
RELAY_PATH = "/ws/desktop-relay"


# ── optional dependency check ─────────────────────────────────────────────

def _check_dependencies() -> None:
    """Name every missing package at once, with a command that works here.

    One at a time meant four rounds of "install this, now install this", and
    `pip` is not on PATH on a default Windows install -- which reads as the
    relay being broken rather than as one word being wrong.
    """
    wanted = [("websockets", "websockets"), ("mss", "mss"),
              ("pyautogui", "pyautogui"), ("PIL", "pillow")]
    missing = []
    for module, package in wanted:
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    if not missing:
        return
    runner = "py" if sys.platform == "win32" else sys.executable
    print("The relay needs a few packages that are not installed here:",
          file=sys.stderr)
    for package in missing:
        print(f"  · {package}", file=sys.stderr)
    print(f"\nInstall them with:\n\n  {runner} -m pip install {' '.join(missing)}\n",
          file=sys.stderr)
    sys.exit(1)


_check_dependencies()

import mss as _mss                     # noqa: E402  type: ignore
import pyautogui as _pag               # noqa: E402  type: ignore
from PIL import Image                  # noqa: E402  type: ignore

# Disable pyautogui's corner-of-screen abort.  In a relay context the agent
# may legitimately move to any screen position; the failsafe causes spurious
# crashes rather than protecting anything.
_pag.FAILSAFE = False
_pag.PAUSE    = 0.0   # no inter-call sleep — the relay manages its own pacing


# ── where the server is ───────────────────────────────────────────────────

def relay_url(server: str) -> str:
    """Turn whatever the person typed into the websocket URL to connect to.

    Everything that identifies the server is accepted, because every one of
    them is something a reasonable person types: the address bar's
    `http://box:8817`, the bare `box:8817` from the terminal that started it,
    `ws://box` with the default port left off, and the full websocket path
    copied out of the docs.  Rejecting four of those five and saying only
    "connection failed" is most of why this step goes wrong.
    """
    text = server.strip().strip('"').strip("'")
    if not text:
        raise ValueError("no server address")
    if "://" not in text:
        text = "ws://" + text
    scheme, _, rest = text.partition("://")
    scheme = {"http": "ws", "https": "wss"}.get(scheme.lower(), scheme.lower())
    if scheme not in ("ws", "wss"):
        raise ValueError(f"cannot connect to a {scheme!r} address")

    authority, slash, path = rest.partition("/")
    path = (slash + path).rstrip("/")
    if not authority:
        raise ValueError("no host in the address")
    # A host with no port is the common case, and the default is not 80.
    host_has_port = authority.rpartition(":")[2].isdigit() and ":" in authority
    if not host_has_port and scheme == "ws":
        authority = f"{authority}:{DEFAULT_PORT}"
    if not path.endswith(RELAY_PATH):
        path = path + RELAY_PATH
    return f"{scheme}://{authority}{path}"


def _probe(url: str, insecure: bool) -> str | None:
    """Ask the server whether it is there and whether it is Autora.

    A websocket failure says almost nothing on its own: refused, 404 and a
    certificate the machine does not trust all arrive as "could not connect".
    One plain HTTP request to a known endpoint separates them, and the answer
    is the difference between "the address is wrong" and "the address is right
    and something else is".
    """
    http = url.replace("ws://", "http://", 1).replace("wss://", "https://", 1)
    origin = http[: -len(RELAY_PATH)] + "/api/origin"
    context = None
    if insecure:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(origin, timeout=6, context=context) as response:
            body = json.loads(response.read().decode("utf-8", "replace"))
        version = body.get("version")
        return f"Autora {version}" if version else "Autora"
    except urllib.error.HTTPError as exc:
        return f"reachable, but answered {exc.code} — is that really Autora?"
    except ssl.SSLCertVerificationError:
        return ("reachable over https, but this machine does not trust its "
                "certificate — add --insecure, or install the server's "
                "certificate from /autora-ca.crt")
    except Exception as exc:               # noqa: BLE001 — diagnosis, not control flow
        reason = getattr(exc, "reason", exc)
        return f"not reachable: {reason}"


# ── screen capture ────────────────────────────────────────────────────────

def _capture(quality: int = 55) -> tuple[bytes, int, int]:
    """Grab the primary monitor → (jpeg_bytes, width, height)."""
    with _mss.mss() as sct:
        mon = sct.monitors[1]          # index 0 is the "all monitors" virtual
        raw = sct.grab(mon)
        img = Image.frombytes("RGB", (raw.width, raw.height), raw.bgra, "raw", "BGRX")
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, optimize=False)
        return buf.getvalue(), raw.width, raw.height


# ── keyboard helper ───────────────────────────────────────────────────────

def _press(combo: str) -> None:
    """Accept combos like 'ctrl+c', 'cmd+shift+4', 'enter', 'escape'."""
    parts = (
        combo.lower()
        .replace("command", "cmd")
        .replace("windows", "winleft")
        .replace("option", "alt")
        .split("+")
    )
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) == 1:
        _pag.press(parts[0])
    else:
        _pag.hotkey(*parts)


# ── websocket connect helper (supports websockets ≥10 and ≥12) ───────────

def _make_connect():
    try:
        from websockets.asyncio.client import connect   # type: ignore  # v12+
        return connect
    except ImportError:
        import websockets                               # type: ignore  # v10/v11
        return websockets.connect                       # type: ignore


_ws_connect = _make_connect()


# ── command dispatch ──────────────────────────────────────────────────────

async def _handle(ws, msg: dict) -> None:
    typ    = msg.get("type")
    msg_id = msg.get("id")

    async def _ok(extra: dict | None = None) -> None:
        await ws.send(json.dumps({"type": "ok", "id": msg_id, **(extra or {})}))

    async def _err(text: str) -> None:
        await ws.send(json.dumps({"type": "error", "id": msg_id, "error": text}))

    try:
        if typ == "ping":
            await ws.send(json.dumps({"type": "pong", "id": msg_id}))

        elif typ == "screenshot":
            data, w, h = _capture(quality=70)
            await ws.send(json.dumps({
                "type": "screenshot", "id": msg_id,
                "data": base64.b64encode(data).decode(),
                "w": w, "h": h,
            }))

        elif typ == "click":
            x, y = int(msg["x"]), int(msg["y"])
            _pag.moveTo(x, y, duration=0.08)
            _pag.click(x, y, button=msg.get("button", "left"))
            await _ok()

        elif typ == "double_click":
            x, y = int(msg["x"]), int(msg["y"])
            _pag.moveTo(x, y, duration=0.08)
            _pag.doubleClick(x, y)
            await _ok()

        elif typ == "right_click":
            x, y = int(msg["x"]), int(msg["y"])
            _pag.moveTo(x, y, duration=0.08)
            _pag.rightClick(x, y)
            await _ok()

        elif typ == "move":
            _pag.moveTo(int(msg["x"]), int(msg["y"]), duration=0.12)
            await _ok()

        elif typ == "type":
            text     = msg.get("text", "")
            interval = float(msg.get("interval", 0.04))
            # typewrite() doesn't handle unicode; use pyperclip paste for
            # non-ASCII text if available, otherwise fall back.
            try:
                import pyperclip  # type: ignore
                pyperclip.copy(text)
                _pag.hotkey("ctrl", "v")
            except ImportError:
                _pag.typewrite(text, interval=interval)
            await _ok()

        elif typ == "key":
            _press(msg.get("key", ""))
            await _ok()

        elif typ == "scroll":
            x, y = int(msg.get("x") or 0), int(msg.get("y") or 0)
            clicks = int(msg.get("amount", 3))
            if x or y:
                _pag.moveTo(x, y, duration=0.08)
            _pag.scroll(clicks)
            await _ok()

        elif typ == "drag":
            _pag.moveTo(int(msg["x1"]), int(msg["y1"]), duration=0.1)
            _pag.dragTo(int(msg["x2"]), int(msg["y2"]), duration=0.25, button="left")
            await _ok()

        else:
            await _err(f"unknown command: {typ!r}")

    except Exception as exc:
        try:
            await _err(f"{type(exc).__name__}: {exc}")
        except Exception:
            pass


# ── main loop ─────────────────────────────────────────────────────────────

async def run(server_url: str, fps: int = 3, insecure: bool = False) -> None:
    url = relay_url(server_url)
    interval = 1.0 / fps
    backoff  = 2.0
    plat     = platform.system().lower()
    kwargs: dict[str, Any] = {"max_size": 16 * 1024 * 1024,
                              "ping_interval": 20, "ping_timeout": 30}
    if url.startswith("wss://") and insecure:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        kwargs["ssl"] = context

    first = True
    while True:
        print(f"Connecting to {url} …", flush=True)
        try:
            async with _ws_connect(url, **kwargs) as ws:
                backoff = 2.0
                first = False
                jpeg, w, h = _capture()
                await ws.send(json.dumps({"type": "hello", "platform": plat, "w": w, "h": h}))
                print(f"  Connected.  Screen: {w}×{h}  Stream: {fps}fps  Ctrl+C to stop.")

                async def _stream() -> None:
                    prev_hash = b""
                    while True:
                        t0 = time.monotonic()
                        try:
                            data, fw, fh = _capture()
                        except Exception:
                            await asyncio.sleep(interval)
                            continue
                        cur_hash = hashlib.md5(data).digest()
                        if cur_hash != prev_hash:
                            prev_hash = cur_hash
                            await ws.send(json.dumps({
                                "type": "frame",
                                "data": base64.b64encode(data).decode(),
                                "w": fw, "h": fh,
                            }))
                        # Sleep for the remainder of the interval so we hit ~fps.
                        elapsed = time.monotonic() - t0
                        await asyncio.sleep(max(0.0, interval - elapsed))

                stream_task = asyncio.create_task(_stream())
                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        await _handle(ws, msg)
                finally:
                    stream_task.cancel()

        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"  Disconnected: {type(exc).__name__}: {exc}")
            # Only on the first failure: once it has connected, the address is
            # known to be right and a reconnect loop should not lecture about it.
            if first:
                verdict = await asyncio.to_thread(_probe, url, insecure)
                print(f"  The server at that address is {verdict}")
                _advise(url, insecure)
                first = False
            print(f"  Retrying in {backoff:.0f}s …", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def _advise(url: str, insecure: bool) -> None:
    """What to check, in the order it is usually wrong."""
    print("\n  Things worth checking:")
    print("   · Is Autora running, and is this the address you open its page at?")
    print("   · `autora up` listens on 127.0.0.1 by default, which no other")
    print("     machine can reach. Start it with --host 0.0.0.0.")
    print("   · A firewall on the server may be blocking the port.")
    if url.startswith("wss://") and not insecure:
        print("   · Self-signed https: add --insecure, or install the server's")
        print("     certificate (downloadable at /autora-ca.crt).")
    print()


def main() -> None:
    import argparse
    p = argparse.ArgumentParser(
        prog="autora relay",
        description="Desktop relay for Autora — run on the machine to control.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("server", metavar="SERVER", nargs="?", default=DEFAULT_SERVER or None,
                   help="Where Autora is, e.g. 192.168.1.100:8817 or "
                        "http://box.local:8817. Optional in a copy downloaded "
                        "from the server itself.")
    p.add_argument("--fps", type=int, default=3,
                   help="Screen capture rate in frames/s (default: 3)")
    p.add_argument("--insecure", action="store_true",
                   help="Accept an https server whose certificate this machine "
                        "does not trust (Autora's own self-signed one)")
    args = p.parse_args()
    if not args.server:
        p.error(
            "no server address.\n\n"
            "Either pass one:\n"
            "    python relay.py 192.168.1.100:8817\n\n"
            "or download this file from the Autora server you want to reach, "
            "which fills the address in:\n"
            "    curl -O http://192.168.1.100:8817/relay.py"
        )
    try:
        url = relay_url(args.server)
    except ValueError as exc:
        p.error(f"{exc}: {args.server!r}")
    print(f"Autora desktop relay → {url}")
    try:
        asyncio.run(run(args.server, fps=args.fps, insecure=args.insecure))
    except KeyboardInterrupt:
        print("\nRelay stopped.")


if __name__ == "__main__":
    main()
