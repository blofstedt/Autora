# Office editors: ribbon audit

Goal: tailor Pages, Sheets and Slides to the 90% case by hiding the esoteric 60-70%
of the controls, without crippling them. The agent keeps every capability (the
`office_*` tools are independent of the editor's UI); only what the person sees changes.

Method: each editor was built from the pinned GenOffice commit (`office/PIN.json`),
opened in headless Chromium inside Autora at 1600x950 with the chat open, and every
ribbon tab was clicked and its visible groups and controls recorded. Counts below are
visible controls (buttons, selects, gallery items, colour swatches), as they appear today.

| App | Tabs | Controls on all tabs | Proposed tabs | Proposed visible controls |
|---|---|---|---|---|
| Pages (.docx) | 9 | ~157 | 5 | ~60 |
| Slides (.pptx) | 10 | ~123 | 5 | ~50 |
| Sheets (.xlsx) | 7 | ~185 | 5 | ~70 |

Tiers: **Keep** (visible), **More** (one click away, inside an existing dropdown or a
single "More" button per group), **Agent** (hidden in the editor; the person asks the
agent: "add a pivot table", "set up page numbers from page 2").

## Findings that are not about bloat

1. **Autora's own AI vs. the editor's AI.** `office/shim/common.js` hides GenOffice's AI
   panel, but Pages still shows **AI Resolve Comments**, **AI Revision Summary** (Review) and
   **AI Panel** (View > Appearance). These are probably dead or duplicate buttons. Verify and
   remove, or reroute to the Autora chat.
2. **Window chrome is jargon.** "Take control", "Agent cursor on", "Follow", "Versions · 1",
   "Saved as you go". Plain wording would help ("Edit myself", "Show what Autora is doing").
3. **Inconsistent chrome.** Pages and Slides have a purple **File** button; Sheets has none
   (and its File menu does not exist). Sheets' ribbon has no group labels at all, the others
   do. Sheets is a different component set (Univer-based `menu-select`), which is why it
   looks like a different product.
4. **Clipping.** At 1600 px with the chat open, Sheets' Home ribbon cuts off at
   "Conditional Form…" (Format as Table and Cell Styles are partly off-screen) and Slides'
   Find/Replace is clipped. Fewer controls fixes most of this; a "More" overflow fixes the rest.
5. **Slides Home has no New Slide button.** It is under Insert. It is the most common action
   in a deck and should be the first thing on Home, with a layout picker.
6. **Autora button** (big, leftmost) is good and consistent. Keep it. Make it the answer to
   every hidden feature ("Not here? Ask Autora").
7. **Escape hatch.** Hiding must be easy to undo (CLAUDE.md: "must stay easy to correct"):
   one **Show all tools** toggle in View (per app, remembered) restores the full ribbon.

## Pages (9 tabs, ~157 controls -> 5 tabs, ~60)

Tabs: keep **Home, Insert, Layout, Review, View**. Cut **Draw**, **References** and **Design**
as tabs. Their few useful items move into Insert and Layout.

| Tab | Keep | More | Agent |
|---|---|---|---|
| **Home** (54) | Font, size, bold/italic/underline, text colour, highlight, bullets, numbering, indent, 4 alignments, line spacing, Paste/Cut/Copy, Format Painter, Find, Replace, Autora. Styles gallery shows 6: Normal, Heading 1, Heading 2, Title, Subtitle, Quote | Strikethrough, sub/superscript, Aa case, Clear formatting, multilevel list, paragraph shading, paragraph borders, the other 12 styles (behind "More styles"), Styles Pane | Select All (Ctrl+A exists), Show/hide formatting marks (-> View) |
| **Insert** (20) | Table, Picture, Chart, Shapes, Link, Page Break, Header, Footer, Page Number, Comment, Text Box + **Table of Contents** and **Footnote** (moved from References) | Equation, Symbol | Cover Page, Blank Page, WordArt, Drop Cap, Field, Bookmark, Cross-reference |
| **Layout** (9) + **Design** (6) merged | Margins, Orientation, Size, Columns, Breaks, Page Color, Watermark | Themes, Fonts, Colors | Indent Left/Right (the ruler and Home cover it), Page Borders. Position and Wrap Text appear only when a picture is selected |
| **References** (12) | (none: items moved to Insert) | Caption | **Zotero (4 buttons), Citations, Bibliography, Index**, Endnote |
| **Review** (18) | Spelling, New Comment, Delete, Previous, Next, Track Changes toggle, Accept, Reject | Show Comments, Markup, Previous/Next change | Editor, Translate, Compare, Protect, AI Resolve Comments, AI Revision Summary |
| **View** (19) | Zoom (In, Out, 100%, Page Width), Print Layout, Read Mode, Ruler, Navigation Pane, formatting marks | Gridlines, One Page | Web Layout, Outline, Page Preview, Split, New Tab, Switch Tabs, Dark Mode (Autora owns the theme), AI Panel |
| **Draw** (19) | | | The whole tab: pen, highlighter, eraser, 14 pen swatches. Ink in a Word document is rare |

## Slides (10 tabs, ~123 controls -> 5 tabs, ~50)

Tabs: keep **Home, Insert, Design, Motion** (Transitions + Animations merged), **View**.
Cut **Draw** and **Review** as tabs. Slide Show becomes one **Present** button next to
Autora in the title bar (plus "From beginning" in its dropdown).

| Tab | Keep | More | Agent |
|---|---|---|---|
| **Home** (23) | **New Slide + layout picker (add)**, Font, size, B/I/U, text colour, Paragraph, Align, Paste/Cut/Copy, Format Painter, Find/Replace, Autora | Strikethrough, sub/superscript, clear formatting, Format Pane | From Current Slide (-> Present button) |
| **Insert** (20) | Table, Pictures, Shapes, Chart, Text Box, Link, Video, Comment, Slide Number | Icons, Audio | 3D Models, SmartArt, Zoom, WordArt, Header & Footer, Date & Time, Equation, Screen Recording |
| **Design** (10) | The 8 theme tiles (a good, already-Autora-looking gallery), Slide Size | Format Background | |
| **Motion** (22) | Transition gallery shows 6: None, Fade, Push, Wipe, Zoom, Morph + Apply to All. Animation dropdown, Preview | Remaining 6 transitions | Motion Paths, Add Animation, Animation Pane, By Paragraph, On Click/Duration/Delay (inside the Animation dropdown's own options) |
| **View** (14) | Normal, Slide Sorter, Notes, Zoom (Fit, In, Out) | Thumbnail Pane, Ruler | Outline View, Reading View, **Slide Master** (agent edits masters), Guides, Gridlines |
| **Slide Show** (8) | Present (title bar) | Hide Slide | Presenter View, Custom Slide Show, Set Up, Rehearse Timings, Record |
| **Draw** (22) / **Review** (4) | | Comment (Insert) | Ink tools, Spelling, Translate, Comments Pane |

## Sheets (7 tabs, ~185 controls -> 5 tabs, ~70)

Tabs: keep **Home, Insert, Formulas, Data, View**. **Page Layout** becomes **File > Print**
(page setup for printing is not what most people open a spreadsheet for). **Review** shrinks
to a few items inside Data and View.

| Tab | Keep | More | Agent |
|---|---|---|---|
| **Home** (~58) | Font, size, B/I/U, text/fill colour, Borders, wrap, 3 alignments, Merge, number format, $ % comma, +/- decimals, Conditional Formatting, Format as Table, AutoSum, Sort & Filter, Find, Paste/Cut/Copy, Format Painter, Insert/Delete row and column, Autora | Strikethrough, Paste Special, Cell Styles, Fill, Clear, Replace | Border Color, double underline, Orientation, Go To, Insert/Delete Cells..., the second row/column Format menu |
| **Insert** (30) | Table, Pictures, Shapes, Link, Comment, charts: **Recommended, Column, Line, Pie, Scatter** | Bar, Area, PivotTable, Checkbox | Radar, Doughnut, Combo, PivotChart, Edit PivotTable, Sparklines, Slicer, Timeline, Screenshot, Icons, Text Box, Header & Footer, Equation, Symbol |
| **Formulas** (25) | Insert Function, AutoSum, the function-category menus (Financial, Logical, Text, Date & Time, Lookup, Math) | Show Formulas | Name Manager (4), Trace Precedents/Dependents, Remove Arrows, Error Checking, Watch Window, Calculation Options, Calculate Now/Sheet |
| **Data** (24) | Sort, Filter, Clear filter, Remove Duplicates, Data Validation, Text to Columns | Group, Ungroup | Reapply, Advanced filter, Flash Fill, Consolidate, Subtotal, What-If, From Text/CSV, Merge Workbooks, Refresh, Refresh All (no external data to refresh) |
| **Review** (12) | New Comment, Delete, Previous, Next, Protect Sheet | Show Comments | Workbook Statistics, both Translates, Notes, Protect Workbook, Allow Edit Ranges |
| **View** (12) | Freeze Panes, Zoom, Gridlines, Formula Bar, Headings | Normal / Page Break Preview, Zoom to Selection | Highlight active row & column |
| **Page Layout** (24) | | Margins, Orientation, Size, Print Area (under File > Print) | Themes/Colors/Fonts, Breaks, Print Titles, scaling, View/Print toggles |

## Implementation plan (not started)

- One data file, `office/shim/simplify.js` (loaded by `office/vite/editor.mjs` beside
  `common.js`), with a per-app table: tabs to hide, controls to hide, controls to move into
  "More". The audit above becomes that table. It applies as CSS plus a `MutationObserver`
  for controls the editor renders later (galleries, dropdowns), the same approach as the AI
  panel rule at `office/shim/common.js:164`.
- Match by stable attributes (`aria-label`, `title`, class), never by position, and have
  `tests/` fail loudly if a listed label no longer exists after a `PIN.json` bump
  (the patching code already does this for the parse worker).
- Show all tools: a View toggle per app, remembered in the host's settings, default off.
- Merged tabs (Pages Layout+Design, Slides Motion) need real DOM work in GenOffice's
  `Ribbon.tsx`, not just hiding; if too fragile as a patch, leave them as two tabs and
  hide only the controls.
- Then the chrome pass: plain-language header buttons, a File button on Sheets, one set of
  group labels, no clipping.
- Rule of thumb for later additions: if a feature is not in Keep, it is the agent's.

## Decisions for the owner

1. Is **Draw** (ink) really out in all three? (Slides is the only place it could matter.)
2. Is **Track Changes** in Keep for Pages? It is the one "esoteric" feature that real
   collaborators use, and Autora's agent can use it to show edits.
3. **Slide Master** and **Page Setup/Print** are hidden but powerful: are you comfortable
   with them as agent-only?
4. Do we want usage logging (local, opt-in) for one release to check these tiers?
