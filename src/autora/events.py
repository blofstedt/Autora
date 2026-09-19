"""The event model.

Autora has exactly one mechanism for observability: an append-only stream of
typed events. The live UI is a subscriber to that stream. A recording is that
stream read back from disk. There is no separate "logging" path, no separate
"replay format", and no way for the agent to do something the stream does not
see -- every tool call goes through the same emit path.

This is the central design decision of the harness. It means:

  * Live view and replay share one renderer, so they cannot drift.
  * "Record a session" is free -- it is what already happens.
  * Joining late is the same operation as replaying: read from seq N, then tail.
  * Debugging the agent is `tail -f events.jsonl`.

Event kinds are dotted strings (`tool.output`, `browser.frame`). The prefix is
the subsystem; the UI routes on it. Kinds are open -- a new tool may emit a new
kind and the UI degrades to a generic timeline row rather than crashing.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterator


# --------------------------------------------------------------------------
# Kind taxonomy
# --------------------------------------------------------------------------
# Not an enum on purpose: kinds are open for extension. These constants cover
# what the built-in subsystems emit, and are what the UI knows how to render
# richly. Anything else still lands on the timeline as a generic row.

class Kind:
    # Session lifecycle
    SESSION_STARTED = "session.started"
    SESSION_ENDED = "session.ended"

    # Conversation
    USER_MESSAGE = "turn.user"
    AGENT_TEXT = "turn.agent.text"        # streamed delta
    AGENT_THINKING = "turn.agent.thinking"  # streamed reasoning delta
    AGENT_DONE = "turn.agent.done"

    # Tool invocation. TOOL_CALL opens a span, TOOL_RESULT/TOOL_ERROR closes it,
    # TOOL_OUTPUT carries incremental output in between.
    TOOL_CALL = "tool.call"
    TOOL_OUTPUT = "tool.output"
    TOOL_RESULT = "tool.result"
    TOOL_ERROR = "tool.error"

    # Permission gate
    POLICY_REQUEST = "policy.request"
    POLICY_DECISION = "policy.decision"

    # Terminal (raw PTY bytes -- rendered by xterm.js, replayable as asciinema)
    PTY_OUTPUT = "pty.output"
    PTY_EXIT = "pty.exit"

    # Browser. FRAME references a blob rather than inlining image bytes.
    BROWSER_FRAME = "browser.frame"
    BROWSER_NAV = "browser.nav"
    BROWSER_ACTION = "browser.action"     # click/type, with coordinates for the overlay

    # Desktop control
    DESKTOP_FRAME = "desktop.frame"
    DESKTOP_ACTION = "desktop.action"

    # Filesystem mutations, as diffs
    FILE_EDIT = "file.edit"

    # Voice
    STT_PARTIAL = "voice.stt.partial"
    STT_FINAL = "voice.stt.final"
    TTS_SPEAKING = "voice.tts.speaking"
    TTS_INTERRUPTED = "voice.tts.interrupted"

    # Text the harness injects straight into the model's context -- an
    # interruption notice, a loop-cap warning. It is logged rather than merely
    # appended to the conversation so that what the model was told is part of
    # the record, and so the context can be rebuilt from the log alone.
    CONTEXT_NOTE = "context.note"

    # Anything the harness itself wants to say
    LOG = "system.log"
    ERROR = "system.error"


#: Kinds that are safe to drop or coalesce under backpressure. A dropped video
#: frame costs nothing -- the next one arrives in 30ms. A dropped tool result
#: corrupts the record, so nothing else may be dropped, ever.
LOSSY_KINDS = frozenset({Kind.BROWSER_FRAME, Kind.DESKTOP_FRAME})

#: Kinds that are high-volume but must not lose data; the bus buffers rather
#: than drops these, and the UI coalesces them at render time instead.
CHATTY_KINDS = frozenset({
    Kind.AGENT_TEXT, Kind.AGENT_THINKING, Kind.TOOL_OUTPUT, Kind.PTY_OUTPUT,
    Kind.STT_PARTIAL,
})


@dataclass(slots=True)
class Event:
    """One observable thing that happened.

    `seq` is assigned by the store at append time and is the only ordering
    authority -- wall-clock `ts` is for display and may go backwards across
    machines. Clients resume with `from_seq`, so seq must be dense and
    monotonic per session.
    """

    kind: str
    payload: dict[str, Any] = field(default_factory=dict)
    actor: str = "system"           # "user" | "agent" | "tool:<name>" | "system"
    span: str | None = None         # groups a tool call's open/output/close events
    seq: int = -1                   # assigned on append
    ts: float = field(default_factory=time.time)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    blob: str | None = None         # content hash, for frames and other binaries

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), default=_fallback)

    @classmethod
    def from_json(cls, line: str) -> "Event":
        d = json.loads(line)
        # Tolerate events written by a future version that added fields.
        known = {f for f in cls.__slots__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in d.items() if k in known})


def _fallback(o: Any) -> Any:
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    return repr(o)


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

class BlobStore:
    """Content-addressed storage for binary payloads.

    Video frames dominate a session by volume -- a 10 minute browser session at
    10fps is ~6000 JPEGs. Inlining those as base64 in the event log would make
    the log unreadable, unstreamable, and roughly 33% larger than necessary.
    So frames live here and events carry a hash.

    Content addressing also dedupes for free, which matters more than it
    sounds: an agent waiting on a page emits dozens of byte-identical frames.
    """

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        path = self._path(digest)
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            # Write-then-rename so a reader never sees a torn blob.
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)
        return digest

    def get(self, digest: str) -> bytes | None:
        # Guard against path traversal via a crafted hash from a client.
        if len(digest) != 64 or not all(c in "0123456789abcdef" for c in digest):
            return None
        path = self._path(digest)
        return path.read_bytes() if path.exists() else None

    def _path(self, digest: str) -> Path:
        return self.root / digest[:2] / digest


class EventStore:
    """Append-only event log for one session, backed by JSONL.

    JSONL rather than SQLite deliberately. The log is the primary artifact of
    this system, so it should be greppable, tailable, diffable, and readable by
    anything that can split on newlines -- including a human at 3am. Seeking is
    handled by an in-memory offset index built on open, which is fast enough
    for sessions far larger than anyone will actually review.
    """

    def __init__(self, root: Path, session_id: str):
        self.session_id = session_id
        self.dir = root / session_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "events.jsonl"
        self.blobs = BlobStore(self.dir / "blobs")
        self._offsets: list[int] = []
        self._next_seq = 0
        self._fh = None
        self._load_index()

    def _load_index(self) -> None:
        """Rebuild the seq -> byte-offset index from an existing log."""
        if not self.path.exists():
            return
        offset = 0
        with self.path.open("rb") as fh:
            for line in fh:
                # A crashed writer can leave a partial final line. Stop there
                # and let the next append overwrite it rather than corrupting
                # the index with a half-event.
                if not line.endswith(b"\n"):
                    break
                self._offsets.append(offset)
                offset += len(line)
        self._next_seq = len(self._offsets)
        # Truncate any partial trailing line so appends stay well-formed.
        if self.path.stat().st_size != offset:
            with self.path.open("r+b") as fh:
                fh.truncate(offset)

    def append(self, event: Event) -> Event:
        """Assign a seq, durably append, return the event.

        Not thread-safe by design -- all appends go through a single Recorder
        owned by the session's event loop.
        """
        event.seq = self._next_seq
        self._next_seq += 1
        line = event.to_json() + "\n"
        if self._fh is None:
            self._fh = self.path.open("ab")
        self._offsets.append(self._fh.tell())
        self._fh.write(line.encode("utf-8"))
        self._fh.flush()
        return event

    def read(self, from_seq: int = 0, limit: int | None = None) -> Iterator[Event]:
        """Yield events from `from_seq` onward, as of this moment."""
        if not self.path.exists() or from_seq >= len(self._offsets):
            return
        start = self._offsets[max(0, from_seq)]
        count = 0
        with self.path.open("rb") as fh:
            fh.seek(start)
            for line in fh:
                if not line.strip():
                    continue
                try:
                    yield Event.from_json(line.decode("utf-8"))
                except (json.JSONDecodeError, TypeError):
                    # One bad line must not sink a replay of a long session.
                    continue
                count += 1
                if limit is not None and count >= limit:
                    return

    @property
    def length(self) -> int:
        return self._next_seq

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
