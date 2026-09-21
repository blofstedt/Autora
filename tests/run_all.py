#!/usr/bin/env python3
"""Run every suite in one process-per-suite, so a hang in one is isolated."""

import subprocess
import sys
from pathlib import Path

SUITES = [
    ("event store + bus + policy", "test_core.py"),
    ("agent loop", "test_agent_loop.py"),
    ("context + compaction", "test_context.py"),
    ("browser snapshot", "test_browser_snapshot.py"),
    ("pick + guide", "test_pick.py"),
    ("memory + distillation", "test_memory.py"),
    ("inferred links", "test_relate.py"),
    ("entrypoint env parsing", "test_entrypoint_env.sh"),
    ("entrypoint arguments", "test_entrypoint_args.sh"),
    ("settings + provider choice", "test_settings.py"),
    ("persistence + instructions", "test_persistence.py"),
    ("scheduled tasks", "test_schedule.py"),
    ("narration", "test_narration.py"),
    ("voice loop", "test_voice_loop.py"),
    ("transport", "test_server_stream.py"),
    ("desktop relay", "test_relay.py"),
]

def main() -> int:
    here = Path(__file__).resolve().parent
    failures = []
    for label, filename in SUITES:
        path = here / filename
        if not path.exists():
            continue
        print(f"\n\033[1m{label}\033[0m  ({filename})")
        runner = ["sh"] if path.suffix == ".sh" else [sys.executable]
        result = subprocess.run([*runner, str(path)], timeout=180)
        if result.returncode != 0:
            failures.append(label)
    print()
    if failures:
        print(f"\033[31mFAILED:\033[0m {', '.join(failures)}")
        return 1
    print("\033[32mall suites passed\033[0m")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
