# The tool rail: one interface for every Autora app

The PDF window, then each other embedded app (Pages, Sheets, Slides, Video, Games...), is being
retrofitted to the layout SecurePDF and the 3D app share. Do one app at a time. Nothing an app can
do today may be lost: what leaves the chrome moves into the grid or the menu.

Reference: `docs/mockups/pdf-tool-rail.html` (open it in a browser; it works at desktop and phone width).
Live copy of the first version: https://claude.ai/artifact/A5vaGaNwJ8EFLA35jv3gDL

## The rules

1. **One floating rail.** Desktop: vertical pill on the right, centred. Phone: the dock along the bottom.
   The old menu bar, toolbar, tabs, side rail and tool dock are folded away, not deleted.
2. **Tool colours are SecurePDF's, per tool.** Round buttons; inactive = tinted background (16%) with the
   coloured icon, active = solid colour with a white icon and a glow. Select blue, Text emerald, Highlight
   amber, Draw purple, Shapes indigo, Note sky, Stamps gold (amber-600), Redact rose, Sign cyan. Icons are
   lucide's (MousePointer, Type, Highlighter, PenTool, Square, MessageSquare, Award, Eraser, Signature).
   Surfaces, type and motion stay Autora's (`src/styles.css`: violet accent, blue-black ladder, one easing).
   A new app picks a colour for each of its tools in the same family.
3. **The bar never scrolls, in either direction.** It shows only as many tools as fit the space the page
   has (measure with a `ResizeObserver`) and the grid button is always last, after a divider.
4. **The grid button opens "All tools"**: every tool the app has, grouped, each tile in its tool's colour.
   A modal in the centre of the screen on desktop and phone alike, over a dimmed backdrop.
5. **Desktop: pin and unpin.** Each tile has a pin; pinned tools are what the bar shows, in pin order.
   Pinning beyond what fits is refused ("The bar is full"). "Reset bar" restores the defaults. Pins are kept
   per app (per person); the mockup uses `localStorage`.
6. **Phone: no pinning.** The bar is the app's default tools, as many as fit; the person taps the grid
   button, then the tool they want. The default tools are the same on desktop until the person pins others.
7. **Options tray, compact on a phone**: no field labels or long hints; the tool's icon and name, its
   controls and the close button share one wrapped row (title and controls first, close pinned top right),
   with one short hint line only where the tool needs it (Redact, Note). A tray is 46px (Highlight) to about
   150px (Sign), never a stack of labelled rows. Only the open tool's settings (colour, size, hints), beside the rail on desktop and
   above the dock on a phone, in the tool's colour. Tools with no settings still show a one-line tray.
8. **Colour and thickness trays share one shape**: Highlight, Draw, Text and Shapes show the tool's icon, three
   colour swatches, a colour wheel (opens the system picker; shows the picked colour) and one slider (thickness,
   or size for Text). Draw, Shapes and Text use red, blue and black; Highlight uses yellow, green and pink
   (black would hide the text; that is Redact). Shapes adds the shape type (Box, Circle, Line, Arrow) before the
   colours: a pill on desktop, and on a phone a round shape button at the left of the row, with a small rotate
   badge in its corner, that steps through the shapes on each tap (Box first). On a phone the tool name is
   dropped and every one of these trays, Shapes included, is a single ~50px row.
9. **Top bar stays slim**: menu (what the menu bar held), pages/outline toggle, title, undo/redo, find, export.
10. **Phone bar defaults leave out Note and Stamps** (they stay in the grid) so the icons can be bigger:
   Select, Text, Highlight, Draw, Shapes, Redact, Sign. Desktop defaults keep all nine.
11. **Redact is tap-to-redact.** Tap text and the tool detects what is there (a word, or a line: a setting in
    the tray) and covers it; the new redaction is selected with handles on its four sides so the person can
    change its dimensions. Dragging over an area still draws a box, for anything that is not text. The text is
    removed from the file, not covered. In the real editor this means hit-testing pdf.js text items at the tap.
12. **Signatures are Sign (draw) or Type only. No image.** Then tap the page to place it.
13. Keep the editor's own commands underneath (as `spectra-editor/src/autora/phone.tsx` does with
   `invokeCommand`): restyle and re-arrange, do not re-implement.

## Retrofit order

PDF first, then Music (done, 0.9.196: the first user of the shared host-side component below), 3D (0.9.199), Pages, Sheets and
Slides (0.9.200: `office/shim/rail.js`, inside the editors' frame; every ribbon command is a tool, the ribbon is never shown), then
Video, Photo, Games. Autora 3D (done, 0.9.199) wears the rail in its own build (`autora-3d/src/components/Rail.tsx`, Tailwind, same colours and
rules): its bottom bar of text pills and the menus of its top bar are gone, the top bar is undo, redo and what is selected, and
every tool is on the bar or in All tools. It is a copy of blofstedt/3D-Modeling, and the change was made in the copy
(`docs/autora-3d-tool-rail.patch` is the same change; apply it upstream with `git apply -p2` before the next `scripts/sync-autora-3d.mjs`, which would otherwise undo it). Browser is a navigation bar, not a palette.

**No repeats.** When an app takes the rail, everything the rail now does is removed from the old chrome in the same change:
a tool that is on the bar is not also a button in a toolbar, a tab, a row of chips or a form. Music dropped its tempo/key row,
the Editor/Mixer tabs, the Split/Duplicate/Delete buttons in the dock, the "Add a track" row, and the phone's ask box and chips
(the chat is the chat; the suggestions are under Ask Autora in All tools). **Space.** An empty panel collapses to a line
(Music's piano roll with no clip open) so the canvas gets the room.

## Where it is built

- PDF, phone and desktop: done (0.9.187). `spectra-editor/src/autora/rail.tsx` and `rail-tools.ts`; see docs/MODULES.md, "Paired-down tools on a phone".
  What differs from the mockup: Text has colours only (Spectra's text boxes have one fixed size); the slider on Highlight is on
  "Pen highlight" (the freehand one) because Highlight follows the text; Redact marks are Spectra's pending redactions
  (applied with its "Redact N regions" button, not blacked out at once); Sign is Spectra's stamp mode showing saved signatures.
- Desktop is the same bar down the right side, with room for more tools (13 at a 900px window, pinned from the grid), a card beside
  the bar for the open tool with labels and hints, every figure of Shapes as a button, click-to-redact, and the menu (Spectra's
  menu tree) behind the button at the top left. Panes (Protect...) open as a window in the middle. The left side is the
  file menu (nine tiles), a row of buttons that switch Spectra's own panels, and the page thumbnails (SecurePDF's "Page Thumbnails"
  panel and header menu, in Autora's look); Spectra's icon strip is put away. A phone has no left panel.

## One component for apps whose editor lives in the host page

`src/components/ToolRail.tsx` (`ToolRail`: the bar, the All tools grid with pins, "Reset bar"; `RailTray`: the open tool's
options) and `src/lib/toolrail.ts` (`RailTool`, `VERB` colours, `usePins`). An app hands over a list of tools, each with a
colour (by verb, the same in every app), a grid group, `phone` (in the phone's bar) or `desktop` (pinned to start with),
and `run`. The window is `has-rail` plus `is-desk` or `is-phone`; the rail measures its window (`ResizeObserver`) and shows
only what fits. Pins are per app in `localStorage` (`autora-rail-pins-<app>`). Spectra's rail (inside its frame) is the same
design and is not yet this component.

## The agent has to know (it replaces the old window)

This interface replaces each window's old toolbar entirely; it is not a second mode. The agent reads a window's manual
(`server/handbook.ts`, delivered with its first tool call or by `tool_manual`) to know what the person sees, so every retrofit
changes that manual in the same commit, with an assertion in `tests/handbook.test.ts`. The PDF manual now describes the bar, the
grid, the trays, tap-to-redact (pending until "Redact N regions"), Sign (Draw or Type, never an image), and tells the agent not to
describe the old toolbar and to name the button and "open All tools" when pointing the person at a tool.
