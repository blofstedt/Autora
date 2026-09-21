# Working on Autora

Notes for whoever (or whatever) works on this repository next. The owner is
not a programmer and does not read diffs, so this file carries the things a
reviewer would otherwise have to catch.

## Commit straight to main

The owner's standing instruction: **do the work, commit it to `main`, push it.**
No branch, no pull request, unless they ask for one. It is a personal project;
the cost of a bad commit is annoyance, not an outage.

That trade only holds if the work is actually checked before it lands, because
nobody else is checking it. Before every push:

```bash
python3 tests/run_all.py          # every suite, ~1 minute
cd ui && pnpm build               # tsc + vite; a type error must not ship
```

A push to `main` publishes a container image immediately (see below), so a
broken commit is a broken install. Run both. If something fails and you cannot
fix it, push nothing and say so.

## Every change that ships needs a version bump

Umbrel decides an update exists by comparing one string. A change can be
merged, built, pushed to the registry and sitting in the store while every
installed copy reports itself up to date. So a change that reaches the
container moves **both** of these, in the same commit:

- `blofstedt-autora/umbrel-app.yml` — `version`, and `releaseNotes` rewritten
  to say what actually changed, in plain language the owner will read on the
  update screen.
- `src/autora/__init__.py` — `__version__`, the same string. The app reports
  this to the page, to Settings and to the relay's probe; if it disagrees with
  the manifest the app will deny a release the store has already shipped.
  `tests/test_release_check.py` fails if they drift.

Docs, tests and CI can change freely with no release. CI checks this on pull
requests and reports it on pushes.

## How a change reaches the owner's machine

1. Push to `main`.
2. `.github/workflows/docker.yml` builds `ghcr.io/blofstedt/autora:latest`
   (amd64 + arm64). Takes about three to four minutes.
3. Umbrel's community store re-reads `umbrel-app.yml`, sees the higher
   `version`, and offers **Update** on the app page. Nothing is pulled until
   the owner presses it.
4. The browser then has to pick up the new page. It is network-first, so a
   reload normally does it; if the tab was loaded while the container was
   restarting it can be pinned to the old shell, which is what the update
   banner in the UI detects and fixes.

When you tell the owner something has shipped, tell them which of these steps
they still have to do. "It is merged" is not "it is running".

## What this app is

The event log is the product. Everything the agent does emits a typed event to
an append-only log; the UI is a subscriber to that log, and a recording is the
log read back. If you find yourself adding a second source of truth for what
happened — a cache, a separate recording path, state held only in a component —
that is the thing to stop and reconsider.

The work belongs in the conversation: a command, a page, a desktop and an edit
each appear as a card where the agent reached for them. There is no stage, no
pane switcher and no scrubber; reviewing a session is scrolling it.

## House style

- Comments explain *why*, especially where the obvious implementation is
  wrong. Several comments in here are load-bearing — the websocket route order
  in `server.py`, the frame crossfade in `Frame.tsx` — and say so.
- Commit messages are written for someone who was not here: what was wrong,
  what the evidence was, what changed. Look at `git log` before writing one.
- No new runtime dependencies in the UI without a good reason. Fonts are
  vendored and it works on an airgapped box; keep it that way.
- Dark theme only, one column, phone and desktop from the same layout.
