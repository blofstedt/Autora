"""Tool contract and registry.

A tool is anything the model can invoke. Two requirements beyond the obvious:

  1. It declares a JSON Schema, so providers can be swapped without rewriting
     tool definitions for each vendor's function-calling dialect.
  2. It receives the `Session` and is expected to emit events as it works.
     A tool that runs for 90 seconds and only reports at the end is a
     transparency failure, even if it returns the right answer.

That second point is the whole reason this harness exists, so `run` is an async
generator rather than a coroutine: yielding is how a tool streams.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, runtime_checkable


@dataclass
class ToolResult:
    """What goes back to the model.

    `content` is for the model; `display` is optional richer data for the UI
    (a diff, an image hash, a table). Keeping them separate means you can show a
    human a screenshot while handing the model a description, without the two
    fighting over one field.
    """

    content: str
    ok: bool = True
    display: dict[str, Any] | None = None


@runtime_checkable
class Tool(Protocol):
    name: str
    description: str
    schema: dict[str, Any]

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        """Stream progress, then yield exactly one final ToolResult last."""
        ...


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        self._tools[tool.name] = tool
        return tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def __contains__(self, name: str) -> bool:
        return name in self._tools

    def __iter__(self):
        return iter(self._tools.values())

    def specs(self) -> list[dict[str, Any]]:
        """Provider-neutral tool declarations; adapters reshape per vendor."""
        return [
            {"name": t.name, "description": t.description, "input_schema": t.schema}
            for t in self._tools.values()
        ]
