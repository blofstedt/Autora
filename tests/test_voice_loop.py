"""Voice loop tests with fake audio providers.

Barge-in and fail-safe approval are behavioral guarantees, not model properties,
so they are testable without a microphone.
"""

import asyncio
import contextlib
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from autora.agent import Agent
from autora.events import Kind
from autora.policy import PolicyGate
from autora.providers.base import TextDelta, ToolCallRequest, TurnEnd
from autora.session import SessionRegistry
from autora.tools.base import ToolRegistry
from autora.tools.terminal import TerminalTool
from autora.voice.engine import Transcript, VoiceLoop
from test_agent_loop import ScriptedProvider


async def _stop(task):
    """Cancel a task and wait for it to actually finish.

    Cancelling without awaiting leaves the task pending at interpreter exit,
    which hangs the suite -- and would hang CI, where nobody is watching to
    ctrl-C it.
    """
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


class FakeTts:
    def __init__(self):
        self.spoken = []
        self.interrupted = 0

    async def speak(self, text):
        self.spoken.append(text)
        try:
            await asyncio.sleep(2.0)  # a long utterance, so it can be cut off
        except asyncio.CancelledError:
            self.interrupted += 1
            raise


class FakeStt:
    def __init__(self, script):
        self.script = script

    async def listen(self):
        for delay, transcript in self.script:
            await asyncio.sleep(delay)
            yield transcript


async def test_barge_in_stops_speech():
    with tempfile.TemporaryDirectory() as tmp:
        reg = SessionRegistry(pathlib.Path(tmp))
        session = reg.create()
        tools = ToolRegistry()
        tools.register(TerminalTool())
        agent = Agent(session, ScriptedProvider([[TextDelta("ok"), TurnEnd("end_turn")]]),
                      tools, gate=PolicyGate(auto_approve=True))
        tts = FakeTts()
        loop = VoiceLoop(session, agent, FakeStt([]), tts)

        worker = asyncio.create_task(loop._speech_worker())
        await loop.say("This is a long sentence the agent is in the middle of.")
        await loop.say("And a second one queued behind it.")
        await asyncio.sleep(0.15)
        assert len(tts.spoken) == 1, tts.spoken

        loop.stop_speaking()          # human starts talking
        await asyncio.sleep(0.15)
        assert tts.interrupted == 1, "speech must be cut off mid-utterance"
        assert loop._queue.empty(), "queued speech must be dropped, not resumed"
        kinds = [e.kind for e in session.store.read()]
        assert Kind.TTS_INTERRUPTED in kinds
        await _stop(worker)
        print("  barge-in cuts speech + queue ... ok")


async def test_partial_transcript_triggers_interrupt():
    with tempfile.TemporaryDirectory() as tmp:
        reg = SessionRegistry(pathlib.Path(tmp))
        session = reg.create()
        tools = ToolRegistry()
        tools.register(TerminalTool())
        agent = Agent(session, ScriptedProvider([
            [TextDelta("working"), ToolCallRequest("c1", "bash", {"command": "sleep 20"}),
             TurnEnd("tool_use")],
            [TextDelta("stopped"), TurnEnd("end_turn")]]),
            tools, gate=PolicyGate(auto_approve=True))
        tts = FakeTts()
        # A partial transcript arrives while the agent is mid-tool.
        stt = FakeStt([(0.8, Transcript("no wait", final=False))])
        loop = VoiceLoop(session, agent, stt, tts)

        turn = asyncio.create_task(agent.run_turn("go"))
        listener = asyncio.create_task(loop.run())
        await asyncio.wait_for(turn, timeout=15)

        done = [e for e in session.store.read() if e.kind == Kind.AGENT_DONE]
        assert done and done[-1].payload["stop_reason"] == "interrupted", done
        await _stop(listener)
        print("  partial speech interrupts tool . ok")


async def test_voice_approval_requires_clarity():
    with tempfile.TemporaryDirectory() as tmp:
        reg = SessionRegistry(pathlib.Path(tmp))
        session = reg.create()
        tools = ToolRegistry()
        gate = PolicyGate(ask_timeout=10)
        agent = Agent(session, ScriptedProvider([[TextDelta("x"), TurnEnd("end_turn")]]),
                      tools, gate=gate)
        tts = FakeTts()
        loop = VoiceLoop(session, agent, FakeStt([]), tts)
        worker = asyncio.create_task(loop._speech_worker())

        pending = asyncio.create_task(
            gate.authorize(session, "bash", {"command": "vercel deploy --prod"}))
        await asyncio.sleep(0.1)
        loop._pending_approval = gate.pending[0]

        await loop._handle("hmm")       # ambiguous -> must not approve
        await asyncio.sleep(0.05)
        assert loop._pending_approval is not None, "ambiguity must not settle an approval"
        assert any("yes or a no" in s for s in tts.spoken), tts.spoken

        await loop._handle("yes go ahead")
        outcome = await asyncio.wait_for(pending, timeout=5)
        assert outcome.decision.value == "allow"
        assert outcome.approved_by == "voice"
        await _stop(worker)
        print("  voice approval needs clarity ... ok")


async def main():
    await test_barge_in_stops_speech()
    await test_partial_transcript_triggers_interrupt()
    await test_voice_approval_requires_clarity()

    # Nothing should still be scheduled once the tests are done. Anything that
    # is would have kept the process alive.
    leftover = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in leftover:
        await _stop(task)
    print(f"\nall voice tests passed (cleaned up {len(leftover)} stray tasks)")


if __name__ == "__main__":
    asyncio.run(main())
