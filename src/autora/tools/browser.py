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

Persistent auth: when a profile_dir is given, the browser uses
`launch_persistent_context` so cookies, localStorage, and login state survive
restarts. One profile can hold Gmail, Google Calendar, and anything else the user
has signed into -- no re-auth required.

Cursor visibility: a tiny red dot injected via `add_init_script` follows every
`mousemove` event, so the CDP screencast shows where the agent's pointer is
even though the OS cursor is not captured by the screencaster.
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult

#: Injected into every page via add_init_script: a red dot that tracks the
#: mouse pointer. The OS cursor is not captured by CDP screencast, so this is
#: the only way to show "where" the agent is looking without a second overlay
#: that would be absent from recordings.
_CURSOR_JS = """\
(() => {
  function _install() {
    if (!document.body || document.getElementById('__autora_cur__')) return;
    const c = document.createElement('div');
    c.id = '__autora_cur__';
    c.style.cssText =
      'position:fixed;left:-999px;top:-999px;width:14px;height:14px;' +
      'pointer-events:none;z-index:2147483646;background:rgba(255,59,107,.9);' +
      'border-radius:50%;border:2px solid rgba(255,255,255,.85);' +
      'box-shadow:0 1px 4px rgba(0,0,0,.55);transition:left .04s,top .04s;';
    document.body.appendChild(c);
    document.addEventListener('mousemove', e => {
      c.style.left = (e.clientX - 7) + 'px';
      c.style.top  = (e.clientY - 7) + 'px';
    }, {passive: true});
  }
  if (document.body) _install(); else window.addEventListener('DOMContentLoaded', _install);
})()
"""

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


_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)


class BrowserSession:
    """Owns one Chromium instance and pipes its screencast into the event log."""

    def __init__(
        self,
        session,
        headless: bool = True,
        width: int = 1280,
        height: int = 800,
        executable_path: str | None = None,
        profile_dir: str | None = None,
    ):
        self.session = session
        self.headless = headless
        self.width, self.height = width, height
        self.executable_path = executable_path or os.environ.get("AUTORA_CHROME_PATH")
        self.profile_dir = profile_dir or os.environ.get("AUTORA_BROWSER_PROFILE")
        self._playwright = None
        self._browser = None
        self._context = None
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
        common_kwargs: dict[str, Any] = {
            "headless": self.headless,
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        if self.executable_path:
            common_kwargs["executable_path"] = self.executable_path

        if self.profile_dir:
            # Persistent context: cookies/localStorage survive across restarts.
            # The user signs in once to Gmail/Google Calendar/etc and the auth
            # persists until they explicitly clear the profile.
            Path(self.profile_dir).mkdir(parents=True, exist_ok=True)
            context = await self._playwright.chromium.launch_persistent_context(
                str(self.profile_dir),
                viewport={"width": self.width, "height": self.height},
                user_agent=_UA,
                **common_kwargs,
            )
            self._context = context
            # Persistent context may already have open pages from a previous run.
            self.page = context.pages[0] if context.pages else await context.new_page()
        else:
            # Ephemeral context: clean slate every time -- fine for stateless tasks.
            self._browser = await self._playwright.chromium.launch(**common_kwargs)
            context = await self._browser.new_context(
                viewport={"width": self.width, "height": self.height},
                # A real UA: many sites serve a degraded page to obvious automation,
                # and debugging that is a waste of an afternoon.
                user_agent=_UA,
            )
            self._context = context
            self.page = await context.new_page()

        # Inject cursor tracker so the screencast shows where the pointer is.
        await context.add_init_script(_CURSOR_JS)
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
            lambda: self._context.close() if self._context else None,
            lambda: self._browser.close() if self._browser else None,
            lambda: self._playwright.stop() if self._playwright else None,
        ):
            try:
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass
        self.page = self._context = self._browser = self._playwright = self._cdp = None


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

    def __init__(
        self,
        headless: bool = True,
        executable_path: str | None = None,
        profile_dir: str | None = None,
    ):
        self.headless = headless
        self.executable_path = executable_path
        self.profile_dir = profile_dir
        self._browser: BrowserSession | None = None

    async def _session_for(self, session) -> BrowserSession:
        if self._browser is None:
            self._browser = BrowserSession(
                session,
                headless=self.headless,
                executable_path=self.executable_path,
                profile_dir=self.profile_dir,
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
                text_val = args.get("text", "")
                if sensitive:
                    # Fast fill for credentials: no delay, nothing to see here.
                    await locator.fill(text_val)
                else:
                    # Visible typing: character-by-character so the screencast
                    # shows what the agent is writing, not just the final value.
                    await locator.click()
                    await locator.fill("")
                    await locator.press_sequentially(text_val, delay=25)
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
