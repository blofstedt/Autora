"""Shell execution over a real pseudo-terminal.

Why a PTY instead of `subprocess.PIPE`: with a pipe, programs detect that they
are not on a terminal and change behavior -- no colors, no progress bars, npm
and pytest switch to terse CI output, and anything that wants to prompt either
hangs forever or silently takes a default. You end up watching a blank pane for
two minutes and then getting a wall of text, which is precisely the experience
this project exists to fix.

With a PTY you get the same bytes your own terminal would get, so the UI can
render them with xterm.js and the recording replays as the real thing -- spinner
frames, cursor moves, colors and all. It also makes the output asciinema-
compatible for free, which is a better recording format than anything custom.
"""

from __future__ import annotations

import asyncio
import codecs
import fcntl
import re
import json
import os
import pty
import signal
import struct
import termios
import time
from pathlib import Path
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult

#: Output cap per command. A runaway `yes` or a verbose build must not be able
#: to fill the event log or the model's context. The head is kept (that is where
#: the useful output usually is) and the tail is kept (that is where the error
#: usually is); the middle is elided.
MAX_CAPTURE_BYTES = 256 * 1024
HEAD_BYTES = 96 * 1024
TAIL_BYTES = 96 * 1024


class TerminalTool:
    name = "bash"
    description = (
        "Run a shell command in a real terminal. Output streams live to the UI as "
        "it is produced. Use for builds, tests, git, and CLI tools. Long-running "
        "commands are fine; they are visible while they run."
    )
    schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command to run."},
            "timeout": {
                "type": "number",
                "description": "Seconds before the command is killed. Default 120.",
            },
            "cwd": {"type": "string", "description": "Working directory, relative to the session root."},
        },
        "required": ["command"],
    }

    def __init__(self, default_timeout: float = 120.0, cols: int = 120, rows: int = 32):
        self.default_timeout = default_timeout
        self.cols = cols
        self.rows = rows

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        command = args["command"]
        timeout = float(args.get("timeout") or self.default_timeout)
        cwd = session.workdir
        if args.get("cwd"):
            candidate = (session.workdir / args["cwd"]).resolve()
            # Keep the agent inside the session root; a tool argument should not
            # be able to walk out of the project with `../../..`.
            if session.workdir.resolve() in candidate.parents or candidate == session.workdir.resolve():
                cwd = candidate
            else:
                yield ToolResult(f"Refused: cwd {args['cwd']!r} is outside the session root.", ok=False)
                return

        master, slave = pty.openpty()
        # Tell the child how wide it is, or it wraps at 80 and progress bars
        # smear across lines in the recording.
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))

        started = time.monotonic()
        process = await asyncio.create_subprocess_shell(
            command,
            stdin=slave, stdout=slave, stderr=slave,
            cwd=str(cwd),
            env={
                **os.environ,
                "TERM": "xterm-256color",
                "FORCE_COLOR": "1",
                # Stop pagers from waiting for a keypress no one will press.
                "GIT_PAGER": "cat", "PAGER": "cat", "LESS": "-FRX",
                "PYTHONUNBUFFERED": "1",
            },
            start_new_session=True,  # own process group, so timeout kills children too
        )
        os.close(slave)

        captured = bytearray()
        truncated = False
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        def on_readable() -> None:
            try:
                chunk = os.read(master, 65536)
            except (OSError, BlockingIOError):
                chunk = b""
            if chunk:
                queue.put_nowait(chunk)
            else:
                loop.remove_reader(master)
                queue.put_nowait(None)

        loop.add_reader(master, on_readable)

        async def pump() -> None:
            nonlocal truncated
            while True:
                chunk = await queue.get()
                if chunk is None:
                    return
                if len(captured) < MAX_CAPTURE_BYTES:
                    captured.extend(chunk)
                elif not truncated:
                    truncated = True
                # Decode incrementally: a 64KB read can split a multi-byte
                # character, and naive per-chunk decoding would corrupt it.
                text = decoder.decode(chunk)
                if text:
                    session.emit(
                        Kind.PTY_OUTPUT,
                        {"data": text, "t": round(time.monotonic() - started, 4)},
                        actor=f"tool:{self.name}", span=span,
                    )

        pump_task = asyncio.create_task(pump())
        timed_out = False
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            timed_out = True
            _killpg(process)
            await process.wait()
        except asyncio.CancelledError:
            # The human interrupted. Kill the child before unwinding -- otherwise
            # barge-in leaves an orphaned build running, still holding the PTY and
            # still writing to a session that has moved on.
            _killpg(process)
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            pump_task.cancel()
            try:
                loop.remove_reader(master)
            except (ValueError, OSError):
                pass
            os.close(master)
            session.emit(Kind.PTY_EXIT, {
                "exit_code": -2, "interrupted": True,
                "duration_ms": round((time.monotonic() - started) * 1000, 1),
            }, actor=f"tool:{self.name}", span=span)
            raise
        finally:
            # Give the pump a moment to drain buffered output after exit --
            # otherwise the last line of a failing test is missing from the log.
            if not pump_task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(pump_task), timeout=2.0)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pump_task.cancel()
            try:
                loop.remove_reader(master)
            except (ValueError, OSError):
                pass
            try:
                os.close(master)
            except OSError:
                pass  # already closed on the cancellation path

        elapsed = time.monotonic() - started
        exit_code = -9 if timed_out else (process.returncode or 0)
        session.emit(Kind.PTY_EXIT, {
            "exit_code": exit_code, "duration_ms": round(elapsed * 1000, 1),
            "timed_out": timed_out,
        }, actor=f"tool:{self.name}", span=span)

        output = _trim(bytes(captured), truncated)
        if timed_out:
            yield ToolResult(
                f"Command timed out after {timeout:.0f}s and was killed.\n\n{output}",
                ok=False, display={"exit_code": exit_code, "timed_out": True},
            )
            return
        status = "" if exit_code == 0 else f"[exit {exit_code}]\n"
        yield ToolResult(
            f"{status}{output}" if output.strip() else f"{status}(no output)",
            ok=exit_code == 0,
            display={"exit_code": exit_code, "duration_ms": round(elapsed * 1000, 1)},
        )


#: CSI/OSC/charset escape sequences. The PTY stream keeps these -- xterm.js needs
#: them to render colors and progress bars -- but the string handed back to the
#: model does not: escape codes cost tokens, and a spinner that rewrote its line
#: 400 times reads as garbage rather than as one line of output.
_ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"      # CSI (colors, cursor moves)
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC (window title, hyperlinks)
    r"|\x1b[()][B0UK]"              # charset selection
    r"|\x1b[=>]"                    # keypad mode
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]"  # stray control bytes
)


def strip_ansi(text: str) -> str:
    """Flatten terminal output into plain text for the model.

    Carriage returns are resolved rather than deleted: a progress bar emits
    `\r` between repaints, so keeping them would hand the model dozens of
    overlapping variants of the same line. Taking the segment after the last
    `\r` reproduces what the line actually ended up showing.
    """
    cleaned = _ANSI_RE.sub("", text)
    # Normalize CRLF *first*. A PTY ends every line with "\r\n", so treating a
    # trailing "\r" as a progress-bar repaint would take the segment after it --
    # the empty string -- and blank every line of real output.
    cleaned = cleaned.replace("\r\n", "\n")
    lines = []
    for line in cleaned.split("\n"):
        if "\r" in line:
            # A bare "\r" mid-line is a repaint: keep only what the line ended
            # up showing.
            line = line.split("\r")[-1]
        lines.append(line.rstrip())
    return "\n".join(lines)


def _killpg(process) -> None:
    """SIGKILL the whole process group.

    Killing just the shell is not enough: `npm test` and `pytest -n` spawn
    children that survive it, keep the PTY open, and keep burning CPU after the
    command has supposedly stopped.
    """
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _trim(raw: bytes, truncated: bool) -> str:
    text = strip_ansi(raw.decode("utf-8", "replace"))
    if not truncated and len(raw) <= MAX_CAPTURE_BYTES:
        return text
    head = strip_ansi(raw[:HEAD_BYTES].decode("utf-8", "replace"))
    tail = strip_ansi(raw[-TAIL_BYTES:].decode("utf-8", "replace"))
    omitted = len(raw) - HEAD_BYTES - TAIL_BYTES
    return f"{head}\n\n... [{omitted} bytes elided] ...\n\n{tail}"


def export_asciicast(store, span: str | None = None, width: int = 120, height: int = 32) -> str:
    """Export a session's terminal output as an asciinema v2 cast.

    Reusing an established format rather than inventing one means `asciinema
    play` and every existing web player work on Autora recordings, and a
    terminal session can be shared as a link without shipping the whole UI.
    """
    header = {
        "version": 2, "width": width, "height": height,
        "timestamp": int(time.time()), "env": {"TERM": "xterm-256color", "SHELL": "/bin/bash"},
    }
    lines = [json.dumps(header)]
    for event in store.read():
        if event.kind != Kind.PTY_OUTPUT:
            continue
        if span is not None and event.span != span:
            continue
        lines.append(json.dumps([event.payload.get("t", 0.0), "o", event.payload.get("data", "")]))
    return "\n".join(lines) + "\n"
