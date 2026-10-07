# Repo map

Where to look for what, so a change can start from two or three files instead
of the whole tree. Line numbers drift; search for the **symbol** named, not the
number. Sizes are lines, as of 0.9.159.

## Skip these unless the task is about them

| Path | Lines | What it is |
|---|---|---|
| `spectra-editor/` | ~344k | Spectra-PDF's renderer, vendored whole (one commit). 16 MB of it is `src/renderer/locales/` (29 languages). Only `spectra-editor/src/autora/` (the Tauri shim) and `vite.config.ts` are Autora's own. |
| `pdf-editor/` | ~11k | SecurePDF's editor. **No longer shown**: `SpectraWindow` replaced `PdfWindow` (see docs/REVIEW.md, D1). Still built and served. |
| `package-lock.json`, `*/package-lock.json` | | Lockfiles. |
| `dist/`, `.cache/`, `node_modules/` | | Build output, the GenOffice/Spectra checkouts, deps. |
| `docs/screenshots/`, `public/icons/` | | Images. |

A grep from the repo root without `--glob '!spectra-editor/**'` spends most of
its output on the vendored editor.

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

## `server.ts` (8k lines), by region

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
- Elsewhere: `server/routes/{system,artifacts,mcp,notebooks}.ts`; `officeRoutes` (`server/officedesk.ts`); `deskRoutes` (`server/pdfdesk.ts`); `spectraRoutes` (`server/spectra.ts`); `server/newfile.ts`

## `server/`, by job

| Job | Files |
|---|---|
| Model calls | `llm.ts` (one call, any vendor), `providers.ts` (vendors, prices), `billing.ts`, `vendor-money.ts` |
| The prompt | `prompt.ts`, `tools.ts` `capabilityBriefing` + `*_GUIDE` constants, `server.ts` `systemInstructionFor`, `COLLABORATION` |
| Tool schemas | `specs/{browser,computer,files,memory,person,schedule,terminal,voice}.ts` (`pdf_*` and `office_*` live in `specs/files.ts`) |
| Tool execution | `tools.ts` `runTool` (the big switch), `argcheck.ts`, `guard.ts`, `modes.ts`, `toolload.ts` (which families are shown) |
| Context | `context.ts` (compaction, vault), `pages.ts` (page re-reads), `readfile.ts`, `hints.ts` |
| Loop safety | `loopwatch.ts`, `errorbudget.ts`, `budgetstore.ts`, `toolhealth.ts`, `resume.ts`, `verify.ts` |
| Working notes | `todos.ts`, `ledger.ts`, `requirements.ts` |
| Sub-agent | `subagent.ts` (+ `researchFor` in `runTurn`) |
| Memory | `memory.ts`, `mindrules.ts`, `site.ts`, `learning.ts` |
| Browser | `browser.ts` (4.5k: `LiveBrowser`), `human.ts`, `captcha*.ts`, `pagedescribe.ts`, `browsedata.ts`, `extensions.ts`, `cookies.ts`, `signins.ts`, `liveview.ts` |
| App window | `preview.ts`, `pick.ts`, `domdiff.ts`, `snapshots.ts` |
| Code | `codediff.ts` (`Workspace`), `codesearch.ts`, `editfile.ts`, `merge3.ts`, `background.ts` (long jobs) |
| PDF | `pdf.ts` (3k: every `pdf_*` tool), `pdftext.ts`, `pdfrender.ts`, `compose.ts`, `pdfdesk.ts` (window state), `spectra.ts` + `spectra/{engine,commands}.ts` (the window's editor and its Python engine) |
| Office | `office.ts` (CLI tools), `officedesk.ts` (window), `officehost.ts` (Electron stand-in engine), `officerender.ts` (headless PDF), `officepages.ts` (phone pictures) |
| Persistence | `store.ts` (sessions, events, vault), `state.ts` (settings, secrets, usage, redactor), `blobs.ts`, `artifacts.ts`, `notebooks.ts`, `retention.ts`, `credentials.ts` |
| Scheduling | `scheduler.ts`, `triggers.ts`, `automation.ts`, `autonomy.ts`, `proactive.ts`, `quiet.ts`, `noticer.ts`, `suggest.ts` |
| Collaboration | `presence.ts`, `companion.ts` |
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
| Windows | Browser: `ScreencastCell`, `lib/liveFrame.ts`, `lib/pageInput.ts`. App: `AppPreview`, `AppInspector`, `AppReview`, `AppVersions`, `DevtoolsPanel`, `lib/preview.ts`, `lib/appApi.ts`. PDF: `SpectraWindow`, `lib/spectra.ts`, `lib/pdfdesk.ts`. Office: `OfficeWindow`, `OfficeCursor`, `OfficePages`, `lib/officedesk.ts`, `lib/officeSelection.ts`, `lib/humanPath.ts` |
| Pages (menu) | `components/Rail.tsx`; lazy: `components/pages/*` ; eager: `Settings.tsx`, `Sessions.tsx`, `Schedule.tsx`, `Triggers.tsx` |
| Settings cards | `Settings.tsx` (1.5k), `SecretStore`, `Credentials`, `VoiceCard`, `NotifyCard`, `QuietCard`, `CaptchaCard`, `AutomationCard`, `CollabSettings`, `TimeZoneCard`, `ModelPicker`, `SetupCard` |
| Composer | `DictateButton`, `AttachButton`, `SlashMenu` + `lib/commands.ts`, `ModeSelect`, `PermissionsPill`, `SpendBar`/`SpendPeek` + `lib/spend.ts`, `LiveChat` + `lib/voice.ts` (1.9k), `lib/liveview.ts` |
| Look | `styles.css` (6.9k, one file), `fonts.css`, `lib/theme.ts`, `lib/mark.ts` + `AutoraMark.tsx`, `Icons.tsx` |

`styles.css` is ordered roughly by feature; search for the component's root
class (`.pdf-window`, `.app-window`, `.composer`, `.rail`, `.turn`, `.cell`...).

## Other places

| Path | What |
|---|---|
| `office/` | GenOffice build glue: `PIN.json`, `shim/` (page side), `host/` (Electron stand-in), `vite/` |
| `spectra/PIN.json`, `scripts/build-spectra.mjs` | Spectra's Python engine, fetched and built |
| `scripts/` | `build-office.mjs`, `build-spectra.mjs`, `replay.ts`, `spectra-look.ts` |
| `tests/` | one `*.test.ts` per area, run serially by `tests/run.ts`; `ui-*` and `e2e-*` drive Chromium |
| `.github/` | `workflows/check.yml` (lint/build/test), image + release workflows, `scripts/check_release.py`, `scripts/offer_release.py` |
| `blofstedt-autora/` | Umbrel app manifest, compose file, store icon |
| `docs/` | `ARCHITECTURE.md` (why), `HARNESS_AUDIT.md`, `BACKLOG.md`, `GEMINI.md`, `REVIEW.md` (the October 2026 review), this file |

## Recipes

- **New tool**: schema in `server/specs/<group>.ts`, case in `runTool` (`server/tools.ts`), if specialist add to a family in `server/toolload.ts`, a test in `tests/`.
- **New route**: inside `startServer` (`server.ts`) or a `server/routes/*.ts` module; side effects never on `GET`.
- **New event kind**: emit via `emitEvent`; fold it in `derive()`; render in `CellView` (`Thread.tsx`).
- **New per-session state on the server**: a map in `server.ts` *and* a line in `forgetSession`.
- **New setting**: `server/state.ts` (type, default, `PATCH /api/settings`), UI in `Settings.tsx`.
