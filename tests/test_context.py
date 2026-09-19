"""Context composition, compaction, recall, and cache-breakpoint placement.

The loop tests already prove the fold is faithful -- they assert on
`agent.messages` and were written against the old imperative history. These
cover what is new: that full tool output survives, that compaction is batched
and sticky (so it does not thrash the provider's prefix cache), and that
anything trimmed can be read back.
"""

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.agent import Agent
from autora.context import ContextPolicy, ContextState, compose, estimate_tokens
from autora.events import Kind
from autora.policy import PolicyGate
from autora.providers.anthropic_provider import _mark_tail, _to_anthropic
from autora.providers.base import TextDelta, ToolCallRequest, TurnEnd, Usage
from autora.session import SessionRegistry
from autora.tools.base import ToolRegistry, ToolResult


class EchoTool:
    """Returns output of a requested size, so context growth is controllable."""

    name = "echo"
    description = "echo"
    schema = {"type": "object", "properties": {"size": {"type": "integer"}}}

    async def run(self, session, args, span):
        yield ToolResult("x" * int(args.get("size", 10)), ok=True)


class ScriptedProvider:
    name = "scripted"
    model = "scripted-1"

    def __init__(self, turns):
        self.turns = list(turns)
        self.calls = 0
        self.seen = []

    async def stream(self, system, messages, tools, max_tokens=8192):
        # Keep what the loop actually sent, so a test can assert on context.
        self.seen.append(messages)
        turn = self.turns[min(self.calls, len(self.turns) - 1)]
        self.calls += 1
        for delta in turn:
            await asyncio.sleep(0)
            yield delta


def make(tmp, turns, policy=None):
    reg = SessionRegistry(pathlib.Path(tmp))
    session = reg.create(workdir=pathlib.Path.cwd())
    tools = ToolRegistry()
    tools.register(EchoTool())
    from autora.tools.recall import RecallTool
    tools.register(RecallTool())
    provider = ScriptedProvider(turns)
    agent = Agent(session, provider, tools, gate=PolicyGate(auto_approve=True),
                  context_policy=policy or ContextPolicy())
    return session, agent, provider


async def test_full_output_survives():
    """The model must see the whole result, not the 400-char timeline preview."""
    with tempfile.TemporaryDirectory() as tmp:
        session, agent, _ = make(tmp, [
            [ToolCallRequest("c1", "echo", {"size": 5000}), TurnEnd("tool_use")],
            [TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))],
        ])
        await agent.run_turn("go")
        tool_msg = [m for m in agent.messages if m["role"] == "tool"][0]
        assert len(tool_msg["content"]) == 5000, len(tool_msg["content"])
        result = [e for e in session.store.read() if e.kind == Kind.TOOL_RESULT][0]
        assert len(result.payload["preview"]) == 400, "timeline still gets a preview"
        assert result.payload["bytes"] == 5000
        assert result.blob, "full text must be parked in the blob store"
        print("  full output survives the fold .. ok")


async def test_history_is_append_only_under_threshold():
    """No compaction below the mark -- the cached prefix must stay byte-stable."""
    with tempfile.TemporaryDirectory() as tmp:
        session, agent, provider = make(tmp, [
            [ToolCallRequest("c1", "echo", {"size": 200}), TurnEnd("tool_use")],
            [ToolCallRequest("c2", "echo", {"size": 200}), TurnEnd("tool_use")],
            [TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))],
        ], policy=ContextPolicy(trigger_tokens=100_000))
        await agent.run_turn("go")
        first, second = provider.seen[0], provider.seen[1]
        assert second[: len(first)] == first, "earlier turns were rewritten"
        assert not agent.context_state.demoted
        print("  append-only under threshold ... ok")


async def test_compaction_is_batched_and_sticky():
    with tempfile.TemporaryDirectory() as tmp:
        turns = [[ToolCallRequest(f"c{i}", "echo", {"size": 4000}), TurnEnd("tool_use")]
                 for i in range(8)]
        turns.append([TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))])
        session, agent, _ = make(tmp, turns,
                                 policy=ContextPolicy(trigger_tokens=2_000, keep_recent=2))
        await agent.run_turn("go")

        tools = [m for m in agent.messages if m["role"] == "tool"]
        demoted = [m for m in tools if m.get("demoted")]
        assert len(tools) == 8, len(tools)
        assert len(demoted) == 6, f"expected all but keep_recent demoted, got {len(demoted)}"
        assert all("recall(ref=" in m["content"] for m in demoted)
        assert all(len(m["content"]) == 4000 for m in tools if not m.get("demoted"))

        # Sticky: folding again must produce identical bytes, or the prefix the
        # provider cached would change underneath it.
        again = [m["content"] for m in agent.messages if m["role"] == "tool"]
        assert again == [m["content"] for m in tools], "demotion is not stable"
        print("  compaction batched + sticky ... ok")


async def test_compaction_actually_saves():
    with tempfile.TemporaryDirectory() as tmp:
        turns = [[ToolCallRequest(f"c{i}", "echo", {"size": 4000}), TurnEnd("tool_use")]
                 for i in range(10)]
        turns.append([TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))])
        session, agent, _ = make(tmp, turns,
                                 policy=ContextPolicy(trigger_tokens=2_000, keep_recent=2))
        await agent.run_turn("go")
        events = list(session.store.read())
        uncompacted = estimate_tokens(compose(events, session.store.blobs,
                                              ContextPolicy(trigger_tokens=10**9),
                                              ContextState()))
        compacted = estimate_tokens(agent.messages)
        assert compacted < uncompacted / 2, (compacted, uncompacted)
        print(f"  compaction saves .............. ok ({uncompacted} -> {compacted} tok)")


async def test_recall_reads_trimmed_output_back():
    with tempfile.TemporaryDirectory() as tmp:
        turns = [[ToolCallRequest(f"c{i}", "echo", {"size": 4000}), TurnEnd("tool_use")]
                 for i in range(6)]
        turns.append([TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))])
        session, agent, _ = make(tmp, turns,
                                 policy=ContextPolicy(trigger_tokens=1_000, keep_recent=1))
        await agent.run_turn("go")

        trimmed = [m for m in agent.messages if m.get("demoted")][0]
        ref = int(trimmed["content"].split("recall(ref=")[1].split(")")[0])

        from autora.tools.recall import RecallTool
        out = None
        async for chunk in RecallTool().run(session, {"ref": ref}, "s"):
            out = chunk
        assert out.ok and len(out.content) == 4000, (out.ok, len(out.content))

        missing = None
        async for chunk in RecallTool().run(session, {"ref": 99999}, "s"):
            missing = chunk
        assert not missing.ok and "No event" in missing.content
        print("  recall restores trimmed output . ok")


async def test_recall_search_greps():
    with tempfile.TemporaryDirectory() as tmp:
        reg = SessionRegistry(pathlib.Path(tmp))
        session = reg.create(workdir=pathlib.Path.cwd())
        body = "\n".join(f"line {i}" for i in range(400) if i != 7) + "\nNEEDLE here\n"
        event = session.emit(Kind.TOOL_RESULT, {"ok": True}, blob=body.encode())

        from autora.tools.recall import RecallTool
        out = None
        async for chunk in RecallTool().run(session, {"ref": event.seq, "search": "NEEDLE"}, "s"):
            out = chunk
        assert "NEEDLE here" in out.content
        assert len(out.content) < len(body) / 10, "search must narrow, not dump"
        print("  recall search narrows ......... ok")


async def test_oversized_single_result_is_elided():
    with tempfile.TemporaryDirectory() as tmp:
        session, agent, _ = make(tmp, [
            [ToolCallRequest("c1", "echo", {"size": 50_000}), TurnEnd("tool_use")],
            [TextDelta("done"), TurnEnd("end_turn", Usage(1, 1, 0))],
        ], policy=ContextPolicy(trigger_tokens=10**9, max_result_chars=10_000))
        await agent.run_turn("go")
        tool_msg = [m for m in agent.messages if m["role"] == "tool"][0]
        assert "elided" in tool_msg["content"]
        assert len(tool_msg["content"]) < 11_000, len(tool_msg["content"])
        print("  oversized result elided ....... ok")


async def test_notes_are_logged_not_invented():
    """An interruption note the model sees must exist in the record."""
    with tempfile.TemporaryDirectory() as tmp:
        session, agent, _ = make(tmp, [
            [ToolCallRequest("c", "echo", {"size": 10}), TurnEnd("tool_use")],
        ])
        agent.max_iterations = 2
        await agent.run_turn("loop")
        notes = [e for e in session.store.read() if e.kind == Kind.CONTEXT_NOTE]
        assert notes, "the cap note was injected into context but never logged"
        assert agent.messages[-1]["content"] == notes[-1].payload["text"]
        print("  injected notes are on record .. ok")


def test_cache_breakpoint_placement():
    """Exactly one breakpoint, on the last block, whatever shape it is."""
    def marks(blocks):
        found = []
        for message in blocks:
            content = message["content"]
            if isinstance(content, list):
                found += [b for b in content if "cache_control" in b]
        return found

    tail_is_text = _mark_tail(_to_anthropic([
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "again"},
    ]))
    assert len(marks(tail_is_text)) == 1
    assert tail_is_text[-1]["content"][0]["text"] == "again"

    tail_is_tool_result = _mark_tail(_to_anthropic([
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "name": "echo", "args": {}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "out", "ok": True},
    ]))
    found = marks(tail_is_tool_result)
    assert len(found) == 1 and found[0]["type"] == "tool_result", found

    # Degenerate inputs must not produce an invalid empty cache target.
    assert _mark_tail([]) == []
    assert not marks(_mark_tail([{"role": "user", "content": ""}]))
    print("  cache breakpoint placement .... ok")


async def main():
    for test in (test_full_output_survives, test_history_is_append_only_under_threshold,
                 test_compaction_is_batched_and_sticky, test_compaction_actually_saves,
                 test_recall_reads_trimmed_output_back, test_recall_search_greps,
                 test_oversized_single_result_is_elided, test_notes_are_logged_not_invented):
        await test()
    test_cache_breakpoint_placement()
    print("\nall context tests passed")


if __name__ == "__main__":
    asyncio.run(main())
