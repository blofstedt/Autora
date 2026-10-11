# Repo map

Where to look for what, so a change can start from two or three files instead
of the whole tree. Line numbers drift; search for the **symbol** named, not the
number. Sizes are lines, as of 0.9.159.

## Skip these unless the task is about them

| Path | Lines | What it is |
|---|---|---|
| `spectra-editor/src/renderer/` | ~340k | **Not in the repo.** Spectra-PDF's renderer, fetched from the commit in `spectra/PIN.json` and patched by `scripts/prepare-spectra-editor.mjs` (run by `npm run build` and `npm run lint`). It is gitignored; if it is on disk, do not edit it. |
| `opencut-editor/src/web/` | ~90k | **Not in the repo.** OpenCut's editor, fetched from the commit in `opencut/PIN.json` by `scripts/prepare-opencut-editor.mjs` (run by `npm run build` and `npm run lint`) and overlaid by `opencut-editor/overlay/web/`. Gitignored; never edit it. |
| `gdevelop-editor/work/` | ~300k | **Not in the repo.** GDevelop's editor (`newIDE/app`), runtime and extensions, fetched from the commit in `gdevelop/PIN.json` by `scripts/prepare-gdevelop-editor.mjs` and made Autora's by `gdevelop-editor/overlay/` and `patches.mjs`. Gitignored; never edit it. |
| `spectra-editor/` (the rest) | small | Autora's own: `src/autora/` (the Tauri shim), `overlay/renderer.patch` (edits to Spectra's `App.tsx`, `i18n.ts`, `index.tsx`), `overlay/renderer/` (`autora.css`, `locale-loaders.ts`), `vite.config.ts`, `tsconfig.json`. |
| `package-lock.json`, `*/package-lock.json` | | Lockfiles. |
| `dist/`, `.cache/`, `node_modules/` | | Build output, the GenOffice/Spectra checkouts, deps. |
| `docs/screenshots/`, `public/icons/` | | Images. |

After a build, `spectra-editor/src/renderer/` exists on disk (gitignored) and
dwarfs everything else: search with `--glob '!spectra-editor/**'` unless the
task is about the PDF editor's shim or overlay.

## The request path, end to end

1. **Client** sends a message: `src/App.tsx` `send` -> `POST /api/sessions/:id/message`.
2. **Server** `server.ts`: the route calls `startTurn()` -> `beginTurn()` -> `runTurn()`.
3. **`runTurn()`** (`server.ts`, ~1,750 lines, one function):
   - setup closures: `charge`, `askModel` (model call + retries), `summarize`/`compacted`
     (context), `researchFor` (sub-agent), `contextFor` (the `ToolContext` each tool gets),
     `watched` (loop watch + error budget), `siteMemory`, `execCheck` (project check),
     `personEdits`/`announceCode` (code diffs);
   - the round loop: `for (;;)` near the end -- model call, tool calls via `runTool()`
     (`server/tools.ts`), notes appended to results, finish audit.
4. Every observable act goes through **`emitEvent()`** (`server.ts`): redacts (`redactDeep`),
   appends to `events.jsonl` (`server/store.ts` `appendEvent`, batched), sends to sockets.
5. **Client** receives on `/ws/:session` (`src/lib/stream.ts` `SessionStream`), batches
   (`EVENT_BATCH_MS` in `App.tsx`), folds the whole log with `derive()` (`src/lib/derive.ts`),
   keeps unchanged cards' identity with `share()` (`src/lib/share.ts`), renders `Thread`.

## `server.ts` (6.4k lines), by region

| Region (search for) | What |
|---|---|
| top -> `createInitialSession` | imports, module-level maps (one per concern, keyed by session id), loading sessions lazily (`events` getter) |
| `sweep`, `forgetSession` | retention, and the list of every per-session map to clear |
| `redactDeep`, `emitEvent`, `logEvent` | the event bus |
| `touchPresence`, `scheduleRemark`, `remarkOn` | presence + companion remarks |
| `browserFor`, `captchaVision` | the session's live browser |
| `previewRunFor` ... `previewStart` | the app (Creator) window |
| `stopTurn`, `askPermission`, `askPerson`, `settleAsk` | approvals and questions |
| `modelGuard`, `heldFor`, `targetBrowser` | guards before a tool runs |
| `engineFor`, `historyFor`, `pastToolCalls` | context engine and history sent to the model |
| `systemInstructionFor` | the system prompt: `pinned` (cached) + `note` (per turn) |
| `notify`, `sendPush`, `flushHeldPushes` | phone notifications |
| `proactiveSweep`, `createJob`, `noticeTick`, `reflect` | jobs, watchers, proactive turns, learning |
| `startTurn`, `beginTurn`, `loadedTools`, `autoLoadTools` | turn entry points |
| `runTurn` | the agent loop (above) |
| `startServer` | Express app + all routes (list below), websockets, static files, shutdown |

### Routes in `startServer` (search for the path string)

- Sessions: `/api/sessions`, `/api/sessions/:id` (patch/delete), `/events`, `/blobs/:blob`, `/trace`, `/presence`, `/control`, `/message`, `/interrupt`, `/ask/:askId`, `/frame`
- Browser: `/api/sessions/:id/browser/*` (scroll, click, type, key, navigate, tabs, find, devtools...), `/api/browser/*`, `/api/extensions/*`
- App window: `/api/sessions/:id/preview/*`, `/api/versions`, `/api/versions/restore`
- Mind: `/api/memory*`, `/api/collaboration`, `/api/agent-cursor`, `/api/memory-settings`
- Automation: `/api/jobs*`, `/api/triggers*`, `/api/automation`, `/api/autonomy*`, `/api/policy/:requestId`, `/api/proactive*`
- Settings: `/api/settings`, `/api/secrets*`, `/api/credentials*`, `/api/providers/:id/*`, `/api/usage*`, `/api/speech*`
- System: `/api/system`, `/api/host`, `/api/storage*`, `/api/notices`, `/api/tools/health`, `/api/custom-tools*`, `/api/relay`, `/relay.py`, `/api/push/*`
- Elsewhere: `server/routes/{system,artifacts,mcp,notebooks,memory,keys,settings,health,preview,browser,jobs,triggers,proactive}.ts` (memory graph and the small Mind switches; secrets, credentials, provider models, billing and usage; the Settings API and speech; tool health, host, storage, custom tools; the app window; the live browser's clicks, tabs, devtools, extensions and the app's versions; scheduled jobs; triggers; suggestions, notices and push). What each needs from `server.ts` arrives in a typed `deps` object; the shapes `Session`, `PreviewRun`, `Notice` and `AutoraEvent` are in `server/session-types.ts`. Still in `startServer`: sessions, the event/blob/trace reads, `/browser` state, `message`, `interrupt`, `ask`, policy approvals, autonomy, relay and the widget routes; `officeRoutes` (`server/officedesk.ts`); `deskRoutes` (`server/pdfdesk.ts`); `spectraRoutes` (`server/spectra.ts`); `server/newfile.ts`

## `server/`, by job

| Job | Files |
|---|---|
| Model calls | `llm.ts` (one call, any vendor), `providers.ts` (vendors, prices), `billing.ts`, `vendor-money.ts` |
| The prompt | `prompt.ts`, `guides.ts` (the `*_GUIDE` texts), `tools.ts` `capabilityBriefing`, `server.ts` `systemInstructionFor`, `COLLABORATION` |
| Tool schemas | `specs/{browser,computer,files,memory,person,schedule,studio,terminal,video,voice}.ts` (`pdf_*` and `office_*` live in `specs/files.ts`) |
| Tool execution | `tools.ts` `runTool` (the big switch), `argcheck.ts`, `guard.ts`, `modes.ts`, `toolload.ts` (which families are shown) |
| Context | `context.ts` (compaction, vault), `pages.ts` (page re-reads), `readfile.ts`, `hints.ts` |
| Loop safety | `loopwatch.ts`, `errorbudget.ts`, `budgetstore.ts`, `toolhealth.ts`, `resume.ts`, `verify.ts` |
| Working notes | `todos.ts`, `ledger.ts`, `requirements.ts` |
| Sub-agent | `subagent.ts` (+ `researchFor` in `runTurn`) |
| Memory | `memory.ts`, `mindrules.ts`, `site.ts`, `learning.ts` |
| Browser | `browser.ts` (4.5k: `LiveBrowser`), `human.ts`, `captcha*.ts`, `pagedescribe.ts`, `browsedata.ts`, `extensions.ts`, `cookies.ts`, `signins.ts`, `liveview.ts` |
| App window | `preview.ts`, `pick.ts`, `domdiff.ts`, `snapshots.ts` |
| Code | `codediff.ts` (`Workspace`), `codesearch.ts`, `editfile.ts`, `merge3.ts`, `background.ts` (long jobs) |
| Video | `opencut.ts` (the project store, the window's state, commands to the editor, the `video_*` tools), `specs/video.ts` |
| PDF | `pdf.ts` (3k: every `pdf_*` tool), `pdftext.ts`, `pdfrender.ts`, `compose.ts`, `pdfdesk.ts` (window state), `spectra.ts` + `spectra/{engine,commands}.ts` (the window's editor and its Python engine) |
| Music | `studio.ts` (the song per chat, routes, commands to the window, `runStudioTool`), `specs/studio.ts`, `src/lib/studio/model.ts` (the song and the theory: shared with the page) |
| Games | `gamedesk.ts` (the game per chat, routes, previews, files, `runGameTool`), `specs/game.ts`, `game-catalog.json` (GENERATED by `scripts/make-game-catalog.mjs`), `game-starter.json`, `gdevelop-editor/` (GDevelop's editor: overlay + patches) |
| Photo | `photodesk.ts` (the picture per chat, routes, the command-line runner, `runPhotoTool`, `servePhoto`), `specs/photo.ts`; the editor is built by `scripts/build-photo.mjs` from `photo/` (pin + Rust overlay) |
| Autora 3D | `caddesk.ts` (the model per chat, routes, `runCadTool`), `specs/cad.ts` (GENERATED tool list), `autora-3d/` (the modeller's source: a copy, see below) |
| Office | `office.ts` (CLI tools), `officedesk.ts` (window), `officehost.ts` (Electron stand-in engine), `officerender.ts` (headless PDF), `officepages.ts` (phone pictures) |
| Static files | `staticfiles.ts` (compressed, cached `express.static`) |
| Persistence | `store.ts` (sessions, events, vault), `state.ts` (settings, secrets, usage, redactor), `blobs.ts`, `artifacts.ts`, `notebooks.ts`, `retention.ts`, `credentials.ts` |
| Scheduling | `scheduler.ts`, `triggers.ts`, `automation.ts`, `autonomy.ts`, `proactive.ts`, `quiet.ts`, `noticer.ts`, `suggest.ts` |
| Collaboration | `presence.ts`, `companion.ts` |
| Agents and Threads | `agents.ts` (the roster and the org map), `threads.ts` (the forum), `routes/organization.ts`; `runAgentTask` in `server.ts`; tools `agents` and `thread` (`specs/files.ts`) |
| MCP | `mcp.ts`, `mcpcatalog.ts`, `mcpoffer.ts`, `mcpscript.ts`, `mcplaunch.ts`, `customtools.ts` |
| Voice | `speech.ts` (TTS), `dictation.ts` (STT) |
| Network/security | `crosssite.ts`, `tls.ts`, `hosts.ts`, `push.ts`, `webpush.ts` |
| Desktop relay | `desktop.ts` |
| Misc | `logs.ts`, `trace.ts`, `replay.ts`, `inventory.ts`, `host.ts`, `thumbs.ts`, `widgets.ts`, `attach.ts`, `fileref.ts`, `newfile.ts`, `ephemeral.ts` |

## `src/` (client)

| Job | Files |
|---|---|
| Shell | `App.tsx` (2.3k: session, stream, panes, composer, routing between pages), `main.tsx` |
| Event log -> UI | `lib/stream.ts`, `lib/derive.ts`, `lib/share.ts`, `lib/steps.ts`, `lib/types.ts` |
| Thread | `components/Thread.tsx` (`TurnBucket`, `CellView`, `Reply`), cells: `ToolCell`, `TerminalCell`, `FileCell`, `ImageCell`, `AskCell`, `PermissionCell`, `TodoCell`, `MemoryCell`, `LearnedCell`, `RemarkCell`, `WidgetCell`, `ScreencastCell`, `Markdown` |
| Phone stage | `lib/stage.ts`, `components/Stage.tsx`, `ImmersiveChat.tsx`, `lib/fullscreen.ts`, `lib/cursorPos.ts` |
| Windows | Video: `OpenCutWindow`, `lib/opencut.ts`. Games: `GameWindow`, `lib/gamedesk.ts`. 3D: `CadWindow`, `lib/caddesk.ts`. Photo: `PhotoWindow`, `lib/photodesk.ts`. Music: `StudioWindow` + `studio/{Arrangement,PianoRoll,Mixer,useSong}`, `lib/studio.ts`, `lib/studio/{model,engine}.ts`. Browser: `ScreencastCell`, `lib/liveFrame.ts`, `lib/pageInput.ts`. App: `AppPreview`, `AppInspector`, `AppReview`, `AppVersions`, `DevtoolsPanel`, `lib/preview.ts`, `lib/appApi.ts`. PDF: `SpectraWindow`, `lib/spectra.ts`, `lib/pdfdesk.ts`. Office: `OfficeWindow`, `OfficeCursor`, `OfficePages`, `lib/officedesk.ts`, `lib/officeSelection.ts`, `lib/humanPath.ts` |
| Pages (menu) | `components/Rail.tsx`; lazy: `components/pages/*` (Organization and Threads: `OrganizationPage`, `ThreadsPage`, `lib/organization.ts`) ; eager: `Settings.tsx`, `Sessions.tsx`, `Schedule.tsx`, `Triggers.tsx` |
| Settings cards | `Settings.tsx` (1.5k), `SecretStore`, `Credentials`, `VoiceCard`, `NotifyCard`, `QuietCard`, `CaptchaCard`, `AutomationCard`, `CollabSettings`, `TimeZoneCard`, `ModelPicker`, `SetupCard` |
| Composer | `DictateButton`, `AttachButton`, `SlashMenu` + `lib/commands.ts`, `ModeSelect`, `PermissionsPill`, `SpendBar`/`SpendPeek` + `lib/spend.ts`, `LiveChat` + `lib/voice.ts` (1.9k), `lib/liveview.ts` |
| Shared hooks | `lib/poll.ts` (`every`, `usePoll`: polling that pauses while the tab is hidden), `lib/sure.ts` + `components/SureHost.tsx` (the "are you sure?" dialog; never `confirm()`), `lib/ago.ts`, `lib/systemTabs.ts` |
| Tool rail | `components/ToolRail.tsx` (bar, All tools grid, tray), `lib/toolrail.ts` (tool list type, verb colours, pins); `docs/TOOL-RAIL.md` is the spec |
| Look | `styles.css` (6.6k, one file), `fonts.css`, `lib/theme.ts`, `lib/mark.ts` + `AutoraMark.tsx`, `Icons.tsx` |

`styles.css` is ordered roughly by feature; search for the component's root
class (`.pdf-window`, `.app-window`, `.composer`, `.rail`, `.turn`, `.cell`...).

## Other places

| Path | What |
|---|---|
| `office/` | GenOffice build glue: `PIN.json`, `shim/` (page side), `host/` (Electron stand-in), `vite/` |
| `gdevelop/PIN.json`, `scripts/{gdevelop-checkout,prepare-gdevelop-editor,build-gdevelop-editor,make-game-catalog}.mjs`, `gdevelop-editor/` | GDevelop's editor (the game window): pin, fetch + overlay + patches, build, the engine's catalog for the agent |
| `opencut/PIN.json`, `scripts/{opencut-checkout,prepare-opencut-editor,typecheck-opencut-editor}.mjs`, `opencut-editor/` | OpenCut's editor (the video window): pin, fetch + overlay, Autora's shims and bridge |
| `photo/PIN.json`, `photo/overlay/autora.rs`, `scripts/build-photo.mjs` | PhotoCraft (the photo window): pin, the Rust overlay that wires its web build to the window, build of the editor (wasm) and the command line |
| `spectra/PIN.json`, `scripts/build-spectra.mjs` | Spectra's Python engine, fetched and built |
| `scripts/` | `build-office.mjs`, `build-spectra.mjs`, `replay.ts`, `spectra-look.ts` |
| `tests/` | one `*.test.ts` per area; `npm test -- <name>` filters, `-- -j 4` runs four at once (`tests/run.ts`); `ui-*` and `e2e-*` drive Chromium |
| `.github/` | `workflows/check.yml` (lint/build/test), image + release workflows, `scripts/check_release.py`, `scripts/offer_release.py` |
| `blofstedt-autora/` | Umbrel app manifest, compose file, store icon |
| `docs/` | `ARCHITECTURE.md` (why), `HARNESS_AUDIT.md`, `BACKLOG.md`, `GEMINI.md`, `REVIEW.md` (the October 2026 review), this file |

## Recipes

- **New tool**: schema in `server/specs/<group>.ts`, case in `runTool` (`server/tools.ts`), if specialist add to a family in `server/toolload.ts`, a test in `tests/`.
- **New route**: in a `server/routes/*.ts` module (what it needs from server.ts goes in a typed `deps` object, as `settingsRoutes` does), or inside `startServer` for the browser/preview/session routes that are still there; side effects never on `GET`.
- **Something that polls**: `every()` / `usePoll()` from `lib/poll.ts`, never a bare `setInterval`.
- **Asking before a delete**: `await sure("...")`, never `confirm()`.
- **New event kind**: emit via `emitEvent`; fold it in `derive()`; render in `CellView` (`Thread.tsx`).
- **New per-session state on the server**: a map in `server.ts` *and* a line in `forgetSession`.
- **New setting**: `server/state.ts` (type, default, `PATCH /api/settings`), UI in `Settings.tsx`.
