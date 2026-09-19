"""Browser control with a live video feed.

The naive way to show a browser agent's work is to screenshot after each action.
That produces a slideshow: you see the before and after, never the actual
navigation, and you cannot tell a slow page from a stuck agent.

Instead this uses Chrome DevTools Protocol `Page.startScreencast`, which is what
Chrome's own remote debugging uses -- Chrome pushes a JPEG every time it paints,
so the feed is genuinely live and costs nothing when the page is static. Frames
go to the blob store; the event log carries hashes. A 10 minute session stays a
readable text file.

The second half of legibility is showing *where* the agent acted. A click event
in a log tells you a selector; it does not tell you that the selector matched a
cookie banner instead of the button. So before every click Autora paints a
marker at the target coordinates into the page itself, which means it appears in
the screencast and therefore in the recording. You watch the agent miss.
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult

#: JS injected before a click: a ring that fades over ~600ms at the click point.
#: Painted into the page so the screencast captures it -- an overlay drawn in the
#: UI instead would be absent from the recording and from any shared clip.
_MARKER_JS = """
(([x, y, label]) => {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;
    height:44px;border:3px solid #ff3b6b;border-radius:50%;z-index:2147483647;
    pointer-events:none;box-shadow:0 0 0 3px rgba(255,59,107,.28);
    transition:opacity .55s ease-out,transform .55s ease-out;`;
  if (label) {
    const t = document.createElement('div');
    t.textContent = label;
    t.style.cssText = `position:absolute;left:52px;top:10px;white-space:nowrap;
      font:600 12px ui-monospace,monospace;color:#fff;background:#ff3b6b;
      padding:3px 7px;border-radius:5px;`;
    d.appendChild(t);
  }
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.7)'; });
  setTimeout(() => d.remove(), 700);
})
"""


class BrowserSession:
    """Owns one Chromium instance and pipes its screencast into the event log."""

    def __init__(
        self,
        session,
        headless: bool = True,
        width: int = 1280,
        height: int = 800,
        executable_path: str | None = None,
    ):
        self.session = session
        self.headless = headless
        self.width, self.height = width, height
        self.executable_path = executable_path or os.environ.get("AUTORA_CHROME_PATH")
        self._playwright = None
        self._browser = None
        self.page = None
        self._cdp = None
        self._frames = 0
        self._started = 0.0

    async def ensure_started(self) -> None:
        if self.page is not None:
            return
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover - depends on install
            raise RuntimeError(
                "Playwright is not installed. Run: uv pip install playwright "
                "&& playwright install chromium. If you already have a Chromium, "
                "set AUTORA_CHROME_PATH to its binary instead."
            ) from exc

        self._playwright = await async_playwright().start()
        launch_args: dict[str, Any] = {
            "headless": self.headless,
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        # Respect an explicitly provided Chrome. Playwright pins an exact browser
        # build per release, so a pip upgrade routinely orphans an already-working
        # Chromium and demands a 150MB redownload. Sandboxes and CI images ship
        # their own binary; let them say so instead of failing at launch.
        if self.executable_path:
            launch_args["executable_path"] = self.executable_path
        self._browser = await self._playwright.chromium.launch(**launch_args)
        context = await self._browser.new_context(
            viewport={"width": self.width, "height": self.height},
            # A real UA: many sites serve a degraded page to obvious automation,
            # and debugging that is a waste of an afternoon.
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
            ),
        )
        self.page = await context.new_page()
        self._started = time.monotonic()
        await self._start_screencast()
        self.page.on("framenavigated", self._on_navigate)

    def _on_navigate(self, frame: Any) -> None:
        # Only top-level navigations; iframe churn would flood the timeline.
        if self.page and frame == self.page.main_frame:
            self.session.emit(Kind.BROWSER_NAV, {"url": frame.url}, actor="tool:browser")

    async def _start_screencast(self) -> None:
        self._cdp = await self.page.context.new_cdp_session(self.page)

        def on_frame(params: dict[str, Any]) -> None:
            data = base64.b64decode(params["data"])
            meta = params.get("metadata", {})
            self._frames += 1
            self.session.emit_frame(
                Kind.BROWSER_FRAME, data, stream="browser",
                t=round(time.monotonic() - self._started, 3),
                w=meta.get("deviceWidth"), h=meta.get("deviceHeight"),
                scroll_y=meta.get("scrollOffsetY", 0),
            )
            # Chrome throttles the screencast until each frame is acknowledged.
            # Miss this and the feed delivers one frame and stops.
            asyncio.create_task(self._ack(params["sessionId"]))

        self._cdp.on("Page.screencastFrame", on_frame)
        await self._cdp.send("Page.startScreencast", {
            "format": "jpeg",
            # 60 is the point where text is still crisp but frames stay ~30-60KB.
            "quality": 60,
            "maxWidth": self.width, "maxHeight": self.height,
            # Chrome only pushes on paint, so this is a ceiling, not a poll rate:
            # a static page costs nothing.
            "everyNthFrame": 1,
        })

    async def _ack(self, session_id: int) -> None:
        try:
            await self._cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:
            # The page can navigate or close between frame and ack; that is
            # normal and must not surface as an error in the timeline.
            pass

    async def mark(self, x: float, y: float, label: str = "") -> None:
        """Paint a click marker into the page so the recording shows the target."""
        try:
            await self.page.evaluate(_MARKER_JS, [x, y, label])
            # One frame's worth of time so the marker is actually painted and
            # captured before the click navigates away.
            await asyncio.sleep(0.05)
        except Exception:
            pass

    async def close(self) -> None:
        for closer in (
            lambda: self._cdp.send("Page.stopScreencast") if self._cdp else None,
            lambda: self._browser.close() if self._browser else None,
            lambda: self._playwright.stop() if self._playwright else None,
        ):
            try:
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass
        self.page = self._browser = self._playwright = self._cdp = None


class BrowserTool:
    name = "browser"
    description = (
        "Drive a real Chromium browser. The page is streamed live to the UI and "
        "recorded. Actions: goto, click, type, scroll, read, screenshot, back. "
        "Prefer `read` to understand a page before acting on it."
    )
    schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["goto", "click", "type", "scroll", "read", "screenshot", "back", "wait"],
            },
            "url": {"type": "string", "description": "For goto."},
            "selector": {
                "type": "string",
                "description": "CSS selector, or text= / role= Playwright selector.",
            },
            "text": {"type": "string", "description": "For type."},
            "submit": {"type": "boolean", "description": "Press Enter after typing."},
            "sensitive": {
                "type": "boolean",
                "description": "Force redaction of the typed value in the log. Password "
                               "fields are detected and redacted automatically.",
            },
            "amount": {"type": "integer", "description": "Pixels to scroll. Negative is up."},
            "seconds": {"type": "number", "description": "For wait."},
        },
        "required": ["action"],
    }

    def __init__(self, headless: bool = True, executable_path: str | None = None):
        self.headless = headless
        self.executable_path = executable_path
        self._browser: BrowserSession | None = None

    async def _session_for(self, session) -> BrowserSession:
        if self._browser is None:
            self._browser = BrowserSession(
                session, headless=self.headless, executable_path=self.executable_path
            )
        await self._browser.ensure_started()
        return self._browser

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        action = args["action"]
        try:
            browser = await self._session_for(session)
        except RuntimeError as exc:
            yield ToolResult(str(exc), ok=False)
            return
        page = browser.page

        try:
            if action == "goto":
                url = args["url"]
                if not url.startswith(("http://", "https://", "file://")):
                    url = "https://" + url
                # `domcontentloaded` rather than `load`: waiting for every
                # tracking pixel makes the agent look hung on most real sites.
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                session.emit(Kind.BROWSER_ACTION, {"action": "goto", "url": url},
                             actor="tool:browser", span=span)
                yield ToolResult(f"Loaded {page.url}\nTitle: {await page.title()}",
                                 display={"url": page.url})

            elif action == "click":
                locator = page.locator(args["selector"]).first
                await locator.wait_for(state="visible", timeout=10000)
                box = await locator.bounding_box()
                if box:
                    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                    await browser.mark(cx, cy, args["selector"][:40])
                    session.emit(Kind.BROWSER_ACTION, {
                        "action": "click", "selector": args["selector"], "x": cx, "y": cy,
                    }, actor="tool:browser", span=span)
                await locator.click(timeout=10000)
                yield ToolResult(f"Clicked {args['selector']}. Now at {page.url}",
                                 display={"url": page.url})

            elif action == "type":
                locator = page.locator(args["selector"]).first
                await locator.wait_for(state="visible", timeout=10000)
                box = await locator.bounding_box()
                if box:
                    await browser.mark(box["x"] + box["width"] / 2,
                                       box["y"] + box["height"] / 2, "type")
                # Detect a credential field from the DOM rather than trusting the
                # caller to flag it. The model does not reliably know it is filling
                # a password, and a leaked password in a shareable recording is not
                # a mistake you get to take back.
                field_type = (await locator.get_attribute("type") or "").lower()
                field_name = ((await locator.get_attribute("name") or "") + " " +
                              (await locator.get_attribute("id") or "")).lower()
                sensitive = (
                    field_type == "password"
                    or bool(args.get("sensitive"))
                    or any(w in field_name for w in ("password", "passwd", "secret",
                                                     "token", "cvv", "card"))
                )
                await locator.fill(args.get("text", ""))
                session.emit(Kind.BROWSER_ACTION, {
                    "action": "type", "selector": args["selector"],
                    "length": len(args.get("text", "")),
                    "sensitive": sensitive,
                    # Record the value only for non-credential fields, where seeing
                    # what was typed into a search box is the whole point of a replay.
                    "text": None if sensitive else args.get("text", "")[:200],
                }, actor="tool:browser", span=span)
                if args.get("submit"):
                    await locator.press("Enter")
                    await page.wait_for_load_state("domcontentloaded", timeout=15000)
                yield ToolResult(f"Typed into {args['selector']}"
                                 + (" and submitted." if args.get("submit") else "."),
                                 display={"url": page.url})

            elif action == "scroll":
                amount = int(args.get("amount") or 600)
                await page.mouse.wheel(0, amount)
                await asyncio.sleep(0.25)
                session.emit(Kind.BROWSER_ACTION, {"action": "scroll", "amount": amount},
                             actor="tool:browser", span=span)
                yield ToolResult(f"Scrolled {amount}px.")

            elif action == "read":
                # Hand the model text, not a screenshot. It is an order of
                # magnitude cheaper, more reliable to act on, and the human gets
                # the visual channel from the screencast anyway.
                # Read from a detached clone. Stripping elements from the live
                # document would mean that reading a page silently damages it --
                # a subsequent click could hit a page whose scripts and iframes
                # the read had already deleted.
                content = await page.evaluate("""() => {
                    const src = document.querySelector('main,article,[role=main]') || document.body;
                    const copy = src.cloneNode(true);
                    copy.querySelectorAll('script,style,noscript,svg,iframe')
                        .forEach(e => e.remove());
                    // innerText respects block boundaries but needs layout, which a
                    // detached node lacks (everything runs together). So attach the
                    // clone offscreen, read it, and remove it. The original document
                    // is never touched -- reading a page must not damage it.
                    const host = document.createElement('div');
                    // Off-screen, but NOT visibility:hidden or display:none --
                    // innerText deliberately returns '' for hidden subtrees.
                    host.style.cssText =
                        'position:absolute;left:-99999px;top:0;width:1200px;height:auto';
                    host.appendChild(copy);
                    document.body.appendChild(host);
                    let text = '';
                    try { text = copy.innerText; } finally { host.remove(); }
                    return text.replace(/[ \\t]+/g, ' ')
                        .replace(/\\n\\s*\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, 20000);
                }""")
                links = await page.evaluate("""() => [...document.querySelectorAll('a[href]')]
                    .slice(0, 60).map(a => `${a.innerText.trim().slice(0,60)} -> ${a.href}`)
                    .filter(s => !s.startsWith(' ->'))""")
                yield ToolResult(
                    f"# {await page.title()}\n{page.url}\n\n{content}\n\n"
                    f"## Links\n" + "\n".join(links),
                    display={"url": page.url})

            elif action == "screenshot":
                shot = await page.screenshot(type="jpeg", quality=70)
                session.emit_frame(Kind.BROWSER_FRAME, shot, stream="browser",
                                   explicit=True)
                yield ToolResult(f"Captured {page.url}", display={"url": page.url})

            elif action == "back":
                await page.go_back(wait_until="domcontentloaded")
                yield ToolResult(f"Back to {page.url}", display={"url": page.url})

            elif action == "wait":
                await asyncio.sleep(min(float(args.get("seconds") or 1.0), 30.0))
                yield ToolResult("Waited.")

            else:
                yield ToolResult(f"Unknown action {action!r}.", ok=False)

        except Exception as exc:
            # Return the failure to the model as text rather than raising: a
            # timed-out selector is information it can act on, not a crash.
            name = type(exc).__name__
            session.emit(Kind.TOOL_ERROR, {"error": f"{name}: {exc}", "action": action},
                         actor="tool:browser", span=span)
            yield ToolResult(f"Browser {action} failed: {name}: {str(exc)[:400]}", ok=False)

    async def cleanup(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
