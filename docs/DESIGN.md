# Design vocabulary

What `src/styles.css` speaks, so a change looks like it belongs. `tests/tokens.test.ts`
fails when the stylesheet stops speaking it. The values are defined once, in the first
`:root` block of `src/styles.css`.

## Type: `font-size: var(--fs-*)`

Each token already carries the person's text-size setting (`--ts`), so never write
`calc(Npx * var(--ts))` yourself.

| Token | px | For |
|---|---|---|
| `--fs-2xs` | 10 | tiny caps labels, badges |
| `--fs-xs` | 11 | hints, timestamps, captions |
| `--fs-sm` | 12 | secondary text, dense controls |
| `--fs-base` | 13 | body text in panels and forms |
| `--fs-md` | 14 | list titles, inputs on a phone |
| `--fs-lg` | 15 | the conversation, page titles |
| `--fs-xl` | 16 | emphasis |
| `--fs-2xl` / `3xl` / `4xl` | 18 / 20 / 24 | headings, big numbers |

Two exceptions are deliberate: `font-size: 16px` on a phone's inputs (below 16px, iOS zooms
the page when one is focused), and the Studio's fixed-geometry controls.

## Corners: `border-radius: var(--r-*)`

`--r-2xs` 4 (a chip, a scrollbar thumb), `--r-xs` 6, `--r-sm` 8 (fields and buttons), `--r-md` 10,
`--r` 12 (cards), `--r-lg` 16 (panels, sheets), `--r-xl` 22 (the big sheet), `--r-pill`, and `50%`
for circles. 1px and 2px hairlines and a device bezel are the only literals.

## Motion

`--dur-1` 0.15s (a hover, a press, a colour), `--dur-2` 0.25s (something small arriving or leaving),
`--dur-3` 0.4s (a panel or a sheet); `--ease` to settle, `--ease-spring` for a little overshoot.
Ambient loops (breathing, shimmer, halos) and spinners keep their own tempo, and are `infinite` or
`linear`. If JavaScript waits for a CSS animation (the drawer's `260`, the to-do dock's `ROTATE_MS`),
it waits a little longer than the duration it is waiting for.

## Colour

Everything comes from a token, so every theme can change it.

- Surfaces `--bg --s1 --s2 --s3 --s4 --sink`, lines `--border --border-strong`, text `--text --text-2 --text-3`.
- Accent: `--accent --accent-light --accent-deep --on-accent --accent-soft --accent-line`; translucency is
  `rgba(var(--accent-rgb), a)`.
- Status: `--live` (good, running), `--warn`, `--danger`, each with an `-rgb` twin; `--live-light`,
  `--danger-light`, and `--on-live` / `--on-warn` for text on them.
- Behind a dialog or drawer: `--scrim` and `--scrim-blur`. Elevation: `--shadow-sm`, `--shadow`, `--shadow-lg`.
- Literals that stay literal: `#fff` on photos and video, the file-type tints of the Artifacts page, the
  Studio's piano keys, a phone's bezel. These are not interface.

## Fields and focus

A text field with its own border takes the accent and a soft halo on `:focus-visible`: add its selector to
the shared rule ("Text fields: one focus language") rather than writing another. Everything else gets the
global `:focus-visible` ring. A bare input inside a pill is lit by its wrapper's `:focus-within`.

## Dialogs

`.scrim` + `.modal` (`.modal-top`, `.modal-body`, `.modal-foot`) is the dialog; `sure()` (`src/lib/sure.ts`)
is the confirmation. Ask before something that cannot be undone, say what goes with it, and name the verb:
**Delete** for what the person or the agent made (tasks, triggers, memories, files, notebooks), **Remove**
for something detached (a saved sign-in, a secret, an MCP server, an agent from the map). Sessions are the
exception: they delete at once and offer Undo.

## The windows that are not this page

Frames that cannot read this page's custom properties are sent them: `src/lib/frameTheme.ts` posts
`--autora-*` tokens to the PDF and Office frames (`useFrameTheme`), which read them with Autora Violet as the
fallback. The video editor has its own, older channel (`autora:opencut:theme`), and GDevelop, the 3D window
and the terminal observe the page's `data-theme`. A new frame needs one of these: do not write a palette into
it.
