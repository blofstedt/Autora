"""File inspection and mutation.

Every write emits a unified diff as an event. That is the point: watching an
agent write code is not watching a spinner that says "editing app.ts" -- it is
seeing the hunks land, in order, with the ability to scrub back and read what
changed three steps ago. A diff is also the only honest record of an edit, since
the file itself only remembers the final state.
"""

from __future__ import annotations

import difflib
import fnmatch
from pathlib import Path
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult

MAX_READ_BYTES = 512 * 1024

#: Never read or write these, whatever the model asks. Complements the policy
#: gate: the gate can be relaxed by a human, this cannot.
BLOCKED_GLOBS = (
    "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".env", ".env.*",
    "*/.ssh/*", "*/.aws/*", "*/.gnupg/*", "*.keystore",
)


def _resolve(session, raw: str) -> Path:
    """Resolve a path against the session root, refusing escapes.

    Called before every read and write. Path containment is checked after
    resolution so that symlinks and `..` cannot be used to step outside.
    """
    root = session.workdir.resolve()
    candidate = (root / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
    if candidate != root and root not in candidate.parents:
        raise PermissionError(f"{raw} is outside the session root ({root})")
    for pattern in BLOCKED_GLOBS:
        if fnmatch.fnmatch(str(candidate), pattern) or fnmatch.fnmatch(candidate.name, pattern):
            raise PermissionError(f"{raw} matches a blocked pattern ({pattern})")
    return candidate


class ReadFileTool:
    name = "read_file"
    description = "Read a UTF-8 text file. Optionally a line range, 1-indexed and inclusive."
    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "start": {"type": "integer", "description": "First line (1-indexed)."},
            "end": {"type": "integer", "description": "Last line, inclusive."},
        },
        "required": ["path"],
    }

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        try:
            path = _resolve(session, args["path"])
        except PermissionError as exc:
            yield ToolResult(f"Refused: {exc}", ok=False)
            return
        if not path.exists():
            yield ToolResult(f"No such file: {args['path']}", ok=False)
            return
        if path.stat().st_size > MAX_READ_BYTES:
            yield ToolResult(
                f"{args['path']} is {path.stat().st_size} bytes, over the "
                f"{MAX_READ_BYTES} byte limit. Read a line range instead.", ok=False)
            return

        lines = path.read_text("utf-8", errors="replace").splitlines()
        start = max(1, int(args.get("start") or 1))
        end = min(len(lines), int(args["end"])) if args.get("end") else len(lines)
        body = "\n".join(f"{i:>6}\t{lines[i - 1]}" for i in range(start, end + 1))
        session.emit(Kind.TOOL_OUTPUT, {
            "summary": f"read {path.name} ({end - start + 1} lines)", "path": str(path),
        }, actor=f"tool:{self.name}", span=span)
        yield ToolResult(body or "(empty file)", display={"path": str(path), "lines": len(lines)})


class WriteFileTool:
    name = "write_file"
    description = (
        "Create a file or replace its entire contents. Emits a diff so the change "
        "is reviewable. For a targeted change to an existing file, prefer edit_file."
    )
    schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"],
    }

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        try:
            path = _resolve(session, args["path"])
        except PermissionError as exc:
            yield ToolResult(f"Refused: {exc}", ok=False)
            return
        before = path.read_text("utf-8", errors="replace") if path.exists() else ""
        after = args["content"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(after, encoding="utf-8")
        _emit_diff(session, span, self.name, path, before, after)
        verb = "Created" if not before else "Overwrote"
        yield ToolResult(f"{verb} {args['path']} ({len(after.splitlines())} lines).",
                         display={"path": str(path)})


class EditFileTool:
    name = "edit_file"
    description = (
        "Replace an exact string in a file. `old` must appear exactly once, so the "
        "edit is unambiguous -- include surrounding context to disambiguate."
    )
    schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "old": {"type": "string", "description": "Exact text to replace."},
            "new": {"type": "string", "description": "Replacement text."},
        },
        "required": ["path", "old", "new"],
    }

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        try:
            path = _resolve(session, args["path"])
        except PermissionError as exc:
            yield ToolResult(f"Refused: {exc}", ok=False)
            return
        if not path.exists():
            yield ToolResult(f"No such file: {args['path']}", ok=False)
            return

        before = path.read_text("utf-8", errors="replace")
        old, new = args["old"], args["new"]
        count = before.count(old)
        # Failing loudly on an ambiguous match is the difference between an agent
        # that edits the line it meant and one that quietly edits the wrong one.
        if count == 0:
            yield ToolResult(
                f"`old` not found in {args['path']}. The file may have changed; "
                f"read it again and retry with exact text.", ok=False)
            return
        if count > 1:
            yield ToolResult(
                f"`old` appears {count} times in {args['path']}. Add surrounding "
                f"context so exactly one match remains.", ok=False)
            return

        after = before.replace(old, new, 1)
        path.write_text(after, encoding="utf-8")
        _emit_diff(session, span, self.name, path, before, after)
        yield ToolResult(f"Edited {args['path']}.", display={"path": str(path)})


class ListDirTool:
    name = "list_dir"
    description = "List a directory's entries, marking directories with a trailing slash."
    schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": []}

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        try:
            path = _resolve(session, args.get("path") or ".")
        except PermissionError as exc:
            yield ToolResult(f"Refused: {exc}", ok=False)
            return
        if not path.is_dir():
            yield ToolResult(f"Not a directory: {args.get('path')}", ok=False)
            return
        entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name))
        listing = "\n".join(
            f"{e.name}/" if e.is_dir() else f"{e.name}\t{e.stat().st_size}"
            for e in entries if not e.name.startswith(".")
        )
        yield ToolResult(listing or "(empty)", display={"path": str(path), "count": len(entries)})


def _emit_diff(session, span: str, tool: str, path: Path, before: str, after: str) -> None:
    """Emit the change as a unified diff event.

    Truncated at a generous but finite size -- a generated lockfile diff is
    100k lines and nobody reviews it, but the event log should still record
    that it happened and by how much.
    """
    diff_lines = list(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a/{path.name}", tofile=f"b/{path.name}", n=3,
    ))
    added = sum(1 for l in diff_lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff_lines if l.startswith("-") and not l.startswith("---"))
    capped = diff_lines[:2000]
    if len(diff_lines) > len(capped):
        capped.append(f"\n... [{len(diff_lines) - len(capped)} more diff lines elided] ...\n")
    session.emit(Kind.FILE_EDIT, {
        "path": str(path), "diff": "".join(capped),
        "added": added, "removed": removed,
        "created": before == "",
    }, actor=f"tool:{tool}", span=span)
