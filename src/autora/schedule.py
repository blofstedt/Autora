"""Scheduled tasks.

A job is a prompt plus a cron expression. When it comes due the harness opens a
fresh session and gives the agent the prompt, so a run leaves exactly the same
artefact every other run does: an event log you can watch live or replay. There
is no separate "job output" format, and nothing to clean up afterwards.

Each run gets its own session rather than reusing one. A scheduled task that
appended to a single ever-growing session would carry every previous run in its
context, so the nightly job would get slower and more expensive every night, and
a failure in March would still be sitting in the transcript in June.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable

# How often the loop wakes. Cron resolves to the minute, so anything under a
# minute is enough; 20s keeps a fire within a third of a minute of its slot
# without the loop being a busy-wait.
TICK_SECONDS = 20

# How far ahead next_run is willing to look. Four years and a day, because
# `0 0 29 2 *` is a real schedule whose next slot can be nearly four years out;
# a year-long horizon would report "never" for it. The search skips whole
# non-matching days, so the extra reach costs a few thousand cheap comparisons.
HORIZON_DAYS = 1462


class CronError(ValueError):
    """A cron expression that cannot be parsed."""


def _parse_field(spec: str, low: int, high: int) -> frozenset[int]:
    """One cron field to the set of values it matches.

    Supports the forms that earn their keep: `*`, `5`, `1,15`, `9-17`, `*/15`
    and `0-30/10`. Names (`MON`, `JAN`) are deliberately not supported -- they
    add a lookup table and a locale question to save four characters.
    """
    values: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            raise CronError(f"empty term in {spec!r}")
        step = 1
        if "/" in part:
            part, _, step_text = part.partition("/")
            try:
                step = int(step_text)
            except ValueError:
                raise CronError(f"step {step_text!r} is not a number") from None
            if step < 1:
                raise CronError(f"step must be positive, got {step}")
        if part == "*":
            start, end = low, high
        elif "-" in part.lstrip("-"):
            start_text, _, end_text = part.partition("-")
            try:
                start, end = int(start_text), int(end_text)
            except ValueError:
                raise CronError(f"{part!r} is not a range") from None
        else:
            try:
                start = end = int(part)
            except ValueError:
                raise CronError(f"{part!r} is not a number") from None
        if start < low or end > high or start > end:
            raise CronError(f"{part!r} is outside {low}-{high}")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@dataclass(frozen=True)
class CronSpec:
    """A parsed five-field cron expression, in the server's local timezone."""

    minute: frozenset[int]
    hour: frozenset[int]
    dom: frozenset[int]
    month: frozenset[int]
    dow: frozenset[int]
    # Whether day-of-month / day-of-week were narrowed, which decides how the
    # two combine. See `matches`.
    dom_restricted: bool
    dow_restricted: bool

    @classmethod
    def parse(cls, text: str) -> CronSpec:
        fields = text.split()
        if len(fields) != 5:
            raise CronError(
                f"expected 5 fields (minute hour day month weekday), got {len(fields)}"
            )
        minute, hour, dom, month, dow = fields
        return cls(
            minute=_parse_field(minute, 0, 59),
            hour=_parse_field(hour, 0, 23),
            dom=_parse_field(dom, 1, 31),
            month=_parse_field(month, 1, 12),
            # 7 is Sunday in most crons; fold it onto 0 so both spellings work.
            dow=frozenset(d % 7 for d in _parse_field(dow, 0, 7)),
            dom_restricted=dom.strip() != "*",
            dow_restricted=dow.strip() != "*",
        )

    def matches(self, when: datetime) -> bool:
        if when.minute not in self.minute or when.hour not in self.hour:
            return False
        if when.month not in self.month:
            return False
        # Vixie cron's rule: when both day fields are narrowed the job runs if
        # *either* matches, so "0 0 1 * MON" is the 1st and every Monday. When
        # only one is narrowed, that one decides.
        dom_ok = when.day in self.dom
        dow_ok = (when.weekday() + 1) % 7 in self.dow  # Monday=0 -> Sunday=0
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok
        if self.dom_restricted:
            return dom_ok
        if self.dow_restricted:
            return dow_ok
        return True

    def next_after(self, when: datetime) -> datetime | None:
        """The first matching minute strictly after `when`, or None."""
        cursor = (when + timedelta(minutes=1)).replace(second=0, microsecond=0)
        limit = when + timedelta(days=HORIZON_DAYS)
        while cursor <= limit:
            # Skip a whole non-matching day at a time rather than testing 1440
            # minutes that cannot match.
            probe = cursor.replace(hour=0, minute=0)
            if not self._day_matches(probe):
                cursor = probe + timedelta(days=1)
                continue
            if self.matches(cursor):
                return cursor
            cursor += timedelta(minutes=1)
        return None

    def _day_matches(self, when: datetime) -> bool:
        if when.month not in self.month:
            return False
        dom_ok = when.day in self.dom
        dow_ok = (when.weekday() + 1) % 7 in self.dow
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok
        if self.dom_restricted:
            return dom_ok
        if self.dow_restricted:
            return dow_ok
        return True


@dataclass
class Job:
    id: str
    name: str
    cron: str
    prompt: str
    enabled: bool = True
    created: float = field(default_factory=time.time)
    last_run: float | None = None
    last_session: str | None = None
    last_error: str | None = None

    def spec(self) -> CronSpec:
        return CronSpec.parse(self.cron)


class Scheduler:
    """Owns the job list, persists it, and fires jobs when they come due."""

    def __init__(
        self,
        path: Path,
        launch: Callable[[Job], Awaitable[str]] | None = None,
    ):
        self.path = path
        self.launch = launch
        self.jobs: dict[str, Job] = {}
        self._task: asyncio.Task | None = None
        self._load()

    # -- persistence ----------------------------------------------------

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            rows = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            # A corrupt schedule should not stop the server from booting; an
            # empty one is recoverable from the UI, a crash loop is not.
            return
        for row in rows:
            try:
                job = Job(**row)
                CronSpec.parse(job.cron)
            except (TypeError, CronError):
                continue
            self.jobs[job.id] = job

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(j) for j in self.jobs.values()], indent=2))
        tmp.replace(self.path)

    # -- the list -------------------------------------------------------

    def list(self) -> list[dict[str, Any]]:
        now = datetime.now()
        out = []
        for job in sorted(self.jobs.values(), key=lambda j: j.created):
            row = asdict(job)
            try:
                nxt = job.spec().next_after(now) if job.enabled else None
                row["next_run"] = nxt.timestamp() if nxt else None
                row["cron_error"] = None
            except CronError as exc:
                row["next_run"] = None
                row["cron_error"] = str(exc)
            out.append(row)
        return out

    def add(self, name: str, cron: str, prompt: str, enabled: bool = True) -> Job:
        CronSpec.parse(cron)  # reject a bad expression at the door
        job = Job(
            id=uuid.uuid4().hex[:12],
            name=name.strip() or "Untitled task",
            cron=cron.strip(),
            prompt=prompt,
            enabled=enabled,
        )
        self.jobs[job.id] = job
        self._save()
        return job

    def update(self, job_id: str, **fields: Any) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None:
            return None
        if "cron" in fields and fields["cron"] is not None:
            CronSpec.parse(fields["cron"])
        for key in ("name", "cron", "prompt", "enabled"):
            if key in fields and fields[key] is not None:
                setattr(job, key, fields[key])
        self._save()
        return job

    def remove(self, job_id: str) -> bool:
        if self.jobs.pop(job_id, None) is None:
            return False
        self._save()
        return True

    # -- firing ---------------------------------------------------------

    def due(self, now: datetime) -> list[Job]:
        """Jobs whose slot is the current minute and that have not run in it.

        Keyed on the minute rather than on elapsed time so a slow tick, a
        restart, or two ticks inside one minute all fire exactly once.
        """
        slot = now.replace(second=0, microsecond=0).timestamp()
        ready = []
        for job in self.jobs.values():
            if not job.enabled:
                continue
            try:
                if not job.spec().matches(now):
                    continue
            except CronError:
                continue
            if job.last_run is not None and job.last_run >= slot:
                continue
            ready.append(job)
        return ready

    async def fire(self, job: Job, slot: datetime | None = None) -> None:
        """Run a job now, stamping it with the slot it is running for.

        The slot is passed in rather than read from the clock: `due` selects on
        one minute and the clock can roll into the next before this runs, which
        would stamp the job a minute ahead and silently swallow its next turn.
        """
        if self.launch is None:
            return
        when = slot or datetime.now()
        job.last_run = when.replace(second=0, microsecond=0).timestamp()
        try:
            job.last_session = await self.launch(job)
            job.last_error = None
        except Exception as exc:
            # A job that cannot start is recorded on the job, not raised: one
            # broken task must not take the scheduler down with it.
            job.last_error = f"{type(exc).__name__}: {exc}"
        self._save()

    async def tick(self, now: datetime | None = None) -> list[Job]:
        now = now or datetime.now()
        fired = self.due(now)
        for job in fired:
            await self.fire(job, now)
        return fired

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(TICK_SECONDS)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):
            pass
        self._task = None
