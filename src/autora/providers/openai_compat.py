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

    def __init__(
        self,
        model: str = "qwen3-coder",
        base_url: str | None = None,
        api_key: str | None = None,
        reasoning_effort: str | None = None,
    ):
        self.model = model
        self.base_url = base_url or os.environ.get("AUTORA_LLM_BASE_URL", "http://localhost:8000/v1")
        self._api_key = api_key or os.environ.get("AUTORA_LLM_API_KEY", "local")
        self.reasoning_effort = reasoning_effort
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

        stream = await client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system}, *_to_openai(messages)],
            tools=payload_tools or None,
            max_tokens=max_tokens,
            stream=True,
            stream_options={"include_usage": True},
            **({"extra_body": extra} if extra else {}),
        )

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


def _to_openai(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg["role"]
        if role == "tool":
            out.append({"role": "tool", "tool_call_id": msg["tool_call_id"],
                        "content": msg.get("content") or "(no output)"})
        elif role == "assistant" and msg.get("tool_calls"):
            out.append({
                "role": "assistant",
                "content": msg.get("content") or None,
                "tool_calls": [
                    {"id": c["id"], "type": "function",
                     "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
                    for c in msg["tool_calls"]
                ],
            })
        else:
            out.append({"role": role, "content": msg.get("content") or ""})
    return out
