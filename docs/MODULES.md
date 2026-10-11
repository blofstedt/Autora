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
  cites), `agents.ts` (the Organization page's roster: each agent's task, when to call it,
  who it reports to and which agents follow it, stored as `agents.json`; the lead,
  `agent_autora`, is always there; `orgBriefing` is what the lead is told, `agentBrief` what
  a started agent is told), `threads.ts` (Threads, the agents' forum: posts, nested
  comments and likes, stored as `threads.json`), `routes/organization.ts` (both pages'
  routes; the person posts as `user`), `threadgif.ts` (agents may add a GIF to a Threads post or comment: they ask for one by a few words, `findGif` looks it up on GIPHY or Tenor with a key from Settings -> secrets -- no key, no GIFs, and agents are not told of them -- and only an https address on those services' own hosts is kept, `cleanGifUrl`; never one more than every other thing an agent says), `agentcharacter.ts` (shown and edited in Mind, `AgentProfile.tsx`, one agent at a time -- not on the Organization page; who an agent is: a human first name plus a job title as role, a `personality` and `traits` -- warmth, candor, rigor, curiosity, humor, initiative, teamwork, 0..100 -- drawn from its expertise by `draftCharacter` unless the hirer or the person set them; `characterLine` puts them and its closest `bonds` in `agentBrief` and the Threads prompts; they evolve: `recordCollab` (agents.ts) raises both agents' bond and teamwork, with diminishing returns, when a handoff (`go`, weight 6) or a Threads reply (weight 2) goes well, and lowers them a little when it does not; `recordWork` counts tasks; the lead keeps none; a bond also scales `urgeOf`), `GET /api/threads/unread?since=` counts what agents said since then, for the N-new tag on Threads in the menu (`lib/threadsUnread.ts`, the last-looked time is per browser); a called agent's chime in the chat carries its own report (`agent.back` has `reply`), `threadnews.ts` (Threads outward: about hourly one agent, never the one before, is asked for a search in its own field, `searchWeb` runs, and it posts the one result worth it -- a post must cite a link the search returned, search text is untrusted; two colleagues are nudged to answer; `NEWS_PER_DAY` 6; `threadNewsStep` in `server.ts`, switch `threadsNews`; also `workTitle`/`workOutcome`: an agent started from the Organization posts in Threads that it is on a task and how it went, templated, a stuck one asks its manager by name), `threadlife.ts` (Threads alive: each agent's local `urgeOf` -- no model call until it passes
  `URGE_AT` -- what it is asked, how its answer is read and vetted (`vetLinks` drops links it was not given),
  the 30/hour, 200/day `LifeGate`; after `QUIET_MS` (3h) of silence one agent is asked to start a thread; an agent may keep up to `MAX_WONDERS` "Wondering: ..." notes, which steer its news search and now and then become private study (`studyPrompt` in `threadnews.ts`: it learns, posts nothing); the model call and a one-minute timer are `threadLifeStep` in
  `server.ts`, switched by `threadsAlive`; the agent's own `again` is its sleep), `agentmind.ts` (each agent other than Autora has a `MemoryGraph` of its own,
  `agentmind-<id>.json`: the same engine as the main Mind, kept apart; `mindForId` in `server.ts` makes a chat
  that is an agent at work recall from and write to it instead of the main Mind. Autora, the base agent, keeps
  the main Mind. `teach`/`clusters` split the main Mind up: the `agents` tool's `domains`, `teach` and a hire's
  `knowledge` move a subject's memories into a specialist, never preferences. It follows a merge, goes with a
  removal, and is listed and correctable on the agent's card via `/api/agents/:id/mind`). Each agent has a `look` (corners, hue)
  drawn at random and never repeated (`pickLook`); the client draws it with `AutoraMark look=`
  (`lib/agentlook.ts`; `lib/mark.ts` takes `sides`). The `agents` tool (`list`, `run`, and the
  lead's `hire`, `edit`, `merge`, `remove`, `move`) starts an agent in
  a chat of its own through `runAgentTask` in `server.ts`, which waits for the report and
  then runs the agent's `next` list in order; it stops at a depth of three and never starts
  an agent twice in one chain (`agentRuns` is per chat, cleared in `forgetSession`). The
  `thread` tool posts as the agent whose chat it is (or `as` another). Both belong to the
  `organization` family in `toolload.ts`. `guard.ts` (what stops and asks before a risky call), `crosssite.ts` (refuses requests and websockets
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
    own "packaged" layout (`cli/`, `wasm/`, `native/`; `office/NOTICE.md`). The pin
    never follows upstream (it is Autora's fork; change it with `office/patches/*.patch`). `npm run build:office` runs it; the Dockerfile builds
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
    schedule, notebooks, organization) are out of the model's list until a message, a PDF, a
    call or a request brings them in (`tools.enable` in the log).
    Every tool is shown by default; `AUTORA_LAZY_TOOLS=1` goes back to the short list that grows as it is wanted. A new tool in one of those families is
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
- `server/handbook.ts` (`tests/handbook.test.ts`, `tests/e2e-manuals.test.ts`): how every window and tool works. Every tool is a default tool (`allToolsOn` in `server.ts`). The briefing carries only `windowsOverview()`; each window's manual is attached to the result of the first tool call into it in a chat (`manualId`, then a `tool.manual` event in the log so it is not repeated), and `tool_manual` reads one sooner. A new window or tool gets a manual here as well as its schema.
- `server/termdesk.ts` + `src/components/TerminalWindow.tsx` (`lib/termdesk.ts`, `tests/termdesk.test.ts`): **Autora Terminal**, a real terminal on
  the machine Autora runs on (one switch with the agent's `terminal` tool: `tools.terminal.enabled`). One shell per chat on a pseudo-terminal, made
  by a small Python program (`PTY_HELPER`, run with the image's `python3`: a native module such as node-pty would be built for the builder's CPU,
  not the image's, so there is none). The page draws it with xterm.js and talks to it over `/api/term/ws?session=` (`termUpgrade`, called from the
  upgrade handler in `server.ts` with `allowSocket`, so the cross-site rule holds): JSON frames `{t:"in",d}`, `{t:"size",cols,rows}` up and
  `{t:"out",d}` down, with the scrollback (400 kB, in memory, never on disk) replayed to a page that connects, so a reload gets the same shell. The
  shell is ended when the window is put away (`/close`) and with the chat (`dropTerm`). The agent shares: the shell's folder (read from `/proc`,
  `termCwd`, used by the `terminal` tool), its commands printed in dim magenta (`termAgentBegin/Chunk/End`; the agent's tool still runs its own
  command, it is not typed into the shell), and what the person ran, told back once on its next terminal result (`termNews`, from the lines sent with
  Enter: best-effort). Completion, history, colours and full-screen programs are the shell's own. A touch screen gets a key row (Esc, Tab, Ctrl+C,
  arrows, `| / ~`). The socket to the page carries only `{open, cwd, rev, running}` (`termdesk`). Class names are `tm-*` (`term-*` is the thread's cell).
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
  **Autora Music**, the music window, and the agent's `studio_*` tools. A song is tracks of clips of notes, in beats
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
  `overlay/renderer/`. Edit the overlay, never the fetched copy; a different Spectra commit is a deliberate act, not an update: a new sha in the
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
- `gdevelop-editor/` + `server/gamedesk.ts`: **Autora Games**, GDevelop's editor (github.com/4ian/GDevelop, MIT; its name and
  logo are its author's) in a window beside the chat, and the agent's `game_*` tools. Built like OpenCut's:
  `scripts/prepare-gdevelop-editor.mjs` (run by `npm run build` and `npm run lint`) fetches `newIDE/app`, `GDJS` and `Extensions` from the
  commit in `gdevelop/PIN.json` into `gdevelop-editor/work/` (gitignored; never edit it), then makes it Autora's in this order:
  `overlay/` (whole files over GDevelop's, or new: the storage provider, the start page, the AI stubs, the theme, the bridge),
  `patches.mjs` (small `find`/`replace` edits to files too big to replace; the build **fails** if a `find` is not in the file exactly
  once, which is how a newer GDevelop that moved a line is found), and what GDevelop generates before it builds (its themes, the
  runtime, Monaco, `libGD.js` + `libGD.wasm`: GDevelop's C++ core as WebAssembly, downloaded from `engine` in the pin, the same
  commit's build). English only (the other 118 languages were 100 MB). `gdevelop-editor/package.json` and its lockfile are a *copy*
  of GDevelop's (with `patches/`, its fixes to its dependencies, applied by `postinstall`); the prepare script says when the pin
  moves and they no longer agree. `npm run typecheck` there is only the prepare step: GDevelop is Flow, which is not run.
  **What was taken out:** the AI (`overlay/.../AiGeneration/` are stubs with the names the rest still imports; `patches.mjs` hides every
  entry point: the title bar button, the menu item, the preferences section, the new-project box, the two "Edit with AI" buttons),
  the account, cloud storage, the shop, courses and tutorials (the start page is Autora's own: the game's name and its scenes),
  telemetry (`posthog.init` is skipped) and the service worker (`registerServiceWorker` returns). Autora's page also allows the editor
  to connect to its own origin and nowhere else (`serveGame` in `server/gamedesk.ts`), so a call GDevelop still makes to its servers (the
  asset store, examples) fails at once rather than leaving the machine: **the asset store is empty by design**; pictures come from
  `game_import`, the person's own files (the "File(s) from your device" chooser uploads to `/api/game/:s/assets`) or a URL.
  **The game** is one project file per chat (`game-<session>.json` in the state directory, `Saved`): GDevelop's own JSON, so
  everything the editor can do is in it. `GET/PUT /api/game/:session/project`; every change bumps `rev` and records `by`; a `PUT`
  carries `ifRev` and a stale one is refused with 409 (the agent's change wins over the last second of the person's: the editor takes
  the newer game, see `Autora/bridge.js`). The editor saves by itself ~1.2 s after a change (`bridge.js` watches `hasUnsavedChanges`
  that a patch exposes as `window.__autoraEditor`) and reloads the game the agent changed without reloading the page
  (`openFromFileMetadataWithStorageProvider`). The window (`GameWindow.tsx`, `lib/gamedesk.ts`) is a frame of this origin: its address
  carries the chat and Autora's colours (`?autora=&theme=`, mapped onto the Deep Blue theme in `overlay/.../DeepBlueTheme/index.js`),
  and must never change while it is up (a new theme is the frame's own `location.replace`).
  **The agent works on the JSON** (`game_look`, `game_edit`: set/insert/remove/merge at a path such as `layouts[Scene].objects[Player]`,
  atomic, `game_check`, `game_template`, `game_catalog`, `game_import`, `game_open`; `server/specs/game.ts`). It cannot ask the engine,
  which is WebAssembly in the page, so `scripts/make-game-catalog.mjs` runs the same engine in node once and writes
  `server/game-catalog.json` (every action, condition and expression with its parameters, the objects and behaviors, and the shape
  of a new scene, object, behavior, instance and resource as the editor saves it): `game_catalog`/`game_template` read it and
  `game_edit` checks what was written against it (unknown instruction, wrong parameter count, instance of a missing object, a picture
  not in the resources, duplicate names), saving anyway and returning the warnings with the paths. **Run it when the pin moves** and
  commit the result. `game-starter.json` is an empty game as GDevelop makes it (one scene), made the same way.
  **Previews** run in a box of their own: GDevelop's launcher writes the page, the data and the generated code to a service worker's
  IndexedDB; here `overlay/.../BrowserSWPreviewIndexedDB.js` sends them to the server (`PUT /api/game/:s/preview/<instance>/...`, in memory,
  192 MB, oldest first) and the popup opens `.../preview/<instance>/preview/index.html` served with `Content-Security-Policy: sandbox
  allow-scripts ...` (no `allow-same-origin`: a game is code the agent or the person wrote, so it has no origin of Autora's and cannot
  reach its API). The runtime it is made of is `dist/gdevelop-editor/GDJS/Runtime` (copied by `build-gdevelop-editor.mjs`, less maps and
  other platforms) with `Access-Control-Allow-Origin: *`, because a game with no origin reads its files across origins; so are the
  game's assets (`/api/game/:s/assets/`, also `Content-Security-Policy: sandbox`, only ever data). **Traps:** (1) the sandboxed game is
  not the editor's origin, so the editor's debugger and hot reload do not reach it (a preview is a fresh run); (2) a patch whose `find`
  moved breaks the build on purpose; (3) incognito chats have no game window (it keeps its game on disk); (4) the window opens on the
  agent's first edit, not on a read; (5) the Docker build needs the network for `libGD`, the checkout and `GDJS`'s own install.
- `photo/` + `server/photodesk.ts`: **Autora Photo**, PhotoCraft (github.com/storytold/photocraft, MIT OR Apache-2.0; ArtCraft's name and
  logo are its authors') in a window beside the chat, and the agent's `photo_*` tools. PhotoCraft is a Rust image editor (layers, masks,
  adjustment layers, layer styles, type, brushes, real PSD files) with 500+ commands in one registry that its UI, its command line and its
  MCP server all call. **Two programs, built from the commit in `photo/PIN.json` by `scripts/build-photo.mjs`** (not by `npm run build`,
  which empties `dist/`; run `npm run build:photo` after it, as with the Office tools; CI and the Docker stage `photo` do): the editor,
  `apps/photocraft-web` as WebAssembly (`trunk build`, into `dist/photo/web/`, served at `/autora-photo` by `servePhoto` under a CSP that
  allows its own scripts and `wasm-unsafe-eval` and is framed by this app only), and the headless `photocraft-cli` (into
  `dist/photo/native/`, one per CPU in the image, musl-static through `cargo zigbuild`). Both are optional: a build that fails leaves the
  tools off (`photoAvailable`, `windowOff`), and tests that need them skip. **The overlay** `photo/overlay/autora.rs` is copied into the
  web app and hooked in by three checked string patches in `build-photo.mjs` (`patch()` fails the build when a pin has moved the text);
  it is the editor's end of a postMessage wire (`autoraPhoto`: `ready`, `load` in; `changed`, `file` out) and does nothing when the page
  is not framed. **The picture** is one file per chat, `work.pcraft` (PhotoCraft's layered format) in `stateDir()/photo/<session>/`,
  with `state.json` (open, size, layers). The agent's tools open it in `photocraft-cli serve` over stdio, whose only file access is that
  folder (`serve()`), one process per call (`inLine` keeps one at a time per chat): `doc.open`, `batch` (the commands, one history step each,
  stopping at the first failure; what ran is kept), `doc.save`, `doc.inspect`, `doc.render` (the picture the model is shown), `engine.commands`.
  `photo_open` converts anything PhotoCraft reads (PSD, PNG, JPEG, TIFF, WebP, camera raw...) into `work.pcraft`. **The window**
  (`PhotoWindow.tsx`, `lib/photodesk.ts`) is a frame of this origin: `ready` -> `GET /api/photo/:s/doc` -> `load` (the bytes transferred);
  the agent's change (`rev` up, `by: "agent"`) reloads it; the person's edits come back as `changed` ~0.7 s after they stop (the overlay
  watches the active document's revision, exports it to `.pcraft` and sends it) -> `PUT` (checked by opening it in the command line, so a
  malformed file is refused) and marked `by: "person"`. A file saved or exported in the editor (`write` in `web.rs`) is sent as `file` and
  offered as a download by the window, since a frame cannot start one. **Traps:** (1) the synced picture is the *active* document, and a
  load replaces every open document, so the agent's edit closes anything else the person had open in the editor; (2) an agent edit while
  the person is mid-stroke reloads over it, so the manual says to leave the editor alone while they hold it; (3) the editor's own
  preferences use the frame's `localStorage`, shared by all chats; (4) incognito chats have no photo window (it keeps its picture on disk);
  (5) a first `trunk build` of the editor is a long Rust build (~15 min cold; CI caches `target/`); (6) the CLI's `serve` would write
  anywhere in its roots, so the roots are the chat's folder and nothing else, and `HOME` is pointed there too. Search with
  `--glob '!.cache/**'`.
- Follow (`lib/follow.ts`): one switch, on by default and kept per browser, for the pill beside the phone's tabs
  (`Stage`) and the one at the top right of the desktop strip (`pane-follow` in `App.tsx`). On, the screen goes where the
  agent works: the stage's `busiestSurface` on a phone, and on a desktop `lib/followPane.ts` (`lastWorkedPane`: the
  window of the newest tool call, an Office one found by the file it names). Picking a tab turns it off; the pill
  turns it back on. The desktop strip and the phone's stage tabs are folder tabs (CSS only, `.pane-pick-tab`, `.stage-tab`).
- The agent's pointer outside the Office windows: `lib/pointer.ts` (a layer on the body: arc, rest, press ring, typed
  words beside it; it goes only where a real element or a frame-confirmed point is). Music points at the clips that
  lit up (`StudioWindow`). The PDF window plays the server's cues (`cueForItem`, with the page's size so a place on a
  page is a fraction of it): `SpectraWindow` asks the frame where a page is (`autora:spectra:locate`, answered in
  `spectra-editor/src/autora/host.ts`, which also scrolls the place into view). Autora 3D draws its own, inside the
  frame (`autora-3d/src/agentCursor.ts`): `caddesk.ts` says the tool (`cue`) with the model, the frame goes to the
  tool's button, applies the model, then goes to the shapes that changed (`ViewerApi.screenOf`). The PDF editor is
  opened on `deskDocument` (the pages with the agent's objects drawn in), not on `deskBase`.
- The PDF editor is one page (`singlePage` in `spectra-editor/vite.config.ts`: script, styles and workers inline, `inlineDynamicImports`, English only), because a frame with no origin fetches without cookies and a login proxy refuses it (`tests/ui-pdfwindow-proxy.test.ts`). pdf.js's data (`dist/spectra-editor/pdfjs/`, shipped by `shipPdfjsAssets`) is asked for through the window (`autora:spectra:asset`). Its CSP allows `blob:` scripts for that. `followAutoraDark` in `autora/host.ts` keeps it dark.
- A frame that does not start: `lib/bootWatch.ts` says so after 25 s (PDF and video windows), and the PDF frame forwards
  its uncaught errors (`autora:spectra:error`). Its build puts a `Map.getOrInsert*` polyfill in front of every chunk,
  workers included (`polyfillFirst` in `spectra-editor/vite.config.ts`): pdf.js needs it and older browsers lack it.
- The rest of the phone's tools: Pages/Sheets/Slides on a phone are two views. Pinned, the pictures of the pages (`OfficePages`:
  tap text to point at it, the message to the agent carries it). The pencil in the window's bar opens the phone's editor, full
  screen: `office/shim/phone.js` (injected into the editor page when the window adds `?phone=1`) closes the ribbon, hides the
  status bar and the notes pane, and lays one bar over the bottom (undo, redo, bold, italic, a list or a row or a slide, the
  size) whose buttons press the editor's own, found by the start of the name each carries (`data-tip`, `aria-label`, `title`;
  `data-linked` marks the ones found, which `ui-office-phone` checks). "More" opens the real ribbon in place over the top of the
  page. The ribbon is closed to a height of nothing, never removed: Sheets lays out in rows and moves every row up when one goes.
  The ribbon's AI group ("Autora" on Home) is gone on every screen (`office/shim/common.js`). The window's bar loses the cursor
  switch and the versions pill, and "Page view" is an icon. The browser's toolbar on a phone is back, reload, the address, hand-over, drag and
  enlarge (CSS in `styles.css`). Autora Photo is paired down in Rust, in `photo/overlay/autora.rs` (the `phone_*` functions): with
  `?phone=1` the editor shows the picture alone (`screen_mode = "fullScreen"`, forced each frame in `pump`) and draws one bar
  (Undo, Redo, Tools, Brush, Layers, Fit) with a sheet over it (nine tools, brush size/strength/colour, layers with eye, name,
  opacity, new, delete). The bar's taps are queued in `tick` (which only sees the app) and done in the next frame's `pump`, through
  the editor's own commands (`menus::invoke`). Sizes are asked for in CSS pixels (`per_css_px`), because a headless browser at a
  device ratio above 1 reports an editor canvas half the page's resolution and a pointer the editor mis-maps: test the phone at
  1:1 (`tests/ui-photo.test.ts`). `build-photo.mjs` adds `serde_json` to the web app for it. The pin never moves.
- Second pass on a phone: the pages (Sessions, Artifacts, Tools, Settings, Mind...), the drawer, the composer and the thread were already
  one column and needed only a thumb's size on their controls (`styles.css`, "Everything else on a phone": 36-40px pills, filters and
  selects, switches and check boxes with an invisible margin, 16px fields so the browser does not zoom). The terminal's bar names it and
  its key row sits above the full-screen strip; widgets' headers are window bars; the app window's bar fits its close button and Music's
  settings sit tempo and bars side by side with the key under them. Games and the browser got their own pass (next item). Method: open every surface at 390px, screenshot it, and list the controls under 38px.
- Games and the browser on a phone. Games: `gdevelop-editor/overlay/.../Autora/session.js` puts `autora-phone` on the editor's `<html>`
  when the window adds `?phone=1`, and `autora.css` hides what a phone does not do with a game (Home, the Events tabs, Share, history,
  the 2D/3D switch, the project manager, the preview menu), leaving the scene, what is in it, undo, save and Play, with GDevelop's own
  bottom tab bar; people do not build whole games on a phone, and the agent has the rest. The editor is rebuilt (`npm run build`) for it.
  Browser (`ScreencastCell.tsx`, `usePhone`): no window bar, tabs only when there is more than one, Enlarge goes straight to full
  screen (not the taller inline step), full screen opens magnified (the page is 1280px wide; at the width of a phone it is a
  thumbnail) with one button that steps Fit, 2, 3 and 4 times, and `.cell.shot.is-max` is raised above the app's header like the other full-screen windows
  (the toolbar had been underneath it). Tests: `ui-game`, `ui-browser-phone`.
- One look across the windows on a phone (`styles.css`, "Tool windows on a phone"): `--pt-bar` 48px, `--pt-hit` 40px, `--pt-r` 12px.
  Every window's bar (`.pdf-bar`, `.app-bar`, the browser's) is the name and 40px soft-square buttons; text pills are for
  desktop; `TakeControl` is the hand-over switch in all of them (PDF, Video, Pages/Sheets/Slides, the app window). The editors
  in frames use the same numbers in their own overlays (Spectra `autora.css`, OpenCut's overlay pages, 3D's `index.css` under
  `html[data-phone]`). Full screen keeps a 64px strip at the bottom for the chat button and Follow, so they never cover an
  editor's own bottom bar. The app window drops Back, Console (unless there are errors), Versions, Templates and the cursor
  switch on a phone; Music drops skip-back, loop and the click track. New phone chrome takes these numbers; a new button is 40px
  and 12px, not a pill or a circle. Test: `ui-pdfwindow` measures the bar.
- Paired-down tools on a phone: a phone gets the same files in an editor arranged for a thumb, never a second
  implementation, and the desktop is untouched. The window adds `&phone=1` to the editor frame's URL (`SpectraWindow`,
  `OpenCutWindow`). PDF: `spectra-editor/src/autora/rail.tsx` is the PDF window's whole interface, on a phone and on a desktop
  (docs/TOOL-RAIL.md is the spec; `rail-tools.ts` is every tool once, with its colour, glyph and Spectra command). It puts Spectra's
  menu bar, toolbar and tab strip away (`html.autora-rail-ui`, plus `autora-phone` or `autora-desktop`) and mounts: a bar of round,
  coloured tools (along the bottom on a phone, down the right on a desktop; it shows as many as fit and never scrolls; a phone shows
  `PHONE_DEFAULT`, a desktop the person's pins, starting from `DESKTOP_DEFAULT`, kept in `localStorage` as `autora-pdf-pins`), a grid
  button that opens every tool in a centred modal (a pin on each tile on a desktop), a tray for the open tool (a one-row strip above
  the bar on a phone, a card beside it on a desktop; Highlight, Pen highlight, Text, Draw, Shapes, Note and Callout: three colours, a
  wheel and, for Draw, Shapes and Pen highlight, a thickness slider; Shapes steps through the figures with one button on a phone and
  shows all seven on a desktop; Redact has A word / A line), and, on a desktop only, the left side: Spectra's nav pane with its own icon strip put away, a file menu of nine tiles (Open, Save, Save as, Merge = `document.combineFiles`, Add pages, Split, Compress, Password, Export) and a row of buttons that switch its panel (Pages, Bookmarks, Search, Signatures, Attachments, Layers, Tags, Articles) put at the top of the pane by a portal (`LeftPanel` in rail.tsx), with Spectra's own Pages thumbnails below; the pane is opened once and a button in the top bar shows or hides it; and a slim bar along the top: the menu (Spectra's own menu tree,
  `commands/menus.ts`, as an accordion), Undo, Redo and Find. Every button calls Spectra's `invokeCommand`; the colour and
  thickness go through `spectra-editor/overlay/renderer/autora-style.ts` (which the canvas view and `PageCell` read, and which
  answers "no preference" until the tray sets something). `autora-tap.ts` answers a Redact tap or click from the page's text layer,
  and `PageCell` turns it into Spectra's own redaction mark and gives the mark a handle on each side; the edits to Spectra's files are in
  `overlay/renderer.patch`. Sign is Spectra's stamp mode with only the saved signatures showing (`html.autora-signing`), and its dialog
  has no image door. A tool with no tray (Stamps, Measure...) keeps Spectra's own strip (restyled: a card beside the bar on a
  desktop); a tool with a pane (Protect, Compress...) opens it as the dock's window in the middle on a desktop and as a sheet on a
  phone. The agent has every tool regardless of what is shown, and its manual (`server/handbook.ts`) describes this window. Pinned (a frame under 520px tall) it is
  for looking only. Video: `opencut-editor/overlay/web/app/editor/[project_id]/page.tsx` is a whole-file copy of OpenCut's
  page with a `PhoneLayout` (preview, timeline, Media and Edit sheets over the timeline slot, Export beside them, no header row)
  and an overlay of `timeline/components/timeline-toolbar.tsx` whose phone branch is six buttons; keep it in step with the
  pin's page, which never moves. Pages, Sheets and Slides were already pictures of the pages with tap-to-point
  (`OfficePages`), and Autora 3D was already built for touch (its own bottom bar). The bar at the top of every window on
  a phone is the name and round icon buttons (`TakeControl`, download, full screen), not text pills. Games are not
  done yet. Tests: `ui-pdfwindow`, `ui-video`.
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
