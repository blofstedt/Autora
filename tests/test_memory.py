"""Memory: storage, retrieval, the promotion gate, and distillation.

The gate is the part worth testing hardest. A memory system that stores things
is easy; one that does not accumulate confident nonsense is the hard problem,
and the rules that prevent it -- provisional until re-confirmed, nothing learned
from a failed run, every claim traceable -- are exactly the ones that fail
silently if they regress.
"""

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.agent import Agent
from autora.distill import Proposal, commit, parse, session_succeeded, transcript_for
from autora.events import Kind
from autora.memory import MemoryStore, project_scope
from autora.policy import PolicyGate
from autora.providers.base import TextDelta, ToolCallRequest, TurnEnd, Usage
from autora.recall import recall_for
from autora.session import SessionRegistry
from autora.tools.base import ToolRegistry
from autora.tools.memory import MemoryTool


def store_in(tmp) -> MemoryStore:
    return MemoryStore(pathlib.Path(tmp) / "memory.db")


def test_write_search_scope():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        proj = "project:/code/api"
        store.write("preference", "Prefers pnpm", "Use pnpm, never npm.",
                    scope="global", tags=["tooling"])
        store.write("procedure", "Run the API tests",
                    "pytest -x tests/ with DATABASE_URL set to the docker one.",
                    scope=proj, tags=["testing"])
        store.write("fact", "Deploys on Fridays are banned", "Ops rule.",
                    scope="project:/code/other")

        hits = store.search("how do I run tests", scopes=["global", proj])
        assert [h.title for h in hits] == ["Run the API tests"], [h.title for h in hits]

        # A fact about another project must not leak into this one.
        assert not [h for h in store.search("deploy", scopes=["global", proj])]
        print("  scoped write + search .......... ok")


def test_provisional_until_confirmed_twice():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        first = store.write("procedure", "Build the image", "docker build .",
                            scope="global")
        assert first.status == "provisional", first.status

        again = store.write("procedure", "Build the image",
                            "docker build . --platform linux/amd64", scope="global")
        assert again.id == first.id, "a repeat must update, not duplicate"
        assert again.status == "confirmed", again.status
        assert "--platform" in again.body
        assert len(store.all()) == 1
        print("  provisional until re-confirmed . ok")


def test_correction_retires_not_deletes():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        wrong = store.write("fact", "Staging URL", "staging.old.example.com")
        right = store.write("fact", "Staging URL is stage.example.com",
                            "Moved in March.", supersedes=wrong.id)

        stale = store.get(wrong.id)
        assert stale.status == "retired" and stale.superseded_by == right.id
        # Retired records stay out of recall but remain on the record.
        assert wrong.id not in [h.id for h in store.search("staging")]
        assert wrong.id in [r.id for r in store.all(include_retired=True)]
        assert {"src": wrong.id, "dst": right.id, "rel": "superseded-by"} in store.links()
        print("  corrections retire, not erase .. ok")


def test_provenance_is_recorded():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        r = store.write("episode", "Migration broke staging", "Flag must be off first.",
                        source_session="20260919-1", source_seq=412)
        got = store.get(r.id)
        assert got.source_session == "20260919-1" and got.source_seq == 412
        print("  every claim is traceable ...... ok")


def test_recall_budget_and_priority():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        store.write("preference", "Terse replies", "Keep answers short.",
                    scope="global", pinned=True)
        for i in range(40):
            store.write("episode", f"Irrelevant thing {i}", "x" * 400, scope="global",
                        tags=["noise"])
        store.write("procedure", "Deploy the worker",
                    "fly deploy --config worker.toml", scope="global", tags=["deploy"])

        found = recall_for(store, "how do I deploy the worker?", scopes=["global"])
        titles = [r.title for r in found.records]
        assert "Terse replies" in titles, "pinned foundation must always be present"
        assert "Deploy the worker" in titles, titles
        # 42 records exist; only a handful may reach the prompt.
        assert len(found.records) <= 10, len(found.records)
        assert len(found.text) < 5000, len(found.text)
        print(f"  recall stays small ............ ok "
              f"({len(store.all())} stored, {len(found.records)} injected, "
              f"~{len(found.text) // 4} tok)")


def test_nothing_learned_from_a_broken_run():
    class E:
        def __init__(self, kind, payload=None):
            self.kind, self.payload = kind, payload or {}

    assert session_succeeded([E(Kind.AGENT_DONE, {"stop_reason": "end_turn"})])
    assert not session_succeeded([E(Kind.AGENT_DONE, {"stop_reason": "interrupted"})])
    assert not session_succeeded([E(Kind.ERROR, {"error": "boom"}),
                                  E(Kind.AGENT_DONE, {"stop_reason": "end_turn"})])
    assert not session_succeeded([])
    print("  failed runs teach nothing ...... ok")


def test_distill_parsing_and_commit():
    assert parse("not json at all") == []
    assert parse('{"records": [{"kind": "nonsense", "title": "x", "body": "y"}]}') == []
    proposals = parse("""Sure! ```json
    {"records": [
      {"kind": "preference", "title": "Uses pnpm", "body": "Always pnpm.",
       "tags": ["Tooling"], "scope": "global"},
      {"kind": "procedure", "title": "Run tests", "body": "pytest -x", "scope": "project"},
      {"kind": "fact", "title": "", "body": "dropped, no title"}
    ]} ```""")
    assert len(proposals) == 2, proposals
    assert proposals[0].tags == ["tooling"], "tags normalise"

    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        ids = commit(store, proposals, "sess-1", "project:/code/api", last_seq=99)
        assert len(ids) == 2
        assert all(store.get(i).status == "provisional" for i in ids), \
            "auto-written records must never land confirmed"
        assert store.get(ids[0]).scope == "global"
        assert store.get(ids[1]).scope == "project:/code/api"
        # Learned together, so linked together -- this is what makes it a web.
        assert {"src": ids[0], "dst": ids[1], "rel": "same-session"} in store.links()
        print("  distillation parses + gates .... ok")


class ScriptedProvider:
    name, model = "scripted", "scripted-1"

    def __init__(self, turns):
        self.turns, self.calls = list(turns), 0

    async def stream(self, system, messages, tools, max_tokens=8192):
        self.seen = messages
        turn = self.turns[min(self.calls, len(self.turns) - 1)]
        self.calls += 1
        for d in turn:
            await asyncio.sleep(0)
            yield d


async def test_recall_reaches_the_model_and_the_log():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        session = SessionRegistry(pathlib.Path(tmp) / "s").create(
            workdir=pathlib.Path("/code/api"))
        store.write("preference", "Prefers pnpm", "Always pnpm, never npm.",
                    scope="global", pinned=True)

        provider = ScriptedProvider([[TextDelta("ok"), TurnEnd("end_turn", Usage(1, 1, 0))]])
        agent = Agent(session, provider, ToolRegistry(),
                      gate=PolicyGate(auto_approve=True), memory=store)
        await agent.run_turn("install the dependencies")

        # In the log, so a human can see what the agent was primed with...
        recalls = [e for e in session.store.read() if e.kind == Kind.MEMORY_RECALL]
        assert recalls and "pnpm" in recalls[0].payload["text"], recalls
        # ...and in the context, via the same fold as everything else.
        assert any("pnpm" in (m.get("content") or "") for m in provider.seen), provider.seen
        assert store.get(recalls[0].payload["ids"][0]).uses >= 1, "use must be counted"
        print("  recall reaches model + log .... ok")


async def test_memory_tool_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        store = store_in(tmp)
        session = SessionRegistry(pathlib.Path(tmp) / "s").create(
            workdir=pathlib.Path("/code/api"))
        tool = MemoryTool(store, scope_for=lambda s: project_scope(s.workdir))

        async def call(**args):
            last = None
            async for chunk in tool.run(session, args, "span"):
                last = chunk
            return last

        out = await call(action="write", kind="procedure", title="Reset the DB",
                         body="make db-reset, then seed.", tags=["db"])
        assert out.ok and "Remembered" in out.content
        rid = out.display["record"]["id"]
        assert store.get(rid).scope == project_scope(pathlib.Path("/code/api"))
        assert store.get(rid).source_session == session.id, "tool writes carry provenance"

        assert "Reset the DB" in (await call(action="search", query="reset database")).content
        assert "make db-reset" in (await call(action="read", id=rid)).content
        assert (await call(action="forget", id=rid)).ok
        assert store.get(rid).status == "retired"
        assert not (await call(action="read", id="nope")).ok
        print("  memory tool round-trip ........ ok")


async def main():
    for t in (test_write_search_scope, test_provisional_until_confirmed_twice,
              test_correction_retires_not_deletes, test_provenance_is_recorded,
              test_recall_budget_and_priority, test_nothing_learned_from_a_broken_run,
              test_distill_parsing_and_commit):
        t()
    await test_recall_reaches_the_model_and_the_log()
    await test_memory_tool_roundtrip()
    print("\nall memory tests passed")


if __name__ == "__main__":
    asyncio.run(main())
