"""The agent loop.

One loop, not two. Gemini's blueprint runs Open Interpreter for shell work and
Browser Use for web work, which means two agent loops with two conversation
histories, two tool vocabularies and no shared event stream. The moment a task
spans both -- "check why the deploy broke, then look at the staging site" -- you
have no single timeline, no coherent transcript, and nothing to replay.

Here every capability is a tool in one registry, driven by one loop, emitting to
one log. The composition problem disappears.

Cancellation is a first-class concern rather than an afterthought, because voice
needs it: when you start talking over the agent, the turn must stop promptly,
mid-tool if necessary, and leave a clean record of having been interrupted.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from .context import ContextPolicy, ContextState, compose, estimate_tokens
from .events import Kind
from .memory import GLOBAL, MemoryStore, project_scope
from .policy import Decision, PolicyGate, _redact
from .providers.base import (
    LLMProvider, TextDelta, ThinkingDelta, ToolCallRequest, TurnEnd,
)
from .tools.base import ToolRegistry, ToolResult

DEFAULT_SYSTEM = """You are Autora, a development agent that works out loud.

Everything you do is streamed to a human watching in real time and recorded for
review. That shapes how you work:

- Say what you are about to do in one short sentence before you do it. Not a
  plan document -- a sentence. The human is watching, not reading.
- Prefer many small visible steps over one opaque mega-step. A 40-line bash
  pipeline that works is worse than four commands someone can follow.
- When something fails, say what you actually think went wrong before you retry.
  Silent retries look identical to being stuck.
- Never print secrets, tokens, or private keys. They end up in the recording.
- Read before you write. Inspect a file before editing it, read a page before
  clicking it.

Some actions pause for human approval. That is normal, not an error. If an action
is denied, do not retry it -- explain what you would need instead."""

#: Iteration cap per turn. A loop that has taken 40 tool calls without finishing
#: is almost always stuck in a retry cycle, and letting it run burns money and
#: fills the recording with noise.
MAX_ITERATIONS = 40


class Interrupted(Exception):
    """Raised inside the loop when the human takes the floor."""


class Agent:
    def __init__(
        self,
        session,
        provider: LLMProvider,
        registry: ToolRegistry,
        gate: PolicyGate | None = None,
        system: str = DEFAULT_SYSTEM,
        max_iterations: int = MAX_ITERATIONS,
        context_policy: ContextPolicy | None = None,
        memory: MemoryStore | None = None,
    ):
        self.session = session
        self.provider = provider
        self.registry = registry
        self.gate = gate or PolicyGate()
        self.system = system
        self.max_iterations = max_iterations
        self.context_policy = context_policy or ContextPolicy()
        self.context_state = ContextState()
        self.memory = memory
        self._cancel = asyncio.Event()
        self._running = False

    @property
    def messages(self) -> list[dict[str, Any]]:
        """What the model sees, folded fresh from the log.

        A property rather than a field: the history used to be built up
        imperatively beside the log, which made the log a copy of the truth
        rather than the truth. Folding on demand costs a pass over the events
        and buys one source of truth, an auditable answer to "what was in
        context at step N", and somewhere for the compaction policy to live.
        """
        return compose(
            self.session.store.read(),
            self.session.store.blobs,
            self.context_policy,
            self.context_state,
        )

    # -- control ---------------------------------------------------------

    def interrupt(self) -> bool:
        """Request that the current turn stop. Safe to call from anywhere."""
        if not self._running:
            return False
        self._cancel.set()
        return True

    @property
    def busy(self) -> bool:
        return self._running

    def _check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise Interrupted()

    async def _cancellable(self, awaitable):
        """Await something, aborting it promptly if the human interrupts.

        Polling a cancel flag between iterations is not enough: a tool blocked in
        `process.wait()` or a provider waiting on a first token yields nothing to
        poll between, so an interrupt would not land until the operation finished
        on its own -- which for `sleep 30` means barge-in takes 30 seconds.

        Racing the work against the cancel event and actively cancelling the task
        propagates CancelledError into the tool, which is what lets it kill its
        child process on the way out.
        """
        task = asyncio.ensure_future(awaitable)
        waiter = asyncio.ensure_future(self._cancel.wait())
        try:
            done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            waiter.cancel()
        if task in done:
            return task.result()
        task.cancel()
        # Wait for the cancellation to actually take effect so that cleanup
        # (killing a process group, closing a browser) completes before we
        # report the turn as interrupted.
        await asyncio.gather(task, return_exceptions=True)
        raise Interrupted()

    # -- main loop -------------------------------------------------------

    async def run_turn(self, user_text: str) -> str:
        """Run one user turn to completion. Returns the final assistant text."""
        self._cancel.clear()
        self._running = True
        self.session.emit(Kind.USER_MESSAGE, {"text": user_text}, actor="user")
        self._recall(user_text)

        final_text = ""
        try:
            for iteration in range(self.max_iterations):
                self._check_cancelled()
                text, thinking, calls, stop = await self._stream_once()
                final_text = text or final_text

                # Nothing to record here: the assistant turn is already in the
                # log as streamed AGENT_TEXT deltas, and each tool call lands as
                # a TOOL_CALL event when it is invoked below. An interruption
                # mid-tool therefore still leaves a well-formed history, because
                # the history is whatever was durably logged.
                if not calls:
                    self.session.emit(Kind.AGENT_DONE, {
                        "stop_reason": stop, "iterations": iteration + 1,
                    }, actor="agent")
                    return final_text

                for call in calls:
                    self._check_cancelled()
                    await self._invoke(call)
            else:
                note = (
                    f"Stopped after {self.max_iterations} steps without finishing. "
                    f"This usually means a retry loop -- look at the timeline."
                )
                self.session.emit(Kind.ERROR, {"error": note}, actor="system")
                self._note(note)
                return note

        except Interrupted:
            self.session.emit(Kind.AGENT_DONE, {
                "stop_reason": "interrupted", "text": final_text,
            }, actor="agent")
            # Leave history consistent: the model must see that it was cut off,
            # or the next turn continues as though nothing happened.
            self._note("[The human interrupted you. Stop what you were doing and listen.]")
            return final_text
        finally:
            self._running = False
            self.session.checkpoint()

        return final_text

    @property
    def scopes(self) -> list[str]:
        """Global facts plus this project's. `pytest -x` is true of one repo."""
        return [GLOBAL, project_scope(self.session.workdir)]

    def _recall(self, prompt: str) -> None:
        """Prime the turn with what is already known about this prompt.

        Emitted rather than quietly prepended: the block is on the timeline, in
        the transcript and in the recording, so you can see what the agent was
        told before it answered. It reaches the model through the same fold as
        everything else, which means it is cached and compacted by the same
        rules and needs no special case anywhere downstream.
        """
        if self.memory is None:
            return
        from .recall import recall_for

        found = recall_for(self.memory, prompt, scopes=self.scopes)
        if not found.text:
            return
        self.memory.touch(found.ids)
        self.session.emit(Kind.MEMORY_RECALL, {
            "text": found.text,
            "ids": found.ids,
            "titles": [r.title for r in found.records],
        }, actor="system")

    def _note(self, text: str) -> None:
        """Say something to the model, on the record.

        Anything injected into the context is logged, so the transcript shows
        what the model was actually told -- and so the context can be rebuilt
        from the log without the harness remembering anything on the side.
        """
        self.session.emit(Kind.CONTEXT_NOTE, {"text": text}, actor="system")

    async def _stream_once(self) -> tuple[str, str, list[ToolCallRequest], str]:
        """One provider round-trip, streamed into the event log as it arrives."""
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        calls: list[ToolCallRequest] = []
        stop_reason = "end_turn"

        # Folding here rather than at each call site means the compaction policy
        # runs exactly once per request, against the whole log prefix.
        before = set(self.context_state.demoted)
        messages = self.messages
        if self.context_state.demoted != before:
            self.session.emit(Kind.LOG, {
                "event": "context.compacted",
                "demoted": len(self.context_state.demoted),
                "approx_tokens": estimate_tokens(messages),
            }, actor="system")

        try:
            stream = self.provider.stream(
                system=self.system,
                messages=messages,
                tools=self.registry.specs(),
            ).__aiter__()
            while True:
                try:
                    delta = await self._cancellable(stream.__anext__())
                except StopAsyncIteration:
                    break
                if isinstance(delta, TextDelta):
                    text_parts.append(delta.text)
                    self.session.emit(Kind.AGENT_TEXT, {"text": delta.text}, actor="agent")
                elif isinstance(delta, ThinkingDelta):
                    thinking_parts.append(delta.text)
                    self.session.emit(Kind.AGENT_THINKING, {"text": delta.text}, actor="agent")
                elif isinstance(delta, ToolCallRequest):
                    calls.append(delta)
                elif isinstance(delta, TurnEnd):
                    stop_reason = delta.stop_reason
                    if delta.usage.input_tokens or delta.usage.output_tokens:
                        self.session.emit(Kind.LOG, {
                            "usage": {
                                "in": delta.usage.input_tokens,
                                "out": delta.usage.output_tokens,
                                "cached": delta.usage.cache_read_tokens,
                            },
                            "model": self.provider.model,
                        }, actor="system")
        except Interrupted:
            raise
        except Exception as exc:
            # A provider failure is a visible event, not a traceback on stderr
            # that the person watching the UI never sees.
            self.session.emit(Kind.ERROR, {
                "error": describe_exception(exc), "where": "provider",
                "model": self.provider.model,
                "endpoint": getattr(self.provider, "base_url", None),
            }, actor="system")
            raise

        return "".join(text_parts), "".join(thinking_parts), calls, stop_reason

    async def _invoke(self, call: ToolCallRequest) -> ToolResult:
        """Authorize, run, and record one tool call."""
        tool = self.registry.get(call.name)
        # Every path below opens a span and closes it with the exact text the
        # model will read, stored as the closing event's blob. That is what lets
        # the context be rebuilt from the log: a tool call that returned nothing
        # to the record would be a hole in the history. It also means an unknown
        # tool now shows up on the timeline instead of failing invisibly.
        span = self.session.open_span(
            call.name, Kind.TOOL_CALL,
            # Redact before the args reach the log. The tool still receives the
            # real values -- redaction is for the record, not the execution.
            {"args": _redact(call.args), "call_id": call.id},
            actor="agent",
        )

        if tool is None:
            available = ", ".join(t.name for t in self.registry)
            return self._fail(span, f"No such tool {call.name!r}. Available: {available}",
                              {"error": "unknown tool"})

        outcome = await self.gate.authorize(self.session, call.name, call.args)
        if outcome.decision is Decision.DENY:
            return self._fail(
                span,
                f"Not permitted: {outcome.reason} Do not retry this; choose a "
                f"different approach or ask the human.",
                {"denied": True, "reason": outcome.reason},
            )

        result = ToolResult("(tool produced no result)", ok=False)

        async def drain() -> ToolResult:
            last = ToolResult("(tool produced no result)", ok=False)
            async for chunk in tool.run(self.session, call.args, span):
                last = chunk
            return last

        try:
            result = await self._cancellable(drain())
        except Interrupted:
            self._fail(span, "[interrupted by the human before this finished]",
                       {"error": "interrupted by human"})
            raise
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            return self._fail(span, f"{call.name} raised {error}", {"error": error})

        content = result.content or "(tool produced no result)"
        self.session.close_span(span, Kind.TOOL_RESULT, {
            "ok": result.ok,
            # The payload keeps a preview for the timeline; the full text goes in
            # the blob, which is what `recall` reads and what the composer folds
            # back into context. Content-addressed, so a command run twice costs
            # one copy and a 200KB build log never lands in the JSONL.
            "preview": content[:400],
            "bytes": len(content),
            "display": result.display,
        }, actor=f"tool:{call.name}", blob=content.encode("utf-8"))
        return result

    def _fail(self, span: str, message: str, payload: dict[str, Any]) -> ToolResult:
        """Close a span with the failure text the model will read."""
        self.session.close_span(
            span, Kind.TOOL_ERROR, {**payload, "preview": message[:400], "ok": False},
            actor="system", blob=message.encode("utf-8"),
        )
        return ToolResult(message, ok=False)


def build_registry(
    headless: bool = True,
    chrome_path: str | None = None,
    profile_dir: str | None = None,
    relay=None,
    memory: MemoryStore | None = None,
) -> ToolRegistry:
    """The default toolset."""
    from .tools.browser import BrowserTool
    from .tools.desktop import DesktopTool
    from .tools.files import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
    from .tools.memory import MemoryTool
    from .tools.recall import RecallTool
    from .tools.terminal import TerminalTool

    registry = ToolRegistry()
    for tool in (
        TerminalTool(),
        ReadFileTool(), WriteFileTool(), EditFileTool(), ListDirTool(),
        BrowserTool(headless=headless, executable_path=chrome_path, profile_dir=profile_dir),
        DesktopTool(relay),
        # Pairs with context compaction: old tool output is trimmed out of the
        # conversation, and this is how the model gets it back.
        RecallTool(),
    ):
        registry.register(tool)
    if memory is not None:
        registry.register(MemoryTool(
            memory, scope_for=lambda session: project_scope(session.workdir)))
    return registry


def describe_exception(exc: BaseException, depth: int = 4) -> str:
    """An exception plus what caused it, as one line.

    The top of the chain is often the least informative part of it. An HTTP
    client raising `APIConnectionError: Connection error.` does not say whether
    the name failed to resolve, the certificate was rejected, or there is simply
    no route -- and those want completely different fixes. The answer is a link
    or two down, so report the chain rather than only its head.
    """
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc

    while current is not None and id(current) not in seen and len(parts) < depth:
        seen.add(id(current))
        text = str(current).strip()
        parts.append(f"{type(current).__name__}: {text}" if text else type(current).__name__)
        # An explicit `raise ... from ...` is the author telling us what caused
        # this. Fall back to the implicit context only when nothing was chained
        # deliberately and Python has not marked it as noise.
        if current.__cause__ is not None:
            current = current.__cause__
        elif not current.__suppress_context__:
            current = current.__context__
        else:
            current = None

    return " <- ".join(parts)
