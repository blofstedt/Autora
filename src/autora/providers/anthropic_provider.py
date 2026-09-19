"""Anthropic adapter."""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

from .base import Delta, LLMProvider, TextDelta, ThinkingDelta, ToolCallRequest, TurnEnd, Usage


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str = "claude-sonnet-5", api_key: str | None = None):
        self.model = model
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._client = None

    def _ensure_client(self):
        if self._client is None:
            try:
                from anthropic import AsyncAnthropic
            except ImportError as exc:
                raise RuntimeError("pip install anthropic") from exc
            if not self._api_key:
                raise RuntimeError("ANTHROPIC_API_KEY is not set.")
            self._client = AsyncAnthropic(api_key=self._api_key)
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
            {"name": t["name"], "description": t["description"],
             "input_schema": t["input_schema"]}
            for t in tools
        ]

        async with client.messages.stream(
            model=self.model,
            max_tokens=max_tokens,
            system=[{"type": "text", "text": system,
                     # The system prompt and tool definitions are identical on
                     # every turn of a session, so cache them. This is the
                     # prefix caching that actually pays off -- unlike
                     # speculatively prefilling half-heard speech, it is
                     # deterministic and cannot be invalidated by a re-transcribe.
                     "cache_control": {"type": "ephemeral"}}],
            messages=_mark_tail(_to_anthropic(messages)),
            tools=payload_tools,
        ) as stream:
            tool_blocks: dict[int, dict[str, Any]] = {}
            async for event in stream:
                etype = event.type
                if etype == "content_block_start":
                    block = event.content_block
                    if block.type == "tool_use":
                        tool_blocks[event.index] = {"id": block.id, "name": block.name, "json": ""}
                elif etype == "content_block_delta":
                    delta = event.delta
                    dtype = getattr(delta, "type", "")
                    if dtype == "text_delta":
                        yield TextDelta(delta.text)
                    elif dtype == "thinking_delta":
                        yield ThinkingDelta(delta.thinking)
                    elif dtype == "input_json_delta" and event.index in tool_blocks:
                        tool_blocks[event.index]["json"] += delta.partial_json
                elif etype == "content_block_stop":
                    block = tool_blocks.pop(event.index, None)
                    if block is not None:
                        try:
                            args = json.loads(block["json"]) if block["json"].strip() else {}
                        except json.JSONDecodeError:
                            args = {}
                        yield ToolCallRequest(block["id"], block["name"], args)

            final = await stream.get_final_message()
            usage = getattr(final, "usage", None)
            yield TurnEnd(
                final.stop_reason or "end_turn",
                Usage(
                    input_tokens=getattr(usage, "input_tokens", 0) or 0,
                    output_tokens=getattr(usage, "output_tokens", 0) or 0,
                    cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                ),
            )


def _mark_tail(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Put a cache breakpoint on the last content block of the conversation.

    The system prompt and tools already carry one, but they are the small half.
    In an agent loop the history is what grows -- forty iterations re-send an
    ever-larger conversation, and without a breakpoint in `messages` every one
    of those tokens is billed as fresh input on every single step.

    Marking the tail is the documented multi-turn placement: each request writes
    an entry ending at the newest turn, and the next request reads it back and
    extends it, so the cost is paid once per turn instead of once per turn per
    remaining iteration. It works because the composer keeps history append-only
    between compactions -- rewriting an earlier message invalidates everything
    after it, which is exactly why compaction is batched and rare.

    Explicit rather than the top-level auto-caching field: this project pins
    `anthropic>=0.40`, and a per-block marker is understood by every SDK version
    that supports caching at all.
    """
    if not blocks:
        return blocks
    content = blocks[-1].get("content")
    if isinstance(content, str):
        if not content:
            # An empty text block is not a valid cache target -- and there is
            # nothing to cache anyway.
            return blocks
        blocks[-1] = {**blocks[-1],
                      "content": [{"type": "text", "text": content,
                                   "cache_control": {"type": "ephemeral"}}]}
    elif isinstance(content, list) and content:
        content = list(content)
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}
        blocks[-1] = {**blocks[-1], "content": content}
    return blocks


def _to_anthropic(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate neutral messages into Anthropic content blocks.

    Consecutive tool results must be merged into a single user message --
    Anthropic requires every tool_use to be answered in the immediately
    following user turn, and emitting them as separate messages is a 400.
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg["role"]
        if role == "tool":
            block = {
                "type": "tool_result",
                "tool_use_id": msg["tool_call_id"],
                "content": msg.get("content") or "(no output)",
            }
            if not msg.get("ok", True):
                block["is_error"] = True
            if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
        elif role == "assistant" and msg.get("tool_calls"):
            content: list[dict[str, Any]] = []
            if msg.get("content"):
                content.append({"type": "text", "text": msg["content"]})
            for call in msg["tool_calls"]:
                content.append({"type": "tool_use", "id": call["id"],
                                "name": call["name"], "input": call["args"]})
            out.append({"role": "assistant", "content": content})
        else:
            out.append({"role": role, "content": msg.get("content") or ""})
    return out
