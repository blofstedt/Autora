#!/usr/bin/env python3
"""Offer a version on Umbrel, once its image is in the registry.

Run by the image workflow straight after it pushes main's build. It sets
`version` in umbrel-app.yml and the image tag in docker-compose.yml to the
version just published, commits that to main and pushes it. Until then Umbrel
keeps offering the previous release, whose image exists, so there is no
window in which an update names an image that is still building.

Only ever upward: if main already offers this version or a later one (two
merges building side by side, the later one finishing first), nothing is
done. Main is re-read on every attempt, so a push that lost a race with
another commit starts again from the new tip.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import time

from check_release import COMPOSE, IMAGE_LINE, MANIFEST, VERSION_LINE, newer

BOT = ("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com")

ATTEMPTS = 5


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def replace_group(pattern, text: str, value: str) -> str:
    """`text` with the first match's group 1 swapped for `value`."""
    found = pattern.search(text)
    if not found:
        raise SystemExit(f"Nothing to replace: {pattern.pattern}")
    return text[: found.start(1)] + value + text[found.end(1):]


def offer(version: str) -> bool:
    """Commit the bump on top of main's tip. False if there is nothing to do."""
    git("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main")
    git("checkout", "-q", "--force", "--detach", "origin/main")

    manifest_path, compose_path = pathlib.Path(MANIFEST), pathlib.Path(COMPOSE)
    manifest = manifest_path.read_text(encoding="utf-8")
    found = VERSION_LINE.search(manifest)
    offered = found.group(1).strip() if found else ""
    if offered and not newer(version, offered):
        print(f"Main already offers {offered}; {version} is not newer. Nothing to do.")
        return False

    manifest_path.write_text(replace_group(VERSION_LINE, manifest, version), encoding="utf-8")
    compose = compose_path.read_text(encoding="utf-8")
    compose_path.write_text(replace_group(IMAGE_LINE, compose, version), encoding="utf-8")

    git(
        "-c", f"user.name={BOT[0]}", "-c", f"user.email={BOT[1]}",
        "commit", "-q", "-m",
        f"Offer {version} on Umbrel\n\n"
        f"ghcr.io/blofstedt/autora:{version} is published, so point the\n"
        f"manifest and docker-compose.yml at it.",
        "--", MANIFEST, COMPOSE,
    )
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="the version whose image was just pushed")
    version = parser.parse_args(argv).version.strip()
    if not version:
        print("No version given.", file=sys.stderr)
        return 1

    for attempt in range(1, ATTEMPTS + 1):
        if not offer(version):
            return 0
        try:
            git("push", "-q", "origin", "HEAD:main")
        except subprocess.CalledProcessError as err:
            print(f"Push {attempt} failed: {err.stderr.strip()}", file=sys.stderr)
            time.sleep(2 ** attempt)
            continue
        print(f"Umbrel now offers {version}.")
        return 0

    print(f"Could not push the bump to {version} after {ATTEMPTS} tries.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
