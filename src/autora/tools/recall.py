"""Read a trimmed tool result back in full.

The context composer demotes old tool output to a preview plus a pointer. That
is only acceptable because the full text is still on disk, one call away -- the
model loses it from working memory, not from the record. Without this tool the
demotion would just be forgetting.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from .base import ToolResult

#: A recalled result is pulled back into context, so it gets the same ceiling a
#: fresh one would. Recalling a 2MB log should not undo the compaction that
#: trimmed it.
MAX_RECALL_CHARS = 40_000


class RecallTool:
    name = "recall"
    description = (
        "Read the full output of an earlier tool call that was trimmed from the "
        "conversation. Pass the ref shown in the trimmed message. Use this when "
        "you need a detail from earlier output -- do not re-run the command."
    )
    schema = {
        "type": "object",
        "properties": {
            "ref": {
                "type": "integer",
                "description": "The ref from the trimmed message, e.g. recall(ref=412).",
            },
            "search": {
                "type": "string",
                "description": (
                    "Optional. Return only lines containing this substring, with "
                    "surrounding context. Prefer it on very large output."
                ),
            },
        },
        "required": ["ref"],
    }

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        ref = args.get("ref")
        try:
            ref = int(ref)
        except (TypeError, ValueError):
            yield ToolResult(f"recall needs an integer ref, got {args.get('ref')!r}", ok=False)
            return

        event = next((e for e in session.store.read() if e.seq == ref), None)
        if event is None:
            yield ToolResult(f"No event {ref} in this session.", ok=False)
            return
        if not event.blob:
            yield ToolResult(
                f"Event {ref} ({event.kind}) carries no stored output. Only tool "
                f"results can be recalled.", ok=False)
            return

        data = session.store.blobs.get(event.blob)
        if data is None:
            yield ToolResult(f"The stored output for {ref} is missing from the blob store.",
                             ok=False)
            return

        text = data.decode("utf-8", errors="replace")
        search = args.get("search")
        if search:
            text = _grep(text, search)
            if not text:
                yield ToolResult(f"No line in {ref} contains {search!r}.", ok=True)
                return

        truncated = len(text) > MAX_RECALL_CHARS
        if truncated:
            text = text[:MAX_RECALL_CHARS] + "\n[… recall truncated; narrow it with `search` …]"
        yield ToolResult(text, ok=True, display={"ref": ref, "truncated": truncated})


def _grep(text: str, needle: str, context: int = 2) -> str:
    lines = text.splitlines()
    keep: set[int] = set()
    for i, line in enumerate(lines):
        if needle in line:
            keep.update(range(max(i - context, 0), min(i + context + 1, len(lines))))
    if not keep:
        return ""
    # Gaps are marked so the model never reads two distant hits as adjacent.
    out: list[str] = []
    previous = None
    for i in sorted(keep):
        if previous is not None and i > previous + 1:
            out.append("…")
        out.append(lines[i])
        previous = i
    return "\n".join(out)
