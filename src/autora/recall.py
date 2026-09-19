"""Choosing what the agent should already know, for this prompt.

The whole cost question lives here. A memory system that pastes everything it
knows into every request has moved the context problem somewhere more
expensive; one that pastes nothing might as well not exist. So the budget is
split in three:

  1. **Foundation** -- a handful of pinned, always-true records. Who the user
     is, how they want things done. A few hundred tokens, every turn.
  2. **Retrieved** -- what the current prompt actually asks about, found by
     search and capped hard.
  3. **Everything else** -- not loaded at all. It is one `memory` search away,
     and the agent is told that it is.

The block is emitted as an event before the turn runs, which means it is in the
transcript, on the timeline, and in the recording. You can see exactly what the
agent was primed with, and so can the agent's next reader -- a memory that
silently steers a session is the thing people are right to distrust.
"""

from __future__ import annotations

from dataclasses import dataclass

from .memory import GLOBAL, MemoryStore, Record

#: Char budgets, converted to tokens at the usual rough 4:1. Deliberately small:
#: this is priming, not briefing. Anything that does not fit was, by
#: construction, less relevant than what did.
FOUNDATION_CHARS = 1_400
RETRIEVED_CHARS = 3_000


@dataclass
class Recalled:
    text: str
    records: list[Record]

    @property
    def ids(self) -> list[str]:
        return [r.id for r in self.records]


def recall_for(
    store: MemoryStore,
    prompt: str,
    scopes: list[str] | None = None,
    limit: int = 8,
) -> Recalled:
    """Build the memory block for one prompt."""
    scopes = scopes or [GLOBAL]

    foundation: list[Record] = []
    used = 0
    for record in store.search("", scopes=scopes, limit=40):
        if not record.pinned:
            continue
        cost = len(record.as_context())
        if used + cost > FOUNDATION_CHARS:
            break
        foundation.append(record)
        used += cost

    chosen = list(foundation)
    seen = {r.id for r in chosen}
    retrieved: list[Record] = []
    used = 0
    for record in store.search(prompt, scopes=scopes, limit=limit * 2):
        if record.id in seen:
            continue
        cost = len(record.as_context())
        if used + cost > RETRIEVED_CHARS or len(retrieved) >= limit:
            break
        retrieved.append(record)
        seen.add(record.id)
        used += cost

    if not chosen and not retrieved:
        return Recalled("", [])

    lines = ["[Memory — what you already know. Each entry has an id you can "
             "pass to memory(action=\"read\"). Search for more with "
             "memory(action=\"search\"); this is a slice, not everything.]"]
    if foundation:
        lines.append("\n## About this user")
        lines += [r.as_context() for r in foundation]
    if retrieved:
        lines.append("\n## Relevant to this task")
        lines += [r.as_context() for r in retrieved]
    lines.append(
        "\n[Provisional entries have not been confirmed twice — trust them less, "
        "and correct them with memory(action=\"write\", supersedes=\"<id>\") if "
        "they turn out wrong.]")

    return Recalled("\n".join(lines), chosen + retrieved)
