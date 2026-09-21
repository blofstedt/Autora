"""OpenAI-compatible adapter: vLLM, Ollama, llama.cpp, LM Studio, or the API.

This is the path to a fully local stack. Point `base_url` at vLLM or Ollama and
the rest of the harness does not change.

One honest caveat, since it is the thing that will actually bite: local models in
the 27-32B range are markedly worse at *multi-step* tool calling than the
frontier hosted models -- not at producing one well-formed call, but at
recovering when a selector misses or a build fails, which is most of what an
agent session consists of. Keep the interface, benchmark on your own tasks, and
route by task if it helps: local for transcription-adjacent and classification
work, hosted for the planning loop.
"""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

from .base import Delta, TextDelta, ThinkingDelta, ToolCallRequest, TurnEnd, Usage


class OpenAICompatProvider:
    name = "openai-compat"

    #: Why this provider was chosen, when it was chosen by falling back rather
    #: than by being asked for. Reported alongside a failure, because "cannot
    #: reach localhost:8000" is only baffling until you know nothing else was
    #: configured. Set by the CLI; None when the choice was explicit.
    selected_because: str | None = None

    def __init__(
        self,
        model: str = "qwen3-coder",
        base_url: str | None = None,
        api_key: str | None = None,
        reasoning_effort: str | None = None,
        send_reasoning: bool | None = None,
    ):
        self.model = model
        self.base_url = base_url or os.environ.get("AUTORA_LLM_BASE_URL", "http://localhost:8000/v1")
        self._api_key = api_key or os.environ.get("AUTORA_LLM_API_KEY", "local")
        self.reasoning_effort = reasoning_effort
        #: Whether assistant turns go back out carrying the thinking that
        #: produced them. There is no agreement to follow here: DeepSeek's
        #: thinking mode rejects a tool-calling turn whose reasoning has been
        #: stripped, its own reasoner rejects one that still has it, and most
        #: servers ignore the field either way. So: a guess from the endpoint,
        #: an env override for when the guess is wrong, and -- because a guess
        #: about an API nobody has standardised will be wrong -- a correction
        #: from whichever 400 comes back. See `_flip_on_complaint`.
        self.send_reasoning = (
            send_reasoning if send_reasoning is not None else _default_send_reasoning(self.base_url)
        )
        self._client = None

    def _ensure_client(self):
        if self._client is None:
            try:
                from openai import AsyncOpenAI
            except ImportError as exc:
                raise RuntimeError("pip install openai") from exc
            self._client = AsyncOpenAI(base_url=self.base_url, api_key=self._api_key)
        return self._client

    async def stream(
        self,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int = 8192,
    ) -> AsyncIterator[Delta]:
        client = self._ensure_client()
        payload_tools = [
            {"type": "function", "function": {
                "name": t["name"], "description": t["description"],
                "parameters": t["input_schema"]}}
            for t in tools
        ]
        extra: dict[str, Any] = {}
        if self.reasoning_effort:
            extra["reasoning_effort"] = self.reasoning_effort

        async def open_stream(with_reasoning: bool):
            return await client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system},
                    *_to_openai(messages, reasoning=with_reasoning),
                ],
                tools=payload_tools or None,
                max_tokens=max_tokens,
                stream=True,
                stream_options={"include_usage": True},
                **({"extra_body": extra} if extra else {}),
            )

        # The request is rejected before a single chunk arrives, which is what
        # makes one retry here cheap and invisible rather than a half-streamed
        # turn that has to be unwound.
        try:
            stream = await open_stream(self.send_reasoning)
        except Exception as exc:
            wanted = _flip_on_complaint(exc, self.send_reasoning)
            if wanted is None:
                raise
            self.send_reasoning = wanted
            stream = await open_stream(wanted)

        # Tool calls arrive as fragments indexed by position, and the id may
        # appear on any fragment, so accumulate rather than assuming the first.
        partial: dict[int, dict[str, str]] = {}
        stop_reason = "end_turn"
        usage = Usage()

        async for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = Usage(
                    input_tokens=chunk.usage.prompt_tokens or 0,
                    output_tokens=chunk.usage.completion_tokens or 0,
                )
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if getattr(delta, "content", None):
                yield TextDelta(delta.content)
            # Several local servers expose reasoning under a nonstandard key.
            for attr in ("reasoning_content", "reasoning"):
                value = getattr(delta, attr, None)
                if value:
                    yield ThinkingDelta(value)
                    break

            for fragment in (getattr(delta, "tool_calls", None) or []):
                slot = partial.setdefault(fragment.index, {"id": "", "name": "", "args": ""})
                if fragment.id:
                    slot["id"] = fragment.id
                if fragment.function and fragment.function.name:
                    slot["name"] = fragment.function.name
                if fragment.function and fragment.function.arguments:
                    slot["args"] += fragment.function.arguments

            if choice.finish_reason:
                stop_reason = (
                    "tool_use" if choice.finish_reason == "tool_calls" else choice.finish_reason
                )

        for index in sorted(partial):
            slot = partial[index]
            if not slot["name"]:
                continue
            try:
                args = json.loads(slot["args"]) if slot["args"].strip() else {}
            except json.JSONDecodeError:
                # Smaller models emit malformed JSON often enough that dropping
                # the call silently would be maddening to debug. Surface it as an
                # empty call and let the loop report the error back to the model.
                args = {}
            yield ToolCallRequest(slot["id"] or f"call_{index}", slot["name"], args)

        yield TurnEnd(stop_reason, usage)


def _to_openai(
    messages: list[dict[str, Any]], reasoning: bool = False
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg["role"]
        if role == "tool":
            out.append({"role": "tool", "tool_call_id": msg["tool_call_id"],
                        "content": msg.get("content") or "(no output)"})
        elif role == "assistant" and msg.get("tool_calls"):
            turn: dict[str, Any] = {
                "role": "assistant",
                "content": msg.get("content") or None,
                "tool_calls": [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
                    for c in msg["tool_calls"]
                ],
            }
            if reasoning and msg.get("reasoning"):
                turn["reasoning_content"] = msg["reasoning"]
            out.append(turn)
        elif role == "assistant":
            turn = {"role": "assistant", "content": msg.get("content") or ""}
            # Every assistant turn, not only the ones that called a tool.
            #
            # That distinction was the first guess and it was wrong: once a
            # conversation has made a single tool call, DeepSeek wants the
            # reasoning back on *all* of the assistant messages behind it, not
            # just the one mid-flight. Sending it on the tool-calling turn
            # alone fails exactly as loudly as sending none, and the error text
            # is identical, which is what made the first fix look like it had
            # worked until a session got long enough to have an ordinary reply
            # in it.
            if reasoning and msg.get("reasoning"):
                turn["reasoning_content"] = msg["reasoning"]
            out.append(turn)
        else:
            out.append({"role": role, "content": msg.get("content") or ""})
    return out


#: Endpoints known to want the thinking back. Everything else starts off
#: assuming not, and gets corrected by its own error message if that is wrong.
_WANTS_REASONING = ("deepseek",)


def _default_send_reasoning(base_url: str) -> bool:
    override = os.environ.get("AUTORA_SEND_REASONING")
    if override is not None:
        return override.strip().lower() not in ("", "0", "false", "no", "off")
    host = (base_url or "").lower()
    return any(name in host for name in _WANTS_REASONING)


def _flip_on_complaint(exc: BaseException, sending: bool) -> bool | None:
    """Read a rejection for an opinion about `reasoning_content`.

    Returns what to send instead, or None if the error was about something else.
    Both complaints exist in the wild and say so plainly:

        "The `reasoning_content` in the thinking mode must be passed back"
        "reasoning_content is not allowed / should not be passed"

    So rather than maintaining a table of which endpoint wants which, take the
    endpoint's word for it and retry once. The answer sticks for the session,
    so a given server is asked at most once.
    """
    if getattr(exc, "status_code", None) not in (400, 422):
        return None
    message = str(exc).lower()
    if "reasoning_content" not in message and "reasoning content" not in message:
        return None
    wants_it_back = "must" in message or "required" in message
    if wants_it_back and not sending:
        return True
    if not wants_it_back and sending:
        return False
    # It is complaining about the field in the state we are already in, so
    # flipping would only trade one rejection for the other. Let it through.
    return None
