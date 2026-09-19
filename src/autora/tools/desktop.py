"""Desktop control tool.

Routes mouse, keyboard, and screenshot commands to a desktop relay — a small
script running on the machine you want to control.  The relay connects OUT to
the Autora server (no inbound port needed), which makes it safe behind a
corporate firewall.  See `src/autora/relay/__main__.py` for the relay script.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult


class DesktopTool:
    name = "desktop"
    description = (
        "Control the desktop of a connected remote machine via the desktop relay. "
        "Use screenshot first to see the screen, then click/type/key to act. "
        "Actions: screenshot, click, double_click, right_click, type, key, scroll, move."
    )
    schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["screenshot", "click", "double_click", "right_click",
                         "type", "key", "scroll", "move"],
            },
            "x": {"type": "number", "description": "Screen X coordinate (pixels)."},
            "y": {"type": "number", "description": "Screen Y coordinate (pixels)."},
            "text": {"type": "string", "description": "Text to type (for 'type' action)."},
            "key": {
                "type": "string",
                "description": "Key or combo for 'key' action, e.g. 'ctrl+c', 'cmd+space', 'enter'.",
            },
            "amount": {
                "type": "integer",
                "description": "Scroll clicks for 'scroll' (positive = down, negative = up).",
            },
            "button": {
                "type": "string",
                "enum": ["left", "right", "middle"],
                "description": "Mouse button for click actions (default: left).",
            },
        },
        "required": ["action"],
    }

    def __init__(self, relay: "RelayBridge | None" = None):
        # relay may be None when build_registry is called without one;
        # the tool still registers and just returns "not connected" each time.
        self.relay = relay if relay is not None else RelayBridge()

    async def run(
        self, session, args: dict[str, Any], span: str
    ) -> AsyncIterator[ToolResult]:
        if not self.relay.connected:
            yield ToolResult(
                "Desktop relay not connected.\n\n"
                "On the machine to control, run:\n"
                "  pip install websockets mss pyautogui pillow\n"
                "  python -m autora.relay ws://THIS_SERVER:PORT\n\n"
                "macOS: also grant Accessibility permission to your Terminal in\n"
                "  System Settings → Privacy & Security → Accessibility.",
                ok=False,
            )
            return

        action = args["action"]
        try:
            if action == "screenshot":
                resp = await self.relay.request({"type": "screenshot"}, timeout=15.0)
                if resp.get("type") == "error":
                    yield ToolResult(f"Screenshot failed: {resp.get('error')}", ok=False)
                    return
                data = base64.b64decode(resp["data"])
                session.emit_frame(
                    Kind.DESKTOP_FRAME, data, stream="desktop",
                    w=resp.get("w"), h=resp.get("h"),
                )
                session.emit(Kind.DESKTOP_ACTION, {
                    "action": "screenshot",
                    "w": resp.get("w"), "h": resp.get("h"),
                }, actor="tool:desktop", span=span)
                yield ToolResult(
                    f"Screenshot captured ({resp.get('w')}×{resp.get('h')}). "
                    "Visible in the Desktop tab of the UI.",
                    display={"type": "desktop"},
                )

            elif action in ("click", "double_click", "right_click"):
                x, y = float(args.get("x", 0)), float(args.get("y", 0))
                payload: dict[str, Any] = {"type": action, "x": x, "y": y}
                if action == "click":
                    payload["button"] = args.get("button", "left")
                resp = await self.relay.request(payload)
                if resp.get("type") == "error":
                    yield ToolResult(f"{action} failed: {resp.get('error')}", ok=False)
                    return
                session.emit(Kind.DESKTOP_ACTION, {
                    "action": action, "x": x, "y": y,
                }, actor="tool:desktop", span=span)
                yield ToolResult(f"{action.replace('_', ' ').title()} at ({x:.0f}, {y:.0f}).")

            elif action == "move":
                x, y = float(args.get("x", 0)), float(args.get("y", 0))
                await self.relay.request({"type": "move", "x": x, "y": y})
                yield ToolResult(f"Mouse moved to ({x:.0f}, {y:.0f}).")

            elif action == "type":
                text = args.get("text", "")
                timeout = max(15.0, len(text) * 0.08)
                resp = await self.relay.request(
                    {"type": "type", "text": text, "interval": 0.04},
                    timeout=timeout,
                )
                if resp.get("type") == "error":
                    yield ToolResult(f"Type failed: {resp.get('error')}", ok=False)
                    return
                session.emit(Kind.DESKTOP_ACTION, {
                    "action": "type", "length": len(text),
                }, actor="tool:desktop", span=span)
                yield ToolResult(f"Typed {len(text)} characters.")

            elif action == "key":
                key = args.get("key", "")
                resp = await self.relay.request({"type": "key", "key": key})
                if resp.get("type") == "error":
                    yield ToolResult(f"Key {key!r} failed: {resp.get('error')}", ok=False)
                    return
                session.emit(Kind.DESKTOP_ACTION, {
                    "action": "key", "key": key,
                }, actor="tool:desktop", span=span)
                yield ToolResult(f"Pressed {key!r}.")

            elif action == "scroll":
                x = float(args.get("x") or 0)
                y = float(args.get("y") or 0)
                amount = int(args.get("amount", 3))
                await self.relay.request({"type": "scroll", "x": x, "y": y, "amount": amount})
                direction = "down" if amount > 0 else "up"
                yield ToolResult(f"Scrolled {direction} {abs(amount)} clicks.")

            else:
                yield ToolResult(f"Unknown desktop action {action!r}.", ok=False)

        except RuntimeError as exc:
            yield ToolResult(f"Desktop {action}: {exc}", ok=False)
        except Exception as exc:
            session.emit(Kind.TOOL_ERROR, {
                "error": f"{type(exc).__name__}: {exc}", "action": action,
            }, actor="tool:desktop", span=span)
            yield ToolResult(
                f"Desktop {action} failed: {type(exc).__name__}: {str(exc)[:300]}",
                ok=False,
            )

    async def cleanup(self) -> None:
        pass


# ── relay bridge ──────────────────────────────────────────────────────────

class RelayBridge:
    """Bridges the /ws/desktop-relay WebSocket to DesktopTool calls.

    The relay (on the controlled machine) connects here.  DesktopTool sends
    typed commands and awaits their responses.  Continuous frame messages from
    the relay are dispatched via `on_frame`.
    """

    def __init__(self) -> None:
        self._ws = None          # FastAPI WebSocket
        self._pending: dict[str, asyncio.Future] = {}
        self._msg_counter = 0

    @property
    def connected(self) -> bool:
        return self._ws is not None

    def attach(self, ws) -> None:
        self._ws = ws

    def detach(self) -> None:
        self._ws = None
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.cancel()
        self._pending.clear()

    async def request(self, msg: dict, timeout: float = 30.0) -> dict:
        if not self._ws:
            raise RuntimeError(
                "no desktop relay connected — run: python -m autora.relay ws://SERVER:PORT"
            )
        import uuid
        msg_id = uuid.uuid4().hex[:10]
        msg = {**msg, "id": msg_id}
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[msg_id] = fut
        try:
            import json
            await self._ws.send_text(json.dumps(msg))
            return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"relay timed out on {msg.get('type')!r} after {timeout:.0f}s"
            )
        finally:
            self._pending.pop(msg_id, None)

    def resolve(self, msg: dict) -> None:
        """Called by the WebSocket endpoint when the relay sends a response."""
        msg_id = msg.get("id")
        if msg_id:
            fut = self._pending.get(msg_id)
            if fut and not fut.done():
                fut.set_result(msg)
