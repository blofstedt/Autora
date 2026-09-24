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

What the pull request raises is `version` in package.json (the version the
image is built and tagged as) along with the release notes. The manifest's
`version` and the image tag in docker-compose.yml are left alone: the image
workflow moves both once that version's image is in the registry
(offer_release.py). Raised by hand, Umbrel offered the update minutes before
the image existed, and an update taken then failed with "manifest unknown".
"""

from __future__ import annotations

import argparse
import json
import os
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
    # The TypeScript server the console is built on: server.ts plus server/.
    "server/",
    "server.ts",
    "package.json",
    "public/",
    "ui/src/",
    # Icons, the manifest and the service worker. Copied into the image
    # verbatim, so they reach a phone exactly as much as the code does -- this
    # was missing until a release that was nothing but new icons sailed past
    # the check it exists to fail.
    "ui/public/",
    "ui/index.html",
    "ui/package.json",
    "Dockerfile",
    "blofstedt-autora/docker-compose.yml",
)

COMPOSE = "blofstedt-autora/docker-compose.yml"

IMAGE_LINE = re.compile(r'^\s*image:\s*"?ghcr\.io/blofstedt/autora:([^"\s]+)"?\s*$', re.MULTILINE)

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


def package_version(ref: str) -> str:
    """`version` in package.json at `ref`, or "" if unreadable.

    The server reads its version out of that file, stamps it into the page it
    serves and answers /api/origin with it, and the image workflow tags the
    build with it.
    """
    try:
        found = json.loads(git("show", f"{ref}:package.json")).get("version")
    except (subprocess.CalledProcessError, ValueError):
        return ""
    return found.strip() if isinstance(found, str) else ""


def lock_versions(ref: str) -> list[str]:
    """The two `version` fields package-lock.json keeps for the app itself."""
    try:
        lock = json.loads(git("show", f"{ref}:package-lock.json"))
    except (subprocess.CalledProcessError, ValueError):
        return []
    root = (lock.get("packages") or {}).get("") or {}
    return [str(lock.get("version", "")), str(root.get("version", ""))]


def image_tag(ref: str) -> str:
    """The tag docker-compose.yml runs, or "" if it names none."""
    try:
        found = IMAGE_LINE.search(git("show", f"{ref}:{COMPOSE}"))
    except subprocess.CalledProcessError:
        return ""
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

    before, after = read_manifest(base), read_manifest(head)

    # Checked whatever the pull request touches, and never opted out of: a
    # hand-raised version is the race this whole arrangement exists to avoid.
    moved = []
    if version_of(after) != version_of(before):
        moved.append(f"`version` in {MANIFEST} ({version_of(before)} -> {version_of(after)})")
    if image_tag(head) != image_tag(base):
        moved.append(f"the image tag in {COMPOSE} ({image_tag(base)} -> {image_tag(head)})")
    if moved:
        print(
            "This changes " + " and ".join(moved) + ".\n\n"
            "Leave that to CI and raise `version` in package.json (and\n"
            "package-lock.json) instead. The image workflow sets them once that\n"
            "version's image is in the registry; set here, Umbrel offers the\n"
            "update before the image exists and it fails with \"manifest unknown\".",
            file=sys.stderr,
        )
        return 1

    app_files = touches_the_app(changed_files(base, head))
    if not app_files:
        print("Nothing that reaches the container changed. No release needed.")
        return 0

    title = os.environ.get("PR_TITLE", "")
    body = os.environ.get("PR_BODY", "")
    if opted_out(title, body):
        print(f"{OPT_OUT} in the pull request. Skipping the version check.")
        return 0

    old_version, new_version = package_version(base), package_version(head)

    shown = "\n".join(f"    {f}" for f in app_files[:10])
    if len(app_files) > 10:
        shown += f"\n    ... and {len(app_files) - 10} more"

    if not new_version:
        print("Could not read `version` from package.json.", file=sys.stderr)
        return 1

    if new_version == old_version:
        print(
            f"This changes the app, but package.json still says {old_version}:\n"
            f"{shown}\n\n"
            f"Umbrel offers an update only when the version goes up, so merging\n"
            f"this as-is ships code nobody can get. Raise `version` in\n"
            f"package.json (and package-lock.json) and rewrite `releaseNotes` in\n"
            f"{MANIFEST} to say what changed -- or put {OPT_OUT} in the pull\n"
            f"request if this genuinely has no user-facing effect.",
            file=sys.stderr,
        )
        return 1

    if not newer(new_version, old_version):
        print(
            f"package.json went from {old_version} to {new_version}, which Umbrel\n"
            f"will not read as an upgrade. It offers an update only for a higher\n"
            f"version, so this ships as quietly as no bump at all.",
            file=sys.stderr,
        )
        return 1

    stale = [v for v in lock_versions(head) if v != new_version]
    if stale:
        print(
            f"package.json says {new_version} but package-lock.json still says\n"
            f"{stale[0]}. Set its top two `version` fields to match.",
            file=sys.stderr,
        )
        return 1

    if release_notes_of(before) == release_notes_of(after):
        print(
            f"The version is now {new_version}, but `releaseNotes` in {MANIFEST}\n"
            f"is unchanged. Umbrel shows those notes on the update, so leaving\n"
            f"them tells everyone the previous release's news as though it were\n"
            f"this one.",
            file=sys.stderr,
        )
        return 1

    print(
        f"package.json: {old_version} -> {new_version}, with fresh notes. Good to merge;\n"
        f"Umbrel is offered it once the image is published."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
