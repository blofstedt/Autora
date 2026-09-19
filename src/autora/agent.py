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

from .events import Kind
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
    ):
        self.session = session
        self.provider = provider
        self.registry = registry
        self.gate = gate or PolicyGate()
        self.system = system
        self.max_iterations = max_iterations
        self.messages: list[dict[str, Any]] = []
        self._cancel = asyncio.Event()
        self._running = False

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
        self.messages.append({"role": "user", "content": user_text})

        final_text = ""
        try:
            for iteration in range(self.max_iterations):
                self._check_cancelled()
                text, thinking, calls, stop = await self._stream_once()
                final_text = text or final_text

                # Record the assistant turn in history before running tools, so
                # an interruption mid-tool still leaves a well-formed history
                # that the next turn can continue from.
                entry: dict[str, Any] = {"role": "assistant", "content": text}
                if calls:
                    entry["tool_calls"] = [
                        {"id": c.id, "name": c.name, "args": c.args} for c in calls
                    ]
                self.messages.append(entry)

                if not calls:
                    self.session.emit(Kind.AGENT_DONE, {
                        "stop_reason": stop, "iterations": iteration + 1,
                    }, actor="agent")
                    return final_text

                for call in calls:
                    self._check_cancelled()
                    result = await self._invoke(call)
                    self.messages.append({
                        "role": "tool", "tool_call_id": call.id,
                        "content": result.content, "ok": result.ok,
                    })
            else:
                note = (
                    f"Stopped after {self.max_iterations} steps without finishing. "
                    f"This usually means a retry loop -- look at the timeline."
                )
                self.session.emit(Kind.ERROR, {"error": note}, actor="system")
                self.messages.append({"role": "user", "content": note})
                return note

        except Interrupted:
            self.session.emit(Kind.AGENT_DONE, {
                "stop_reason": "interrupted", "text": final_text,
            }, actor="agent")
            # Leave history consistent: the model must see that it was cut off,
            # or the next turn continues as though nothing happened.
            self.messages.append({
                "role": "user",
                "content": "[The human interrupted you. Stop what you were doing and listen.]",
            })
            return final_text
        finally:
            self._running = False
            self.session.checkpoint()

        return final_text

    async def _stream_once(self) -> tuple[str, str, list[ToolCallRequest], str]:
        """One provider round-trip, streamed into the event log as it arrives."""
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        calls: list[ToolCallRequest] = []
        stop_reason = "end_turn"

        try:
            stream = self.provider.stream(
                system=self.system,
                messages=self.messages,
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
                "error": f"{type(exc).__name__}: {exc}", "where": "provider",
            }, actor="system")
            raise

        return "".join(text_parts), "".join(thinking_parts), calls, stop_reason

    async def _invoke(self, call: ToolCallRequest) -> ToolResult:
        """Authorize, run, and record one tool call."""
        tool = self.registry.get(call.name)
        if tool is None:
            available = ", ".join(t.name for t in self.registry)
            return ToolResult(f"No such tool {call.name!r}. Available: {available}", ok=False)

        # Redact before the args reach the log. The tool still receives the real
        # values -- redaction is for the record, not the execution.
        span = self.session.open_span(
            call.name, Kind.TOOL_CALL,
            {"args": _redact(call.args), "call_id": call.id},
            actor="agent",
        )

        outcome = await self.gate.authorize(self.session, call.name, call.args)
        if outcome.decision is Decision.DENY:
            self.session.close_span(span, Kind.TOOL_ERROR, {"denied": True,
                                    "reason": outcome.reason}, actor="system")
            return ToolResult(
                f"Not permitted: {outcome.reason} Do not retry this; choose a "
                f"different approach or ask the human.", ok=False)

        result = ToolResult("(tool produced no result)", ok=False)

        async def drain() -> ToolResult:
            last = ToolResult("(tool produced no result)", ok=False)
            async for chunk in tool.run(self.session, call.args, span):
                last = chunk
            return last

        try:
            result = await self._cancellable(drain())
        except Interrupted:
            self.session.close_span(span, Kind.TOOL_ERROR,
                                    {"error": "interrupted by human"}, actor="system")
            raise
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            self.session.close_span(span, Kind.TOOL_ERROR, {"error": error}, actor="system")
            return ToolResult(f"{call.name} raised {error}", ok=False)

        self.session.close_span(span, Kind.TOOL_RESULT, {
            "ok": result.ok,
            # A preview, not the payload: full tool output is already in the
            # streamed TOOL_OUTPUT/PTY_OUTPUT events, and duplicating a 200KB
            # build log into the result event would double the log for nothing.
            "preview": (result.content or "")[:400],
            "display": result.display,
        }, actor=f"tool:{call.name}")
        return result


def build_registry(
    headless: bool = True,
    chrome_path: str | None = None,
    profile_dir: str | None = None,
    relay=None,
) -> ToolRegistry:
    """The default toolset."""
    from .tools.browser import BrowserTool
    from .tools.desktop import DesktopTool
    from .tools.files import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
    from .tools.terminal import TerminalTool

    registry = ToolRegistry()
    for tool in (
        TerminalTool(),
        ReadFileTool(), WriteFileTool(), EditFileTool(), ListDirTool(),
        BrowserTool(headless=headless, executable_path=chrome_path, profile_dir=profile_dir),
        DesktopTool(relay),
    ):
        registry.register(tool)
    return registry
