"""Turning a finished session into things worth keeping.

An agent that remembers everything it did remembers nothing useful. What
survives a session is narrower than the transcript: the conventions of this
project, the preferences the user stated, and the procedure that actually
worked -- which is what a "skill" is, once you stop capitalising it.

The gate matters more than the extraction. An auto-written procedure that
nothing has re-validated is a guess, and a guess the agent follows confidently
is worse than having no memory at all: it is a confident wrong instruction with
the authority of experience behind it. So:

  * Nothing is distilled from a session that failed or was interrupted. A
    procedure learned from a broken run teaches the break.
  * Everything lands `provisional`. It is promoted to `confirmed` only when a
    later session writes the same title again -- the second success is the
    evidence, not the first.
  * Every record carries the session and event that produced it, so any claim
    can be traced back to the run that made it and deleted if that run was wrong.

The extraction itself is an LLM call, because deciding what mattered is a
judgement. `propose()` is separated from `commit()` so the judgement can be
tested, reviewed, or replaced without touching the gate.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterable

from .events import Kind
from .memory import KINDS, MemoryStore

PROMPT = """You are reviewing a finished agent session to decide what is worth
remembering for next time. Most sessions yield nothing. That is a normal answer.

Record only what will still be true in a month:
- preference: how this user wants things done, stated by them, not inferred
  from one instance.
- procedure: a sequence that worked and would work again in this project --
  the commands, the order, the gotcha. Write it so it can be followed.
- fact: something durable about the user, their stack, or their project.
- episode: a notable outcome worth recalling ("the v2 migration needs the
  feature flag off first, we broke staging otherwise").

Do NOT record: what happened step by step, anything you are unsure of, anything
specific to one run (timestamps, one-off ids), or restatements of the task.

Return JSON only:
{"records": [{"kind": "...", "title": "one specific line", "body": "...",
              "tags": ["..."], "scope": "global" | "project"}]}
An empty list is a good answer when nothing durable happened."""


@dataclass
class Proposal:
    kind: str
    title: str
    body: str
    tags: list[str]
    scope: str

    def valid(self) -> bool:
        return (self.kind in KINDS and bool(self.title.strip())
                and bool(self.body.strip()) and len(self.title) <= 200)


def session_succeeded(events: Iterable[Any]) -> bool:
    """Did this session end in a state worth learning from?

    Interrupted and errored sessions are excluded: whatever the agent was doing
    when the human cut in is, by definition, not the thing that worked.
    """
    saw_done = False
    for event in events:
        if event.kind == Kind.AGENT_DONE:
            reason = event.payload.get("stop_reason")
            if reason == "interrupted":
                return False
            saw_done = saw_done or reason == "end_turn"
        elif event.kind == Kind.ERROR:
            return False
    return saw_done


def transcript_for(events: Iterable[Any], limit: int = 12_000) -> str:
    """A compact retelling, as input to the judgement."""
    lines: list[str] = []
    for event in events:
        payload = event.payload
        if event.kind == Kind.USER_MESSAGE:
            lines.append(f"USER: {payload.get('text', '')}")
        elif event.kind == Kind.TOOL_CALL:
            args = payload.get("args", {})
            detail = args.get("command") or args.get("path") or args.get("action") or ""
            lines.append(f"TOOL {payload.get('name')}: {str(detail)[:200]}")
        elif event.kind == Kind.TOOL_ERROR:
            lines.append(f"  failed: {str(payload.get('error', ''))[:160]}")
        elif event.kind == Kind.TOOL_RESULT:
            lines.append(f"  -> {str(payload.get('preview', ''))[:160]}")
        elif event.kind == Kind.FILE_EDIT:
            lines.append(f"EDIT {payload.get('path')} +{payload.get('added')} "
                         f"-{payload.get('removed')}")
    text = "\n".join(lines)
    # The end of a session is where the outcome is; keep the tail if it is long.
    return text[-limit:]


def parse(raw: str) -> list[Proposal]:
    """Read the model's answer, tolerating the fences it sometimes adds."""
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    out = []
    for item in data.get("records", []) or []:
        if not isinstance(item, dict):
            continue
        proposal = Proposal(
            kind=str(item.get("kind", "")).strip(),
            title=str(item.get("title", "")).strip(),
            body=str(item.get("body", "")).strip(),
            tags=[str(t).lower() for t in (item.get("tags") or []) if str(t).strip()],
            scope="global" if item.get("scope") == "global" else "project",
        )
        if proposal.valid():
            out.append(proposal)
    return out


def commit(
    store: MemoryStore,
    proposals: Iterable[Proposal],
    session_id: str,
    project: str,
    last_seq: int | None = None,
) -> list[str]:
    """Write proposals through the gate. Returns the ids that landed."""
    written = []
    for proposal in proposals:
        record = store.write(
            kind=proposal.kind, title=proposal.title, body=proposal.body,
            scope="global" if proposal.scope == "global" else project,
            tags=proposal.tags,
            # Always provisional from here. `write` promotes to confirmed only
            # when the same title arrives a second time, which is the point.
            status="provisional",
            source_session=session_id, source_seq=last_seq,
        )
        written.append(record.id)
    # Everything learned in one session is related by construction; the links
    # are what make the knowledge view a web rather than a list.
    for i, src in enumerate(written):
        for dst in written[i + 1:]:
            store.link(src, dst, "same-session")
    return written


async def distill(
    provider,
    store: MemoryStore,
    session,
    project: str,
    max_tokens: int = 1500,
) -> list[str]:
    """Review a finished session and record what is worth keeping."""
    events = list(session.store.read())
    if not session_succeeded(events):
        return []
    transcript = transcript_for(events)
    if len(transcript) < 200:
        return []

    chunks: list[str] = []
    async for delta in provider.stream(
        system=PROMPT,
        messages=[{"role": "user", "content": transcript}],
        tools=[],
        max_tokens=max_tokens,
    ):
        text = getattr(delta, "text", None)
        if text and type(delta).__name__ == "TextDelta":
            chunks.append(text)

    proposals = parse("".join(chunks))
    last_seq = events[-1].seq if events else None
    ids = commit(store, proposals, getattr(session, "id", ""), project, last_seq)
    if ids:
        session.emit(Kind.MEMORY_WRITE, {
            "ids": ids, "count": len(ids),
            "titles": [p.title for p in proposals],
        }, actor="system")
    return ids
