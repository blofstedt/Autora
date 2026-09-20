"""Cron parsing and scheduled-task firing."""

import asyncio
import pathlib
import sys
import tempfile
from datetime import datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from autora.schedule import CronError, CronSpec, Job, Scheduler


def test_field_forms():
    every = CronSpec.parse("* * * * *")
    assert len(every.minute) == 60 and len(every.hour) == 24

    spec = CronSpec.parse("0,30 9-17 * * *")
    assert spec.minute == frozenset({0, 30})
    assert spec.hour == frozenset(range(9, 18))

    step = CronSpec.parse("*/15 * * * *")
    assert step.minute == frozenset({0, 15, 30, 45})

    ranged = CronSpec.parse("0-30/10 * * * *")
    assert ranged.minute == frozenset({0, 10, 20, 30})

    # 7 and 0 are both Sunday.
    assert CronSpec.parse("0 0 * * 7").dow == CronSpec.parse("0 0 * * 0").dow
    print("  field forms ................... ok")


def test_bad_expressions_rejected():
    for bad in ["* * * *", "60 * * * *", "* 24 * * *", "abc * * * *",
                "*/0 * * * *", "5-1 * * * *", ""]:
        try:
            CronSpec.parse(bad)
        except CronError:
            continue
        raise AssertionError(f"{bad!r} should not parse")
    print("  bad expressions rejected ...... ok")


def test_matching():
    spec = CronSpec.parse("30 9 * * *")
    assert spec.matches(datetime(2026, 3, 4, 9, 30))
    assert not spec.matches(datetime(2026, 3, 4, 9, 31))
    assert not spec.matches(datetime(2026, 3, 4, 10, 30))

    # 2026-03-04 is a Wednesday.
    weekday = CronSpec.parse("0 8 * * 3")
    assert weekday.matches(datetime(2026, 3, 4, 8, 0))
    assert not weekday.matches(datetime(2026, 3, 5, 8, 0))
    print("  matching ...................... ok")


def test_day_fields_or_together():
    """Vixie rule: both day fields narrowed means either may match."""
    spec = CronSpec.parse("0 0 1 * 3")  # the 1st, or any Wednesday
    assert spec.matches(datetime(2026, 4, 1, 0, 0))   # the 1st (a Wednesday)
    assert spec.matches(datetime(2026, 3, 11, 0, 0))  # a Wednesday
    assert spec.matches(datetime(2026, 6, 1, 0, 0))   # the 1st (a Monday)
    assert not spec.matches(datetime(2026, 3, 12, 0, 0))  # Thursday, not the 1st

    # Only day-of-month narrowed: weekday must not constrain it.
    dom_only = CronSpec.parse("0 0 15 * *")
    assert dom_only.matches(datetime(2026, 3, 15, 0, 0))
    assert not dom_only.matches(datetime(2026, 3, 16, 0, 0))
    print("  day fields OR together ........ ok")


def test_next_after():
    spec = CronSpec.parse("30 9 * * *")
    nxt = spec.next_after(datetime(2026, 3, 4, 9, 30))
    assert nxt == datetime(2026, 3, 5, 9, 30), nxt  # strictly after

    nxt = spec.next_after(datetime(2026, 3, 4, 8, 0))
    assert nxt == datetime(2026, 3, 4, 9, 30), nxt

    # Far-apart schedule still resolves: 29 Feb only exists on leap years.
    leap = CronSpec.parse("0 0 29 2 *")
    nxt = leap.next_after(datetime(2026, 3, 1, 0, 0))
    assert nxt == datetime(2028, 2, 29, 0, 0), nxt

    # A schedule with no slot inside the horizon reports nothing rather than
    # spinning: 30 February never happens.
    assert CronSpec.parse("0 0 30 2 *").next_after(datetime(2026, 1, 1)) is None
    print("  next_after .................... ok")


def test_add_validates_and_persists():
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "schedule.json"
        sched = Scheduler(path)
        sched.add("Nightly", "0 3 * * *", "summarise the day")

        try:
            sched.add("Broken", "not a cron", "x")
            raise AssertionError("bad cron should be rejected")
        except CronError:
            pass

        reopened = Scheduler(path)
        assert len(reopened.jobs) == 1
        job = next(iter(reopened.jobs.values()))
        assert job.name == "Nightly" and job.cron == "0 3 * * *"

        rows = reopened.list()
        assert rows[0]["next_run"] is not None
        assert rows[0]["cron_error"] is None
        print("  add validates and persists .... ok")


def test_corrupt_file_does_not_crash():
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "schedule.json"
        path.write_text("{not json")
        assert Scheduler(path).jobs == {}

        # A job row that no longer matches the shape is skipped, not fatal.
        path.write_text('[{"id":"a","name":"x","cron":"* * * * *","prompt":"p"},'
                        ' {"id":"b","nonsense":true}]')
        assert list(Scheduler(path).jobs) == ["a"]
        print("  corrupt file tolerated ........ ok")


async def test_fires_once_per_slot():
    with tempfile.TemporaryDirectory() as tmp:
        fired = []

        async def launch(job: Job) -> str:
            fired.append(job.id)
            return f"session-{len(fired)}"

        sched = Scheduler(pathlib.Path(tmp) / "schedule.json", launch=launch)
        job = sched.add("Every minute", "* * * * *", "go")

        at = datetime(2026, 3, 4, 9, 30, 0)
        await sched.tick(at)
        await sched.tick(at.replace(second=41))  # same minute, later tick
        assert fired == [job.id], fired

        await sched.tick(at.replace(minute=31))
        assert len(fired) == 2, fired

        assert sched.jobs[job.id].last_session == "session-2"
        print("  fires once per slot ........... ok")


async def test_disabled_and_failing_jobs():
    with tempfile.TemporaryDirectory() as tmp:
        calls = []

        async def launch(job: Job) -> str:
            calls.append(job.id)
            raise RuntimeError("no provider configured")

        sched = Scheduler(pathlib.Path(tmp) / "schedule.json", launch=launch)
        off = sched.add("Off", "* * * * *", "go", enabled=False)
        on = sched.add("On", "* * * * *", "go")

        await sched.tick(datetime(2026, 3, 4, 9, 30))
        assert calls == [on.id], calls
        assert sched.jobs[off.id].last_run is None

        # A launch that raises is recorded, not propagated.
        assert "no provider configured" in (sched.jobs[on.id].last_error or "")

        # And it does not wedge the schedule: the next slot still tries.
        await sched.tick(datetime(2026, 3, 4, 9, 31))
        assert len(calls) == 2, calls
        print("  disabled + failing jobs ....... ok")


async def main():
    test_field_forms()
    test_bad_expressions_rejected()
    test_matching()
    test_day_fields_or_together()
    test_next_after()
    test_add_validates_and_persists()
    test_corrupt_file_does_not_crash()
    await test_fires_once_per_slot()
    await test_disabled_and_failing_jobs()
    print("\nall schedule tests passed")


if __name__ == "__main__":
    asyncio.run(main())
