#!/usr/bin/env python3
"""Fail a pull request that changes the app without changing what Umbrel reads.

Umbrel decides whether an update exists by comparing one string: `version` in
`blofstedt-autora/umbrel-app.yml`. Not the image digest, not the commit --
that one line. So a change can be merged, built, pushed to the registry and
sitting in the store, and the installed app will still report itself up to
date, because as far as Umbrel is concerned it is. There is nothing to notice
and nothing to retry: removing and re-adding the community store re-fetches the
same manifest and reaches the same conclusion.

That has now happened twice, both times costing a round trip through "why is
the update not showing", so it is checked here instead of remembered.

The rule: if a pull request changes anything that reaches the container, the
manifest has to say so -- a version that went up, and release notes that are
not the previous release's. A refactor with no user-facing effect is a real
thing, so `[no release]` in the pull request title or body opts out and says
why in the same place a reviewer is already looking.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import subprocess
import sys

MANIFEST = "blofstedt-autora/umbrel-app.yml"

#: Paths that change what actually runs in the container. Tests, CI and prose
#: are deliberately absent: they can change freely without a release, and a
#: check that fires on a typo fix in the README is a check people learn to
#: ignore.
WATCHED = (
    "src/",
    "ui/src/",
    # Icons, the manifest and the service worker. Copied into the image
    # verbatim, so they reach a phone exactly as much as the code does -- this
    # was missing until a release that was nothing but new icons sailed past
    # the check it exists to fail.
    "ui/public/",
    "ui/index.html",
    "ui/package.json",
    "Dockerfile",
    "docker-entrypoint.sh",
    "pyproject.toml",
    "blofstedt-autora/docker-compose.yml",
)

OPT_OUT = "[no release]"

VERSION_LINE = re.compile(r'^version:\s*"?([^"\n]+)"?\s*$', re.MULTILINE)


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def changed_files(base: str, head: str) -> list[str]:
    """What this branch changed, as against what has happened on main since.

    Three dots on purpose: two would also report files main touched after the
    branch diverged, and failing someone's docs-only pull request because
    somebody else edited `src/` is exactly the false alarm that teaches people
    to merge past this.
    """
    out = git("diff", "--name-only", f"{base}...{head}")
    return [line for line in out.splitlines() if line]


def touches_the_app(files: list[str]) -> list[str]:
    return [f for f in files if f.startswith(WATCHED)]


def read_manifest(ref: str) -> str:
    try:
        return git("show", f"{ref}:{MANIFEST}")
    except subprocess.CalledProcessError:
        return ""


def version_of(manifest: str) -> str:
    found = VERSION_LINE.search(manifest)
    return found.group(1).strip() if found else ""


def release_notes_of(manifest: str) -> str:
    """The `releaseNotes:` block, without parsing YAML.

    A regex rather than PyYAML because this has to run on whatever Python the
    runner happens to ship, and the shape here is fixed: a folded scalar
    indented under the key, ending at the next key in column zero.
    """
    lines = manifest.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith("releaseNotes:"))
    except StopIteration:
        return ""
    body = []
    for line in lines[start + 1:]:
        if line and not line[0].isspace():
            break
        body.append(line.strip())
    return " ".join(part for part in body if part)


def newer(head: str, base: str) -> bool:
    """Whether `head` would read as an upgrade.

    Umbrel compares versions as versions, so 0.5.10 is above 0.5.9 -- but a
    version that went sideways or backwards offers no update at all, which
    looks identical to the failure this whole check exists to catch.
    """
    def parts(version: str) -> tuple[int, ...] | None:
        pieces = version.split(".")
        if not all(piece.isdigit() for piece in pieces) or not pieces:
            return None
        return tuple(int(piece) for piece in pieces)

    head_parts, base_parts = parts(head), parts(base)
    if head_parts is None or base_parts is None:
        # Not something we can order. It changed, which is the main thing.
        return head != base
    return head_parts > base_parts


VERSION_ATTR = re.compile(r'^__version__\s*=\s*"([^"]+)"', re.MULTILINE)


def running_version() -> str:
    """What the server will report as its own version, or "" if unreadable."""
    try:
        source = pathlib.Path("src/autora/__init__.py").read_text(encoding="utf-8")
    except OSError:
        return ""
    found = VERSION_ATTR.search(source)
    return found.group(1).strip() if found else ""


def opted_out(title: str, body: str) -> bool:
    return OPT_OUT in f"{title}\n{body}".lower()


#: What a push event sends for `before` when there is nothing before it -- a
#: new branch, or the first push after a force. Not a commit, so not a base.
EMPTY_SHA = "0" * 40


def resolve_base(base: str, head: str) -> str:
    """The commit to compare against, given what the event handed us.

    A push to main carries the tip main had beforehand, which is exactly right.
    It can also carry nothing at all, and `git` would rather fail than guess --
    so fall back to the commit's own first parent, which for both an ordinary
    commit and a merge is the main line this landed on.
    """
    if base and base != EMPTY_SHA:
        try:
            return git("merge-base", base, head)
        except subprocess.CalledProcessError:
            pass
    return git("rev-parse", f"{head}^")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("BASE_REF") or "origin/main")
    parser.add_argument("--head", default=os.environ.get("HEAD_REF") or "HEAD")
    args = parser.parse_args(argv)

    head = git("rev-parse", args.head)
    base = resolve_base(args.base, head)

    app_files = touches_the_app(changed_files(base, head))
    if not app_files:
        print("Nothing that reaches the container changed. No release needed.")
        return 0

    title = os.environ.get("PR_TITLE", "")
    body = os.environ.get("PR_BODY", "")
    if opted_out(title, body):
        print(f"{OPT_OUT} in the pull request. Skipping the version check.")
        return 0

    before, after = read_manifest(base), read_manifest(head)
    old_version, new_version = version_of(before), version_of(after)

    shown = "\n".join(f"    {f}" for f in app_files[:10])
    if len(app_files) > 10:
        shown += f"\n    ... and {len(app_files) - 10} more"

    if not new_version:
        print(f"Could not read `version` from {MANIFEST}.", file=sys.stderr)
        return 1

    if new_version == old_version:
        print(
            f"This changes the app, but {MANIFEST} still says {old_version}:\n"
            f"{shown}\n\n"
            f"Umbrel offers an update only when that string is higher than the\n"
            f"installed one, so merging this as-is ships code nobody can get.\n"
            f"Bump `version` and rewrite `releaseNotes` to say what changed --\n"
            f"or put {OPT_OUT} in the pull request if this genuinely has no\n"
            f"user-facing effect.",
            file=sys.stderr,
        )
        return 1

    if not newer(new_version, old_version):
        print(
            f"`version` went from {old_version} to {new_version}, which Umbrel\n"
            f"will not read as an upgrade. It offers an update only for a higher\n"
            f"version, so this ships as quietly as no bump at all.",
            file=sys.stderr,
        )
        return 1

    running = running_version()
    if running and running != new_version:
        print(
            f"`version` is {new_version} but src/autora/__init__.py reports\n"
            f"{running}. The app shows that second number in Settings as the\n"
            f"version actually answering, so a stale one does not just drift --\n"
            f"it tells someone their update did not land when it did.",
            file=sys.stderr,
        )
        return 1

    if release_notes_of(before) == release_notes_of(after):
        print(
            f"`version` is now {new_version}, but `releaseNotes` still describes\n"
            f"{old_version}. Umbrel shows those notes on the update, so leaving\n"
            f"them tells everyone the previous release's news as though it were\n"
            f"this one.",
            file=sys.stderr,
        )
        return 1

    print(f"{MANIFEST}: {old_version} -> {new_version}, with fresh notes. Good to merge.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
