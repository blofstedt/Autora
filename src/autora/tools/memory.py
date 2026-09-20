"""The model's own handle on what it knows.

Deliberately not automatic-only. Distillation at the end of a session catches
the durable shape of what happened, but the agent is the only thing present at
the moment a user says "no, always use pnpm here" -- and a memory system that
cannot take dictation makes the user repeat themselves forever.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from ..events import Kind
from ..memory import KINDS, MemoryStore
from .base import ToolResult


class MemoryTool:
    name = "memory"
    description = (
        "Your long-term memory across sessions. "
        "search: find what you already know (do this before asking the user "
        "something they may have told you before). "
        "read: open one entry by id. "
        "write: record something durable — a preference, a project convention, "
        "a procedure that worked. Not a running commentary: write what will "
        "still be true next week. "
        "supersedes: pass the id of an entry this corrects. "
        "forget: retire an entry that is wrong or no longer applies."
    )
    schema = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["search", "read", "write", "forget", "link"]},
            "query": {"type": "string", "description": "For search."},
            "id": {"type": "string", "description": "For read, forget, link."},
            "to": {"type": "string", "description": "For link: the other entry's id."},
            "kind": {"type": "string", "enum": list(KINDS),
                     "description": "For write. procedure = a repeatable how-to."},
            "title": {"type": "string", "description": "For write. One line, specific."},
            "body": {"type": "string", "description": "For write. The actual content."},
            "tags": {"type": "array", "items": {"type": "string"}},
            "scope": {"type": "string",
                      "description": "'global' for facts about the user, 'project' for "
                                     "things true only of this codebase. Default project."},
            "supersedes": {"type": "string", "description": "id of the entry this replaces."},
        },
        "required": ["action"],
    }

    def __init__(self, store: MemoryStore, scope_for=None):
        self.store = store
        # Injected so the tool does not need to know how a session decides which
        # project it is in.
        self._scope_for = scope_for or (lambda session: "global")

    @staticmethod
    def _announce(session, kind: str, records) -> None:
        """Put a read or a write on the log.

        The UI folds these into the memory web: without them a record the agent
        looked up or wrote leaves no trace anywhere, and the only memory traffic
        the interface could see was end-of-session distillation -- which is the
        rarest kind, so the web sat empty while memory was plainly being used.
        """
        records = [r for r in records if r is not None]
        if not records:
            return
        session.emit(kind, {
            "ids": [r.id for r in records],
            "titles": [r.title for r in records],
            "count": len(records),
        }, actor="system")

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        action = args.get("action")
        scopes = ["global", self._scope_for(session)]

        if action == "search":
            hits = self.store.search(args.get("query", ""), scopes=scopes, limit=12)
            if not hits:
                yield ToolResult("Nothing remembered about that.")
                return
            self.store.touch([h.id for h in hits])
            self._announce(session, Kind.MEMORY_RECALL, hits)
            yield ToolResult("\n\n".join(
                f"[{h.id}] {h.title}  ({h.kind}, {h.status})\n{h.body[:400]}"
                for h in hits))

        elif action == "read":
            record = self.store.get(args.get("id", ""))
            if record is None:
                yield ToolResult(f"No entry {args.get('id')!r}.", ok=False)
                return
            self.store.touch([record.id])
            self._announce(session, Kind.MEMORY_RECALL, [record])
            where = (f"\nRecorded in session {record.source_session}"
                     if record.source_session else "")
            yield ToolResult(
                f"[{record.id}] {record.title}\n"
                f"{record.kind} · {record.status} · {record.scope}"
                f"{' · tags: ' + ' '.join(record.tags) if record.tags else ''}{where}\n\n"
                f"{record.body}")

        elif action == "write":
            title, body = args.get("title"), args.get("body")
            if not title or not body:
                yield ToolResult("write needs a title and a body.", ok=False)
                return
            scope = ("global" if args.get("scope") == "global"
                     else self._scope_for(session))
            record = self.store.write(
                kind=args.get("kind") or "fact",
                title=title, body=body, scope=scope,
                tags=args.get("tags") or [],
                source_session=getattr(session, "id", None),
                source_seq=getattr(session.store, "count", None),
                supersedes=args.get("supersedes") or None,
            )
            self._announce(session, Kind.MEMORY_WRITE, [record])
            yield ToolResult(
                f"Remembered [{record.id}] {record.title} ({record.status}, {scope})"
                + (f", superseding {args['supersedes']}" if args.get("supersedes") else ""),
                display={"record": record.to_dict()})

        elif action == "forget":
            retired = self.store.get(args.get("id", ""))
            ok = self.store.forget(args.get("id", ""))
            if ok and retired is not None:
                self._announce(session, Kind.MEMORY_WRITE, [retired])
            yield ToolResult(f"Retired {args.get('id')}." if ok
                             else f"No entry {args.get('id')!r}.", ok=ok)

        elif action == "link":
            src, dst = args.get("id"), args.get("to")
            if not src or not dst:
                yield ToolResult("link needs both `id` and `to`.", ok=False)
                return
            self.store.link(src, dst)
            yield ToolResult(f"Linked {src} → {dst}.")

        else:
            yield ToolResult(f"Unknown memory action {action!r}.", ok=False)
