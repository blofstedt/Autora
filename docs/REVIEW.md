# Repo review, October 2026 (0.9.159, acted on in 0.9.160 and 0.9.161)

A full pass over the repo for inefficiency, weak code, UI inconsistency and how
cheaply an AI can find its way around. Each finding says **what**, the
**evidence** (measured or quoted, so it can be checked), the **fix**, and a
rough **effort** (S < 1 h, M < 1 day, L > 1 day). Ids are stable so a later
change can say "fixes P3".

Companion file: `docs/MAP.md`, a map of the repo by job, for starting a change
from the right two or three files.

## State of the repo

- **Lint** (`npm run lint`: three `tsc` projects + type-aware ESLint): passes,
  no warnings, 52 s.
- **Build**: passes, 20 s.
- **Tests**: see "Test run" at the end.
- The code is careful. Comments explain *why*, past bugs are written down where
  they were fixed, security rules are followed (one redactor, `crosssite.ts`,
  sandboxed frames, hostname comparison). Most findings below are about
  **scale** -- files and bundles that grew past the point where they are cheap
  to load, for a browser or for an AI -- not about sloppiness.

## Status (0.9.161)

What was done after the review, what was measured and found smaller than
first written, and what is left. Findings keep their ids.

| Id | Now |
|---|---|
| A1 | **Done.** `CLAUDE.md` is 7 KB (was 32 KB); the module detail moved to `docs/MODULES.md`, read only for the area being changed. |
| A2 | **Done (0.9.161).** `spectra-editor/src/renderer` (340k lines) is no longer in the repository: `scripts/prepare-spectra-editor.mjs` fetches it from the commit in `spectra/PIN.json` and applies `spectra-editor/overlay/` (a patch to three files and two added files; the old vendored copy differed from upstream in exactly those). Identical output, checked byte for byte. Needs git and the network at build and lint time, as the engine build already did. |
| A3 | **Done**: `CLAUDE.md`, `eslint.config.js`, `Dockerfile`, CI, `check_release.py`, the "The the" headers, `.gitignore`, and a note on `docs/HARNESS_AUDIT.md` that its line numbers have drifted. |
| A4 | **Done**: `docs/MAP.md`. |
| B1 | **Done.** Spectra's page 16.6 -> 3.9 MB, its metadata worker 14 -> 1.3 MB. The 27 other languages are separate files fetched when chosen (`locale-loaders.ts`; the worker is English). |
| B2 | **Done.** `server/staticfiles.ts`: brotli/gzip kept after the first time, hashed `assets/` cached for a year, everything else revalidated by ETag. Used for the app, the Spectra editor and the Office editors. |
| B3 | **Done**: main chunk 620 -> 448 KB (gzip 144 KB), the size warning gone. `AppPreview`, `OfficeWindow` and `SpectraWindow` load when first opened (`components/lazyWindows.ts`) on top of the earlier `Settings`/`Schedule`/`Triggers`/`LiveChat`. |
| B4 | **Done**: `pdf-editor/` is gone and the server bundle is built without a source map (it was never read: the container does not start node with `--enable-source-maps`). |
| C1 | **Substantially done.** `server.ts` 7,999 -> 6,371 lines. Nine route groups left it (`routes/{memory,keys,settings,health,preview,browser,jobs,triggers,proactive}.ts`) and the shapes they share (`Session`, `PreviewRun`, `Notice`, `AutoraEvent`) are in `server/session-types.ts`. What is left in `startServer` is the sessions/message/interrupt/policy core. **`runTurn` (1,750 lines) is not split:** it is a web of closures over a dozen `let`s (`handedOver`, `ranSomething`, `loopReason`, `streamed`, ...), and pulling it apart means giving that state an owner (a `TurnRun` class) first -- a change to make on its own, with the loop tests as the net, not folded into a tidy-up. |
| C2 | Partly: the prompt guides moved to `server/guides.ts` (`tools.ts` 3,190 -> 3,027). `App.tsx` and `browser.ts` are as they were. |
| C3 | **Smaller than written.** `hostOf`, `slug` and `siteOf` are different functions that share a name, not copies. Done: the two local redactors are now `redactForPerson` / `redactForModel`, and the two `usePoll`s are one (`lib/poll.ts`). `withTimeout` x2 differ in their message; left. |
| C4 | **Done.** 323 unused exports/types un-exported, 20 unused declarations deleted, `knip` added (`npm run unused`, a CI step). |
| C5 | Not done. A typed `EventPayloads` map shared by `emitEvent` and `derive()` is its own change: ~250 `any`s, and it touches every emit site. |
| D1 | **Done**: `pdf-editor/`, `PdfWindow.tsx`, `serveEditor` and their CI/Docker/lint lines are gone. **Open:** the PDF agent cursor. The server still computes `cues` (`pdf_replace_text`, `cueForItem`); nothing plays them in Spectra. Porting it means drawing over Spectra's canvas pages (zoom, scroll and page offsets live in its reducer), and the Chromium in the sandbox here predates a JS API pdf.js 6 needs (`Map.getOrInsertComputed`), so no page draws and the overlay could not be seen working. It should be done where a page can be looked at. |
| D2 | **Done**: ~340 lines of unused CSS and four orphan keyframes removed. |
| P1 | **Done** (`forgetSession` clears `workspaces`/`codeTouched`). One shared `Workspace` per folder is not done: each chat's baseline is "what changed since *this* chat last looked", so sharing the file text without sharing the baseline is a rewrite of `codediff.ts` for at most 16 MB per chat that has run code. |
| P2 | **Done**: a chat idle 15 minutes with no viewer and no turn lets go of its parsed log (`unloadIdleLogs`). |
| P3 | **Done**: `Workspace.scan`/`prime` are asynchronous, a directory's files are `stat`ed together. |
| P4 | **Wrong as written.** Measured: 15 microseconds per string. Not worth caching. |
| P5 | `GET /events` now binary-searches. The ledger sum measured at tens of microseconds; left. |
| M1 | **Left as it is, on purpose.** Measured again: the default set is 51 tools, 45 KB; the biggest single schema is `app_preview` at 2.3 KB and the rest are 1-2 KB each, so there is no one thing to cut -- trimming is ~3% for a change to what the model is told, which wants an eval (same tasks, before and after), not an edit. `tests/toolbudget.test.ts` stops it growing unnoticed. |
| U1 | **Done**: `lib/poll.ts`; every poller pauses while the tab is hidden. |
| U2 | **Done**: the `Dock` element is memoised. `Thread` itself is still not `memo`. |
| U3 | **Overstated.** `derive()` costs 0.3 ms at 460 events, 1.3 ms at 2,300 and 3.6 ms at 6,900 (synthetic log), and the page loads at most 5,000 events at a time. Fine; a checkpointed fold matters only for 50k-event threads. |
| U4 | **Done**: one phone tab per open Office app; `word` surface renamed `docx`/`pptx`/`xlsx`, `*Word*` helpers renamed `*Office*`. |
| U5 | Partly: raw-px font sizes scale; `--r-md`, `--r-pill` exist; the accent fallback is gone; the 14 stacking layers above 10 are named tokens (`--z-pop` .. `--z-expanded`, same numbers, no visual change). **Breakpoints are not unified**: CSS cannot use a variable in `@media`, and 560/520/440/760/860/980 are each a different layout's own tipping point, so merging them changes layouts and needs a visual pass. |
| U6 | **Done**: `SecretStore` has no inline styles; the seven `confirm()` calls are `sure()` (`lib/sure.ts`, drawn by `SureHost`). |
| U7 | Partly: `app-x` is now `btn icon ghost` with a size; the other close buttons (`kweb-close`, `immersive-close`) are on a dark overlay or inside the knowledge web and look different on purpose. |
| T1 | **Done**: `npm test -- <name>`, `-- -j 4`. |
| T2 | **Corrected:** the first version of this was wrong. `spectra-editor` had no `tsconfig.json`, so `tsc --noEmit` there checked nothing and passed. It has one now (`paths` map the Tauri imports to the shim), the shim types were fixed (9 real errors), and `npm run typecheck` checks the fetched renderer and the shim together. |
| T3 | Partly: `knip` is in CI, the tool budget is a test. A bundle-size budget is not. |
| T4 | **Done**. |

## Top ten, by payoff

| # | Id | Finding | Effort |
|---|---|---|---|
| 1 | B1 | The PDF window's editor ships **35 MB of JavaScript** (19 MB page + 16 MB worker), 15 MB of it 28 translations nobody chose, uncompressed | S |
| 2 | B2 | No compression and no long-lived caching for any static asset (app, PDF editor, widget) | S |
| 3 | A1 | `CLAUDE.md` is **32 KB (~8k tokens)** loaded into every AI session, mostly one 300-line bullet | M |
| 4 | D1 | `pdf-editor/` (11k lines) and `PdfWindow.tsx` are **dead**: still installed, typechecked, built (6.9 MB), served and shipped in the image | S |
| 5 | P1 | Every chat that ran code keeps its own up-to-16 MB copy of the same folder, never freed (`workspaces` map) | S |
| 6 | P2 | A thread's events, once opened, stay in memory until restart | M |
| 7 | P3 | The code-diff folder scan is synchronous (up to 6,000 `stat`s) on the event loop, several times per round | M |
| 8 | B3 | Main client chunk 620 KB: `SystemPage` is imported both statically and lazily, and `Settings` (1.5k lines) is eager | S |
| 9 | C1 | `server.ts` is 8k lines; `runTurn` alone is 1,750 lines and `startServer` 2,760 | L |
| 10 | U1 | Eleven pollers keep fetching while the tab is hidden; two hand-rolled `usePoll`s disagree | S |

---

## A. Finding your way (AI cost)

### A1. `CLAUDE.md` costs ~8k tokens per session and is hard to scan
**Evidence.** 32,479 bytes. "Where things are" is a single bullet list whose
`server/` item runs ~250 lines with nested parentheticals (the Office paragraph
alone is ~80 lines). It is loaded into every Claude Code session before any
work starts, including sessions that touch one CSS rule.
**Fix.** Keep in `CLAUDE.md` only what must be obeyed every time: release rule,
checks before push, security rules, core principle, standing decisions (~5 KB).
Move the per-module prose to the module's own header comment (most already have
one, see `docs/MAP.md`) or to `docs/MAP.md`, and point at it in one line. The
Office/PDF deep-dives belong in `docs/office.md` / `docs/pdf.md`, read only when
the task is there.
**Effort.** M (moving text, no code).

### A2. The vendored editor drowns every search
**Evidence.** `spectra-editor/` is 541 files, ~344k lines (more than the rest of
the repo combined, ~120k), committed in one commit, 16 MB of it locale JSON. A
plain `grep -r` from the root returns mostly Spectra hits.
**Fix.** Either fetch it from a pin like `office/` and `spectra/` already do
(`scripts/build-spectra.mjs` pattern; keep only `spectra-editor/src/autora/` +
`vite.config.ts` in the repo), or at least add to `.claude/settings.json`
`"permissions": {"deny": ["Read(./spectra-editor/src/renderer/**)"]}` and say in
`CLAUDE.md` to search with `--glob '!spectra-editor/**'`.
**Effort.** S (deny rule) / M (fetch from pin).

### A3. Docs that describe code that no longer runs
**Evidence.**
- `CLAUDE.md` describes `pdf-editor/` and `AgentCues.tsx` (the PDF cursor) as
  the PDF window; the window is `SpectraWindow` (Spectra-PDF) since commit
  e97251e. Spectra, `server/spectra.ts`, `server/spectra/*` and
  `spectra-editor/` are not mentioned in `CLAUDE.md` at all.
- `docs/HARNESS_AUDIT.md` cites `server.ts:2875-4100` and `server.ts:3597-3627`;
  `runTurn` now starts at 3482.
- `server/specs/*.ts` headers read "The the live browser tools", "The the
  desktop tools" ... (generated text).
- `.gitignore` still lists Python caches, `ui/dist/` and `recordings/` from an
  earlier stack.

**Fix.** Update the PDF paragraph, drop line numbers from docs (name symbols),
fix the "The the" headers, prune `.gitignore`. **Effort.** S.

### A4. A map
Done in this change: `docs/MAP.md` -- the request path end to end, `server.ts` by
region (by symbol, not line), every `server/` and `src/` file grouped by job,
route groups, and recipes for the common changes (new tool, route, event kind,
per-session state, setting).

---

## B. Bundles and delivery

### B1. Spectra editor: 35 MB, 15 MB of it translations
**Evidence.** `dist/spectra-editor/assets/index-*.js` 16.6 MB,
`metadata.worker-*.js` 14 MB. `spectra-editor/src/renderer/i18n.ts` statically
imports 28 `locales/<lang>/chrome.json` (~500 KB each); `lib/metadata-host.ts`
and `lib/metadata-carry.ts` import `../i18n`, so the worker carries them too.
Served by `express.static` with no compression (`server/spectra.ts`), so a
phone opening a PDF downloads ~35 MB.
**Fix.** Without editing vendored files: a Vite plugin in
`spectra-editor/vite.config.ts` (beside the existing Tauri aliases) that
resolves `./locales/<not en>/chrome.json` to an empty module, or rewrites them
to `import.meta.glob` lazy imports if other languages must keep working.
Expected: page ~2 MB, worker < 1 MB before compression.
**Effort.** S.

### B2. Nothing static is compressed or cached for long
**Evidence.** `app.use(express.static(distPath))` (`server.ts`, end of
`startServer`), `server/spectra.ts`, `server/pdfdesk.ts`: no compression, no
`maxAge`/`immutable`, so hashed `assets/*` are revalidated on every load.
`server/officedesk.ts` `serveOfficeEditors` already has a brotli/gzip cache that
does this right for the Office pages.
**Fix.** Lift the Office brotli cache into one helper (`server/staticfiles.ts`)
and use it for `dist/`, `dist/spectra-editor/`, `dist/widget/`; send
`Cache-Control: public, max-age=31536000, immutable` for hashed `assets/` and
keep `no-store` on `index.html` (already). App JS 620 KB -> ~190 KB gzip; CSS
245 KB -> 44 KB.
**Effort.** S.

### B3. Main client chunk 620 KB
**Evidence.** `vite build` warns: *"SystemPage.tsx is dynamically imported by
App.tsx but also statically imported by App.tsx"* -- `App.tsx` imports
`isSystemTab` from it, which defeats the lazy page. `Settings` (1,507 lines),
`Schedule`, `Triggers`, `Sessions`, `LiveChat` + `lib/voice.ts` (1,925 lines)
and `KnowledgeWeb` are imported eagerly although they are separate pages or
opened on demand.
**Fix.** Move `isSystemTab`/`SystemTab` to `src/lib/` (or `Rail.tsx`); load
`Settings`, `Schedule`, `Triggers` through the existing `lazyPage`; dynamic
import `LiveChat` when talk mode starts.
**Effort.** S.

### B4. Image ships dead weight
**Evidence.** The runtime image copies all of `dist/`: `server.cjs.map` (3.3 MB),
`pdf-editor/` (6.9 MB, dead, see D1).
**Fix.** Drop the map from the runtime stage (or keep it but stop shipping
`pdf-editor`). **Effort.** S.

---

## C. Code structure

### C1. `server.ts` is three programs in one file
**Evidence.** 7,999 lines; 99 top-level functions, 26 module-level `Map`/`Set`s
keyed by session id, 121 routes. `runTurn` is one function of ~1,750 lines
(setup closures to ~4,497, then a `for (;;)` round loop of ~700 lines);
`startServer` is ~2,760 lines of route handlers.
**Why it matters.** Any change near the loop means reading thousands of lines
to be sure of closure-captured state; an AI loading the file pays ~100k tokens.
**Fix, in order of safety.**
1. Move route groups into `server/routes/*` like `artifacts`/`mcp`/`notebooks`
   already are (browser, preview, memory, jobs/triggers, settings/secrets,
   speech). Mechanical; each takes the deps it needs as an options object, the
   pattern `systemRoutes(app, {...})` already uses.
2. Gather per-session runtime state into one `SessionRuntime` object
   (`browser`, `preview`, `context`, `workspace`, `amendments`, timers...) so
   `forgetSession` is `runtime.dispose()` and cannot miss one (it already misses
   `workspaces`, see P1).
3. Split `runTurn`'s setup closures into a `TurnContext` class in
   `server/turn.ts`; leave the round loop for last.

**Effort.** L (do 1 first; it is the biggest win per risk).

### C2. Other large files
`server/browser.ts` 4.5k, `server/tools.ts` 3.2k (the `runTool` switch plus all
the `*_GUIDE` prompt text), `server/pdf.ts` 3k, `src/App.tsx` 2.3k (45
`useState`, 33 `useEffect`), `src/styles.css` 6.9k. Split `tools.ts`'s guides
into `server/guides.ts` (prompt text is edited for different reasons than
dispatch code), and `App.tsx`'s composer (voice help, attachments, slash menu)
into `Composer.tsx`. **Effort.** M.

### C3. Same helper, written twice
| Helper | Where |
|---|---|
| `usePoll` | `src/components/Rail.tsx`, `src/components/Dock.tsx` (one checks `document.hidden` and listens for `visibilitychange`, the other does not) |
| `redactSecrets` (local names over one redactor) | `server.ts`, `server/tools.ts`, `server/state.ts` -- three functions with the same name and different behaviour (`identity: false` in one) |
| `hostOf` | `server/memory.ts`, `server/toolhealth.ts`, `src/App.tsx` |
| `withTimeout` | `server/browser.ts`, `server/mcp.ts` |
| `slug` | `server/mcp.ts`, `server/tools.ts` |
| `siteOf` | `server/signins.ts`, `server/site.ts` (different semantics, same name) |
| `runCommand` | `server/tools.ts`, `server/spectra/commands.ts` |

**Fix.** One `src/lib/usePoll.ts` (see U1); rename the local redactors to what
they are (`redactForModel`, `redactForPerson`); one `hostOf`/`withTimeout` in a
small `server/util.ts`. **Effort.** S.

### C4. Dead exports and code
`knip` over the app (vendored editors excluded): 1 unused file
(`src/components/PdfWindow.tsx`), 60 unused exports, 96 unused exported types,
and these functions that nothing calls at all: `renderDocxToPdf`
(`server/officerender.ts`), `testKey` (`server/llm.ts`), `spectraReport`
(`server/spectra.ts`). Also 7 unused icons in `Icons.tsx`, and `TEXT_SIZES` /
`ICON_SIZES` exported twice from `server/state.ts`. **Fix.** Delete the three
functions and the file; drop `export` from the rest; add `knip` as a dev
dependency and a CI step. **Effort.** S.

### C5. Typing
256 `any`s in the server (46 in `server.ts`, 26 in `tools.ts`, 25 in `llm.ts`),
42 in the client. Most come from `payload: Record<string, any>` on events and
untyped request bodies. A typed `EventPayloads` map keyed by `kind`, shared by
`emitEvent` and `derive()`, would let the compiler check that every event the
server emits is folded by the client. **Effort.** M.

---

## D. Dead features still paid for

### D1. The old PDF window
**Evidence.** `SpectraWindow` is the PDF window (`App.tsx`, `Thread.tsx`).
`PdfWindow.tsx` is imported by nothing. `pdf-editor/` is still:
installed in CI and the Dockerfile (`npm --prefix pdf-editor ci`), typechecked
by `npm run lint`, built by `npm run build` (6.9 MB), served at `/pdf-editor`
(`serveEditor` in `server/pdfdesk.ts`), and shipped. Its `AgentCues.tsx` (the
PDF cursor described in `CLAUDE.md`) therefore never plays, while the server
still computes cues (`cueForItem`). `tests/ui-immersive.test.ts` only checks
that `dist/pdf-editor/index.html` exists.
**Fix.** Decide whether the cue animation is wanted in Spectra. If not, delete
`pdf-editor/`, `PdfWindow.tsx`, `serveEditor`, the `.pdf-review*` CSS, the
cue computation, and the lines in CI/Dockerfile/`package.json`. If yes, port
`AgentCues` into `spectra-editor/src/autora/` and then delete the rest.
**Effort.** S (delete) / M (port).

### D2. Dead CSS
56 class names in `styles.css` are mentioned nowhere in the client, in whole
families: `neural-*` and `web-node/web-svg/web-stage/web-legend*` (an earlier
knowledge web), `live-orb`, `orb-*`, `live-end*`, `live-pips`, `rail-new`,
`rail-relay`, `stop-btn`, `tool-approve`... ~150 rules. **Fix.** Delete after a
visual check; add a `purgecss --rejected` report to CI. **Effort.** S.

---

## P. Server performance and memory

### P1. One copy of the working folder per chat, never freed
**Evidence.** `workspaces` (`server.ts`, above `workspaceFor`) holds a
`Workspace` per session; each keeps up to `MAX_KEPT_TOTAL` = 16 MB of file text
(`server/codediff.ts`). Every session uses the same `terminalDir()`, so ten
chats that ran code hold ten copies of one folder. `forgetSession` does not
delete from `workspaces`, so deleted and swept chats keep theirs until restart.
**Fix.** Add `workspaces.delete(id)` to `forgetSession` (one line, do now).
Better: one `Workspace` per root, shared, with a per-session baseline marker.
**Effort.** S / M.

### P2. Opened threads never leave memory
**Evidence.** `events` is a lazy getter (`createInitialSession`... `loaded ??=
loadSessionEvents(...)`) with no way back. The code itself mentions threads of
68,000 lines. Opening a few old long threads keeps all of them parsed.
**Fix.** Drop `loaded` for a session with no sockets, no running turn and no
activity for N minutes (a timer in `scheduleEphemeralDrop`'s style); the getter
reloads it on demand. **Effort.** M.

### P3. Synchronous folder walk on the event loop
**Evidence.** `Workspace.walk` uses `readdirSync`/`statSync` over up to 6,000
files; `runTurn` scans before each changing call and at the end of each round.
While it runs, every socket, stream frame and HTTP request of every chat waits.
**Fix.** `fs.promises` with bounded concurrency, or a `fs.watch` (recursive)
dirty set that limits the scan to what changed. **Effort.** M.

### P4. The redactor rebuilds its table for every string
**Evidence.** `redactDeep` calls `redactSecrets` on every string of every event
payload, streamed token deltas included. Each call runs `secretTable()` (walks
`allSecrets()`, `state.keys`, every provider's env keys, `OTHER_ENV_KEYS`) and
joins every secret into a signature string to see whether the cached regex is
still good; then `redactCredentials` builds and sorts the credential list and
does one `split/join` per credential.
**Fix.** Bump a version number wherever secrets, keys or credentials change and
rebuild the combined regex only then; one regex for secrets and credentials.
**Effort.** S.

### P5. Small ones
- `GET /api/sessions` sums the whole usage ledger (up to 5,000 rows) on every
  call; the client polls it every 10 s (`SESSION_POLL_MS`). Keep per-session
  totals as usage is recorded.
- `GET /api/sessions/:id/events` filters the whole array before slicing; events
  are in `seq` order, so binary-search the start.
- `server/store.ts` `sessionFolders` walks every session folder synchronously
  (housekeeping and the Storage page).

---

## M. What the model is sent

### M1. Fixed prefix per call: ~15k tokens before the conversation
**Evidence.** Measured with a fresh state dir: the default tool set (specialist
families unloaded) is 51 tools, 44 KB of schema JSON (~11k tokens; 24.5 KB of
it descriptions); all 66 tools are 78 KB (~19k tokens). `capabilityBriefing()`
adds ~16 KB (~4k tokens). Biggest single schemas: `pdf_edit` 7.1 KB,
`pdf_compose` 4.4 KB, `mcp_offer` 3 KB, `widget_show` 2.5 KB, `app_preview`
2.3 KB, `schedule` 2.1 KB.
**Why it matters.** It is cached by providers that cache, but it is paid on
every cache miss, every compaction, and in full by providers without caching
(local and some OpenAI-compatible servers), and it is context the model must
read past every round.
**Fix.** Read the default-set descriptions beside the `*_GUIDE` text in
`capabilityBriefing` and say each thing once. Move long how-to text (`pdf_edit`'s item formats, `pdf_compose`'s block list)
behind a `*_guide` call the way `office_guide` already does. Add the
measurement as a test with a budget, so growth is a decision.
**Effort.** M.

---

## U. Client: performance and consistency

### U1. Pollers that do not stop when nobody is looking
**Evidence.** Eleven `setInterval` pollers never check `document.hidden`:
`Schedule` (15 s), `Triggers` (15 s), `Settings` (5 s), `McpPage` (5 s),
`StatusPage` (5 s), `NotebooksPage`, `SessionsPage`, `ArtifactsPage` (8 s),
`DevtoolsPanel` (1.5 s), `Notices`, `UpdateNotice`. `AppPreview` polls rects
every 600 ms while tracking. On a phone with the app in the background, these
keep the radio and the server busy.
**Fix.** One `usePoll(url, ms)` in `src/lib/` (Rail's version: hidden check plus
`visibilitychange`) used everywhere. Longer term, push the cheap ones
(sessions list, notices) over the websocket the page already has.
**Effort.** S.

### U2. Unstable prop into `Thread`
**Evidence.** `App.tsx` passes `dock={<Dock targets={{ openMemory: (..) => ..,
settingsTab: (..) => .. }} />}`: a new element and two new arrows on every
App render, against the rule in `CLAUDE.md` ("every prop passed into `Thread`
must be stable"). `Thread` itself is not `memo`ised, so today the cost is the
`Dock` subtree re-rendering; it becomes a full thread re-render the day
`Thread` is memoised.
**Fix.** `useMemo` the `Dock` element (or pass `targets` built with
`useCallback`). Also memoise `Thread`. **Effort.** S.

### U3. The thread re-folds the whole log on every batch
**Evidence.** `App.tsx`: `useMemo(() => share(lastView.current,
derive(events)), [events])` -- `derive()` (`lib/derive.ts`, 1.25k lines) walks
every event every `EVENT_BATCH_MS` (66 ms) while a reply streams. `share()` keeps
the render cheap; the fold is still O(events) per batch. `readActivity(events)`
walks it again.
**Fix.** Checkpoint the fold at the last closed turn and fold only the tail;
closed buckets are immutable. Worth doing once threads with thousands of events
are common. **Effort.** M.

### U4. Office windows: three on a desktop, one on a phone
Desktop keeps one window per app (`OFFICE_PANES`: Pages, Sheets, Slides, each
with a tab). The phone stage has one `"word"` surface showing whichever changed
last (`useWordState`), so a person with a deck and a sheet open sees only one
and cannot switch to the other. The naming (`word`, `useWordState`,
`setWordState`, `resetWord`) also predates Sheets and Slides. **Fix.** One stage
surface per open Office window; rename `word` -> `office` in `stage.ts`,
`Thread.tsx` and `lib/officedesk.ts`. **Effort.** S-M.

### U5. Styling drift
Measured in `src/styles.css`:
- **Text scale ignored**: 19 `font-size`s in raw px instead of
  `calc(Npx * var(--ts, 1))`, so the Appearance text-size setting does not reach
  them -- `.office-pages-*`, `.shot-panel-*`, `.shot-find-none`, `.app-chip`,
  `.diff-writing`, `.jf-cron` (with `!important`), `.jf-hint code`. They are all
  in features added recently, i.e. the drift is ongoing.
- **Undefined token**: `var(--r-md, 10px)` (3 uses); `--r-md` is never defined,
  so it is always the fallback.
- **Two pill radii**: `99px` (61) and `999px` (22) for the same shape.
- **Fallback colours that disagree with the theme**: `var(--accent, #8b7cf6)` in
  `.diff-writing`; the accent is `#6E5BFF`.
- **34 distinct font sizes**, 35 border radii, 128 unique hex colours and 151
  unique `rgba()` literals beside 2,730 `var()` uses.
- **24 `z-index` values** from -1 to 1000 with no scale.
- **20 different `@media` breakpoints** (680, 560, 520, 440, 760, 860, 980,
  1000, 1180, 1400, 1500...).

**Fix.** Add tokens for the type scale (`--fs-xs`..`--fs-xl`, already
multiplied by `--ts`), pill radius (`--r-pill`), z layers (`--z-dock`,
`--z-sheet`, `--z-overlay`, `--z-toast`) and two or three breakpoints; replace
literals file by file. A `stylelint` rule (`declaration-property-value-
disallowed-list` for `font-size: \d+px`) keeps it from coming back.
**Effort.** M.

### U6. Inline styles and native dialogs
- `SecretStore.tsx` has **63** `style={{...}}` (the next highest file has 6),
  with its own font sizes and a hard-coded `rgba(34, 211, 238, 0.15)` badge. It
  looks unlike the other Settings cards because it is styled differently. Move
  it to classes shared with `Credentials.tsx`.
- Seven deletions ask with the browser's `confirm()` (`Credentials`,
  `SecretStore`, `NotebooksPage`, `StatusPage` x2, `ArtifactsPage`), while
  elsewhere the app asks in its own UI. A small shared `ConfirmButton` (two-tap
  "Delete? / Yes") matches the rest and works in installed PWAs where
  `confirm()` is awkward.

**Effort.** S each.

### U7. Button vocabulary
58 distinct first classes on `<button>`: `btn` (115) is the system, then
`cell-act`, `pdf-pill`, `stat-card`, `shot-tool`, `setup-more`, `dock-act`,
`ask-primary`, `app-x`, `notice-x`, `immersive-close`, `linkish`... Several are
the same thing (close buttons: `app-x`, `notice-x`, `immersive-close`,
`kweb-close`). Fold the duplicates into `btn` modifiers (`btn icon ghost` is
already the pattern). **Effort.** M.

---

## T. Tests and tooling

### T1. Tests run one file at a time, with no filter
`tests/run.ts` spawns `tsx` per file serially over 143 files and takes no
arguments. **Fix.** Accept a name filter (`npm test -- pdf`) and run N files in
parallel (`os.availableParallelism()`, with the browser tests in their own
lane). Faster local loops mean the checks in `CLAUDE.md` actually get run.
**Effort.** S.

### T2. `spectra-editor` is not typechecked
`npm run typecheck` covers the app, server, tests and `pdf-editor` (dead), not
`spectra-editor`, whose `src/autora/` shim is Autora's own code. Swap one for
the other. **Effort.** S.

### T3. Add the measurements to CI
`knip` (C4), bundle size budget (B1/B3), tool-schema budget (M1): each a few
lines, each turns a slow drift into a failing check.

---

### T4. `office.test.ts` fails instead of skipping without the Office build
`CLAUDE.md` says the Office tests skip when `dist/office` is not built. The
first test does print "not built", then asserts anyway (`tests/office.test.ts`,
the "each app is a switch of its own" case expects a switched-off message and
gets "not installed"). Guard that case with the same check. **Effort.** S.

## Test run

`npm run build` then `npm test` on 0.9.159, **without** `build-office.mjs` /
`build-spectra.mjs` (the engines CI builds first): **136 of 140 files pass**, in
12 minutes serial (slowest: `pdftext` 69 s, `ui-remark` 41 s, `browsing` 39 s).
The four failures all need those engine builds:

- `office.test.ts`: see T4 (should have skipped).
- `ui-panes.test.ts`: the document pane never opens (no Office build).
- `ui-pdfwindow.test.ts`, `ui-pdfwindow-proxy.test.ts`: Spectra's page loads,
  its engine is not built, the page is never drawn.

Lint (`npm run lint`) and build pass clean.
