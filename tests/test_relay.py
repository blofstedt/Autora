"""Desktop relay: addressing, handout, and what reaches a session's log.

The relay is the one piece of Autora that runs on another machine, which is
exactly why it was the piece that could not be got working: every failure --
wrong address, no Autora installed there, server bound to localhost -- arrived
as the same silent "not connected". These tests cover the three things that
make it diagnosable: the address forms a person actually types, the script
being downloadable with the address already in it, and frames reaching only
the sessions that asked for a desktop.
"""

import asyncio
import base64
import json
import pathlib
import sys
import tempfile
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

import httpx
import uvicorn
import websockets

from autora.events import Kind
from autora.server import Harness, create_app

PORT = 8913


def test_addressing() -> None:
    """Every form of "where the server is" has to resolve to one URL."""
    # Imported lazily: the module imports mss/pyautogui at load, which are not
    # installed on a server that only hands the script out.
    source = (pathlib.Path(__file__).resolve().parents[1]
              / "src" / "autora" / "relay" / "__main__.py").read_text()
    namespace: dict = {}
    body = "def relay_url" + source.split("def relay_url")[1].split("def _probe")[0]
    exec("from __future__ import annotations\nDEFAULT_PORT = 8817\n"
         'RELAY_PATH = "/ws/desktop-relay"\n' + body, namespace)
    relay_url = namespace["relay_url"]

    cases = {
        "192.168.1.5:8817": "ws://192.168.1.5:8817/ws/desktop-relay",
        "http://box.local:8817": "ws://box.local:8817/ws/desktop-relay",
        "ws://box": "ws://box:8817/ws/desktop-relay",
        "https://box.ts.net": "wss://box.ts.net/ws/desktop-relay",
        "  http://1.2.3.4:8817/ws/desktop-relay  ": "ws://1.2.3.4:8817/ws/desktop-relay",
        "wss://x/ws/desktop-relay/": "wss://x/ws/desktop-relay",
    }
    for given, want in cases.items():
        got = relay_url(given)
        assert got == want, f"{given!r} -> {got!r}, wanted {want!r}"
    for bad in ["", "ftp://box"]:
        try:
            relay_url(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} should not resolve")
    print("  address forms .................. ok")


async def main() -> None:
    test_addressing()

    tmp = tempfile.mkdtemp()
    harness = Harness(root=pathlib.Path(tmp), workdir=pathlib.Path(tmp), memory_db=False)
    session_id = harness.create_session(title="relay test")
    session = harness.sessions.get(session_id)

    app = create_app(harness)
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        await asyncio.sleep(0.05)
        if server.started:
            break

    base = f"http://127.0.0.1:{PORT}"
    async with httpx.AsyncClient(base_url=base, timeout=10) as http:
        script = await http.get("/relay.py", headers={"host": "box.local:8817"})
        assert script.status_code == 200, script.status_code
        stamped = [line for line in script.text.splitlines()
                   if line.startswith("DEFAULT_SERVER")]
        assert stamped == ["DEFAULT_SERVER = 'ws://box.local:8817/ws/desktop-relay'"], stamped
        # The handed-out copy must not import Autora: the machine running it
        # is precisely the machine that does not have Autora.
        assert "from autora" not in script.text and "import autora" not in script.text
        print("  script handed out, addressed ... ok")

        status = (await http.get("/api/relay", headers={"host": "box.local:8817"})).json()
        assert status["connected"] is False
        assert status["ws_url"] == "ws://box.local:8817/ws/desktop-relay"
        assert status["download"] == "http://box.local:8817/relay.py"

        # Behind a TLS-terminating proxy, the address handed out has to be the
        # one the person can reach, not the private port we happen to bind.
        proxied = (await http.get("/api/relay", headers={
            "host": "127.0.0.1", "x-forwarded-host": "box.ts.net",
            "x-forwarded-proto": "https"})).json()
        assert proxied["ws_url"] == "wss://box.ts.net/ws/desktop-relay", proxied
        print("  status + proxy addressing ...... ok")

        jpeg = base64.b64encode(b"\xff\xd8\xff-not-really-a-jpeg").decode()
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/desktop-relay") as ws:
            await ws.send(json.dumps({"type": "hello", "platform": "windows",
                                      "w": 1920, "h": 1080}))
            await ws.send(json.dumps({"type": "frame", "data": jpeg, "w": 1920, "h": 1080}))
            await asyncio.sleep(0.4)

            status = (await http.get("/api/relay")).json()
            assert status["connected"] is True, status
            assert status["platform"] == "windows"
            assert status["screen"] == {"w": 1920, "h": 1080}
            print("  relay connects, reports itself . ok")

            frame = await http.get("/api/relay/frame")
            assert frame.status_code == 200 and frame.content.startswith(b"\xff\xd8")
            print("  live preview frame ............. ok")

            # Nobody asked for a desktop, so nothing about an idle screen has
            # any business in the conversation.
            kinds = [e.kind for e in session.store.read()]
            assert Kind.DESKTOP_FRAME not in kinds, kinds
            print("  idle frames stay out of the log  ok")

            # Once the session uses the desktop, the frames are the record.
            harness.relay.note_interest(session_id)
            await ws.send(json.dumps({"type": "frame", "data": jpeg, "w": 1920, "h": 1080}))
            await asyncio.sleep(0.4)
            kinds = [e.kind for e in session.store.read()]
            assert Kind.DESKTOP_FRAME in kinds, kinds
            print("  frames recorded where used ..... ok")

        await asyncio.sleep(0.3)
        status = (await http.get("/api/relay")).json()
        assert status["connected"] is False
        assert (await http.get("/api/relay/frame")).status_code == 404
        print("  disconnect forgets the screen .. ok")

    server.should_exit = True
    print("\nall relay tests passed")


if __name__ == "__main__":
    asyncio.run(main())
