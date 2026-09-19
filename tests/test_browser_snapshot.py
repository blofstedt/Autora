"""The page as the model reads it.

Needs a real Chromium, because the thing under test is what a browser computes:
layout, visibility, and label association. Skips cleanly when Playwright or a
browser is not installed, so it never blocks a run on a machine without one.
"""

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

FIXTURE = """<!doctype html><meta charset="utf-8"><title>Account sign-in</title>
<style>.tall{height:1400px}</style>
<main>
  <label for="em">Email address</label>
  <input id="em" name="email" type="email" value="ada@example.com">
  <label for="pw">Password</label>
  <input id="pw" name="password" type="password" value="hunter2">
  <input type="text" placeholder="Coupon code" name="coupon">
  <input type="checkbox" id="rm" checked><label for="rm">Remember me</label>
  <select name="country"><option>Canada</option><option selected>Norway</option></select>
  <button type="submit">Sign in</button>
  <button type="button" disabled>SSO</button>
  <input type="hidden" name="csrf" value="xyz">
  <div role="button" tabindex="0" aria-label="Open help" aria-expanded="false">?</div>
  <span aria-hidden="true"><a href="/ghost">Hidden</a></span>
  <a href="/tos" style="display:none">Invisible</a>
  <div class="tall"></div>
  <a href="/footer">Far below</a>
</main>"""


def _browser_available():
    try:
        import playwright  # noqa: F401
    except ImportError:
        return None
    import os
    for candidate in (
        os.environ.get("AUTORA_CHROME_PATH"),
        "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    ):
        if candidate and pathlib.Path(candidate).exists():
            return candidate
    return ""   # playwright present; let it find its own build


async def drive(tool, session, **args):
    last = None
    async for chunk in tool.run(session, args, "span"):
        last = chunk
    return last


async def main():
    chrome = _browser_available()
    if chrome is None:
        print("  (skipped: playwright not installed)")
        print("\nall browser tests skipped")
        return

    from autora.events import Kind
    from autora.session import SessionRegistry
    from autora.tools.browser import BrowserTool

    with tempfile.TemporaryDirectory() as tmp:
        page_path = pathlib.Path(tmp) / "page.html"
        page_path.write_text(FIXTURE)
        session = SessionRegistry(pathlib.Path(tmp) / "sessions").create(
            workdir=pathlib.Path.cwd())
        tool = BrowserTool(headless=True, executable_path=chrome or None)
        try:
            out = await drive(tool, session, action="goto", url=page_path.as_uri())
            if not out.ok:
                print(f"  (skipped: no usable browser — {out.content[:80]})")
                print("\nall browser tests skipped")
                return
            body = out.content

            # Navigation returns an actionable page, not just a confirmation.
            assert "[0] textbox" in body, body
            assert 'checkbox "Remember me" checked' in body, body
            assert 'button "Sign in"' in body, body
            assert 'button "SSO" disabled' in body, body
            assert 'button "Open help" collapsed' in body, body
            assert 'combobox "country" value="Norway"' in body, body
            print("  roles, names and states ....... ok")

            # A password is never echoed back into the transcript.
            assert "password set" in body and "hunter2" not in body, body
            print("  credentials never echoed ...... ok")

            # What a screen reader would not announce, the model does not see.
            for hidden in ("/ghost", "Invisible", "csrf"):
                assert hidden not in body, f"{hidden} should be hidden: {body}"
            assert "(off-screen)" in body, "below-fold elements should be marked"
            print("  hidden excluded, off-screen flagged  ok")

            # The whole point: an actionable page costs a fraction of an image.
            assert len(body) < 1200, f"snapshot too fat: {len(body)} chars"
            print(f"  whole page in ~{len(body) // 4} tokens ......... ok")

            # One call fills a form; the credential is redacted in the record.
            refs = {line.split("]")[0][1:]: line for line in body.splitlines()
                    if line.startswith("[")}
            coupon = next(r for r, l in refs.items() if "Coupon" in l)
            password = next(r for r, l in refs.items() if "Password" in l)
            out = await drive(tool, session, action="fill", fields=[
                {"ref": int(coupon), "text": "SAVE20"},
                {"ref": int(password), "text": "correct horse"},
            ])
            typed = [e.payload for e in session.store.read()
                     if e.kind == Kind.BROWSER_ACTION and e.payload.get("action") == "type"]
            assert len(typed) == 2, typed
            assert typed[0]["text"] == "SAVE20" and typed[0]["sensitive"] is False
            assert typed[1]["text"] is None and typed[1]["sensitive"] is True
            assert 'value="SAVE20"' in out.content, out.content
            print("  one call fills a whole form ... ok")

            # Acting by ref hits the element it named.
            box = next(r for r, l in refs.items() if "Remember me" in l)
            out = await drive(tool, session, action="click", ref=int(box))
            assert "Remember me" in out.content and "unchecked" in out.content, out.content
            print("  click by ref toggles the right one  ok")

            # A stale ref must fail, not click whatever now sits at that index.
            out = await drive(tool, session, action="click", ref=9999)
            assert not out.ok and "stale" in out.content, out.content
            print("  stale ref fails loudly ........ ok")
        finally:
            await tool.cleanup()

    print("\nall browser tests passed")


if __name__ == "__main__":
    asyncio.run(main())
