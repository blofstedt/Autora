"""Fan-out from the event log to live subscribers.

The hard problem in a transparency layer is not getting events out, it is what
to do when a subscriber cannot keep up. A browser screencast at 10fps plus PTY
output from a noisy build can easily outrun a websocket on a slow link.

The naive answers are both wrong:

  * Unbounded queues -> the server's memory grows until it dies, and the
    subscriber falls further behind forever, showing stale video.
  * Drop-oldest on a full queue -> you silently lose tool results and the
    client's view of what the agent did becomes a lie.

Autora's policy is per-kind, because the kinds have genuinely different
semantics:

  * Frames (LOSSY_KINDS) are *coalesced* -- only the newest frame per stream is
    kept. A subscriber on a slow link sees a lower frame rate, which is exactly
    the correct degradation for video, and never falls behind.
  * Everything else is buffered losslessly. If a subscriber still overflows, it
    is disconnected with a resumable seq rather than being fed a corrupted
    stream; it reconnects and replays from the log, which is on disk anyway.

That last point is why the event-log-as-substrate design pays off here: the bus
is allowed to be lossy under pressure precisely because the log is not.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Callable

from .events import Event, LOSSY_KINDS


class Subscriber:
    """One live consumer of a session's event stream."""

    def __init__(self, max_buffer: int = 2048, kind_filter: Callable[[str], bool] | None = None):
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=max_buffer)
        self._kind_filter = kind_filter
        #: Newest pending frame per coalescing key, replacing any older one.
        self._latest_frame: dict[str, Event] = {}
        self._frame_wakeup = asyncio.Event()
        self.overflowed = False
        self.last_seq = -1
        self._closed = False

    def offer(self, event: Event) -> None:
        """Non-blocking hand-off from the emitter. Never awaits, never raises."""
        if self._closed:
            return
        if self._kind_filter is not None and not self._kind_filter(event.kind):
            return

        if event.kind in LOSSY_KINDS:
            # Coalesce: one slot per stream, newest wins. A subscriber that
            # stalls for a second and resumes sees the current frame, not a
            # second-old backlog it would have to burn through.
            key = f"{event.kind}:{event.payload.get('stream', 'default')}"
            self._latest_frame[key] = event
            self._frame_wakeup.set()
            return

        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # Lossless kinds must not be dropped. Mark the subscriber broken so
            # the transport closes it; the client resumes from `last_seq` via
            # the on-disk log and misses nothing.
            self.overflowed = True
            self._frame_wakeup.set()
            try:
                self._queue.put_nowait(None)  # wake the reader
            except asyncio.QueueFull:
                pass

    async def stream(self) -> AsyncIterator[Event]:
        """Yield events until the subscriber is closed or overflows."""
        while not self._closed:
            if self.overflowed:
                return
            # Drain buffered lossless events first -- ordering within the
            # lossless stream is meaningful and must be preserved.
            try:
                event = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                event = None

            if event is not None:
                self.last_seq = max(self.last_seq, event.seq)
                yield event
                continue

            # Then any coalesced frame.
            if self._latest_frame:
                _, frame = self._latest_frame.popitem()
                self.last_seq = max(self.last_seq, frame.seq)
                yield frame
                continue

            if self.overflowed:
                return

            # Nothing pending: sleep until something arrives.
            self._frame_wakeup.clear()
            getter = asyncio.ensure_future(self._queue.get())
            waker = asyncio.ensure_future(self._frame_wakeup.wait())
            done, pending = await asyncio.wait(
                {getter, waker}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if getter in done:
                got = getter.result()
                if got is None:
                    if self.overflowed or self._closed:
                        return
                    continue
                self.last_seq = max(self.last_seq, got.seq)
                yield got

    def close(self) -> None:
        self._closed = True
        self._frame_wakeup.set()
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


class EventBus:
    """Publishes to zero or more subscribers. One bus per session."""

    def __init__(self) -> None:
        self._subscribers: set[Subscriber] = set()

    def subscribe(self, sub: Subscriber) -> Subscriber:
        self._subscribers.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subscribers.discard(sub)
        sub.close()

    def publish(self, event: Event) -> None:
        """Fan out. Synchronous and non-blocking so that emitting an event can
        never stall the agent -- a hung websocket must not be able to pause the
        thing it is observing."""
        dead = []
        for sub in self._subscribers:
            sub.offer(event)
            if sub.overflowed:
                dead.append(sub)
        for sub in dead:
            self._subscribers.discard(sub)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
