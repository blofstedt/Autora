# Autora: rules for every change

## Release every change that reaches the container (CI enforces this)

The "Release version" workflow (`.github/scripts/check_release.py`) fails any
change to `src/`, `server/`, `server.ts`, `package.json`, `public/`,
`index.html`, `vite.config.ts`, `Dockerfile`, `pdf-editor/` or
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

Once per checkout, also `npm --prefix pdf-editor ci`: the PDF window's editor
is a sub-project with its own dependencies (see below).

- `npm run lint`: typechecks the client (`tsconfig.json`), the server
  (`tsconfig.server.json`) and the tests (`tsconfig.test.json`), then runs
  ESLint (`eslint.config.js`). ESLint is type-aware and aimed at bugs, not
  style: unawaited promises (mark fire-and-forget ones with `void`), hooks
  called conditionally or with stale dependencies, unused code. It must pass
  with no errors or warnings; `.github/workflows/check.yml` and the Docker
  build both run it.
- `npm test` (after `npm run build`: the PDF window's test drives the built editor)
- `npm run build`: also builds `pdf-editor/` into `dist/pdf-editor/`

## Where things are

- `server.ts`: the Express app, every `/api/*` route, the `/ws/:session`
  event stream and the agent turn loop.
- `server/`: the pieces it uses. `tools.ts` (the agent's tools), `llm.ts` and
  `providers.ts` (model calls), `browser.ts` (Playwright), `desktop.ts` (the
  relay), `store.ts` / `state.ts` (what is kept on disk under `AUTORA_HOME`),
  `credentials.ts`, `mcp.ts` (plus `mcpcatalog.ts`, `mcpoffer.ts` and
  `mcpscript.ts`: the servers the agent offers, sets up or writes itself),
  `preview.ts` and `pick.ts` (the app window: a second browser per session
  showing what the agent is building, the static server and dev-server
  address finding, and the page-side script that reads what a person
  selected; comments are kept in `server.ts` until sent as one review),
  `pdf.ts` and `pdfrender.ts` (the PDF tools: pdf-lib -- the `@cantoo` fork,
  for encrypted files -- changes the file; pdf.js in a headless Chromium reads
  text and draws pages. Positions are top-left points of the page as shown;
  every result is a new artifact, and dropped or redacted content is removed
  from the bytes, not covered), `pdfdesk.ts` (the PDF window: the file the
  agent works on, open beside the chat in SecurePDF's editor. What `pdf_edit`
  places becomes the editor's own movable objects, each keeping the item it
  came from so the file shows exactly what was drawn until the person changes
  it; the file is the base pages with every object flattened on, rewritten
  on every change; the person's changes are told to the agent once),
  `notebooks.ts` (artifacts grouped by purpose with notes between them,
  stored as `notebooks.json`; retention keeps whatever a notebook holds or
  cites), `guard.ts` (what stops and asks before a risky call), `crosssite.ts` (refuses requests and websockets
  started by other websites), `tls.ts` (the optional https listener and the
  certificates it issues), `logs.ts` (the Logs page's ring buffer).
- How it learns and runs on its own:
  - `memory.ts`: the memory graph (ranked recall, merging near-copies,
    provisional to confirmed).
  - `learning.ts`: looking back at a finished turn and deciding what to keep.
  - `scheduler.ts`: cron jobs and watchers.
  - `customtools.ts`: scripts the agent saved as its own tools.
  - `toolhealth.ts`: recent failures per tool, told to the agent.
  - `suggest.ts`: what to suggest, from what is actually on the install --
    one-tap tasks for a new chat, a schedule offered once, next-step chips
    after a reply. Pure, no model call.
  - `noticer.ts`: cheap checks (disk, Docker over its socket, failed
    schedules) said once and dismissable until they clear.
  - `push.ts` and `webpush.ts`: the installed app is the phone interface, so
    notifications go through it (Web Push, encrypted to the device), held
    during quiet hours. There is deliberately no chat-app or third-party
    channel (Telegram, WhatsApp, ntfy): don't add one.
- Every turn, from any source (the chat box, a job, a watcher), goes through
  `startTurn()` in `server.ts`, and learning runs after it.
- `pdf-editor/`: SecurePDF's editor (from blofstedt/SecurePDF), its own
  sub-project with its own React 19 and Tailwind so neither touches the app.
  It runs in a frame sandboxed without an origin (`components/PdfWindow.tsx`)
  and talks to the page by `postMessage` only; it never calls the API. So it
  bundles pdf.js's legacy build and runs its worker as a classic script from a
  blob (a module worker cannot start in an origin-less frame), and fetches
  nothing from a CDN: Autora may have no internet.
- `src/`: the React client. `App.tsx` holds the session and stream;
  `lib/derive.ts` folds the event log into what the thread shows;
  `components/` renders it.
- Keeping long threads fast (measured: a 150-turn thread went from 100% CPU
  and 7 fps while a reply streamed to about what a 3-turn one costs):
  - `App.tsx` adds streamed events in batches (`EVENT_BATCH_MS`), not one
    render per event.
  - `derive()` output goes through `share()` (`lib/share.ts`), so unchanged
    cards keep their identity; `TurnBucket`, `CellView`, `Reply` and
    `Markdown` are `memo`ised on it. Every prop passed into `Thread` must be
    stable: handlers from `useCallback`, never inline arrows.
  - `.turn` has `content-visibility: auto` in `styles.css`, so off-screen
    turns cost nothing per frame. A new `position: fixed` element inside a
    thread card must be added to the `:has()` exemption there.
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

- Yolo is the default: no tool call waits for approval in chat, and
  `needsApproval` in `server/tools.ts` returns false. Approval is opt-in, per
  chat, by the person: the header's Yolo / Ask selector (`permissions`, with
  `ask_when` for when to ask, in `server/modes.ts`). Don't make Ask the
  default or add approval prompts anywhere else unless asked.
- A chat also has a work mode, chosen in the message box: Agent (the default:
  plans first, then switches itself to build with `set_mode`; the switches show in the thread, the
  selector stays on Agent), Build (works straight away) or Plan (read-only).
  Planning is refused, never asked about.
