#!/usr/bin/env python3
"""Notice when a Flix release is published but not being offered on Umbrel.

Flix is built and tagged in its own repository; the entry that Umbrel reads
lives here, in `blofstedt-flix/`. Nothing connects the two. That is how 0.1.4
was built, pushed to the registry and then sat unshipped: no workflow was
watching the registry, so nobody was told.

This is the watcher. It reads what the registry actually has, compares it with
what our store entry offers, and says so -- on a schedule, and whenever someone
touches the entry by hand.

Three ways to be wrong, all of them silent in the store:

- the registry has a version newer than `version` in umbrel-app.yml: a release
  exists that Umbrel will never offer;
- the manifest's version and the image tag in docker-compose.yml disagree:
  an update naming a different image from the one the notes describe;
- the manifest names a version the registry does not have: an update that
  fails on install with "manifest unknown" (the mistake offer_release.py's
  ordering exists to prevent, which nothing checks for Flix).

A registry that cannot be reached is not a failure: it prints a warning and
exits 0, the same way Flix's own version guard treats it. A check that goes red
because GitHub is briefly unavailable is a check people learn to ignore.

`--report issue` turns the problems into (or updates) one open GitHub issue
labelled `release-gap`, using GITHUB_TOKEN, and closes it again when the gap is
gone. Without that flag -- and when no token is present -- it only prints.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

IMAGE = "viberific/flix"
MANIFEST = "blofstedt-flix/umbrel-app.yml"
COMPOSE = "blofstedt-flix/docker-compose.yml"

VERSION_LINE = re.compile(r'^version:\s*"?([^"\n]+)"?\s*$', re.MULTILINE)
IMAGE_LINE = re.compile(r'^\s*image:\s*"?ghcr\.io/viberific/flix:([^"\s]+)"?\s*$', re.MULTILINE)

LABEL = "release-gap"
MARKER = "<!-- flix-store-gap -->"
GH_API = "https://api.github.com"


def read_pattern(path: str, pattern: re.Pattern[str]) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as error:
        raise SystemExit(f"Cannot read {path}: {error}") from error
    found = pattern.search(text)
    if not found:
        raise SystemExit(f"{path} has no match for {pattern.pattern}")
    return found.group(1).strip()


def parts(version: str) -> tuple[int, ...] | None:
    pieces = version.split(".")
    if not pieces or not all(piece.isdigit() for piece in pieces):
        return None
    return tuple(int(piece) for piece in pieces)


def newest(tags: list[str]) -> str | None:
    """The highest plain version tag. Other tags (latest, sha-…) are ignored."""
    known = [tag for tag in tags if parts(tag) is not None]
    return max(known, key=parts) if known else None


def fetch(url: str, token: str | None = None, accept: str = "application/json"):
    request = urllib.request.Request(url)
    request.add_header("Accept", accept)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 -- fixed hosts
        return json.loads(response.read().decode("utf-8"))


def registry_tags() -> list[str] | None:
    """Every tag in the registry, or None if GitHub would not say."""
    scope = urllib.parse.quote(f"repository:{IMAGE}:pull", safe="")
    try:
        token = fetch(f"https://ghcr.io/token?scope={scope}&service=ghcr.io")["token"]
        return fetch(f"https://ghcr.io/v2/{IMAGE}/tags/list", token=token).get("tags") or []
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, ValueError) as error:
        print(f"::warning::ghcr.io did not answer for {IMAGE} ({error}); nothing checked")
        return None


def problems(offered: str, tag: str, tags: list[str]) -> list[str]:
    """Everything wrong with our store entry, as sentences."""
    out: list[str] = []
    if offered != tag:
        out.append(
            f"umbrel-app.yml offers {offered} but docker-compose.yml names the image tag {tag}"
        )
    found = newest(tags)
    if found and parts(found) and parts(offered) and parts(found) > parts(offered):
        out.append(f"the registry has {found}, newer than the {offered} we offer")
    if offered not in tags:
        out.append(f"the registry has no image tagged {offered}, so an install of it would fail")
    return out


def body_for(offered: str, tag: str, found: str | None, issues: list[str]) -> str:
    lines = [
        MARKER,
        f"Flix's store entry does not match what the registry has.",
        "",
        "| what | value |",
        "| --- | --- |",
        f"| registry's newest | `{found or 'unknown'}` |",
        f"| offered by umbrel-app.yml | `{offered}` |",
        f"| image tag in docker-compose.yml | `{tag}` |",
        "",
        "What is wrong:",
        "",
    ]
    lines += [f"- {issue}" for issue in issues]
    lines += [
        "",
        f"Fix by hand in `{MANIFEST}` and `{COMPOSE}`: set `version` and the image tag to",
        f"`{found or offered}`, and write release notes that are about that version. Then the",
        "Umbrel tile offers it; nothing has to be rebuilt.",
        "",
        "_Opened by `.github/workflows/flix-store-check.yml`; it closes itself once the entry agrees with the registry._",
    ]
    return "\n".join(lines)


def api(path: str, method: str, token: str, payload: dict | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"{GH_API}{path}", data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/vnd.github+json")
    if data:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 -- fixed host
        return json.loads(response.read().decode("utf-8") or "null")


def report_issue(token: str, repo: str, text: str | None) -> None:
    """Keep exactly one open issue: opened/updated with `text`, closed without."""
    open_issues = [
        issue
        for issue in api(f"/repos/{repo}/issues?state=open&labels={LABEL}&per_page=50", "GET", token)
        if MARKER in (issue.get("body") or "")
    ]
    if text is None:
        for issue in open_issues:
            api(f"/repos/{repo}/issues/{issue['number']}", "PATCH", token, {"state": "closed"})
            print(f"closed issue #{issue['number']}")
        return
    if open_issues:
        issue = open_issues[0]
        if (issue.get("body") or "").strip() != text.strip():
            api(f"/repos/{repo}/issues/{issue['number']}", "PATCH", token, {"body": text})
            print(f"updated issue #{issue['number']}")
        else:
            print(f"issue #{issue['number']} already says this")
        return
    made = api(
        f"/repos/{repo}/issues",
        "POST",
        token,
        {
            "title": "A published Flix release is not being offered on Umbrel",
            "body": text,
            "labels": [LABEL],
        },
    )
    print(f"opened issue #{made['number']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="open or close the GitHub issue")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    args = parser.parse_args()

    offered = read_pattern(MANIFEST, VERSION_LINE)
    tag = read_pattern(COMPOSE, IMAGE_LINE)
    tags = registry_tags()
    if tags is None:
        return 0

    found = newest(tags)
    found_issues = problems(offered, tag, tags)
    print(f"registry's newest: {found or 'unknown'}   offered: {offered}   image tag: {tag}")

    token = os.environ.get("GITHUB_TOKEN", "")
    if not found_issues:
        print(f"ok: {offered} is what the registry has and what we offer")
    else:
        for issue in found_issues:
            print(f"::error::{issue}")

    if args.report and token and args.repo:
        report_issue(token, args.repo, body_for(offered, tag, found, found_issues) if found_issues else None)
    elif args.report:
        print("no GITHUB_TOKEN or repository; nothing reported")

    return 1 if found_issues else 0


if __name__ == "__main__":
    sys.exit(main())
