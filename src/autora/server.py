"""HTTP + WebSocket transport.

The whole API is small on purpose, because there is only one thing to transport:
events. Live viewing, replay, and joining halfway through are the same
operation with a different starting sequence number.

Note what is *not* here: no separate "recording" endpoint, no export pipeline, no
second serialization format. A recording is a session whose log stopped growing.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import mimetypes
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .agent import Agent, build_registry, compose_system
from .events import Kind
from .memory import MemoryStore, project_scope
from .policy import PolicyGate
from .schedule import CronError, Job, Scheduler
from .session import SessionRegistry
from .settings import Settings, build_provider
from .tools.desktop import RelayBridge
from .tools.terminal import export_asciicast

# Python does not know this one, and a manifest served as octet-stream is a
# manifest the browser declines to install from.
mimetypes.add_type("application/manifest+json", ".webmanifest")


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
        memory_db=None,
    ):
        self.sessions = SessionRegistry(root)
        self.memory = MemoryStore(memory_db) if memory_db is not False else None
        self.gate = PolicyGate(auto_approve=auto_approve)
        self.workdir = workdir or Path.cwd()
        self.provider = provider
        self.relay = RelayBridge()
        self.tools = build_registry(
            headless=headless,
            chrome_path=chrome_path,
            profile_dir=browser_profile_dir,
            relay=self.relay,
            memory=self.memory,
        )
        self.agents: dict[str, Agent] = {}
        self._turns: dict[str, asyncio.Task] = {}
        self.schedule = Scheduler(
            self.sessions.root / "schedule.json", launch=self.launch_job
        )
        #: Operator standing instructions, folded into every agent's prompt.
        self.instructions = Settings.load().system_prompt

    def create_session(self, title: str = "") -> str:
        session = self.sessions.create(title=title, workdir=self.workdir)
        if self.provider is not None:
            self.agents[session.id] = Agent(
                session, self.provider, self.tools, gate=self.gate,
                memory=self.memory, system=compose_system(self.instructions),
            )
        return session.id

    def agent_for(self, session_id: str) -> Agent | None:
        return self.agents.get(session_id)

    def use_instructions(self, text: str) -> None:
        """Change the standing instructions, including mid-session.

        Same reasoning as the provider: an edit that only takes effect after a
        restart is an edit most people will conclude did not work. The prompt
        is read when a turn is composed, so an open session picks this up on
        its next turn without losing its history.
        """
        self.instructions = (text or "").strip()
        system = compose_system(self.instructions)
        for agent in self.agents.values():
            agent.system = system

    def use_provider(self, provider) -> None:
        """Swap the model client, including in sessions already open.

        Editing a key is only useful if it takes effect; making someone restart
        the app to pick up a corrected key is most of the reason the key was
        wrong for so long. Agents hold their own reference, so they are updated
        too -- an open session keeps its history and simply continues against
        the new model.
        """
        self.provider = provider
        for agent in self.agents.values():
            agent.provider = provider

    async def launch_job(self, job: Job) -> str:
        """Open a session for a scheduled task and set the agent going in it.

        Deliberately fire-and-forget: the scheduler's job is to start the run,
        not to sit inside it. The session is live from this moment, so the run
        is watchable in the UI exactly like one someone typed.
        """
        session_id = self.create_session(title=job.name)
        session = self.sessions.get(session_id)
        agent = self.agent_for(session_id)
        if agent is None:
            raise RuntimeError("no model provider configured")
        session.emit(Kind.LOG, {"event": "schedule.fired", "job": job.id,
                                "name": job.name, "cron": job.cron},
                     actor="system")
        task = asyncio.create_task(agent.run_turn(job.prompt))
        self._turns[session_id] = task
        task.add_done_callback(lambda t: _report_turn_failure(session, t))
        task.add_done_callback(lambda t: self.learn_from(session, t))
        return session_id

    def learn_from(self, session, task: asyncio.Task) -> None:
        """After a turn lands, decide what was worth keeping.

        Deliberately after, not during: distillation is a judgement about the
        whole run, and the run is not finished until it is finished. It costs a
        model call, so it is skipped for sessions that failed or were
        interrupted -- a procedure learned from a broken run teaches the break.
        """
        if self.memory is None or self.provider is None:
            return
        if task.cancelled() or task.exception() is not None:
            return

        async def run() -> None:
            from .distill import distill
            try:
                await distill(self.provider, self.memory, session,
                              project_scope(session.workdir))
            except Exception as exc:
                # Learning is a bonus, never the thing that breaks a session.
                session.emit(Kind.LOG, {"event": "distill.failed",
                                        "error": f"{type(exc).__name__}: {exc}"},
                             actor="system")

        self._learning = asyncio.create_task(run())


#: What Android looks for before it offers to install a downloaded file as a
#: certificate. Served as bytes with this type rather than as a static file,
#: because a `.crt` handed over as octet-stream lands in Downloads and does
#: nothing, which looks exactly like the link being broken.
CA_MEDIA_TYPE = "application/x-x509-ca-cert"


def create_app(
    harness: Harness,
    ui_dist: Path | None = None,
    secure_port: int | None = None,
    tls_dir: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="Autora")
    app.state.harness = harness

    def ca_file() -> Path | None:
        candidate = (tls_dir / "ca.crt") if tls_dir else None
        return candidate if candidate and candidate.exists() else None

    @app.get("/api/origin")
    async def origin() -> dict[str, Any]:
        """Where a secure copy of this page is listening, and how to trust it.

        The page can tell for itself whether it is a secure context -- it just
        cannot tell where to find one. Without this, an http page reached from a
        phone can only say that voice needs https and leave you to work out the
        rest; with it, the same page can offer the link.

        The host is deliberately not included: whatever name or address reached
        this listener is the one that will reach the other, and it is the only
        one the client is known to have a route to.
        """
        return {"secure_port": secure_port, "certificate": ca_file() is not None}

    @app.get("/autora-ca.crt")
    async def certificate_authority() -> Response:
        """The authority that signs this server's certificate.

        Public half only -- this is the part that is meant to be copied around.
        Installing it on a device is what turns the warning, the missing
        microphone and the refusal to install to a home screen into an ordinary
        trusted site, because all three are the same fact: nothing had vouched
        for the certificate.
        """
        path = ca_file()
        if path is None:
            raise HTTPException(404, "this server is not running its own authority")
        return Response(
            content=path.read_bytes(),
            media_type=CA_MEDIA_TYPE,
            headers={"Content-Disposition": 'attachment; filename="autora-ca.crt"'},
        )

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

    @app.post("/api/sessions/{session_id}/pick")
    async def pick(session_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """What is at this point of the page, asked from the UI.

        Pointing is a more precise way to ask than describing. The pick is
        emitted to the log like any other event, so the agent sees that the
        human pointed at something and at what -- the selection becomes part of
        the conversation rather than a side channel.
        """
        session = harness.sessions.get(session_id)
        if session is None:
            raise HTTPException(404, "no such live session")
        tool = harness.tools.get("browser")
        if tool is None:
            raise HTTPException(404, "browser tool is not available")

        result = None
        async for chunk in tool.run(
            session,
            {"action": "pick", "x": float(body.get("x", 0)),
             "y": float(body.get("y", 0)), "label": body.get("label") or "selected"},
            "ui-pick",
        ):
            result = chunk
        if result is None or not result.ok:
            return {"ok": False, "error": result.content if result else "no result"}
        return {"ok": True, "text": result.content, **(result.display or {})}

    # -- knowledge ------------------------------------------------------
    # The whole store, for the Knowledge Web. Memory you cannot see is memory
    # you cannot correct, and a graph you can delete from is the only kind
    # worth trusting.

    @app.get("/api/memory")
    async def list_memory(q: str = "", include_retired: bool = False) -> dict[str, Any]:
        if harness.memory is None:
            return {"records": [], "links": [], "enabled": False}
        store = harness.memory
        records = (store.search(q, scopes=_all_scopes(store), limit=200)
                   if q else store.all(include_retired=include_retired))
        return {
            "records": [r.to_dict() for r in records],
            "links": store.links(),
            "enabled": True,
        }

    @app.get("/api/memory/{record_id}")
    async def read_memory(record_id: str) -> dict[str, Any]:
        if harness.memory is None:
            raise HTTPException(404, "memory is disabled")
        record = harness.memory.get(record_id)
        if record is None:
            raise HTTPException(404, "no such record")
        return record.to_dict()

    @app.patch("/api/memory/{record_id}")
    async def edit_memory(record_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Pin, unpin, or correct a record by hand."""
        if harness.memory is None:
            raise HTTPException(404, "memory is disabled")
        store = harness.memory
        record = store.get(record_id)
        if record is None:
            raise HTTPException(404, "no such record")
        fields, values = [], []
        for key in ("title", "body", "status"):
            if key in body:
                fields.append(f"{key}=?")
                values.append(body[key])
        if "pinned" in body:
            fields.append("pinned=?")
            values.append(int(bool(body["pinned"])))
        if fields:
            store.db.execute(
                f"UPDATE records SET {', '.join(fields)}, updated=? WHERE id=?",
                (*values, time.time(), record_id))
            store.db.commit()
        return store.get(record_id).to_dict()   # type: ignore[union-attr]

    @app.delete("/api/memory/{record_id}")
    async def delete_memory(record_id: str, hard: bool = False) -> dict[str, Any]:
        if harness.memory is None:
            raise HTTPException(404, "memory is disabled")
        return {"ok": harness.memory.forget(record_id, hard=hard)}

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
        task.add_done_callback(lambda t: harness.learn_from(session, t))
        return {"ok": True, "queued": False}

    @app.post("/api/sessions/{session_id}/interrupt")
    async def interrupt(session_id: str) -> dict[str, Any]:
        agent = harness.agent_for(session_id)
        if agent is None:
            raise HTTPException(404, "no agent for session")
        return {"interrupted": agent.interrupt()}

    # -- settings -------------------------------------------------------

    @app.get("/api/settings")
    async def get_settings() -> dict[str, Any]:
        state = Settings.load().redacted()
        # What is actually in use may differ from what is saved, if the file
        # was edited by hand since boot. Report both rather than implying the
        # editor's contents are live.
        state["active"] = {
            "model": getattr(harness.provider, "model", None),
            "endpoint": getattr(harness.provider, "base_url", None),
            "provider": getattr(harness.provider, "name", None),
            "hint": getattr(harness.provider, "selected_because", None),
        }
        return state

    @app.patch("/api/settings")
    async def edit_settings(body: dict[str, Any]) -> dict[str, Any]:
        settings = Settings.load().merge(body)
        try:
            settings.save()
        except OSError as exc:
            raise HTTPException(500, f"could not write settings: {exc}") from None
        settings.apply_to_env()

        # Rebuild against the new values. A bad combination must not leave the
        # harness without a working client, so the old one stays until the new
        # one is built.
        harness.use_instructions(settings.system_prompt)
        try:
            harness.use_provider(build_provider(settings))
        except Exception as exc:
            raise HTTPException(400, f"settings saved, but no usable model: {exc}") from None

        state = settings.redacted()
        state["active"] = {
            "model": getattr(harness.provider, "model", None),
            "endpoint": getattr(harness.provider, "base_url", None),
            "provider": getattr(harness.provider, "name", None),
            "hint": getattr(harness.provider, "selected_because", None),
        }
        # Voice is assembled once at startup and bound to a session, so a key
        # for it is saved now and picked up on the next run. Say so rather than
        # letting someone wonder why the microphone did not change.
        state["restart_required_for"] = ["voice"]
        return state

    # -- scheduled tasks -----------------------------------------------

    @app.get("/api/jobs")
    async def list_jobs() -> list[dict[str, Any]]:
        return harness.schedule.list()

    @app.post("/api/jobs")
    async def add_job(body: dict[str, Any]) -> dict[str, Any]:
        try:
            job = harness.schedule.add(
                name=body.get("name", ""),
                cron=(body.get("cron") or "").strip(),
                prompt=(body.get("prompt") or "").strip(),
                enabled=bool(body.get("enabled", True)),
            )
        except CronError as exc:
            raise HTTPException(400, str(exc)) from None
        if not job.prompt:
            harness.schedule.remove(job.id)
            raise HTTPException(400, "a task needs a prompt")
        return {"id": job.id}

    @app.patch("/api/jobs/{job_id}")
    async def edit_job(job_id: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            job = harness.schedule.update(job_id, **body)
        except CronError as exc:
            raise HTTPException(400, str(exc)) from None
        if job is None:
            raise HTTPException(404, "no such job")
        return {"ok": True}

    @app.delete("/api/jobs/{job_id}")
    async def delete_job(job_id: str) -> dict[str, Any]:
        if not harness.schedule.remove(job_id):
            raise HTTPException(404, "no such job")
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/run")
    async def run_job_now(job_id: str) -> dict[str, Any]:
        """Run a task immediately, without waiting for its slot."""
        job = harness.schedule.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job")
        await harness.schedule.fire(job)
        if job.last_error:
            raise HTTPException(400, job.last_error)
        return {"session": job.last_session}

    @app.on_event("startup")
    async def _start_schedule() -> None:
        harness.schedule.start()

    @app.on_event("shutdown")
    async def _stop_schedule() -> None:
        await harness.schedule.stop()

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

    # -- desktop relay ------------------------------------------------

    @app.websocket("/ws/desktop-relay")
    async def desktop_relay_ws(websocket: WebSocket) -> None:
        """The relay (on the controlled machine) connects here.

        It sends continuous frames; the server broadcasts them to all live
        sessions.  It also responds to typed command requests from DesktopTool.
        """
        await websocket.accept()
        bridge = harness.relay
        bridge.attach(websocket)
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if msg.get("type") == "frame":
                    # Broadcast desktop frames to every live session so whoever
                    # is watching sees the relay screen in real time.
                    data = base64.b64decode(msg["data"])
                    for session in harness.sessions.live.values():
                        session.emit_frame(
                            Kind.DESKTOP_FRAME, data, stream="desktop",
                            t=round(time.time(), 3),
                            w=msg.get("w"), h=msg.get("h"),
                        )
                elif msg.get("type") == "hello":
                    # Log the relay connecting so the timeline shows it.
                    for session in harness.sessions.live.values():
                        session.emit(Kind.LOG, {
                            "message": f"Desktop relay connected "
                                       f"({msg.get('platform','?')} "
                                       f"{msg.get('w','?')}×{msg.get('h','?')})",
                        })
                else:
                    bridge.resolve(msg)

        except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
            pass
        finally:
            bridge.detach()

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


def _all_scopes(store) -> list[str]:
    """Every scope present in the store, so a UI search is not scoped to one project."""
    return [r[0] for r in store.db.execute("SELECT DISTINCT scope FROM records")]


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
