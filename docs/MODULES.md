# Modules, in detail

The long form of `docs/MAP.md`: what each piece of the server and client does and
why, with the decisions and traps that came with it. Read the part for the area
you are changing, not the whole file. (Moved out of `CLAUDE.md`, which is read
in full every session.)

Start from `docs/MAP.md` (the repo by job, the request path, `server.ts` by
region, recipes for common changes); `docs/REVIEW.md` lists known
inefficiencies by id. Search with `--glob '!spectra-editor/**'`: once built,
Spectra's fetched renderer is most of what is on disk.

- `server.ts`: the Express app, every `/api/*` route, the `/ws/:session`
  event stream and the agent turn loop.
- `server/`: the pieces it uses. `tools.ts` (the agent's tools), `llm.ts` and
  `providers.ts` (model calls), `browser.ts` (Playwright; the session's browser has tabs --
  `tabPages`, `newTab/switchTab/closeTab`, a link to a new tab opens and shows one, the
  sign-in popup returns to its opener when it closes -- and an adaptive stream: `TIERS`
  step down when `hooks.backlog` says a viewer is behind, the rate rises while
  `touched()`, and one sharp screenshot follows when the page has been still), `desktop.ts` (the
  relay), `store.ts` / `state.ts` (what is kept on disk under `AUTORA_HOME`),
  `LiveBrowser.devtools()` (every console line and request of every tab, 400 kept; the menu's
  Developer tools panel polls `GET /browser/devtools`, the agent has `browser_devtools`),
  `snapshots.ts` (version history of the working folder: a git directory of its own under the state
  dir with the project as work tree, so the project's `.git` is never touched; a version is saved
  at the end of a turn that wrote code (`codeTouched` in `server.ts`), `restore` saves the present
  first and uses `read-tree --reset -u`; `GET /api/versions`, `POST /api/versions/restore`; the app
  window's Versions, Templates and Console panels are `AppVersions.tsx` and `DevtoolsPanel.tsx`),
  `extensions.ts` (Chrome extensions, unpacked under `AUTORA_HOME/extensions/<name>/pkg`; `launchArgs()`
  adds `--load-extension` and `--headless=new` when any is enabled, `browser.ts` then drops Playwright's
  `--disable-extensions`; the id is Chrome's, from the folder's path; the popup opens as a tab),
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
  `desk.open`. Nothing plays them today: the editor that did (`pdf-editor/`, SecurePDF's)
  was replaced by Spectra's, and porting its cursor is open -- see docs/REVIEW.md D1), `pdfdesk.ts` (the PDF window: the file the
  agent works on, open beside the chat in Spectra-PDF's editor (`spectra.ts`, `spectra/`, `spectra-editor/`). What `pdf_edit`
  places becomes the editor's own movable objects, each keeping the item it
  came from so the file shows exactly what was drawn until the person changes
  it; the file is the base pages with every object flattened on, rewritten
  on every change; the person's changes are told to the agent once),
  `officedesk.ts` + `src/components/OfficeWindow.tsx` (the Office window -- Autora Pages (.docx), Sheets (.xlsx) and Slides (.pptx), each its own switch on the Tools page,
  `pages`/`sheets`/`slides` in `ToolSettings`, an old `office` in a settings file turns all three; the PDF window is "Autora PDF". One window per app: a Pages, a Sheets and a Slides
  document can be open beside the conversation at once, each with its own document, versions and engine (`deskAt` in
  `officeRoutes`, keyed by a `DeskKey` -- session and kind together -- so a call cannot reach the wrong app's
  document), each with a tab on the desktop (`App.tsx`: `OFFICE_PANES`, every open window kept mounted and only the
  chosen one shown, the strip run to the top of the screen) named for the app rather than the file. The agent's cursor:
  `officedesk.ts` `cuesFor` diffs before/after into `cues` on the window's state, `server/officestage.ts` turns the change into in-between files (`stagePlan`, `blankOf` for a new document) that the window asks for one at a time (`POST /stage`) as `OfficeCursor.tsx` types, so the typing is the change; `desk.stage` holds them in memory and `personSaved` ignores saves while it is up. `OfficeCursor.tsx` plays them over the frame
  asking `office/shim/cursor.js` where the text/cell is -- whose answer is the only place the cursor goes (no caption fallback, no invented spot) -- with `src/lib/humanPath.ts` -- the browser pointer's
  motion and a human typing rhythm. Briefing text: `OFFICE_GUIDE`/`WINDOWS_GUIDE` in `guides.ts`. The
  document the agent works on, open beside the chat in
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
  - The browser's pointer (`CURSOR_SCRIPT` in `browser.ts`) wears the Office cursor's arrow and name and is driven by the
    real input events (move, press, keys, wheel), not by announcements; the stream runs at its faster rate while the
    agent moves it (`touched()`). `tests/browser-cursor.test.ts`.
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
- `autora-3d/` and `server/caddesk.ts`: **Autora 3D**, the 3D modelling window (a sketch-and-extrude CAD modeller) and the agent's
  `cad_*` tools. `autora-3d/` is a **copy** of github.com/blofstedt/3D-Modeling, which is also its own app: never edit it here, change
  it there and run `node scripts/sync-autora-3d.mjs [checkout]` (it also regenerates `server/specs/cad.ts`, one `cad_*` tool for
  each call the modeller declares, so the two cannot drift). `npm run build` builds it into `dist/autora-3d/` (the window's page) and
  `dist/autora-3d-engine/` (`engine.mjs` + `manifold.wasm`: the headless model, loaded by the server at run time, so the server is
  typechecked without it and a server built without it simply does not offer the tools: `cadAvailable`). One model per chat lives
  in `caddesk.ts` (kept as `cad-<session>.json` in the state directory, removed with the chat); the agent's tools run on it
  (`runCadTool`, called from `runTool`), and the window is a frame of this origin (`CadWindow.tsx`) that only talks to the page by
  `postMessage`: `ready` -> the model is fetched and sent down with Autora's theme (`THEME_TOKENS`, applied by `autora-3d/src/embed.ts`,
  colours only); `changed` -> `PUT /api/cad/:session/doc`; an agent change -> `caddesk` over the socket -> the frame is sent the new
  model. Each change carries `by` (agent or person) so the window reloads only for the agent's: a drag in progress is never
  answered with an echo. `cad_export` is saved as an artifact (the STL never goes through the conversation). Traps: the window opens
  on the agent's first call; an incognito chat has none; tool names in the engine's messages are prefixed on the way out
  (`asAgentSees`). The phone shows it as a tab in the pinned view like the other windows (`Thread.tsx`, `lib/stage.ts` kind `cad`).
- `server/studio.ts`, `server/specs/studio.ts`, `src/lib/studio/`, `src/components/StudioWindow.tsx` + `src/components/studio/`:
  **Autora Studio**, the music window, and the agent's `studio_*` tools. A song is tracks of clips of notes, in beats
  (`src/lib/studio/model.ts`: plain JSON, no DOM/React/Node, imported by the server *and* the page, so there is one idea of a valid
  song; `normalizeProject` repairs anything that arrives, the generators `chordNotes`/`bassNotes`/`drumNotes` and the chord reader
  `detectChord` are pure and seeded). One song per chat lives in `studio.ts` (kept as `studio-<session>.json`, removed with the
  chat). The **sound is made in the browser** (`lib/studio/engine.ts`, Web Audio: oscillator and noise instruments, a mixer, a
  `Transport` that schedules ahead of the clock, `bounce()` to a 16-bit WAV with an `OfflineAudioContext`), so the server cannot
  play or render: the three things that need a browser (`play`/`stop`/`seek`, `export`) are *commands* to the open window
  (`command()` -> `studio.command` over the socket -> the window claims it (`/claim`, first tab wins) -> `/reply`; export puts the WAV
  to `/deliver`, which saves the artifact). The window says it can take commands with `/ready`; a command to a window that never
  does fails after 20 s with a message rather than hanging. Editing: the agent's tools change a copy of the song and `commit()` it
  (`by: "agent"`, `rev++`); the person's edits are saved by `useSong.ts` (`PUT /doc` with the `rev` they last saw: **409 when the
  agent has changed the song since**, so a save never undoes the agent's work unseen; the window then loads theirs and says so).
  The window loads the agent's change, lights the clips it touched (`touched()`), and puts the old song on its own undo stack, so
  Ctrl+Z takes any agent change back. While a note is being dragged (`hold`) an agent change waits for the pointer. `focus` (the clip
  open in the editor) is posted to the server so "this clip" means something to the agent (`studio_look`, the turn note). The
  agent cannot hear: `studio_look` adds `review()` observations (empty clips, notes outside the key, no bass, volumes far apart).
  Per the core principle the agent writes *scaffolding* (`studio_make`: chords, a bass that follows them, drums) and fixes technique
  (quantize, levels, transpose); a melody is written only when asked, and `studio_open new` refuses to throw away a song with notes
  without `replace: true`. Traps: the playhead (`--ph`) and the meter (`--lvl`) are painted straight onto the window from a
  `requestAnimationFrame` loop, so nothing re-renders for them; never animate a clip's `background` (Chromium interpolates
  `color-mix` against a translucent token through colours off the palette: the flash is an overlay); a browser holds sound back
  until a tap, so `studio_play` reports `blocked` rather than pretending; the phone shows it as the `studio` kind in the pinned view
  (`stage.ts`), and `.stage-body[data-active="studio"]` is not height-limited. Tests: `tests/studio.test.ts` (theory, tools, wire),
  `tests/e2e-studio.test.ts` (a real turn), `tests/ui-studio.test.ts` (a real browser: draws, plays, bounces a WAV and checks it has
  sound, an agent change lights up and undoes).
- `spectra-editor/`: Spectra-PDF's renderer (github.com/jasonulbright/Spectra-PDF), the PDF window's
  editor, built by `spectra-editor/vite.config.ts` into `dist/spectra-editor/`. **Its source is not in
  this repository**: `scripts/prepare-spectra-editor.mjs` (run by `npm run build` and `npm run lint`)
  copies `src/renderer` from the commit in `spectra/PIN.json` -- the same pin as the engine -- into
  `spectra-editor/src/renderer/` (gitignored) and applies Autora's changes: `overlay/renderer.patch`
  (three of Spectra's files: `App.tsx` brings the opened document to the front, `i18n.ts` loads other
  languages on demand, `index.tsx` installs the shim and `autora.css`) and the files in
  `overlay/renderer/`. Edit the overlay, never the fetched copy; a newer Spectra is a new sha in the
  pin and a patch that still applies. It is a Tauri app, so its six `@tauri-apps/*` imports are aliased
  (vite and `tsconfig.json`) to `spectra-editor/src/autora/` (Autora's own shim, answered over
  `server/spectra.ts` and `server/spectra/commands.ts`). Its Python engine is `spectra/PIN.json` ->
  `scripts/build-spectra.mjs` -> `server/spectra/engine.ts`. It runs in a frame sandboxed without an
  origin (`components/SpectraWindow.tsx`) and talks to the page by `postMessage`. Only English is in the
  page; the other locales are files fetched on demand (`locale-loaders.ts`), and the metadata worker is
  built without them. `npm run typecheck` checks the renderer and the shim together.
  Search with `--glob '!spectra-editor/**'` unless the task is about it.
- `opencut-editor/` + `server/opencut.ts`: **Autora Video**, OpenCut's editor (github.com/opencut-app/opencut-classic, MIT) in
  a window beside the chat. The linked `opencut-app/OpenCut` is mid-rewrite and has no editor yet, so the pin
  (`opencut/PIN.json`) is the classic repo, which does. Built like Spectra's: `scripts/prepare-opencut-editor.mjs`
  (run by `npm run build` and `npm run lint`) copies `apps/web/src` from the pin into `opencut-editor/src/web/`
  (gitignored; less the site, blog, sign-in, API routes, its own tests and the transcription worker) and lays
  `opencut-editor/overlay/web/` over it -- **whole files that replace OpenCut's own at the same path**, not a patch
  (storage adapters, the header, the transcription service, a few stubs). Edit the overlay, never the fetched copy.
  It is Next.js there, built with Vite here: `next/link|image|navigation|script|font` are aliased to
  `opencut-editor/src/autora/shims/`, `opencut-wasm` (npm) loads through `vite-plugin-wasm`, and absolute public
  paths (`/fonts/...`) are made relative to the page (`publicBeside` in `vite.config.ts`). `src/autora/` is Autora's
  half: `bridge.ts` (the postMessage wire), `commands.ts` (what the agent can do, written against OpenCut's own
  `EditorCore`, so every step goes through the editor's command history and can be undone), `storage-shim.ts`
  (`localStorage` and the storage manager for a frame with no origin), `autora.css` (OpenCut's tokens pointed at
  Autora's, `--a-*`), `main.tsx`.
  The frame is sandboxed without an origin (`components/OpenCutWindow.tsx`), so it has no IndexedDB or OPFS: both
  adapters are replaced (`overlay/web/services/storage/`) and its projects and media are kept by the server, through
  the window, under `stateDir()/opencut/` (`server/opencut.ts`). Projects belong to the person, not to a chat.
  **Traps:** (1) the iframe `src` must never change while it is mounted (it reloads, and loses a command in flight);
  (2) `ready` is said once a *project* is loaded, not when the page is up; a window that mounts sets the server's
  flag false first; (3) a command can arrive in two tabs: `/api/opencut/claim` makes one of them do it, and the
  server sends an unclaimed one again every 1.5 s; (4) theme: the window reads Autora's tokens off its own page and
  posts them (`--a-*`), so a different theme here is a different one there; (5) automatic captions are removed (they
  download a model from Hugging Face); (6) saved exports are capped at the artifact limit (50 MB), the editor's own
  Export button downloads without one.
  **The agent can use every part of the editor, two ways.** Typed commands, against `EditorCore` (`commands.ts` for the
  cut, `features.ts` for the rest: stickers, shapes, effect layers, subtitles, effects, masks, keyframes, speed, tracks,
  scenes, bookmarks, project settings, the editor's own actions and panels, a picture of a frame, and the catalogs that
  say what exists). And a screen driver (`ui.ts`) for anything those do not reach: it reads the controls on the page
  (each with a `[ref]`), and clicks, types, presses and drags with *real* pointer, mouse, keyboard and input events, so
  Radix menus, selects, dialogs and the timeline answer as they do to a hand. Tools (`server/specs/video.ts`):
  `video_open`, `video_look`, `video_import`, `video_edit`, `video_style`, `video_project`, `video_ui`,
  `video_catalog`, `video_frame`, `video_export`. A new typed command: a case in `features.ts`, its name in the right
  action list in `server/opencut.ts` and the enum in the spec; the cursor needs nothing (see below).
  **The cursor and typing are the other windows'** (`lib/humanPath.ts`), for every command: `whereFor` in
  `OpenCutWindow.tsx` says what a command is about (a clip, a track, a time, a panel, a control), the frame's `locate`
  finds it on the screen (moving its playhead or scrolling first), the cursor goes there and presses, then the command
  runs. Words are typed a few letters at a time: a title (`add_text`, then `set_params {history: false}` for the rest),
  a clip's content, a project name, and any field via `ui_type`. Commands that change nothing on screen (`SILENT`) go
  without the cursor. The editor's tools are brought in by the person's words (`toolload.ts`), the surface `video` can
  be taken (`presence.ts`), and Plan mode allows only looking (`video_look`, `video_catalog`, `video_frame`, `video_ui
  read`). Patches to OpenCut's own files, made as they are read (`markSources` in `vite.config.ts`, which fails the
  build if a line has moved): `data-element-id` and `data-track-id` on the timeline so a clip can be found on screen,
  and the wasm renderer's `effect_pass_groups` (an effect layer failed every frame without it). One whole-file overlay
  fixes a bug at the pin: stickers registered with the wrong call and every one failed (`overlay/web/stickers/`).
  `npm run typecheck` checks only Autora's files in it (`scripts/typecheck-opencut-editor.mjs`): at the pin a few
  of OpenCut's own do not typecheck. Search with `--glob '!opencut-editor/**'` unless the task is about it.
- Full screen on a phone (`lib/fullscreen.ts`): one shared flag for every pinned tool (browser, app window, PDF,
  Pages/Sheets/Slides, widget), so Follow (`busiestSurface` in `Thread`) moves the stage to the next tool with the
  screen still full. While it is up, `components/ImmersiveChat.tsx` is laid over it: the agent's last reply as a
  `glance` (first sentence, fades after ~5 s) placed beside the cursor when the tool reports one (`lib/cursorPos.ts`:
  the Office cursor and the PDF cues -- `autora:cursor` from the editor frame), else at the top; a translucent chat
  button and a one-line box that sends through `onSuggest`; and a Follow toggle. Office cues locate the place in
  the editor (`office/shim/cursor.js`): text in the DOM for Pages; a deck's element box as fractions of the slide
  (`withSlideBoxes`, the canvas is not searchable); a workbook cell by clicking and reading the editor's own name
  box, so a cell the editor cannot confirm is not pointed at (and one window per app: a Pages, a Sheets and a Slides
  document each have their own window and their own tab, all open at once).
  The cursor uses the interface rather than drawing over it: the click is a real click in the editor (the cell is
  selected, the caret goes into the word) and the words go into the editor's own input, left with Escape so the
  document keeps only what the agent's tool made of it; where the editor has no field to type in, the words are
  drawn over the spot it did confirm. Nothing is placed at a spot the editor did not confirm.
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
