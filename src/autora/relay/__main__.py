"""Desktop relay — run this on the machine you want the agent to control.

Usage
-----
    # If Autora is installed on this machine:
    python -m autora.relay ws://192.168.1.100:8817

    # Standalone (just copy this file):
    pip install websockets mss pyautogui pillow
    python relay.py ws://192.168.1.100:8817

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
import sys
import time
from typing import Any

# ── optional dependency check ─────────────────────────────────────────────

def _need(pkg: str, install: str) -> Any:
    try:
        return __import__(pkg)
    except ImportError:
        print(f"Missing: {pkg}.  Install with:  pip install {install}", file=sys.stderr)
        sys.exit(1)

_need("websockets", "websockets>=10")
_need("mss",        "mss")
_need("pyautogui",  "pyautogui pillow")
_need("PIL",        "pillow")

import mss as _mss                     # type: ignore
import pyautogui as _pag               # type: ignore
from PIL import Image                  # type: ignore

# Disable pyautogui's corner-of-screen abort.  In a relay context the agent
# may legitimately move to any screen position; the failsafe causes spurious
# crashes rather than protecting anything.
_pag.FAILSAFE = False
_pag.PAUSE    = 0.0   # no inter-call sleep — the relay manages its own pacing


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

async def run(server_url: str, fps: int = 3) -> None:
    url = server_url.rstrip("/") + "/ws/desktop-relay"
    interval = 1.0 / fps
    backoff  = 2.0
    plat     = platform.system().lower()

    while True:
        print(f"Connecting to {url} …", flush=True)
        try:
            async with _ws_connect(url, max_size=16 * 1024 * 1024,
                                   ping_interval=20, ping_timeout=30) as ws:
                backoff = 2.0
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
            print(f"  Disconnected: {exc}")
            print(f"  Retrying in {backoff:.0f}s …", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)


def main() -> None:
    import argparse
    p = argparse.ArgumentParser(
        description="Desktop relay for Autora — run on the machine to control.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("server", metavar="ws://HOST:PORT",
                   help="Autora server URL (e.g. ws://192.168.1.100:8817)")
    p.add_argument("--fps", type=int, default=3,
                   help="Screen capture rate in frames/s (default: 3)")
    args = p.parse_args()
    try:
        asyncio.run(run(args.server, fps=args.fps))
    except KeyboardInterrupt:
        print("\nRelay stopped.")


if __name__ == "__main__":
    main()
