# Backlog

Ideas that are scoped but not started. Nothing here is promised. Sizes are
rough: S is days, M is a couple of weeks, L is a month or more, XL is a
project of its own. Move an item out of here (into an issue or a PR) when work
starts, and say why if one is dropped.

Every item below follows the pattern the PDF window set: a sandboxed editor
sub-project that talks to the page only by `postMessage`, state and files owned
by the server, an agent tool family loaded on demand (`server/toolload.ts`),
cursor cues, and presence so the agent leaves what the person holds alone.
After the second such window, pull that out into one shared "desk" abstraction
instead of copying `pdfdesk.ts` again.

Every creative item below follows the core principle in `CLAUDE.md`: the agent
removes friction and guides, the person keeps the creative decisions and the
granular controls. The 3D tool and the 2D game engine (a "Godot lite") are
built as easy tools first, with code in the background.

## Constraints that apply to all of them

- Autora runs on low-CPU Umbrel boxes, with no GPU and possibly no internet.
  Everything is bundled; nothing is fetched from a CDN (as `spectra-editor/` does).
- The container image grows with every engine (ffmpeg, WASM kernels, game
  libraries) and each release publishes to GHCR. Weigh size before adding one.
- Anything the agent produces runs in a sandboxed frame, never on the app's
  origin.
- Check licences (OpenCascade, ffmpeg build flags) before bundling.
- AI-generated art needs an image-model provider and does not work on a
  local-only install. Items that need it say so.

## Suggested order

1. Word tool, then Writers Block (1).
2. 2D game engine at tier 0, then tier 1 (3).
3. Animation layer (5), as the base for video and games.
4. Video editor (4).
5. 3D tool and its game mode (2), then the 3D game maker (7).

The music production tool (8) has started; its remaining work is independent of the rest.

The store (6) is independent of the rest and can start whenever there are
enough skills and tools worth sharing; free listings first.

## 0. Word tool (prerequisite for 1)

There is no word tool in the repo yet. Size: M.

- Rich-text editor in `word-editor/`, its own sub-project like `spectra-editor/`
  (TipTap / ProseMirror is the likely base), with comments anchored to text.
- `.docx` import and export.
- Agent tools to read the document and to comment on it. Decide separately
  whether the general agent may also edit text; Writers Block must not.

## 1. Writers Block

Size: S once the word tool exists.

A built-in skill that helps organise a story and critiques the writing, like
an editor or reviewer. It does **not** write for the person.

- Make "never writes" structural, not a prompt rule: the tool family has only
  comment, critique and `bible_*` tools, with no insert or replace.
- Critique arrives as anchored margin comments in the word tool.
- A "bible" store (probably a notebook type, `server/notebooks.ts`): characters,
  setting, background, who / what / why / when, a timeline.
- Critique checks the text against the bible ("Mara has green eyes in ch. 1").
- Prompts the person with questions to organise ideas, not answers.

## 2. 3D tool, with a game mode

Size: XL.

Simple editing like Tinkercad with some of Shapr3D's feel, with AI, and
export. A built-in run mode comes later and shares the game runtime from (3).

- Start with primitives plus mesh booleans (`manifold-3d`) rendered in three.js.
  A real B-rep kernel (OpenCascade.js, WASM) is heavy and slow on these boxes;
  decide later, and only if fillets and precise CAD are wanted.
- The agent works on a scene graph through ops: add, transform, boolean, group.
  LLMs do this well; organic sculpting they do not.
- Export STL, 3MF, glTF.
- Game mode (create and run) comes after (3), on the same game-as-data format.

## 3. 2D game engine

> **Done in part (0.9.175):** Autora Games, GDevelop's editor as a window with the agent working on its project file
> (docs/MODULES.md). That is this item's tier 1 on an existing engine, so "do not build two engines" now means: the 3D
> game mode should target GDevelop's 3D objects, not a runtime of its own. Still open: the asset store through a proxy,
> a screenshot/play tool so the agent can see the running game, and the debugger through the sandbox.

Size: M to L, in tiers.

- Tier 0 (days): templates for Phaser or Kaplay, a sprite and asset tool, and
  the agent building and running in the existing app window.
- Tier 1 (weeks): a visual editor (tilemap, entities, sprite painting) over a
  game-as-data file that the agent and the person both edit, with presence
  rules as in the PDF window.
- Runs in a sandboxed frame.
- Shares one runtime and one data format with the 3D game mode. Do not build
  two engines.

## 4. Video editor

Size: XL. A CapCut-style editor, kept narrow.

- First version: a timeline with trim, split, move, text overlays and audio;
  export to mp4 through ffmpeg on the server. Export speed on a box with no
  GPU is the main risk; measure early.
- The AI parts are cheap once the timeline is data: move or trim clips,
  transcript-based cutting (`server/speech.ts` may help), silence removal,
  auto-captions.
- Animations from (5) drop onto the timeline as clips.
- Out of scope for now: effects library, transitions library, keyframes,
  templates.

## 5. Animation layer

Size: L to XL. Shared by the video editor, the 2D engine and the 3D tool.

"Put a character here and here and say make him walk." The pipeline:

1. A character with a rig (see below).
2. A motion library of clips (walk, run, idle, wave, jump).
3. A path with timing from point A to point B; walk speed matches the distance
   so feet do not slide.
4. A language step that maps "make him walk" to a clip plus a path plus a
   duration. The agent edits a timeline of these ops, so the person can adjust
   them by hand.

Output is reusable: a transparent render for the video timeline, or a sprite
sheet / skeletal animation for the 2D engine.

Where the character comes from is the hard part, and the choices are:

- **Bring your own rigged character** (3D humanoid, or a layered 2D file).
  Cheapest; do this first, with a small built-in cast.
- **Auto-rig a 2D image** by splitting it into parts and fitting a skeleton
  (Spine / DragonBones style). Works for simple characters and fails on
  arbitrary art.
- **Generated frames** from an image or video model. Flexible, needs a
  provider, so not for local-only installs.
- **3D humanoid with retargeted clips** (Mixamo style), tied to (2). Good
  walk cycles, needs the 3D tool first.

Recommendation: start with a built-in 2D skeletal cast and a procedural
walk / run / idle library, then widen to other sources.

## 6. Autora Store

Size: XL. Not a window like the others: a marketplace, so it does not follow
the sandboxed-editor pattern above. It needs a hosted service Autora talks to,
which is new, since everything else runs on the person's own box.

A place where people list skills and tools for others to install, free or
paid.

- **Free listings are free.** Paid listings pay the seller, and the store keeps
  a small cut. That is the monetisation: many small cuts instead of charging
  for Autora itself. Autora stays free to run.
- **Ratings are the reason to pay.** A skill or tool that is rated well by
  other people is worth a dollar or two against building and testing one
  yourself. Ratings (and probably review text and install counts) are
  therefore the core of the store, not an extra. Only people who installed an
  item can rate it, so ratings are hard to fake.
- What can be listed: skills, and tools (`server/customtools.ts` scripts, MCP
  setups from `server/mcpcatalog.ts`). Listings carry a name, description,
  version, price, screenshots and what the item needs access to.
- Installing puts the item where the agent already finds it, so the store
  adds no new way of running things.
- Safety is the main risk. A tool runs shell commands for whoever installed it
  and Autora has no login, so a paid or free listing is untrusted code. At
  minimum: show what an item can touch before install, run listed tools
  through `server/guard.ts`, scan or review listings, and let people report
  and the store pull an item. Credentials are never part of a listing
  (`server/credentials.ts`).
- Needs sellers and buyers to have accounts, payments and payouts, refunds,
  tax handling and seller terms. A payment provider with marketplace payouts
  (Stripe Connect or similar) is the likely base; decide before building.
- Autora may have no internet (see the constraints above), so the store is
  opt-in and the app works fully without it. Paid items need to keep working
  offline once bought.
- No chat-app or third-party notification channels for store activity, as
  elsewhere: notifications go through the installed app (`server/push.ts`).

- **Every listing is labelled by how the agent behaves in it**, following the
  core principle in `CLAUDE.md`:
  - *Full agentic* (productivity: documents, data, files, automation): the
    agent does the whole job.
  - *Guided* (creative: writing, art, music, games, 3D): the agent removes
    friction and coaches, and the person keeps the creative decisions and
    granular controls.
  The label is a promise, so it is checked, not self-declared. A guided
  listing's tool set must not include tools that write or replace the person's
  creative work (the same structural rule as Writers Block), and the install
  safety review looks at this. Browse and filter by label; a listing that
  mixes both says which part is which.

First version to try: free listings with ratings only, to get the catalogue,
the install path and the safety checks right before any money moves. Add paid
listings and the cut once there is something worth paying for.

## 7. 3D game maker

Size: XL. Backlog only; this is the hard one. Item 2 already lists a game mode
for the 3D tool; this is that mode grown into a tool of its own, so decide
whether to fold the two together when (2) starts.

- Build on (2) for the scene graph and (3) for the game runtime and
  game-as-data format. Do not build a third engine.
- Candidate runtime: three.js with a small physics library (Rapier WASM), run
  in a sandboxed frame. Babylon.js is the alternative; pick one for both 3D
  tool and games.
- Person and agent both edit the same scene-and-rules file: place objects, set
  behaviours (move, collect, spawn, win / lose), test-play in the window.
- Assets: primitives and a small built-in kit first; imported glTF next.
  Generated models need a provider and do not work on local-only installs.
- Main risks: rendering and physics on low-CPU boxes with no GPU, and an agent
  that can reliably make a 3D game playable without seeing it feel. Measure
  frame rate on a real Umbrel box before committing.

## 8. Music production tool: started (Autora Studio, 0.9.170)

Moved out of the backlog because work started: the first version is built (see `docs/MODULES.md`, Autora Studio). It is a window of
this app's own React code with the audio engine in the page (Web Audio, nothing fetched), not a sandboxed `postMessage` sub-project:
there is no third-party editor to fence in. What is in: tracks of built-in instruments and drums, clips, a piano roll and a drum
grid, a mixer, a click track, WAV export, and `studio_*` tools (chords, a bass that follows them, a drum beat, quantize,
humanize, transpose, levels, "this clip" focus). What is left, in the order that would help most:

- **Sample import** (wav / mp3) as audio clips with a waveform, and mp3 export (ffmpeg on the server).
- **MIDI**: import and export of .mid, and Web MIDI keyboard input to record notes.
- **A loop region** (the song loops as a whole today), **swing** on the transport, **automation** lanes, **patterns** reused across
  a playlist (clips are copied today).
- **Hearing for the agent**: it cannot listen, so render the bounce to a waveform / spectrogram picture it can look at.
- **A melody coach** in the pattern of Writers Block: it asks and critiques but has no insert tool. Today `studio_notes` can write
  notes when the person asks, and the briefing says to do so only then; a tool family without it would make that structural.
- A small effects rack (filter, delay, compressor) and presence (`held`) so the agent leaves a clip the person has taken alone.
- Out of scope for now: VST / plugin hosting, audio recording and editing, time-stretching.

## Open questions

- Store: what cut, and a minimum price? Who hosts it, and does a store
  account exist separately from the install (Autora has no login today)?

- Does the word tool exist elsewhere (SecurePDF-style), or is it new here?
- Target hardware: real Umbrel boxes or stronger machines? That decides
  whether video export and OpenCascade are viable.
- Is AI-generated art or sprites in scope, given local-only installs?
