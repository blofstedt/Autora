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

#: The page as the model reads it: every interactive element, with the role and
#: accessible name a screen reader would announce, plus a numeric ref to act on.
#:
#: This is the accessibility tree rather than the DOM on purpose. The DOM is
#: wrapper soup -- a button is six nested divs, and the text around it says
#: nothing about what can be clicked. The a11y layer is the one the platform
#: already computes for exactly this problem: perceiving an interface without
#: looking at it. Roles and names come out of it for free, form fields and their
#: current values are in it (they are invisible to `innerText`), and the whole
#: page collapses to a few hundred tokens.
#:
#: Refs are held in `window.__autora_refs` rather than stamped onto elements as
#: attributes: reading a page must not modify it, and a data attribute is still
#: a modification that a MutationObserver or an attribute selector can see.
_SNAPSHOT_JS = r"""
((maxEls) => {
  const refs = [];
  window.__autora_refs = refs;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vw = window.innerWidth, vh = window.innerHeight;

  function visible(el) {
    if (el.closest('[aria-hidden="true"]')) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  }

  function roleOf(el) {
    const explicit = clean(el.getAttribute('role'));
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'expander';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      if (['button', 'submit', 'reset', 'image'].indexOf(t) >= 0) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return null;
  }

  // Accessible name, in roughly the order the accname spec resolves it. This is
  // what a screen reader would announce, which is also the handle a human would
  // describe the control by -- "the Sign in button", not "button.btn-primary".
  function nameOf(el, role) {
    let n = clean(el.getAttribute('aria-label'));
    if (n) return n;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      n = clean(lb.split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? t.innerText || t.getAttribute('aria-label') : '';
      }).join(' '));
      if (n) return n;
    }
    if (el.labels && el.labels.length) {
      n = clean([].map.call(el.labels, (l) => l.innerText).join(' '));
      if (n) return n;
    }
    n = clean(el.getAttribute('placeholder')) || clean(el.getAttribute('alt'))
      || clean(el.getAttribute('title'));
    if (n) return n;
    if (role === 'button' && el.tagName.toLowerCase() === 'input') {
      n = clean(el.getAttribute('value'));
      if (n) return n;
    }
    // Not for fields: a <select>'s innerText is its option list, and a
    // textbox's is whatever the user has typed -- neither is a name.
    if (role !== 'textbox' && role !== 'combobox') {
      n = clean(el.innerText);
      if (n) return n;
    }
    // Last resort: the developer's own handle. Ugly, but a nameless field is
    // worse than one identified by its form name.
    return clean(el.getAttribute('name') || el.getAttribute('id'));
  }

  function stateOf(el, role) {
    const bits = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (role === 'checkbox' || role === 'radio') {
      const on = el.checked !== undefined ? el.checked
        : el.getAttribute('aria-checked') === 'true';
      bits.push(on ? 'checked' : 'unchecked');
    } else if (role === 'textbox') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      const v = el.isContentEditable ? clean(el.innerText) : (el.value || '');
      // Never echo a credential back into the transcript, even as a "value".
      if (t === 'password') bits.push(v ? 'password set' : 'password empty');
      else if (v) bits.push('value=' + JSON.stringify(v.slice(0, 60)));
      else bits.push('empty');
    } else if (role === 'combobox' && el.selectedOptions) {
      const sel = clean([].map.call(el.selectedOptions, (o) => o.text).join(', '));
      bits.push('value=' + JSON.stringify(sel.slice(0, 60)));
    }
    const exp = el.getAttribute('aria-expanded');
    if (exp) bits.push(exp === 'true' ? 'expanded' : 'collapsed');
    return bits;
  }

  const SEL = 'a[href],button,input,select,textarea,summary,[role],[onclick],' +
    '[contenteditable=""],[contenteditable="true"]';
  const seen = new Set();
  const found = [];

  const all = document.querySelectorAll(SEL);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (seen.has(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    // Presentational roles carry no affordance; listing them is pure noise.
    if (role === 'presentation' || role === 'none' || role === 'generic') continue;
    if (!visible(el)) continue;
    seen.add(el);

    const name = nameOf(el, role).slice(0, 80);
    const bits = stateOf(el, role);
    // A nameless, stateless control is something the model cannot ask for and
    // should not guess at -- skip it rather than emit "[7] link".
    if (!name && !bits.length) continue;

    const r = el.getBoundingClientRect();
    const off = r.top > vh || r.bottom < 0 || r.left > vw || r.right < 0;
    found.push({ el: el, role: role, name: name, bits: bits, off: off });
  }

  // Over budget, off-screen elements go first. What is on screen is what the
  // model can act on this instant; a link 1400px down is a reason to scroll,
  // not a reason to spend the budget. Document order is preserved either way --
  // it is the reading order, and shuffling it costs comprehension.
  let keep = found;
  let dropped = 0;
  if (found.length > maxEls) {
    const onscreen = found.filter((f) => !f.off);
    const budget = Math.max(maxEls - onscreen.length, 0);
    const offKeep = new Set(found.filter((f) => f.off).slice(0, budget));
    keep = found.filter((f) => !f.off || offKeep.has(f));
    if (keep.length > maxEls) keep = keep.slice(0, maxEls);
    dropped = found.length - keep.length;
  }

  const lines = keep.map((f) => {
    const ref = refs.length;
    refs.push(f.el);
    let line = '[' + ref + '] ' + f.role;
    if (f.name) line += ' ' + JSON.stringify(f.name);
    if (f.bits.length) line += ' ' + f.bits.join(' ');
    if (f.role === 'link') {
      const href = f.el.getAttribute('href') || '';
      if (href && href.indexOf('javascript:') !== 0) line += ' -> ' + href.slice(0, 70);
    }
    if (f.off) line += ' (off-screen)';
    return line;
  });

  return {
    lines: lines,
    total: lines.length,
    dropped: dropped,
    offscreen: keep.filter((f) => f.off).length,
    title: document.title,
    url: location.href,
  };
})
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


#: How many elements a refreshed snapshot carries after an action, versus an
#: explicit `read`. Post-action snapshots are the common case and want to be
#: cheap; a `read` is a deliberate "show me this page" and can afford more.
SNAPSHOT_AFTER_ACTION = 35
SNAPSHOT_ON_READ = 90


async def _snapshot(page, limit: int) -> dict[str, Any]:
    return await page.evaluate(f"({_SNAPSHOT_JS})({int(limit)})")


def _render(snap: dict[str, Any]) -> str:
    """The interactive map, as the model reads it."""
    if not snap["lines"]:
        return "No interactive elements found."
    out = "\n".join(snap["lines"])
    notes = []
    if snap.get("dropped"):
        notes.append(f"{snap['dropped']} more not shown")
    if snap.get("offscreen"):
        notes.append(f"{snap['offscreen']} off-screen — scroll to reach them")
    if notes:
        out += f"\n({'; '.join(notes)})"
    return out


async def _target(page, args: dict[str, Any], key: str = "ref"):
    """Resolve a ref or a selector to one element handle.

    Both paths end at an ElementHandle so every action has a single code path.
    Refs come from the last snapshot; a stale one fails loudly rather than
    clicking whatever now occupies that index, because a ref that silently
    points somewhere else is how an agent ends up buying something.
    """
    ref = args.get(key)
    if ref is not None:
        handle = await page.evaluate_handle(
            "(i) => (window.__autora_refs || [])[i] || null", int(ref))
        element = handle.as_element()
        if element is None:
            raise LookupError(
                f"ref {ref} is stale or out of range — the page changed since the "
                f"last snapshot. Use `read` to get fresh refs.")
        # A ref for an element that has since been detached is just as stale.
        if not await element.evaluate("(e) => e.isConnected"):
            raise LookupError(
                f"ref {ref} points at an element no longer in the page. "
                f"Use `read` to get fresh refs.")
        await element.scroll_into_view_if_needed(timeout=5000)
        return element
    selector = args.get("selector")
    if not selector:
        raise LookupError("Give either a ref (from the last snapshot) or a selector.")
    element = await page.wait_for_selector(selector, state="visible", timeout=10000)
    if element is None:
        raise LookupError(f"No visible element matched {selector!r}.")
    return element


async def _describe(element) -> str:
    """A short human label for the log and the click marker.

    Same order the snapshot names elements by, so the label in the recording
    matches the one the model was shown. A checkbox labelled by a sibling
    `<label for=...>` is the common case that a naive version renders as
    "INPUT" -- which tells whoever is reviewing the session nothing.
    """
    return (await element.evaluate("""(e) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const byId = clean((e.getAttribute('aria-labelledby') || '').split(/\s+/)
            .map((i) => (document.getElementById(i) || {}).innerText).join(' '));
        const byLabel = e.labels && e.labels.length
            ? clean([].map.call(e.labels, (l) => l.innerText).join(' ')) : '';
        return clean(e.getAttribute('aria-label')) || byId || byLabel
            || clean(e.innerText) || clean(e.getAttribute('placeholder'))
            || clean(e.getAttribute('value')) || clean(e.getAttribute('name'))
            || e.tagName.toLowerCase();
    }"""))[:40]


async def _is_sensitive(element, override: bool) -> bool:
    """Decide from the DOM whether a value must never reach the record.

    The model does not reliably know it is filling a password, and a leaked
    credential in a shareable recording is not a mistake you get to take back.
    """
    if override:
        return True
    field_type = (await element.get_attribute("type") or "").lower()
    if field_type == "password":
        return True
    name = ((await element.get_attribute("name") or "") + " "
            + (await element.get_attribute("id") or "")
            + " " + (await element.get_attribute("autocomplete") or "")).lower()
    return any(w in name for w in
               ("password", "passwd", "secret", "token", "cvv", "card", "ssn"))


class BrowserTool:
    name = "browser"
    description = (
        "Drive a real Chromium browser. The page is streamed live to the UI and "
        "recorded.\n"
        "Work from refs, not screenshots: `read` returns the page as numbered "
        "interactive elements ([4] button \"Sign in\"), and click/type/fill take "
        "that number. Every action returns a fresh numbered list, so you rarely "
        "need a second `read`.\n"
        "Use `fill` to complete a whole form in one call rather than typing "
        "field by field. `screenshot` is a fallback for when a page is visual "
        "(a chart, a canvas, a layout question) — it costs far more than `read` "
        "and cannot be acted on."
    )
    schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["goto", "read", "click", "type", "fill", "scroll",
                         "screenshot", "back", "wait"],
            },
            "url": {"type": "string", "description": "For goto."},
            "ref": {
                "type": "integer",
                "description": "Element number from the last snapshot. Preferred "
                               "over selector.",
            },
            "selector": {
                "type": "string",
                "description": "CSS or Playwright selector. Use when you have no "
                               "ref, or the element is not in the snapshot.",
            },
            "text": {"type": "string", "description": "For type."},
            "fields": {
                "type": "array",
                "description": "For fill: several fields in one round trip, e.g. "
                               "[{\"ref\": 2, \"text\": \"ada@example.com\"}, "
                               "{\"ref\": 3, \"text\": \"...\"}].",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "integer"},
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                        "sensitive": {"type": "boolean"},
                    },
                },
            },
            "submit": {"type": "boolean", "description": "Press Enter when done."},
            "sensitive": {
                "type": "boolean",
                "description": "Force redaction of the typed value in the log. "
                               "Password fields are detected and redacted anyway.",
            },
            "amount": {"type": "integer", "description": "Pixels to scroll. Negative is up."},
            "seconds": {"type": "number", "description": "For wait."},
            "full_text": {
                "type": "boolean",
                "description": "For read: also return the page's prose. Default true. "
                               "Set false when you only need something to click.",
            },
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

        async def after(note: str) -> ToolResult:
            """Confirm the action, then hand back a fresh numbered page.

            The expensive part of browser work is not the click, it is the round
            trip: act, then read, then act. Refreshing the snapshot in the
            action's own result collapses that to one call, and keeps refs from
            going stale under an SPA that re-rendered. Old snapshots are trimmed
            out of context by the compactor, so the cost does not accumulate.
            """
            snap = await _snapshot(page, SNAPSHOT_AFTER_ACTION)
            return ToolResult(
                f"{note}\n\n# {snap['title']}\n{snap['url']}\n{_render(snap)}",
                display={"url": page.url},
            )

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
                yield await after(f"Loaded {page.url}")

            elif action == "read":
                snap = await _snapshot(page, SNAPSHOT_ON_READ)
                parts = [f"# {snap['title']}\n{snap['url']}"]
                if args.get("full_text", True):
                    # Hand the model text, not a screenshot. It is an order of
                    # magnitude cheaper, more reliable to act on, and the human
                    # gets the visual channel from the screencast anyway.
                    # Read from a detached clone: stripping elements from the
                    # live document would mean reading a page silently damages
                    # it, and a later click could hit a page whose scripts and
                    # iframes the read had already deleted.
                    parts.append(await page.evaluate("""() => {
                        const src = document.querySelector('main,article,[role=main]')
                            || document.body;
                        const copy = src.cloneNode(true);
                        copy.querySelectorAll('script,style,noscript,svg,iframe')
                            .forEach(e => e.remove());
                        // innerText respects block boundaries but needs layout,
                        // which a detached node lacks. So attach the clone
                        // offscreen -- but not display:none or visibility:hidden,
                        // for which innerText deliberately returns ''.
                        const host = document.createElement('div');
                        host.style.cssText =
                            'position:absolute;left:-99999px;top:0;width:1200px;height:auto';
                        host.appendChild(copy);
                        document.body.appendChild(host);
                        let text = '';
                        try { text = copy.innerText; } finally { host.remove(); }
                        return text.replace(/[ \\t]+/g, ' ')
                            .replace(/\\n\\s*\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, 20000);
                    }"""))
                parts.append("## Interactive\n" + _render(snap))
                session.emit(Kind.BROWSER_ACTION, {
                    "action": "read", "url": page.url, "elements": snap["total"],
                }, actor="tool:browser", span=span)
                yield ToolResult("\n\n".join(parts), display={"url": page.url})

            elif action == "click":
                element = await _target(page, args)
                label = await _describe(element)
                box = await element.bounding_box()
                if box:
                    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                    await browser.mark(cx, cy, label)
                    session.emit(Kind.BROWSER_ACTION, {
                        "action": "click", "ref": args.get("ref"),
                        "selector": args.get("selector"), "label": label,
                        "x": cx, "y": cy,
                    }, actor="tool:browser", span=span)
                await element.click(timeout=10000)
                yield await after(f"Clicked {label!r}.")

            elif action in ("type", "fill"):
                if action == "type":
                    fields = [{k: args.get(k) for k in ("ref", "selector", "text", "sensitive")}]
                else:
                    fields = args.get("fields") or []
                    if not fields:
                        yield ToolResult(
                            "fill needs `fields`, e.g. "
                            "[{\"ref\": 2, \"text\": \"ada@example.com\"}].", ok=False)
                        return

                done: list[str] = []
                for field in fields:
                    element = await _target(page, field)
                    label = await _describe(element)
                    box = await element.bounding_box()
                    if box:
                        await browser.mark(box["x"] + box["width"] / 2,
                                           box["y"] + box["height"] / 2, label)
                    value = field.get("text") or ""
                    sensitive = await _is_sensitive(element, bool(field.get("sensitive")))
                    if sensitive:
                        # Fast fill for credentials: no delay, nothing to see here.
                        await element.fill(value)
                    else:
                        # Visible typing: the screencast shows what is being
                        # written, not just the settled value. One field at a
                        # time is still one round trip for the whole form.
                        await element.click()
                        await element.fill("")
                        await page.keyboard.type(value, delay=18)
                    session.emit(Kind.BROWSER_ACTION, {
                        "action": "type", "ref": field.get("ref"),
                        "selector": field.get("selector"), "label": label,
                        "length": len(value), "sensitive": sensitive,
                        # Record the value only for non-credential fields, where
                        # seeing what went into a search box is the point of a replay.
                        "text": None if sensitive else value[:200],
                    }, actor="tool:browser", span=span)
                    done.append(f"{label!r}" + (" (redacted)" if sensitive else ""))

                if args.get("submit"):
                    await page.keyboard.press("Enter")
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception:
                        # A form that updates in place never fires a navigation.
                        # That is not a failure, and the snapshot below shows it.
                        pass
                note = f"Filled {', '.join(done)}"
                yield await after(note + (" and submitted." if args.get("submit") else "."))

            elif action == "scroll":
                amount = int(args.get("amount") or 600)
                await page.mouse.wheel(0, amount)
                await asyncio.sleep(0.25)
                session.emit(Kind.BROWSER_ACTION, {"action": "scroll", "amount": amount},
                             actor="tool:browser", span=span)
                yield await after(f"Scrolled {amount}px.")

            elif action == "screenshot":
                # The fallback, not the default. An image costs far more than a
                # snapshot and cannot be clicked -- it is for questions about how
                # a page *looks* (a chart, a canvas, a broken layout).
                shot = await page.screenshot(type="jpeg", quality=70)
                session.emit_frame(Kind.BROWSER_FRAME, shot, stream="browser",
                                   explicit=True)
                yield ToolResult(f"Captured {page.url} to the recording.",
                                 display={"url": page.url})

            elif action == "back":
                await page.go_back(wait_until="domcontentloaded")
                yield await after(f"Back to {page.url}")

            elif action == "wait":
                await asyncio.sleep(min(float(args.get("seconds") or 1.0), 30.0))
                yield ToolResult("Waited.")

            else:
                yield ToolResult(f"Unknown action {action!r}.", ok=False)

        except LookupError as exc:
            # A stale ref is the one failure the model can always fix itself.
            yield ToolResult(str(exc), ok=False)

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
