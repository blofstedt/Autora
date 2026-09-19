"""Transport tests against a live uvicorn instance.

Deliberately over a real socket rather than a test client: the things worth
testing here -- replay/live handover, resuming from a sequence number, and an
approval that unblocks a suspended agent -- are all timing-dependent, and an
in-process client can hide ordering bugs that a socket exposes.
"""

import asyncio
import json
import pathlib
import sys
import tempfile
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import httpx
import uvicorn
import websockets

from autora.agent import Agent
from autora.events import Kind
from autora.policy import PolicyGate
from autora.providers.base import TextDelta, ToolCallRequest, TurnEnd
from autora.server import Harness, create_app
from autora.tools.base import ToolRegistry
from autora.tools.terminal import TerminalTool
from test_agent_loop import ScriptedProvider

PORT = 8911


async def main() -> None:
    tmp = tempfile.mkdtemp()
    harness = Harness(root=pathlib.Path(tmp), workdir=pathlib.Path.cwd())
    # A scripted turn that pauses on an approval, so the gate is exercised
    # across the wire rather than in-process.
    harness.provider = ScriptedProvider([
        [TextDelta("I'll deploy that."),
         ToolCallRequest("c1", "bash", {"command": "vercel deploy --prod"}),
         TurnEnd("tool_use")],
        [TextDelta("Deployed."), TurnEnd("end_turn")],
    ])
    tools = ToolRegistry()
    tools.register(TerminalTool())
    harness.tools = tools
    harness.gate = PolicyGate(ask_timeout=20)
    session_id = harness.create_session(title="wire test")
    harness.agents[session_id] = Agent(
        harness.sessions.get(session_id), harness.provider, tools, gate=harness.gate)

    app = create_app(harness)
    config = uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        await asyncio.sleep(0.05)
        if server.started:
            break

    base = f"http://127.0.0.1:{PORT}"
    async with httpx.AsyncClient(base_url=base, timeout=10) as http:
        assert (await http.get("/api/sessions")).status_code == 200
        print("  REST session list .............. ok")

        received: list[dict] = []
        approved_request: list[str] = []

        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/{session_id}") as ws:
            # Handshake: replay batch(es) then a `live` marker.
            saw_live = False
            while not saw_live:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                if msg["type"] == "batch":
                    received.extend(msg["events"])
                elif msg["type"] == "live":
                    saw_live = True
            assert any(e["kind"] == Kind.SESSION_STARTED for e in received)
            print("  replay-then-live handover ...... ok")

            # Drive a turn; the deploy command must suspend on an approval.
            await http.post(f"/api/sessions/{session_id}/message", json={"text": "deploy it"})

            deadline = asyncio.get_event_loop().time() + 20
            while asyncio.get_event_loop().time() < deadline:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                if msg["type"] != "event":
                    continue
                received.append(msg)
                kind = msg["kind"]
                if kind == Kind.POLICY_REQUEST and not approved_request:
                    rid = msg["payload"]["request_id"]
                    approved_request.append(rid)
                    print(f"  approval surfaced over ws ...... ok ({msg['payload']['reason']})")
                    # Answer on the same socket, which is the path the UI uses.
                    await ws.send(json.dumps({"type": "policy", "request_id": rid,
                                              "approved": True, "who": "test"}))
                if kind == Kind.AGENT_DONE:
                    break

        kinds = [e["kind"] for e in received]
        assert approved_request, "policy request never arrived"
        assert Kind.POLICY_DECISION in kinds
        # Approval granted => the command actually ran.
        assert Kind.PTY_EXIT in kinds, "approved command did not execute"
        print("  approval unblocks the agent .... ok")

        # Resume: reconnecting from a later seq must not replay earlier events.
        total = (await http.get(f"/api/sessions/{session_id}/events")).json()
        midpoint = len(total) // 2
        async with websockets.connect(
            f"ws://127.0.0.1:{PORT}/ws/{session_id}?from_seq={midpoint}"
        ) as ws2:
            resumed: list[dict] = []
            while True:
                msg = json.loads(await asyncio.wait_for(ws2.recv(), timeout=5))
                if msg["type"] == "batch":
                    resumed.extend(msg["events"])
                elif msg["type"] == "live":
                    break
            assert resumed and resumed[0]["seq"] == midpoint, resumed[0]["seq"]
            print(f"  resume from seq={midpoint} .......... ok")

        # Frames are content-addressed and served with an immutable cache header.
        session = harness.sessions.get(session_id)
        digest = session.store.blobs.put(b"\xff\xd8fake")
        blob_resp = await http.get(f"/api/sessions/{session_id}/blobs/{digest}")
        assert blob_resp.status_code == 200 and "immutable" in blob_resp.headers["cache-control"]
        bad = await http.get(f"/api/sessions/{session_id}/blobs/../../etc/passwd")
        assert bad.status_code == 404, bad.status_code
        print("  blob serving + traversal guard . ok")

        cast = await http.get(f"/api/sessions/{session_id}/cast")
        header = json.loads(cast.text.splitlines()[0])
        assert header["version"] == 2
        print("  asciinema export ............... ok")

        # A finished session must still be replayable with no live agent.
        session.end()
        harness.sessions.live.pop(session_id)
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/ws/{session_id}") as ws3:
            got, ended = 0, False
            while not ended:
                msg = json.loads(await asyncio.wait_for(ws3.recv(), timeout=5))
                if msg["type"] == "batch":
                    got += len(msg["events"])
                elif msg["type"] == "end":
                    assert msg["live"] is False
                    ended = True
            assert got > 0
            print(f"  recorded replay ({got} events) ... ok")

    server.should_exit = True
    print("\nall transport tests passed")


if __name__ == "__main__":
    asyncio.run(main())
