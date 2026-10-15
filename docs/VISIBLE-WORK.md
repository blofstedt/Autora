# Visible work: the agent uses the app as a person does

The **Visible** switch (`VisibleWork.tsx`, Settings → Working together; one setting, `state.agentCursor`, mirrored by
`lib/agentCursor.ts`) decides how the agent's work in a tool window happens.

- **Visible on:** the agent works *through the window's own interface*, the way a person at the computer would, **live**:
  the person watches it being done, not a recording of it afterwards. The tool call does not finish until the window has
  done the work in front of them, so what the agent is told it did is what they saw happen. Every
  click, move, selection, keystroke and adjustment is made with the same controls the person has: it selects real text and
  types into it, opens the real menu or tool, drags the real slider, moves the real layer, clicks the real OK. Its cursor
  (its colour, its name) travels between them at a person's pace, so what the person watches *is* the work, not a picture of
  it.
- **Visible off:** no cursor and no pacing. The agent may change the file directly on the server, as fast as it can, and the
  window shows the result.
- **Nobody watching** (the window is not open in any tab) counts as off: there is nobody to show the work to, so it is
  never held up waiting for a window. A window that is open but whose editor is still starting takes the work and does it
  once the editor is up: someone is looking, so it is not done out of sight.

What is **not** acceptable with Visible on: a recording. Editing the file on the server and then playing a cursor
animation over the window ("pointing at where the change landed", swapping in staged copies of the file while a cursor
pretends to type) shows work that is already finished. That is how most windows began; each is being moved over, one at a
time, and this page is the list. A window that cannot do something live shows nothing for it rather than a replay.

## How a window does it

1. The tool call reaches the server as usual. With Visible on and a window that can do it, the server hands the call to the
   window (an ephemeral message on the chat's socket), waits for the first window to **claim** it (two tabs on one chat must
   not do it twice), and waits for its **answer**. Nothing claims it within a few seconds → the server does it itself, at speed.
2. The window drives its editor with the editor's own input: real pointer and key events into the editor (not calls into
   its document model), aimed at elements the editor really drew, found by where it drew them that frame.
3. The answer carries what each step did and the document as it now is; the server keeps that as the agent's change, and the
   window does not reload it (it already has it).
4. A step that has no control a person could use (no menu item, button or field for it) may run as the editor's own command,
   but its result says so (`how: "direct"`), so the gap stays visible and can be closed.

## Where each window stands

| Window | With Visible on today | Status |
| --- | --- | --- |
| Browser, Creator, App preview | Real input events into the page (`server/human.ts`, `LiveBrowser`): moves, clicks, keys, wheel | Done |
| Terminal | The command is drawn on the terminal's screen key by key (`termAgentBegin` emits it), but it runs in a process of its own, not in the shell the person sees | To do: type it into the shell itself |
| Photo | Live: `photo_edit` is done in the editor by hand while the call waits (no cursor is played over a picture the server changed): All tools → search → the tile → the command's dialog (values set in it, then OK), through the editor's own input (`photo/overlay/autora.rs`, `hand_*`; `byHand` in `server/photodesk.ts`) | Done for menu commands. Gaps: commands with no tile run directly (`how: "direct"`); dialog values are set in the dialog's fields with the cursor over the dialog, not by dragging each field's own widget; `photo_open` still loads the file into the window |
| Video | Commands run in the editor's timeline API (`toFrame`); the cursor goes to the located element first; text is typed in steps | Partial: the edits are API calls, not clicks on the editor's controls |
| PDF | Live: `pdf_edit` is done in Spectra by hand while the call waits (`spectra-editor/src/autora/hand.ts`; `server/pdfhand.ts`, `editByHand` in `pdf.ts`): the tool on the bar or in All tools, its colour in the card, a drag on the page for Text, Highlight (a box, or the words found in the page's text layer) and Shapes, a click for Note and Stamps, strokes with Draw for check, cross, curve and path, words typed into the editor's text box; form fields clicked and typed or ticked, then "Fill N fields"; then Select and Ctrl+S, whose save is the agent's change (`expectHandSave` in `pdfdesk.ts`), one mark to accept or decline. No cursor is played over a file the server changed | Done for those. Gaps: images, signatures, stamps other than Spectra's five, items over several pages, watermark, page numbers, properties, flatten, `change`/`remove`, and the other PDF tools (`pdf_pages`, `pdf_redact`, `pdf_replace_text`, `pdf_compose`, `pdf_compress`) are done on the file and appear; text size and thickness are left at the tool's own |
| Pages, Sheets, Slides | Live: what `office_edit` changes in the words is typed in the editor by hand while the call waits (`office/shim/hand.js`; `server/officehand.ts`, `handSteps` from the before/after files): Pages selects the words that change and types over them (the browser's insert-text into its ProseMirror page), types a new paragraph after the one it follows (Enter), selects and deletes a removed one; Sheets goes to each cell by typing its address in the name box, types into the cell's editor, confirms with the formula bar's tick; Slides double-clicks the box on its slide, types over the words that change, leaves with Escape. Then the file the operations made goes in (`showInWindow`), and its formatting appears. The old replay (`officestage.ts`, `OfficeCursor.tsx`, `cursor.js`) is gone | Done for words. Gaps: formatting, tables, pictures, charts, new slides or boxes, sheet structure (rows, columns, sheets) appear with the finished file; `office_create` appears; in Pages a tracked deletion stays struck through (nothing to delete by hand); at most 40 steps by hand per call |
| Music | Recording: the song is changed; then the clips that changed flash and the pointer points at them | To do |
| Games | Recording: the game is changed; then `GameCursor` points at what changed, and the editor reloads | To do |
| 3D | The frame's pointer goes to the tool's button, then the model is applied | Partial: the button is pointed at, not pressed |
| Code (file cards in the thread) | Code written to disk; the card types it out | A presentation of the file, not an editor: no change planned |

Each move is its own change: the window's manual in `server/handbook.ts` (and its test) says what the agent's hand does
there, and this table is updated in the same commit.
