"""Pointing at things: DOM picking, 3D picking, and the guidance overlay.

Needs a real Chromium. Skips cleanly without one, like the snapshot suite.
"""

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

DOM_PAGE = """<!doctype html><meta charset="utf-8"><title>Pick</title>
<style>
 .card { padding: 24px; border-radius: 14px; background: #101522; width: 320px; }
 .cta { background: #6e5bff; color: #fff; border: 0; border-radius: 8px;
        padding: 10px 18px; font-size: 15px; font-weight: 600; }
</style>
<div class="card" id="signup" data-testid="signup-card">
  <h2>Create an account</h2>
  <button class="cta" data-testid="cta"><span>Get started</span></button>
</div>"""


def _chrome():
    try:
        import playwright  # noqa: F401
    except ImportError:
        return None
    import os
    for c in (os.environ.get("AUTORA_CHROME_PATH"),
              "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"):
        if c and pathlib.Path(c).exists():
            return c
    return ""


async def drive(tool, session, **a):
    last = None
    async for chunk in tool.run(session, a, "span"):
        last = chunk
    return last


async def main():
    chrome = _chrome()
    if chrome is None:
        print("  (skipped: playwright not installed)")
        print("\nall pick tests skipped")
        return

    from autora.events import Kind
    from autora.session import SessionRegistry
    from autora.tools.browser import BrowserTool

    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp) / "pick.html"
        page.write_text(DOM_PAGE)
        session = SessionRegistry(pathlib.Path(tmp) / "s").create(workdir=pathlib.Path.cwd())
        tool = BrowserTool(headless=True, executable_path=chrome or None)
        try:
            out = await drive(tool, session, action="goto", url=page.as_uri())
            if not out.ok:
                print(f"  (skipped: no usable browser — {out.content[:70]})")
                print("\nall pick tests skipped")
                return

            # Find the button's box from the snapshot so the click is real.
            ref_line = next(l for l in out.content.splitlines() if "Get started" in l)
            ref = int(ref_line.split("]")[0][1:])
            out = await drive(tool, session, action="highlight", ref=ref, label="here")
            assert out.ok, out.content
            box = [e for e in session.store.read()
                   if e.kind == Kind.BROWSER_HIGHLIGHT][-1].payload["box"]
            print("  highlight resolves a ref ...... ok")

            # Point at the middle of the label — which is the <span>, not the
            # button. The button's padding would hit the button directly and
            # test nothing.
            out = await drive(tool, session, action="pick",
                              x=box["x"] + box["w"] / 2, y=box["y"] + box["h"] / 2)
            body = out.content
            # It must retarget to the control, not report the label.
            assert "you pointed at a <span>" in body, body
            assert "<button>" in body and "cta" in body, body
            assert f"ref: [{ref}]" in body, body
            print("  retargets label -> control .... ok")

            # A stable selector, preferring what the author wrote deliberately.
            assert 'Selector: [data-testid="cta"]' in body, body
            print("  prefers an authored selector .. ok")

            # Only what this element sets, not the inherited cascade.
            assert "border-radius: 8px" in body and "padding: 10px 18px" in body, body
            assert "background-color: rgb(110, 91, 255)" in body, body
            # A fresh sibling would inherit these, so they are not this
            # element's doing and must not be reported as though they were.
            assert "text-align" not in body, body
            print("  reports only its own styles ... ok")

            # No dev build here, so it must say so rather than invent a file.
            assert "not exposed by this build" in body, body
            print("  honest when source is absent .. ok")

            # The pick is on the log, so the agent knows the human pointed.
            picks = [e for e in session.store.read() if e.kind == Kind.BROWSER_PICK]
            assert picks and picks[-1].payload["selector"] == '[data-testid="cta"]', picks
            print("  pointing lands in the log ..... ok")

            out = await drive(tool, session, action="scene")
            assert not out.ok and "No 3D engine" in out.content, out.content
            print("  no engine reported honestly ... ok")
        finally:
            await tool.cleanup()

    print("\nall pick tests passed")


if __name__ == "__main__":
    asyncio.run(main())
