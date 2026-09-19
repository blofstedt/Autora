"""Model provider abstraction.

Gemini's blueprint hardcodes one model into the orchestrator. That is the single
costliest decision in the whole design, because model choice is the thing you
will change most often and it is entangled with everything: tool-call dialects,
streaming shapes, reasoning blocks, vision payloads.

So providers are an interface, and the harness holds no vendor types. Two
adapters ship: Anthropic (best tool-calling reliability today, which is what an
agent driving a browser and a shell actually lives or dies on) and any
OpenAI-compatible endpoint, which covers vLLM, Ollama, llama.cpp and LM Studio --
so a local Qwen is a config change, not a rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol, runtime_checkable


@dataclass
class TextDelta:
    text: str


@dataclass
class ThinkingDelta:
    """Reasoning tokens, where the provider exposes them separately.

    Kept distinct from TextDelta so the UI can show reasoning in a collapsed
    panel and, critically, so the voice layer never reads it aloud.
    """
    text: str


@dataclass
class ToolCallRequest:
    id: str
    name: str
    args: dict[str, Any]


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0


@dataclass
class TurnEnd:
    stop_reason: str
    usage: Usage = field(default_factory=Usage)


Delta = TextDelta | ThinkingDelta | ToolCallRequest | TurnEnd


@runtime_checkable
class LLMProvider(Protocol):
    name: str
    model: str

    async def stream(
        self,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int = 8192,
    ) -> AsyncIterator[Delta]:
        """Stream one assistant turn.

        Implementations must yield exactly one TurnEnd, last. Messages use the
        neutral shape below; adapters translate.

        Neutral message format:
          {"role": "user"|"assistant", "content": str}
          {"role": "assistant", "tool_calls": [{"id","name","args"}], "content": str}
          {"role": "tool", "tool_call_id": str, "content": str, "ok": bool}
        """
        ...
