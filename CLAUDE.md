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
  `providers.ts` (model calls), `browser.ts` (Playwright; the session's browser has tabs --
  `tabPages`, `newTab/switchTab/closeTab`, a link to a new tab opens and shows one, the
  sign-in popup returns to its opener when it closes -- and an adaptive stream: `TIERS`
  step down when `hooks.backlog` says a viewer is behind, the rate rises while
  `touched()`, and one sharp screenshot follows when the page has been still), `desktop.ts` (the
  relay), `store.ts` / `state.ts` (what is kept on disk under `AUTORA_HOME`),
  `browsedata.ts` (the browser's history, bookmarks and downloads, one list for the install in
  `browser-data.json`; a download becomes an artifact via `hooks.onDownload`; `LiveBrowser.find`
  walks text nodes itself because headless `window.find` finds nothing), `credentials.ts`, `mcp.ts` (plus `mcpcatalog.ts`, `mcpoffer.ts` and
  `mcpscript.ts`: the servers the agent offers, sets up or writes itself),
  `preview.ts` and `pick.ts` (the app window: a second browser per session
  showing what the agent is building, the static server and dev-server
  address finding, and the page-side script that reads what a person
  selected; comments are kept in `server.ts` until sent as one review),
  `pdf.ts` and `pdfrender.ts` (the PDF tools: pdf-lib -- the `@cantoo` fork,
  for encrypted files -- changes the file; pdf.js in a headless Chromium reads
  text and draws pages. Positions are top-left points of the page as shown;
  every result is a new artifact, and dropped or redacted content is removed
  from the bytes, not covered), `pdftext.ts` (`pdf_replace_text`: reads a page's content stream and the fonts
  it names, finds the words, and rewrites their bytes in place where the font
  holds the letters -- a cut-down font is trusted only with letters the file
  shows it drawing -- or removes the old glyphs and returns where to draw the new
  ones. Edits run one at a time on the stream as the last left it, matches last
  first; the page stays vector, nothing is rasterised. Where it worked, and each
  object `pdf_edit` places (`cueForItem`), go to the window as `cues` on
  `desk.open`; `pdf-editor/src/AgentCues.tsx` plays them -- a cursor that
  retypes, types a box, clicks a stamp into place, drags a box or traces a
  stroke, the toolbar ringed on the tool it would have picked up, and the
  placed objects held back until the cursor lands them. Only ever a
  presentation: the file and the objects are the server's, authorship stays
  with the agent (so the changes are still up for accept/decline), nothing
  injects input into the editor, and the window can switch it off), `pdfdesk.ts` (the PDF window: the file the
  agent works on, open beside the chat in SecurePDF's editor. What `pdf_edit`
  places becomes the editor's own movable objects, each keeping the item it
  came from so the file shows exactly what was drawn until the person changes
  it; the file is the base pages with every object flattened on, rewritten
  on every change; the person's changes are told to the agent once),
  `officedesk.ts` + `src/components/OfficeWindow.tsx` (the Office window, switched on and off with the other windows on the Tools page --
  `office` in `ToolSettings`: the
  Word, PowerPoint or Excel document the agent works on, open beside the chat in
  GenOffice's own editor for it, built by `scripts/build-office.mjs` into
  `dist/office/web/{docs,slides,sheets}` and served at `/office-app` with a sandbox
  CSP. The editor runs in an origin-less frame, so it cannot fetch anything:
  `OfficeWindow` answers its `autora:office` requests (fonts, the document, saves,
  Export PDF -> the PDF window, presence) and passes on the agent's edits;
  `office/shim` is the Electron stand-in, it hides the editor's own AI panel and
  turns its AI group into an "Autora" button that focuses the chat box, and uses
  the editor's dark theme. **Word** keeps the document in the page: the page sends
  the bytes on every save and the agent's edit is pushed in. **PowerPoint and Excel**
  keep it in an engine (`officehost.ts`, one child process per window, started on the
  first ipc): the frame's ipc goes `POST /api/officedesk/:session/ipc?rev=N`, `rev`
  being the window's `loadRev` so a replaced page cannot reach the new one; the
  engine saves to `<session>.work.<ext>`, which is polled every 800 ms
  (`checkEngineFile`) and becomes the document (`personSaved`); the agent's edit is
  written there and handed to the open editor where it stands (`reloadLive`: a deck is read
  again and the page told `slides:deck-changed`, which keeps the slide it was on; a
  workbook is queued again and nudged to open it), and only if that fails is the frame
  remounted (its key follows `loadRev`). `settle()` runs before every Office tool so the person's last edit has
  reached the file. The person's changes are told to the agent once in words made by
  comparing text (`describeChange` for paragraphs and slide text, `describeCells` for
  cells). One surface, `"office"`, for presence and Take control (`touched`, held), as
  for the PDF. **On a phone** the window is not the editor but `components/OfficePages.tsx`:
  pictures of the pages (`officepages.ts`: the editor's PDF, drawn by pdf.js, kept per
  session by a hash of the file's bytes -- the last two -- with each run of text and
  where it sits; `POST /api/officedesk/:session/pages` until `ready`, the previous
  pictures shown dimmed meanwhile). Tapping words points at them (`lib/officeSelection.ts`):
  a chip beside the message box, and `send` in `App.tsx` puts "(Pointing at ... on slide 2
  of pitch.pptx.)" in front of what they type, which is how a phone edits; "Full editor"
  is one button away. `renderToPdf` also keeps the last six PDFs by hash, so the agent
  and the phone share one layout. A tap names what it landed on: a deck's element by the
  id `office_edit` takes (`slideElements` in `office.ts` reads their boxes; shapes and
  pictures with no words are pointed at by their box), a workbook's cell when the value
  is in only one; `locatorFor` in `officedesk.ts`), `officerender.ts` (the same editors headless, for `office_look`
  pictures and `office_pdf`; PDFs always go to Autora's own PDF window),
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
  - `loopwatch.ts` (the same call repeating) and `errorbudget.ts` (the same
    error across *different* attempts; kept per chat by `budgetstore.ts`, eased
    by a success, forgotten after hours): notes in the result the model reads,
    then a stop that is told to the next turn (`resume.ts`).
    `loopwatch.gate` refuses (in a line, tool list unchanged, so the provider's
    cache holds) an exact call repeated after its warning; rounds that change
    nothing earn a `[Stall]` note; an error-budget stop is kept as a provisional
    "dead end" memory. `server/replay.ts` + `npm run replay -- events.json
    [warnAt=3 ...]` replays a recorded chat against these rules, to compare
    settings on the same chat. `context.supersedeReads` stubs old reads in one
    batch (a mid-history edit breaks the provider's cache, so never one by one).
  - `requirements.ts` (`requirements` tool, `requirements.update` in the log):
    what the person asked for, verbatim, with a status. A message that lists its
    asks is split into items; one sent while work is open is kept whole
    (`noteAsks` in `server.ts`); the agent merges, edits, drops. Told every turn
    from the log (so compaction cannot paraphrase it), and `finishAudit` sends
    the agent back once per turn if an ask is neither done nor dropped.
    A message typed while a turn runs is an *amendment* (`turn.amend`), not an
    interrupt: queued in `amendments`, told to the turn at its next round
    boundary (end of the last tool result) or when it is about to finish, and
    answered by a fresh turn if it lands after the last look. Only
    `{mode: "interrupt"}` (Alt/Ctrl/Cmd+Enter), files, voice and `/commands`
    stop the turn first. The project check also runs when a to-do or ask is
    marked done mid-turn (`itemCheckNote`, capped per turn).
  - `office.ts` (`office_guide|read|edit|check|create|convert`, family `office` in
    `toolload.ts`): Word, Excel and PowerPoint files, read and edited without a
    window by running GenOffice's command line (Apache-2.0, github.com/genspark-ai/genoffice)
    as a child process. Nothing of it is copied into this repo:
    `scripts/build-office.mjs` fetches the commit in `office/PIN.json`, bundles its
    CLI and builds its Rust spreadsheet engine into `dist/office/` in GenOffice's
    own "packaged" layout (`cli/`, `wasm/`, `native/`; `office/NOTICE.md`). Bump the
    sha to take a newer one. `npm run build:office` runs it; the Dockerfile builds
    the engine in its own stage with `cargo zigbuild` for musl amd64+arm64 (it has a
    C dependency, so plain `rust-lld` cross-linking does not work) and the CLI in
    the builder; CI runs it before the tests. Without the build the tools are not
    offered (`officeDir()`), without the engine only the Excel ones say so, and
    `tests/office.test.ts` / `e2e-office.test.ts` skip. Results are artifacts like the
    PDF tools' (an edit works on a copy; the agent's own file is updated in place);
    after an Excel edit `refreshFormulas` rewrites every formula so stored results
    of dependents are current (the engine only sets fullCalcOnLoad). **Pictures and
    PDF come from the editors themselves**: laying a page out is GenOffice's *editor's*
    job, not the engines'. Each editor is built (`office/vite/editor.mjs`, run with the
    checkout's own Vite by `build-office.mjs`) as one page for a sandboxed frame --
    `dist/office/web/{docs,slides,sheets}/index.html`: script, styles and worker
    inline, fonts listed in a manifest and supplied by the host, PDF import stubbed
    (the PDF editor does that) -- with `office/shim/` standing in for Electron
    (`common.js` is the host bridge: `postMessage` in a frame, `window.__autoraHost`
    in headless Chromium; `docs.js` answers Word's `window.desktop` itself).
    **PowerPoint and Excel keep their document in Electron's main process**, so that
    code runs too, as a child process (`server/officehost.ts`, built per app into
    `dist/office/host/<app>.cjs` by `office/host/build.mjs`): GenOffice's real
    `slides-main` / `sheets-main` bundled over `office/host/electron-main.cjs`, a
    stand-in for the `electron` module (ipcMain registry, web contents whose
    `send` is a push to the parent, a `BrowserWindow` that is a page in the server's
    Chromium via rpc -- how it prints, nativeImage sizes read from the file header;
    menus, dialogs and the dock do nothing). The page side is the app's *real*
    preload, bundled by `office/host/preload.mjs` over `office/shim/electron-renderer.js`
    (ipcRenderer -> the host's `ipc`, JSON with tagged buffers: `common.js` `enc/dec`,
    `wire` in `officehost.ts`), so every one of the 160-odd channels works without
    being listed; `slides.js` / `sheets.js` only override where Autora is the host
    (theme, which file is open, Export PDF). `autora:<name>` invokes are Autora's
    own requests to the app's main code (`extra` in `office/host/build.mjs`: Excel
    makes the editor's window and queues the workbook itself). `server/officerender.ts`
    opens the editor page in the shared Chromium (`withBrowserContext` in
    `pdfrender.ts`), serves it from memory over a made-up origin and refuses
    everything else, lets the editor's own headless-export path run, and returns the
    PDF; `office_look` draws pages from it (`lookAtPdf` in `pdf.ts`, shared with
    `pdf_look`) and `office_pdf` / `office_convert to pdf` save it as an artifact and
    open it in the **PDF editor window** (PDFs go to our editor, never GenOffice's).
    A deck takes ~10 s, a workbook ~11 s (Excel's export waits until the engine has
    been quiet after the workbook opened: its formulas settle a moment late).
    `AUTORA_OFFICE_DEBUG=1` prints the page's console, the ipc channels and where the time goes.
    The engine is forked with `execArgv: []` (under tsx it would start the loader too: 5 s),
    Excel's export waits for the engine to be quiet 1 s and the workbook to have been open
    1.7 s (formulas settle late), and `serveOfficeEditors` sends pages and fonts compressed
    (brotli, kept after the first time; the Excel page is 14 MB, 3 MB sent).
  - `mindrules.ts` (+ `site.ts`): the rules the mind is kept by. Every
    `memory_write` / `memory_update` goes through `checkEntry` / `checkText`: a
    title that starts with its subject, one topic per record (length limit by
    kind), nothing about the moment, no secrets, and a `reference` (what a
    product's *official* docs say: kind `reference`, with `subject`, `facet`
    interface|api|docs|workflow|quirk, `source` URL, `fetched`) that names its
    source -- one not recognisably the subject's own site is kept `provisional`.
    Interface references go stale in 21 days, docs in 90 (`REFERENCE_FRESH_DAYS`);
    `MemoryGraph.groundingOf(site)` says none/stale/fresh. **Ground first**
    (`state.groundFirst`, Mind page): `actsOnSite` calls (browser click/fill/
    press/upload, non-GET `http_request`) on a site with nothing fresh stored are
    refused up to three times a turn with "read the official docs and write a
    reference", then let through so a missing docs site cannot wedge a turn;
    `groundingNote` names such sites from the request, `siteMemory` says it on the
    first visit, and `MEMORY_GUIDE` (tools.ts) tells the agent to do it for any
    product, API or app interface before working or answering "where is X in Y".
    `POST /api/memory/tidy {dry?}` files old records under a subject and lists
    what needs a rewrite (the Mind page's Tidy up button). The reflection prompt
    (`learning.ts`) asks for subject-first titles and drops lessons that break
    the same rules.
  - `argcheck.ts`: every call is checked against its tool's own schema before
    anything else sees it.
  - `verify.ts`: the person's project check (Settings), run by the loop when the
    agent says it is finished after changing something; a failure goes back to
    the agent with the raw output, up to `tries` runs a turn.
  - `subagent.ts` (`research`): a worker with a fresh context and read-only
    tools (`looksOnly` judges every call), its own loop watch and schema check,
    a step limit; only its short report reaches the main thread. It is given
    the model and tools by `researchFor` in `server.ts`, so it is tested with a
    script.
  - `codediff.ts`: the working folder, watched. After a command that changes
    things the loop scans it (stat first, read what changed, small source
    files kept to compare) and emits `file.edit` cards -- lines added, removed
    and a little context; lock files, environment files, build output and
    Autora's own state dir are never shown; a folder over `MAX_TRACKED` files
    is not followed. `FileCell` types a card that has just arrived (a replay of
    code already written, off with the agent-cursor switch in `lib/agentCursor.ts`).
  - `presence.ts`: working side by side. One record per chat of what the person
    touches (`touchPresence` in `server.ts`, from the input routes), leases that
    run out a few seconds after their last touch, and explicit control they take
    and hand back (`POST /api/sessions/:id/control`). `heldFor` refuses an agent
    call that would use a held surface -- not an error, so it never feeds the loop
    watch or error budget -- and `note()` says what they did, once, at the next
    round (or the next turn's note). `COLLABORATION` tells the agent how to behave.
    Client: `lib/collab.ts` and the Take control / Hand back buttons. In the PDF
    the editor tells the server what is selected or dragged (`autora:presence`,
    every few seconds while held) and `personChanges` touches each object the
    person changed; `pdf_edit` skips objects they hold, does the rest of the call
    and says what it left (`PdfOutcome.held` when nothing could be done).
  - `domdiff.ts` + `LiveBrowser.domMap/markAt/glideTo` (`browser.ts`): after code
    changes the preview's page is compared with how it was (matched by tag,
    words and class, never position) and the cursor -- drawn into the page, so
    it is in the streamed frames -- glides to what is new or restyled and
    outlines it with a name. A served folder is reloaded by the loop on a code
    change as well as by its file watcher, which misses files replaced whole.
    `app_preview` click/hover/type/press/scroll use the page as a person would,
    in the window the person is watching, and are refused while planning.
    All of it follows the one agent-cursor switch (`state.agentCursor`).
  - `companion.ts`: when no turn is running and nobody is mid-task, the agent
    says one short line about what the person just did in a shared window
    (`agent.remark`, shown in the thread and kept in its history as its own words).
    A small unwatched model call, so: only for touches worth a word, after they
    pause, 25s apart and at most 12 an hour, never over a running turn or with
    nobody looking, the model may answer SKIP, and `collabRemarks` switches it
    off (Settings -> Working together). A running turn answers in its own words
    instead, from the presence note.
  - `merge3.ts` + `editfile.ts` (`edit_file`): the careful way to change a file
    the person may also edit. The loop scans the folder before each changing
    call and at the end of each round, and what changed that the agent did not
    do is the person's: shown as a card tagged "you", told to the agent, leased
    to them for a while. `edit_file` applies exact replacements, keeps their
    changes beside the agent's when the two touched different lines, and writes
    nothing (naming what they did) when they clashed. Not while a background
    command runs, which also writes files.
  - `codesearch.ts` (`code_search`): exact, regex and BM25-ranked search over a
    folder in plain code; walks afresh each time, caches only per-file indexes.
  - `ledger.ts` (`ledger` tool): the agent's working notes (goal, decisions,
    facts, next) in the log as `ledger.update`, plus what it touched, read off
    its calls; said every turn so interrupts and restarts lose nothing.
  - `readfile.ts` (`read_file`: range / outline / symbol) and `hints.ts` (the
    nearest paths and page text said inside a failure). A long result's vault
    id is logged as `tool.stored` and named in the recap.
  - `toolload.ts` (`tools_enable`): specialist tool sets (pdf, widgets, mcp,
    schedule, notebooks) are out of the model's list until a message, a PDF, a
    call or a request brings them in (`tools.enable` in the log).
    `AUTORA_ALL_TOOLS=1` shows all. A new tool in one of those families is
    covered by its `match`; a new family goes in `FAMILIES`.
  - `trace.ts`: `GET /api/sessions/:id/trace`, read from the log.
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
  `startTurn()` in `server.ts`, and learning runs after it. A turn cut short
  (Stop, a message sent while it works, a restart) ends with
  `turn.agent.done {stopped}`; `resume.ts` reads that from the log and the next
  turn is told what was cut off, so it carries on rather than treating the new
  message as the whole job (and an Agent-mode build stays a build).
- `pdf-editor/`: SecurePDF's editor (from blofstedt/SecurePDF), its own
  sub-project with its own React 19 and Tailwind so neither touches the app.
  It runs in a frame sandboxed without an origin (`components/PdfWindow.tsx`)
  and talks to the page by `postMessage` only; it never calls the API. So it
  bundles pdf.js's legacy build and runs its worker as a classic script from a
  blob (a module worker cannot start in an origin-less frame), and fetches
  nothing from a CDN: Autora may have no internet.
- `src/`: the React client. `App.tsx` holds the session and stream; on a desktop the
  menu, the conversation and the window beside it are three panes whose seams drag
  (`components/ResizeHandle.tsx`, widths and "menu folded away" kept per browser by
  `lib/panes.ts`, applied as `--rail-w` / `--chat-w`);
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
