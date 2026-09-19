"""HTTP + WebSocket transport.

The whole API is small on purpose, because there is only one thing to transport:
events. Live viewing, replay, and joining halfway through are the same
operation with a different starting sequence number.

Note what is *not* here: no separate "recording" endpoint, no export pipeline, no
second serialization format. A recording is a session whose log stopped growing.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .agent import Agent, build_registry
from .events import Kind
from .policy import PolicyGate
from .session import SessionRegistry
from .tools.terminal import export_asciicast


class Harness:
    """Holds the registry, the gate, and one agent per live session."""

    def __init__(
        self,
        root: Path | None = None,
        provider=None,
        workdir: Path | None = None,
        auto_approve: bool = False,
        headless: bool = True,
        chrome_path: str | None = None,
        browser_profile_dir: str | None = None,
    ):
        self.sessions = SessionRegistry(root)
        self.gate = PolicyGate(auto_approve=auto_approve)
        self.workdir = workdir or Path.cwd()
        self.provider = provider
        self.tools = build_registry(
            headless=headless,
            chrome_path=chrome_path,
            profile_dir=browser_profile_dir,
        )
        self.agents: dict[str, Agent] = {}
        self._turns: dict[str, asyncio.Task] = {}

    def create_session(self, title: str = "") -> str:
        session = self.sessions.create(title=title, workdir=self.workdir)
        if self.provider is not None:
            self.agents[session.id] = Agent(
                session, self.provider, self.tools, gate=self.gate
            )
        return session.id

    def agent_for(self, session_id: str) -> Agent | None:
        return self.agents.get(session_id)


def create_app(harness: Harness, ui_dist: Path | None = None) -> FastAPI:
    app = FastAPI(title="Autora")
    app.state.harness = harness

    # -- sessions ------------------------------------------------------

    @app.get("/api/sessions")
    async def list_sessions() -> list[dict[str, Any]]:
        return harness.sessions.list()

    @app.post("/api/sessions")
    async def new_session(body: dict[str, Any] | None = None) -> dict[str, str]:
        return {"id": harness.create_session((body or {}).get("title", ""))}

    @app.get("/api/sessions/{session_id}/events")
    async def get_events(session_id: str, from_seq: int = 0, limit: int = 5000):
        """Replay without a websocket -- handy for scripts and for debugging."""
        store = _store_for(harness, session_id)
        return [
            {"seq": e.seq, "ts": e.ts, "kind": e.kind, "actor": e.actor,
             "span": e.span, "payload": e.payload, "blob": e.blob}
            for e in store.read(from_seq=from_seq, limit=limit)
        ]

    @app.get("/api/sessions/{session_id}/blobs/{digest}")
    async def get_blob(session_id: str, digest: str):
        """Serve a frame or screenshot.

        Frames are content-addressed and therefore immutable, so they can be
        cached forever. That matters for replay: scrubbing back and forth over a
        timeline re-requests the same frames constantly.
        """
        store = _store_for(harness, session_id)
        data = store.blobs.get(digest)
        if data is None:
            raise HTTPException(404, "no such blob")
        return Response(data, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.get("/api/sessions/{session_id}/cast")
    async def get_cast(session_id: str, span: str | None = None):
        """Terminal output as an asciinema v2 cast."""
        store = _store_for(harness, session_id)
        return Response(
            export_asciicast(store, span=span),
            media_type="application/x-asciicast",
            headers={"Content-Disposition": f'attachment; filename="{session_id}.cast"'},
        )

    # -- driving the agent ---------------------------------------------

    @app.post("/api/sessions/{session_id}/message")
    async def send_message(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        session = harness.sessions.get(session_id)
        agent = harness.agent_for(session_id)
        if session is None:
            raise HTTPException(404, "session is not live")
        if agent is None:
            raise HTTPException(400, "no model provider configured")
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "empty message")

        # A message arriving while the agent is mid-turn is barge-in, not a
        # queue. Interrupt, then take the new instruction -- that is what the
        # person meant by talking over it.
        if agent.busy:
            agent.interrupt()
            existing = harness._turns.get(session_id)
            if existing is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await asyncio.wait_for(asyncio.shield(existing), timeout=10)

        task = asyncio.create_task(agent.run_turn(text))
        harness._turns[session_id] = task
        # Surface a crashed turn in the log instead of an asyncio warning on stderr.
        task.add_done_callback(lambda t: _report_turn_failure(session, t))
        return {"ok": True, "queued": False}

    @app.post("/api/sessions/{session_id}/interrupt")
    async def interrupt(session_id: str) -> dict[str, Any]:
        agent = harness.agent_for(session_id)
        if agent is None:
            raise HTTPException(404, "no agent for session")
        return {"interrupted": agent.interrupt()}

    @app.post("/api/policy/{request_id}")
    async def decide(request_id: str, body: dict[str, Any]) -> dict[str, Any]:
        approved = bool(body.get("approved"))
        who = body.get("who") or "user"
        if not harness.gate.resolve(request_id, approved, who):
            raise HTTPException(404, "unknown or already-settled request")
        return {"ok": True, "approved": approved}

    # -- the live stream -----------------------------------------------

    @app.websocket("/ws/{session_id}")
    async def stream(websocket: WebSocket, session_id: str) -> None:
        """Replay from `from_seq`, then tail live.

        One code path for both. A client that reconnects after a dropped
        connection passes the last seq it saw and misses nothing, which is the
        payoff for persisting before publishing.
        """
        await websocket.accept()
        from_seq = int(websocket.query_params.get("from_seq", 0))

        session = harness.sessions.get(session_id)
        if session is None:
            # Not live: serve the recording, then close. Replay of a finished
            # session needs no subscription.
            store = harness.sessions.open_recorded(session_id)
            if store is None:
                await websocket.send_text(json.dumps({"type": "error", "error": "no such session"}))
                await websocket.close()
                return
            await _send_batch(websocket, store.read(from_seq=from_seq))
            await websocket.send_text(json.dumps({"type": "end", "live": False,
                                                  "length": store.length}))
            await websocket.close()
            return

        backlog, subscriber = session.attach(from_seq=from_seq)
        try:
            await _send_batch(websocket, backlog)
            await websocket.send_text(json.dumps({
                "type": "live", "session": session_id,
                "seq": session.store.length,
                "busy": bool(harness.agent_for(session_id) and harness.agent_for(session_id).busy),
            }))

            # Reading from the socket concurrently keeps the connection honest:
            # without it a half-closed client is only noticed on the next send,
            # which for an idle session may be minutes.
            reader = asyncio.create_task(_drain_client(websocket, harness, session_id))
            try:
                async for event in subscriber.stream():
                    await websocket.send_text(json.dumps({
                        "type": "event", "seq": event.seq, "ts": event.ts,
                        "kind": event.kind, "actor": event.actor, "span": event.span,
                        "payload": event.payload, "blob": event.blob,
                    }))
                if subscriber.overflowed:
                    # Tell the client exactly where to resume; it reconnects and
                    # replays from the log rather than silently missing events.
                    await websocket.send_text(json.dumps({
                        "type": "overflow", "resume_from": subscriber.last_seq + 1,
                    }))
            finally:
                reader.cancel()
        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            session.detach(subscriber)

    # -- UI ------------------------------------------------------------

    if ui_dist is not None and ui_dist.exists():
        # Mount every top-level directory the build produced rather than
        # hardcoding "assets". The bundle also emits /fonts, and hardcoding one
        # name means a new static directory 404s silently at runtime.
        for child in sorted(ui_dist.iterdir()):
            if child.is_dir():
                app.mount(f"/{child.name}", StaticFiles(directory=child), name=child.name)

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(ui_dist / "index.html")

        # Root-level static files the build emits (favicon, manifest, robots).
        @app.get("/{filename}")
        async def root_file(filename: str) -> FileResponse:
            candidate = (ui_dist / filename).resolve()
            if (
                ui_dist.resolve() in candidate.parents
                and candidate.is_file()
                and not filename.startswith(".")
            ):
                return FileResponse(candidate)
            raise HTTPException(404, "not found")
    else:
        @app.get("/")
        async def no_ui() -> HTMLResponse:
            return HTMLResponse(
                "<h1>Autora</h1><p>The API is running. The UI is not built yet:</p>"
                "<pre>cd ui && pnpm install && pnpm build</pre>"
                "<p>Events are available at <code>/api/sessions</code>.</p>",
                status_code=200,
            )

    return app


async def _send_batch(websocket: WebSocket, events) -> None:
    """Send a replay in chunks.

    One JSON array for a 50k-event session would be a multi-megabyte frame the
    client cannot render incrementally; chunking lets the timeline start drawing
    immediately.
    """
    batch: list[dict[str, Any]] = []
    for event in events:
        batch.append({
            "seq": event.seq, "ts": event.ts, "kind": event.kind, "actor": event.actor,
            "span": event.span, "payload": event.payload, "blob": event.blob,
        })
        if len(batch) >= 500:
            await websocket.send_text(json.dumps({"type": "batch", "events": batch}))
            batch = []
    if batch:
        await websocket.send_text(json.dumps({"type": "batch", "events": batch}))


async def _drain_client(websocket: WebSocket, harness: Harness, session_id: str) -> None:
    """Handle client->server messages on the same socket.

    Approvals and interrupts come back over the websocket as well as over REST,
    so the UI does not need a round-trip through fetch() while watching a
    stream.
    """
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "policy":
                harness.gate.resolve(msg.get("request_id", ""), bool(msg.get("approved")),
                                     msg.get("who") or "user")
            elif kind == "interrupt":
                agent = harness.agent_for(session_id)
                if agent is not None:
                    agent.interrupt()
            elif kind == "ping":
                await websocket.send_text(json.dumps({"type": "pong", "t": time.time()}))
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        return


def _store_for(harness: Harness, session_id: str):
    session = harness.sessions.get(session_id)
    if session is not None:
        return session.store
    store = harness.sessions.open_recorded(session_id)
    if store is None:
        raise HTTPException(404, "no such session")
    return store


def _report_turn_failure(session, task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        session.emit(Kind.ERROR, {
            "error": f"{type(exc).__name__}: {exc}", "where": "turn",
        }, actor="system")
