# Autora: rules for every change

## Release every change that reaches the container (CI enforces this)

The "Release version" workflow (`.github/scripts/check_release.py`) fails any
change to `src/`, `server/`, `server.ts`, `package.json`, `public/`,
`index.html`, `vite.config.ts`, `Dockerfile`, `spectra-editor/` or
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

Once per checkout, also `npm --prefix opencut-editor ci` and `npm --prefix autora-3d ci` (both are typechecked and built), and `npm --prefix spectra-editor ci`: the PDF window's
editor is a sub-project with its own dependencies (see docs/MODULES.md).

- `npm run lint`: typechecks the client (`tsconfig.json`), the server
  (`tsconfig.server.json`) and the tests (`tsconfig.test.json`), then runs
  ESLint (`eslint.config.js`). ESLint is type-aware and aimed at bugs, not
  style: unawaited promises (mark fire-and-forget ones with `void`), hooks
  called conditionally or with stale dependencies, unused code. It must pass
  with no errors or warnings; `.github/workflows/check.yml` and the Docker
  build both run it.
- `npm test` (after `npm run build`: the PDF window's test drives the built editor)
- `npm run build`: also builds `spectra-editor/` into `dist/spectra-editor/`

## Where things are

Start from `docs/MAP.md`: the repo by job, the request path, `server.ts` by
region, recipes for common changes. `docs/MODULES.md` has the detail and the
traps for each area (read the part you are changing). `docs/REVIEW.md` lists
known inefficiencies by id. `docs/ARCHITECTURE.md` is why it is built this way.
Search with `--glob '!spectra-editor/**'`: once built, Spectra's fetched
renderer (gitignored, never edit it; Autora's changes are
`spectra-editor/overlay/`) is most of what is on disk.

Rules that hold wherever you are:

- Every turn, from any source (the chat box, a job, a watcher), goes through
  `startTurn()` in `server.ts`, and learning runs after it. A turn cut short
  ends with `turn.agent.done {stopped}`; `resume.ts` tells the next turn.
- Every event goes through `emitEvent()`; the client folds the log with
  `derive()`.
- A new tool: schema in `server/specs/`, case in `runTool` (`server/tools.ts`),
  a family in `server/toolload.ts` if it is specialist, a test in `tests/`.
- Every prop passed into `Thread` must be stable (`useCallback`/`useMemo`);
  a new `position: fixed` element inside a thread card goes in the `:has()`
  exemption in `styles.css`.
- Per-session state held in a map in `server.ts` must be cleared in
  `forgetSession`.
- The embedded editors are Autora's own forks, not dependencies: GenOffice (Pages, Sheets,
  Slides), Spectra (PDF), OpenCut (Video) and GDevelop (Games). Each `*/PIN.json` is one exact
  commit and **never moves to follow upstream**: do not bump a sha to "take a newer one", and
  add no automation that does. What Autora wants different is its own change: an overlay or
  patch (`spectra-editor/overlay/`, `opencut-editor/overlay/`, `gdevelop-editor/overlay/`,
  `office/patches/*.patch`, `office/shim/`), made freely. `tests/pins.test.ts` fails on a pin
  that is not a full commit sha.
- `tests/`: plain `tsx` scripts, one per area; `npm test` runs every
  `tests/*.test.ts` (`npm test -- name` filters), so a new file needs no wiring.


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

## Core principle: remove friction, keep the person's creativity

The agent exists to remove all friction from creative work and to do
non-creative work completely. Ask of every feature: is there creativity in this?

- **No creativity involved, so the agent does it.** Productivity work (Word,
  Excel, PowerPoint, PDF, forms, files, set-up, wiring) runs in full agentic
  mode. Nobody needs to enjoy it. This is what Autora already does.
- **Creativity involved, so the agent guides and the person decides.** It
  brainstorms, asks questions, suggests, explains and handles the technical
  background, but never replaces the person's choices. The goal is to keep
  creativity in the process, not to override it.
- **The mode follows the work, not a setting.** The same chat is full agent on a
  deck and a guide on a novel; switching what the person is making switches
  how the agent behaves. It may watch what the person is doing and work out
  what they are after (the presence and companion code), and it picks a tool
  for them when they cannot find one. It must stay easy to correct.
- **Creative writing:** a tutor and editor. It structures brainstorming, helps
  define characters and places, and critiques. It does not write the story.
  Enforce this by giving the tool family no insert or replace tool, not by a
  prompt rule (see Writers Block in `docs/BACKLOG.md`).
- **Building an app:** the agent handles code, databases and connections. The
  person focuses on design and usability, editing as much as they like
  directly, in real time beside the agent, not only by prompting.
- **Games and 3D (planned):** coding stays in the background. The person asks
  for actions and properties ("slippery", "jump", "run") and the agent makes
  them, but every granular setting stays theirs to change. The story and the
  world are theirs.
- Everything is a canvas where the person's imagination runs the scene: no
  learning curve, no friction. New tools are judged against this.

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
