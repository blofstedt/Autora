# Autora: rules for every change

## Release every change that reaches the container (CI enforces this)

The "Release version" workflow (`.github/scripts/check_release.py`) fails any
change to `src/`, `server/`, `server.ts`, `package.json`, `public/`, `ui/src/`,
`ui/public/`, `ui/index.html`, `ui/package.json`, `Dockerfile` or
`blofstedt-autora/docker-compose.yml` unless the same branch also:

1. Bumps `"version"` in `package.json` to a higher number (patch bump by
   default, e.g. 0.9.1 -> 0.9.2), and the top two `"version"` fields in
   `package-lock.json` to the same number.
2. Rewrites `releaseNotes` in `blofstedt-autora/umbrel-app.yml` to describe
   this change, not the last release. If the change contradicts the
   manifest's `description`, update that too.

Do not touch `version` in `umbrel-app.yml` or the image tag in
`blofstedt-autora/docker-compose.yml`; the check fails if you do. After the
merge, the image workflow builds and publishes `ghcr.io/blofstedt/autora:<version>`
and only then commits both to main (`.github/scripts/offer_release.py`), so
Umbrel never offers an update whose image is still building ("manifest
unknown").

Do this in the same commit as the code change, without being asked. Before
pushing, run the check locally and make sure it passes:

```bash
git fetch -q origin main && python3 .github/scripts/check_release.py --base origin/main --head HEAD
```

Only when a change genuinely has no user-facing effect, skip the bump and put
`[no release]` in the pull request title or body instead.

## Other checks before pushing

- `npm run lint`: typechecks the client (`tsconfig.json`), the server
  (`tsconfig.server.json`) and the tests (`tsconfig.test.json`), then runs
  ESLint (`eslint.config.js`). ESLint is type-aware and aimed at bugs, not
  style: unawaited promises (mark fire-and-forget ones with `void`), hooks
  called conditionally or with stale dependencies, unused code. It must pass
  with no errors or warnings; `.github/workflows/check.yml` and the Docker
  build both run it.
- `npm test`
- `npm run build`

## Where things are

- `server.ts`: the Express app, every `/api/*` route, the `/ws/:session`
  event stream and the agent turn loop.
- `server/`: the pieces it uses. `tools.ts` (the agent's tools), `llm.ts` and
  `providers.ts` (model calls), `browser.ts` (Playwright), `desktop.ts` (the
  relay), `store.ts` / `state.ts` (what is kept on disk under `AUTORA_HOME`),
  `credentials.ts`, `mcp.ts` (plus `mcpcatalog.ts`, `mcpoffer.ts` and
  `mcpscript.ts`: the servers the agent offers, sets up or writes itself),
  `jev/` (the evaluator), `crosssite.ts` (refuses requests and websockets
  started by other websites), `tls.ts` (the optional https listener and the
  certificates it issues), `logs.ts` (the Logs page's ring buffer).
- How it learns and runs on its own:
  - `memory.ts`: the memory graph (ranked recall, merging near-copies,
    provisional to confirmed).
  - `learning.ts`: looking back at a finished turn and deciding what to keep.
  - `scheduler.ts`: cron jobs and watchers.
  - `customtools.ts`: scripts the agent saved as its own tools.
  - `toolhealth.ts`: recent failures per tool, told to the agent.
- Every turn, from any source (the chat box, a job, a watcher), goes through
  `startTurn()` in `server.ts`, and learning runs after it.
- `src/`: the React client. `App.tsx` holds the session and stream;
  `lib/derive.ts` folds the event log into what the thread shows;
  `components/` renders it.
- `tests/`: plain `tsx` scripts, one per area. `npm test` runs every
  `tests/*.test.ts` it finds (`tests/run.ts`), so a new file needs no wiring.
- `docs/ARCHITECTURE.md`: why it is built this way.

## Security rules

Autora has no login of its own and runs shell commands for whoever reaches
it, so these hold for every change:

- Every event goes through `emitEvent()` in `server.ts`, which blanks secrets
  at any depth of the payload (`redactDeep`). Never write to a socket or the
  log around it. A new kind of secret the app reads from the environment
  belongs in `secretTable()` in `server/state.ts`.
- New routes need no auth code, but must not undo `server/crosssite.ts`: it
  refuses state-changing requests and websockets whose `Sec-Fetch-Site` says
  another site started them. Keep side effects off `GET`.
- Anything the agent or a web page produced (HTML, SVG, widgets) is shown in a
  sandboxed frame or served with `Content-Security-Policy: sandbox`, never
  inline on the app's own origin.
- A saved credential is only sent where it belongs: compare parsed hosts
  (`new URL(...).hostname`), never substrings of a URL.
- The default bind is `127.0.0.1`; only the container sets `AUTORA_HOST=0.0.0.0`.

## Standing product decisions

- Autora always runs in yolo mode: no tool call waits for approval in chat.
  `needsApproval` in `server/tools.ts` returns false. Don't reintroduce
  approval prompts or an "Ask me first" setting unless asked.
