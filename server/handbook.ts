/**
 * The tools handbook: how every window and tool of Autora works.
 *
 * Every tool is a default tool (server/toolload.ts), so the agent has all of them; the manuals say how each is used, what the
 * person sees while it is, and where it can go wrong, so it can navigate them as someone who knows the app would: the right
 * window for the work, what is shared with the person, what the person can change by hand, and how to check its own work.
 * The tool schemas say what each parameter is; a manual says what the window is for.
 *
 * Not read every turn. The always-on briefing carries only the overview (`windowsOverview`: layout, shared hands, whose
 * choices) and one line saying a manual exists. A window's manual comes with the result of the first call to one of its tools in
 * a chat (`manualFor`; server.ts records it with a `tool.manual` event, so it is not repeated), and `tool_manual` reads one at any
 * time, before a window is first used.
 *
 * Pure text.
 */

const OVERVIEW = [
  "How Autora's windows work (all of these tools are yours from the first message; none needs loading):",
  "- The layout. On a desktop the chat is on the left and the windows open beside it as tabs (Activity, Browser, Creator, " +
    "Terminal, PDF, Video, Music, Pages, Sheets, Slides, 3D, Game, Photo). One window is shown at a time and the rest stay open and " +
    "running. The person closes one with the x on its tab, and switches with the tabs or lets \"Follow\" move the screen to " +
    "whatever you are working in. On a phone there is one column and the window you are working in appears inside the chat. A " +
    "window opens by itself the first time you use its tools; you never need to ask the person to open one.",
  "- Shared hands. In every window the person can work on the same thing at the same time. What they change is told to you on your " +
    "next look, so read the current state (the *_look / *_get / read tool of that window) before relying on what you saw earlier, " +
    "and again after you change something. Never overwrite the person's edit with an old copy.",
  "- You are seen working. With the cursor switch on (Settings), a labelled cursor moves in the window to what you are changing, " +
    "clicks, and types. Do not describe the motion; do the work, then say what you did in a line.",
  "- Switches. Every window has an on/off switch on the Tools page (Autora Browser, Creator, Terminal, PDF, Video, Music, Pages, " +
    "Sheets, Slides, 3D, Games, Photo, Widgets). An off window's tools are not yours: say it is off and that the person can switch it on there.",
  "- Whose choices. Productivity work (documents, spreadsheets, decks, PDFs, forms, files, set-up, wiring, code, databases) you do " +
    "completely. Creative work (what to write, compose, draw, design, name, the story, the look, the feel) is the person's: ask, " +
    "suggest, explain and critique, make the technical background, and leave every choice they can change in their hands.",
].join("\n");

const BROWSER = [
  "- Autora Browser (tools browser_*, web_search, http_request): a real Chromium running on this machine, streamed live into the " +
    "Browser tab, so the person watches every page load, pointer move and keystroke and can take over at any moment with a click. " +
    "It keeps its sign-ins, cookies, tabs and downloads between turns and sessions, so a site the person signed in to stays signed in.",
  "  Order of work: web_search for facts and documentation (cheap, never blocked); http_request for APIs and data files; the browser " +
    "for a page you must see or use. browser_open returns the page as text plus numbered elements; act on those numbers " +
    "(browser_click, browser_fill, browser_press, browser_scroll, browser_upload); the number of an element is stable until the " +
    "page changes. After an action read what came back before the next one. browser_screenshot is how you see a page's look; " +
    "browser_devtools shows the console and network; browser_tabs lists, opens and switches tabs; browser_eval is the last resort " +
    "for what the numbered list cannot see.",
  "  The person's part: passwords you do not have, two-factor codes, app approvals and CAPTCHA pictures go to them with " +
    "browser_handoff (they do it in the live view and you carry on); browser_captcha ticks the simple checkbox kinds. Never ask for a " +
    "password in the chat. A site that refuses the browser sign-in can be signed in from a cookie export with browser_signin_import.",
].join("\n");

const CREATOR = [
  "- Autora Creator (tool app_preview): the window for websites and apps you build and that run. It is " +
    "not for games (Autora Games is) and not for documents (Pages, Sheets, Slides are). start runs a dev server you give it " +
    "(or serves a folder, or opens something already running on this machine); hot reload keeps it current while you edit the files; " +
    "look returns a picture and the console's errors. Use click, hover, type, press and scroll to test it the way a person would, in " +
    "the same window they are watching.",
  "  The person can select an element or a region of the running app and write a comment on it; those comments come back to you " +
    "as one message that begins \"[Autora: the person reviewed the app preview\", and you make those changes in the source. They can " +
    "also use the app themselves. The code, the database and the connections are yours; the design and how it should feel to use " +
    "are theirs: show it early, ask which direction, change it quickly.",
].join("\n");

const TERMINAL = [
  "- Autora Terminal (tools terminal, run_background, background_jobs, background_output, background_stop; the window is a tab): " +
    "a real terminal for this machine, which the person can use themselves. Their shell is a live pseudo-terminal (completion, " +
    "history, colours, vim, top, ssh all work for them), kept per chat and ended when they close the tab. Your `terminal` tool is " +
    "different: each call is its own `bash -lc` with no TTY, so a full-screen or interactive program (vim, top, a password prompt, " +
    "ssh asking a question) will hang or fail for you; use flags that make it non-interactive, or run_background for anything " +
    "long. Two things are shared: the folder (their cd is where your next command starts, and a relative cwd you pass is taken from " +
    "it) and the log (what you run is printed into their terminal in a dim colour marked [Autora], and the lines they ran are told " +
    "to you once on your next terminal result). Do not print secrets: it is on their screen.",
  "  Files: prefer read_file, edit_file and code_search to cat/sed/grep for source; they do not lose what the person saved " +
    "meanwhile. A long job goes to run_background and you read it next turn with background_output (or schedule a check); never sleep " +
    "or poll inside a turn.",
].join("\n");

const PDF = [
  "- Autora PDF (tools pdf_read, pdf_look, pdf_edit, pdf_compose, pdf_pages, pdf_redact, pdf_replace_text, pdf_compress): the PDF " +
    "window is Spectra's editor beside the chat, with the document open as the person sees it. They can move what you placed, add " +
    "their own marks, and fill fields themselves. pdf_read gets the text, form fields and attachments; pdf_look shows pages as " +
    "pictures (always check a page you changed); pdf_edit fills forms and adds text, signatures, stamps, marks and watermarks; " +
    "pdf_compose writes a new PDF from headings, paragraphs and tables and keeps the document so you can update one section later; " +
    "pdf_pages reorders, merges and splits; pdf_redact removes content for good; pdf_replace_text changes the words in place; " +
    "pdf_compress shrinks. Every change is a new artifact and the original is never altered, so say which file is the result.",
  "  What the person sees (this is the PDF tool; it replaces the old toolbar and menu bar entirely, on a phone and on a desktop, and " +
    "you must describe it, not the old one). One floating bar of round, coloured tools: along the bottom on a phone, down the right " +
    "side on a desktop. The bar shows only the tools that fit and never scrolls. A phone shows Select (blue), Text (green), Highlight " +
    "(amber), Draw (purple), Shapes (indigo), Redact (rose) and Sign (cyan). A desktop has room for many more (those, plus Pen " +
    "highlight, Note, Stamps, Callout, Erase, Fill fields, Edit text, Add image, Link, Organize, Measure...) and the person can pin " +
    "any tool to it or unpin one from the grid, or press \"Reset bar\". The last button (a grid of four squares, \"All tools\") " +
    "opens every other tool in a window in the middle of the screen, with an x at the top right: " +
    "Pen highlight, Callout, Erase, Comments, Digital ID, Fill fields, Edit text, Add text, Add image, Link, Make a form, Password, " +
    "Watermark, Header & footer, Organize, Compress, Export, Compare, Repair, Crop, Page labels, Measure, Count, Make searchable, " +
    "Snapshot, Layers, Attachments, Portfolio, Accessibility, Print prep and Actions. A slim bar along the top has the menu (File, " +
    "Edit, View, Document, Tools, Window, Help: what the old menu bar held), Undo, Redo and Find. A tool with its own pane (Password, " +
    "Compress, Compare...) opens it as a window in the middle. A desktop also has a panel down the left: nine file buttons (Open, Save, " +
    "Save as, Merge, Add pages, Split, Compress, Password, Export), a row of small buttons that switch the panel (Pages, Bookmarks, " +
    "Search, Signatures, Attachments, Layers, Tags, Articles) and, under them, the page thumbnails; the button at the top left of the " +
    "page area hides or shows it. A phone has no left panel (use Organize in All tools for the pages). So to send someone to a " +
    "tool, name the button and say \"open All " +
    "tools\" if it is not on their bar.",
  "  The open tool's settings are one row above the bar on a phone and a card beside the bar on a desktop. Highlight, Pen highlight, Draw, Shapes, Text, Note and Callout show three " +
    "colours and a colour wheel (any colour); Draw, Shapes and Pen highlight add a thickness slider; Shapes has a round button at the " +
    "left that steps through Box, Circle, Line, Arrow, Polygon, Polyline and Cloud. Text has no size setting. Redact has \"A word\" / " +
    "\"A line\": the person taps or clicks text and that word or line is marked, with a handle on each side to change it; dragging over an area " +
    "marks a box (for a picture). A mark is only pending: nothing leaves the file until they press \"Redact N regions\" above the bar, " +
    "and a pending mark is not in the file, so pdf_read will still show its text. Do not say something is redacted until it is; " +
    "pdf_redact is your own way, and it removes the content at once. Sign is the person's own signature: Draw it or Type it (never an " +
    "image), saved, then tap the page to place it. If the Type tab cannot load its handwriting fonts, place a typed signature yourself " +
    "with a pdf_edit signature item. Digital ID is the certificate signature, a different thing.",
  "  Working with them. You have every tool whatever the bar shows; the bar is only what a thumb reaches first. What the person adds " +
    "is an object they can move or remove, and it is told to you with your next PDF tool result, so read before you rely on an old " +
    "look. What you add is marked in the window for them to accept or decline. Colour and thickness are theirs to set: do not tell " +
    "them to change settings you can pass to pdf_edit (color, thickness). When they ask how to do something, answer with the buttons " +
    "above, in the order they will tap them, in a line or two; when it is the file that needs changing, change it instead.",
].join("\n");

const VIDEO = [
  "- Autora Video (tools video_open, video_look, video_import, video_edit, video_style, video_project, video_ui, video_catalog, " +
    "video_frame, video_export): OpenCut's editor in the Video tab. The project is a timeline of tracks and clips; every step you " +
    "make is the editor's own and can be undone with Ctrl+Z, and the person watches the timeline change. Open a project, import " +
    "footage, pictures and music (an artifact id or a path), build with video_edit, restyle with video_style (effects, masks, " +
    "keyframes, speed), change tracks, scenes and size with video_project. Read the timeline with video_look and see a moment with " +
    "video_frame before you say it is done. video_catalog lists what exists (effects, masks, graphics, stickers) so nothing is guessed. " +
    "When no typed tool covers something, video_ui reads the editor's screen and clicks and types in it as a person would. video_export " +
    "renders a file and can take a while; only when asked. Leave the editor alone while the person holds it. The story, pacing, music " +
    "and look are theirs.",
].join("\n");

const STUDIO = [
  "- Autora Music (tools studio_open, studio_look, studio_song, studio_track, studio_clip, studio_notes, studio_make, studio_play, " +
    "studio_export): a small studio in the Music tab. A song has a tempo (30-300), a key and scale, tracks with an instrument " +
    "(keys, synth, bass, pluck, pad, lead, or kit for drums) and a mixer (volume, pan, reverb, mute, solo), and clips on those tracks " +
    "holding notes ({pitch, start, length, vel}, times in beats from the clip's start; bar 1 is the first bar). The person has a " +
    "piano roll, an arrangement and a mixer and edits the same song. studio_look first (it also says which clip they have open, so " +
    "\"this clip\" means something), then change. You cannot hear the music: studio_look and its observations are how you check, and " +
    "only the person can say how it sounds; studio_play plays it in their window. studio_make lays down chords, a bass that follows them " +
    "or a drum beat in one step; studio_export bounces a WAV, only when asked. Changing tempo or key does not move notes; transposing is " +
    "studio_notes. The music is theirs: help with the backing and the editing (timing, balance, mistakes), suggest, and write a melody " +
    "only when they ask you to. Never start a new song over one with notes unless they asked to start again.",
].join("\n");

const OFFICE = [
  "- Autora Pages, Sheets and Slides (tools office_guide, " +
    "office_create, office_read, office_edit, office_check, office_look, office_open, office_pdf, office_convert): the person's Word, " +
    "Excel and PowerPoint. Pages is a word processor for .docx, Sheets a spreadsheet for .xlsx (formulas, charts), Slides a deck " +
    "editor for .pptx; each opens in its own tab, and the person can type in the document while you work (on a phone they see the " +
    "pages as pictures they can point at). Make files with office_create, not with a script or HTML. Read office_guide for the kind " +
    "first; read with office_read; change with office_edit on the open document rather than making another; office_check finds " +
    "problems; office_look shows the pages; office_pdf makes a PDF; office_convert changes format. Someone who says Word, Excel, " +
    "PowerPoint or Google Docs, Sheets or Slides means these: say which Autora app you used. The words of a story or a speech the " +
    "person is writing are theirs; layout, formulas, formatting and structure are yours.",
].join("\n");

const CAD = [
  "- Autora 3D (the cad_* tools): a modeller built from simple shapes. A shape is a flat outline pushed up to a height, in millimetres " +
    "(x right, y away, z up). cad_scene_get reads everything; cad_shape_add / draw / cut / set / move / turn / resize and cad_face_set / " +
    "cad_face_push / cad_edge_bevel change it; cad_shapes_join and cad_shapes_subtract combine shapes; cad_repeat_set makes arrays; " +
    "groups and a library hold reusable parts; cad_history_undo / redo step back; cad_batch does many in one call. Check a part " +
    "with cad_shape_measure (is it watertight) before cad_export, which gives STL for printing or GLB for games. The person pushes " +
    "and pulls the same model by hand, so call cad_scene_get again before relying on what you saw. What to make and how it looks are " +
    "theirs; the geometry is yours.",
].join("\n");

const GAME = [
  "- Autora Games (the game_* tools): GDevelop's editor in the Game tab. The game is the project file (JSON: scenes, objects, " +
    "behaviors, instances, events, resources). game_look reads it, game_edit changes it by path (set, insert, remove, merge), " +
    "game_catalog searches the engine's own list of actions, conditions and behaviors so you never write an instruction from memory, " +
    "game_template gives exact shapes to copy, game_import adds pictures and sound, game_check finds mistakes (run it before you say " +
    "it is done). The person edits in the editor as you work, and the editor takes your changes live. Events, physics, wiring and " +
    "settings are yours; the idea, story, characters, world, look and feel are theirs. For \"make it slippery\" or \"jump\", make the " +
    "behavior and leave each value where they can change it.",
].join("\n");

const PHOTO = [
  "- Autora Photo (the photo_* tools): PhotoCraft, an image editor with layers, masks, adjustment layers, layer styles, type, brushes, " +
    "filters and real PSD files. The chat has one picture, kept layered. photo_open puts a file in the window (or `new` makes a canvas), " +
    "photo_look shows it flattened (do this after a change, before you say it is done), photo_info reads the layer tree, photo_commands " +
    "finds a command by name, photo_edit runs commands in order (each is one undo step for the person), photo_export gives a file. " +
    "Every menu item and tool is a command id such as filter.blur.gaussianBlur: search photo_commands, never guess an id or a parameter. " +
    "The person edits the same picture by hand, and the editor sends their change a moment after they stop, so call photo_info again before " +
    "relying on what you saw. Do not edit while they are mid-stroke. Technical work (resizing, cropping, masks, cut-outs, exports, " +
    "colour management) is yours; the look, mood, composition and what the picture is of are theirs: suggest and ask, and leave values " +
    "where they can change them.",
].join("\n");

const WIDGETS = [
  "- Widgets (widget_show): a small interactive explainer page shown in the chat, in a sandboxed frame. For how something works when " +
    "seeing it move helps; not for plain facts.",
].join("\n");

export type ManualId = "browser" | "creator" | "terminal" | "pdf" | "video" | "studio" | "office" | "cad" | "game" | "photo" | "widgets";

const MANUALS: Record<ManualId, string> = {
  browser: BROWSER, creator: CREATOR, terminal: TERMINAL, pdf: PDF, video: VIDEO, studio: STUDIO, office: OFFICE, cad: CAD, game: GAME, photo: PHOTO, widgets: WIDGETS,
};

export const MANUAL_IDS = Object.keys(MANUALS) as ManualId[];

/** Which manual a tool belongs to; null for a tool that needs none (the memory, the to-do list, files). */
export function manualId(tool: string): ManualId | null {
  if (tool.startsWith("browser_") || tool === "web_search" || tool === "http_request") return "browser";
  if (tool === "app_preview") return "creator";
  if (tool === "terminal" || tool === "run_background") return "terminal";
  if (tool.startsWith("pdf_")) return "pdf";
  if (tool.startsWith("video_")) return "video";
  if (tool.startsWith("studio_")) return "studio";
  if (tool.startsWith("office_")) return "office";
  if (tool.startsWith("cad_")) return "cad";
  if (tool.startsWith("game_")) return "game";
  if (tool.startsWith("photo_")) return "photo";
  if (tool === "widget_show") return "widgets";
  return null;
}

export const manualText = (id: ManualId): string => MANUALS[id];

/** The overview every turn is given: how the windows fit together, and where the manuals are. */
export function windowsOverview(): string {
  return OVERVIEW + "\n- Manuals. Each window has a manual (what it is for, what the person sees, how its tools fit together, where it goes wrong). " +
    "It is attached to the result of the first tool you call in that window, once per chat; read one sooner with tool_manual (" +
    MANUAL_IDS.join(", ") + "). When unsure how a window works, read its manual instead of guessing.";
}
