"""Composing the model's context from the event log.

The UI folds the log into something a human can watch (`derive` in the web
client). This is the same move for the other reader: fold the log into the
messages the model sees. One log, two projections, no third source of truth.

That matters beyond tidiness. The agent used to build its history imperatively
alongside the log -- two writes per step, two structures that could disagree,
and no way to ask "what was actually in context at step 12". Here the context is
a pure function of the log prefix, so that question has an answer, and replay
can show it.

The savings come from one observation: a tool result is enormous exactly once.
While the agent is acting on a 4000-line pytest run it needs every line; ten
steps later it needs to remember that the run failed and where. So old results
are demoted to their preview plus a pointer, and the full text stays in the blob
store where `recall` can fetch it back. Lossy in context, lossless on disk.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .events import Event, Kind

#: Rough chars-per-token. Only used to decide *when* to compact, so being off by
#: 20% moves the trigger point and nothing else. Counting properly would mean a
#: tokenizer per provider, which is a lot of machinery for a threshold.
CHARS_PER_TOKEN = 4


@dataclass
class ContextPolicy:
    """When to compact, and how hard.

    `trigger_tokens` is a high-water mark, not a budget: nothing is demoted
    until the context crosses it. That is deliberate. Demotion rewrites history,
    and rewritten history invalidates the provider's prefix cache from the
    rewrite point onward -- so compacting a little on every step would forfeit
    the caching that makes the loop cheap in the first place. Compact rarely, in
    batches, and let the prefix stay append-only in between.
    """

    trigger_tokens: int = 60_000
    #: Tool results to leave untouched when compacting. The agent is usually
    #: still working with the last couple.
    keep_recent: int = 4
    #: What a demoted result shrinks to.
    preview_chars: int = 400
    #: A single result larger than this is elided in the middle even while it is
    #: still "recent" -- one runaway command should not fill the window on its own.
    max_result_chars: int = 20_000


@dataclass
class ContextState:
    """Which results have already been demoted.

    A set that only grows, so a demoted result never silently comes back and the
    bytes the model saw at step N are still the bytes it sees at step N+1. That
    stability is what keeps the cached prefix valid between compactions.
    """

    demoted: set[int] = field(default_factory=set)


def compose(
    events: Iterable[Event],
    blobs,
    policy: ContextPolicy | None = None,
    state: ContextState | None = None,
) -> list[dict[str, Any]]:
    """Fold a log prefix into provider-neutral messages."""
    policy = policy or ContextPolicy()
    state = state or ContextState()

    messages: list[dict[str, Any]] = []
    # Text deltas coalesce into the open assistant turn; a tool call closes it,
    # because the sentences either side of a tool ran are separate thoughts.
    open_assistant: dict[str, Any] | None = None
    # span id -> the tool_use id the provider gave us, so a result can be
    # matched to its call without the agent carrying a side table.
    call_ids: dict[str, str] = {}

    for event in events:
        kind = event.kind
        payload = event.payload

        if kind == Kind.USER_MESSAGE:
            messages.append({"role": "user", "content": payload.get("text", "")})
            open_assistant = None

        elif kind in (Kind.CONTEXT_NOTE, Kind.MEMORY_RECALL):
            # Recalled memory enters context as an ordinary turn so it is folded,
            # cached and compacted by exactly the same rules as everything else.
            text = payload.get("text", "")
            if text:
                messages.append({"role": "user", "content": text})
                open_assistant = None

        elif kind == Kind.AGENT_TEXT:
            if open_assistant is None:
                open_assistant = {"role": "assistant", "content": ""}
                messages.append(open_assistant)
            open_assistant["content"] += payload.get("text", "")

        elif kind == Kind.AGENT_THINKING:
            # Reasoning is folded back in because some providers require it
            # back: a model that thinks, calls a tool, and is then handed its
            # own tool_calls with the thinking stripped out is being shown a
            # turn it did not take. DeepSeek rejects that outright ("the
            # reasoning_content in the thinking mode must be passed back"), and
            # every adapter that does not want it simply drops the key.
            if open_assistant is None:
                open_assistant = {"role": "assistant", "content": ""}
                messages.append(open_assistant)
            open_assistant["reasoning"] = (
                open_assistant.get("reasoning", "") + payload.get("text", "")
            )

        elif kind == Kind.TOOL_CALL:
            call_id = payload.get("call_id") or event.span or ""
            if event.span:
                call_ids[event.span] = call_id
            if open_assistant is None:
                open_assistant = {"role": "assistant", "content": ""}
                messages.append(open_assistant)
            open_assistant.setdefault("tool_calls", []).append({
                "id": call_id,
                "name": payload.get("name", "tool"),
                "args": payload.get("args", {}),
            })

        elif kind in (Kind.TOOL_RESULT, Kind.TOOL_ERROR):
            # The model-facing text is in the blob; the payload holds only what
            # the UI needs. A missing blob means an old log written before this
            # existed, so fall back to the preview rather than dropping the turn.
            content = _blob_text(blobs, event.blob)
            if content is None:
                content = payload.get("preview") or payload.get("error") or "(no output)"
            messages.append({
                "role": "tool",
                "tool_call_id": call_ids.get(event.span or "", event.span or ""),
                "content": content,
                "ok": bool(payload.get("ok", kind == Kind.TOOL_RESULT)),
                "seq": event.seq,
            })
            open_assistant = None

        elif kind == Kind.AGENT_DONE:
            open_assistant = None

    _compact(messages, policy, state)
    return messages


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """Cheap size estimate, for deciding when to compact."""
    total = 0
    for message in messages:
        total += len(message.get("content") or "")
        total += len(message.get("reasoning") or "")
        for call in message.get("tool_calls", ()):
            total += len(str(call.get("args", "")))
    return total // CHARS_PER_TOKEN


def _compact(
    messages: list[dict[str, Any]], policy: ContextPolicy, state: ContextState
) -> None:
    """Demote old tool results in place, in batches, when the window gets full."""
    tool_indexes = [i for i, m in enumerate(messages) if m["role"] == "tool"]

    # Anything demoted on an earlier pass stays demoted, whatever the size now:
    # un-demoting would rewrite the prefix a second time and cost another cache
    # rebuild to recover bytes the model has already moved on from.
    for i in tool_indexes:
        if messages[i].get("seq") in state.demoted:
            _demote(messages[i], policy)

    # One result can be oversized on its own; that is elision, not compaction,
    # and it applies whether or not the window is under pressure.
    for i in tool_indexes:
        _elide_oversized(messages[i], policy)

    if estimate_tokens(messages) <= policy.trigger_tokens:
        return

    # Over the mark: demote everything except the most recent few, in one batch.
    for i in tool_indexes[: max(len(tool_indexes) - policy.keep_recent, 0)]:
        seq = messages[i].get("seq")
        if seq is not None:
            state.demoted.add(seq)
        _demote(messages[i], policy)


def _demote(message: dict[str, Any], policy: ContextPolicy) -> None:
    if message.get("demoted"):
        return
    content = message.get("content") or ""
    seq = message.get("seq")
    head = content[: policy.preview_chars]
    if len(content) > policy.preview_chars:
        head += "…"
    message["content"] = (
        f"{head}\n\n[Output trimmed to save context "
        f"({len(content)} chars). Call recall(ref={seq}) to read it in full.]"
    )
    message["demoted"] = True


def _elide_oversized(message: dict[str, Any], policy: ContextPolicy) -> None:
    content = message.get("content") or ""
    if message.get("demoted") or len(content) <= policy.max_result_chars:
        return
    # Head and tail, not head alone: a failing build puts the command at the top
    # and the error at the bottom, and the middle is the part nobody reads.
    half = policy.max_result_chars // 2
    seq = message.get("seq")
    message["content"] = (
        f"{content[:half]}\n\n[… {len(content) - policy.max_result_chars} chars elided. "
        f"Call recall(ref={seq}) to read it in full …]\n\n{content[-half:]}"
    )


def _blob_text(blobs, digest: str | None) -> str | None:
    if not digest or blobs is None:
        return None
    data = blobs.get(digest)
    if data is None:
        return None
    return data.decode("utf-8", errors="replace")
