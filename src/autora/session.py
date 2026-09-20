"""A session: the unit of work, recording, and replay.

Every observable act in the harness funnels through `Session.emit`. That is the
invariant the whole design rests on -- there is no side channel, no `print`, no
direct websocket write. If it is not in the log, it did not happen.

Ordering matters inside emit: the event is persisted *before* it is published.
A subscriber therefore can never see an event that a reconnect would fail to
replay, which is what makes "resume from seq N" safe.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

from .bus import EventBus, Subscriber
from .events import Event, EventStore, Kind


def default_root() -> Path:
    import os
    return Path(os.environ.get("AUTORA_HOME", Path.home() / ".autora")) / "sessions"


class Session:
    """Owns the log, the bus, and the live state of one agent run."""

    def __init__(
        self,
        session_id: str | None = None,
        root: Path | None = None,
        title: str = "",
        workdir: Path | None = None,
    ):
        self.id = session_id or time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.root = root or default_root()
        self.store = EventStore(self.root, self.id)
        self.bus = EventBus()
        self.workdir = workdir or Path.cwd()
        self.title = title
        self.created_at = time.time()
        #: Open spans, so the UI can show what is currently in flight and so a
        #: crashed tool leaves a visible dangling span rather than silence.
        self.open_spans: dict[str, dict[str, Any]] = {}
        self._meta_path = self.store.dir / "meta.json"
        self._write_meta()

    # -- emit ------------------------------------------------------------

    def emit(
        self,
        kind: str,
        payload: dict[str, Any] | None = None,
        actor: str = "system",
        span: str | None = None,
        blob: bytes | None = None,
    ) -> Event:
        """Record, then broadcast. The only way anything becomes visible."""
        digest = self.store.blobs.put(blob) if blob is not None else None
        event = Event(
            kind=kind, payload=payload or {}, actor=actor, span=span, blob=digest
        )
        self.store.append(event)   # durable first
        self.bus.publish(event)    # then live
        return event

    def emit_frame(self, kind: str, image: bytes, stream: str = "default", **meta: Any) -> Event:
        """Convenience for video: the frame body goes to the blob store and the
        event carries only a hash plus metadata, keeping the log text-sized."""
        payload = {"stream": stream, "bytes": len(image), **meta}
        return self.emit(kind, payload, actor="system", blob=image)

    # -- spans -----------------------------------------------------------

    def open_span(self, name: str, kind: str, payload: dict[str, Any], actor: str) -> str:
        span_id = uuid.uuid4().hex[:12]
        self.open_spans[span_id] = {"name": name, "started": time.time(), **payload}
        self.emit(kind, {"name": name, **payload}, actor=actor, span=span_id)
        return span_id

    def close_span(
        self, span_id: str, kind: str, payload: dict[str, Any], actor: str,
        blob: bytes | None = None,
    ) -> Event:
        """Close a span, optionally parking a payload too big for the log.

        Tool output goes in the blob rather than the event: a 200KB build log
        inlined into JSONL makes the log unreadable and untailable, and the blob
        store already dedupes, so a command run twice costs one copy.
        """
        meta = self.open_spans.pop(span_id, None)
        duration = (time.time() - meta["started"]) if meta else None
        return self.emit(
            kind, {**payload, "duration_ms": round(duration * 1000, 1) if duration else None},
            actor=actor, span=span_id, blob=blob,
        )

    # -- subscription ----------------------------------------------------

    def attach(self, from_seq: int = 0, max_buffer: int = 4096) -> tuple[list[Event], Subscriber]:
        """Join the stream, optionally catching up first.

        Returns the backlog and a live subscriber. The subscriber is registered
        *before* the backlog is read, so an event landing between the two is
        delivered live rather than dropped in the seam. The client dedupes by
        seq, which is cheap and makes the seam harmless.
        """
        sub = self.bus.subscribe(Subscriber(max_buffer=max_buffer))
        backlog = list(self.store.read(from_seq=from_seq))
        return backlog, sub

    def detach(self, sub: Subscriber) -> None:
        self.bus.unsubscribe(sub)

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        self.emit(Kind.SESSION_STARTED, {
            "session": self.id, "title": self.title,
            "workdir": str(self.workdir), "created_at": self.created_at,
        })

    def end(self, reason: str = "complete") -> None:
        # Any span still open when a session ends is a bug or a crash. Close it
        # explicitly so a replay shows a failure rather than an event that never
        # resolves and a spinner that spins forever.
        for span_id, meta in list(self.open_spans.items()):
            self.close_span(span_id, Kind.TOOL_ERROR,
                            {"error": f"abandoned at session end ({reason})",
                             "name": meta.get("name")}, actor="system")
        self.emit(Kind.SESSION_ENDED, {"reason": reason, "events": self.store.length})
        self._write_meta()
        self.store.close()

    def name_from(self, text: str) -> None:
        """Take a name from the first thing asked of this session.

        A session id is a timestamp and a nonce: perfect for finding a session
        again, useless for recognising one in a list. The opening request is
        what the session is actually about, so the first one names it.

        Only when nothing better exists. A title passed in deliberately -- by a
        scheduled task, or by whoever opened the session -- outranks a guess.
        """
        if self.title.strip() or not text.strip():
            return

        # First sentence or line, whichever comes first, clipped to something
        # that fits a list row without a tooltip.
        head = text.strip().splitlines()[0].strip()
        for stop in (". ", "? ", "! "):
            if stop in head:
                head = head.split(stop)[0] + stop.strip()
                break
        if len(head) > 60:
            head = head[:57].rstrip(" ,;:-") + "…"

        self.title = head
        self._write_meta()

    def _write_meta(self) -> None:
        """A sidecar so the session list can be built without parsing logs."""
        self._meta_path.write_text(json.dumps({
            "id": self.id, "title": self.title, "created_at": self.created_at,
            "workdir": str(self.workdir), "events": self.store.length,
            "updated_at": time.time(),
        }, indent=2))

    def checkpoint(self) -> None:
        self._write_meta()


class SessionRegistry:
    """Tracks live sessions and lists recorded ones for replay."""

    def __init__(self, root: Path | None = None):
        self.root = root or default_root()
        self.root.mkdir(parents=True, exist_ok=True)
        self.live: dict[str, Session] = {}

    def create(self, title: str = "", workdir: Path | None = None) -> Session:
        session = Session(root=self.root, title=title, workdir=workdir)
        self.live[session.id] = session
        session.start()
        return session

    def get(self, session_id: str) -> Session | None:
        return self.live.get(session_id)

    def open_recorded(self, session_id: str) -> EventStore | None:
        """Open a finished session's log read-only, for replay."""
        if not (self.root / session_id / "events.jsonl").exists():
            return None
        return EventStore(self.root, session_id)

    def list(self) -> list[dict[str, Any]]:
        out = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            meta_path = d / "meta.json"
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text())
                except json.JSONDecodeError:
                    meta = {"id": d.name}
            else:
                meta = {"id": d.name}
            meta["live"] = d.name in self.live
            out.append(meta)
        return out
