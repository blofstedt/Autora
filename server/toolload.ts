/**
 * Which tools the model is shown, and when a specialist set is brought in.
 *
 * Every tool's schema is sent on every call. The whole set is about eighteen
 * thousand tokens, and most of a chat never touches the PDF editor, the widget
 * builder or the scheduler: it pays for them anyway, and a model reading
 * sixty-odd tool descriptions picks worse than one reading thirty. So the
 * specialist sets start out of the list, named in one line each, and come in
 * when they are wanted -- the person's words or a file say so, the agent calls
 * one of the tools, or the agent asks for the set with `tools_enable`.
 *
 * What was loaded is read back off the log (a tool call, or a `tools.enable`
 * event), so it holds across turns, interruptions and restarts without a
 * store of its own. Pure: a log and a message in, a set of names out.
 */

interface Family {
  id: string;
  /** What it is, for the one-line index. */
  about: string;
  /** Tools in it. */
  match: (name: string) => boolean;
  /** Words from the person that bring it in. */
  words: RegExp;
}

export const FAMILIES: Family[] = [
  {
    id: "pdf",
    about: "read, look at, edit, redact, compose, reorder and compress PDFs",
    match: (n) => n.startsWith("pdf_"),
    words: /\bpdfs?\b|\bautora pdf\b|\.pdf\b|\bacrobat\b|\bfill (?:in |out )?(?:the |this |a )?form\b|\bredact|\bsignature\b|\bstamp\b/i,
  },
  {
    id: "video",
    about: "Autora Video: open a video project and import clips, cut, arrange, title and export them",
    match: (n) => n.startsWith("video_"),
    words: /\bvideos?\b|\bautora video\b|\bopencut\b|\bfootage\b|\bclips?\b|\bvideo edit|\b(?:mp4|mov|webm)\b|\bsubtitles?\b|\bsplice\b|\btimeline\b/i,
  },
  {
    id: "studio",
    about: "Autora Music: make music in the music window -- tracks, chords, bass, drums, notes, tempo, mixing and a WAV export",
    match: (n) => n.startsWith("studio_"),
    words: /\bautora studio\b|\bmusic\b|\bsongs?\b|\bbeats?\b|\bdaw\b|\bchord progression|\bchords?\b|\bmelod(?:y|ies)\b|\bbassline\b|\bbass line\b|\bdrum (?:loop|pattern|track|beat|kit)|\bsynth(?:esizer)?\b|\bpiano roll\b|\bbpm\b|\btempo\b|\bmix(?:ing)? (?:the |a |my )?(?:song|track|tracks)\b|\bjingle\b|\bsoundtrack\b|\bproduce (?:a |some )?(?:track|tune|song)/i,
  },
  {
    id: "office",
    about: "Autora Pages, Sheets and Slides: read, edit, check, make and convert documents (.docx), spreadsheets (.xlsx) and presentations (.pptx)",
    match: (n) => n.startsWith("office_"),
    words: /\bautora (?:pages|sheets|slides)\b|\.(?:docx|xlsx|pptx)\b|\bword (?:doc|document|file)\b|\bexcel\b|\bspreadsheet|\bworkbook\b|\bpowerpoint\b|\bslide ?deck\b|\bslides?\b|\bpresentation\b|\bpitch deck\b|\bgoogle (?:docs|sheets|slides)\b/i,
  },
  {
    id: "cad",
    about: "Autora 3D: model, edit, measure and export 3D shapes (STL for printing, GLB for games) in the 3D window",
    match: (n) => n.startsWith("cad_"),
    words: /\bautora 3d\b|\b3d[- ]?(?:model|print|design|shape|object|part|scene)|\bcad\b|\.(?:stl|glb)\b|\bstl\b|\bextrud|\bbevel|\bprintable\b/i,
  },
  {
    id: "game",
    about: "Autora Games: make a game in the game window (GDevelop's editor) -- scenes, objects, behaviors, events, pictures and sound",
    match: (n) => n.startsWith("game_"),
    words: /\bautora games?\b|\bgdevelop\b|\b(?:make|build|create|design|prototype|code) (?:me )?(?:a |an |the |my )?(?:\w+ ){0,3}(?:game|platformer|shooter|puzzle game|rpg|arcade game)\b|\bvideo ?game\b|\bgame (?:jam|engine|design|scene|level|dev)\b|\bplatformer\b|\bsprite\b|\bgame objects?\b|\bpixel[- ]art game\b/i,
  },
  {
    id: "widgets",
    about: "show a chart, table or small interactive widget in the thread",
    match: (n) => n === "widget_show",
    words: /\bwidgets?\b|\bchart\b|\bgraph\b|\bplot\b|\bdashboard\b|\bvisuali[sz]/i,
  },
  {
    id: "mcp",
    about: "find and connect tool servers (MCP) for another service",
    match: (n) => n === "mcp_offer",
    words: /\bmcp\b|\bintegrations?\b|\bconnect (?:to |with )?(?:a |an |my )?(?:server|service|app)\b|\bconnector\b/i,
  },
  {
    id: "schedule",
    about: "schedule recurring jobs and watchers, and pre-authorise actions for them",
    match: (n) => n === "schedule" || n === "unschedule" || n === "pre_authorise" || n === "pre_authorisations",
    words: /\bschedul|\bevery (?:day|week|hour|morning|evening|night|monday|tuesday|wednesday|thursday|friday|weekday|\d+)|\bcron\b|\bremind|\brecurring\b|\bwatch(?:er)? (?:for|my|the)\b|\bmonitor\b|\bdaily\b|\bweekly\b|\bhourly\b/i,
  },
  {
    id: "notebooks",
    about: "group saved files into notebooks with notes between them",
    match: (n) => n === "notebook",
    words: /\bnotebooks?\b|\bgroup (?:these|my|the) (?:files|artifacts|documents)/i,
  },
];

interface LoadEvent {
  kind: string;
  payload: Record<string, any>;
}

/** What the log says was brought in: asked for, or already used. */
export function loadedFromLog(events: readonly LoadEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === "tools.enable" && typeof e.payload?.family === "string") out.add(e.payload.family);
    else if (e.kind === "tool.call") {
      const name = String(e.payload?.name ?? "");
      for (const f of FAMILIES) if (f.match(name)) out.add(f.id);
    }
  }
  return out;
}

interface LoadContext {
  events: readonly LoadEvent[];
  /** What the person just said (this turn's message). */
  said?: string;
  /** A PDF is open in the window, or was uploaded: the pdf set is wanted. */
  hasPdf?: boolean;
  /** Everything on, whatever else is true. */
  all?: boolean;
  /** Bring families in only as they are wanted (the person's words, use, tools_enable). Off by default: every tool is a default tool. */
  lazy?: boolean;
}

/** The families in the model's list this step. */
export function loadedFamilies(ctx: LoadContext): Set<string> {
  // Every tool is a default tool: the agent has all of them, and the handbook (server/handbook.ts) says how each works.
  if (ctx.all || !ctx.lazy) return new Set(FAMILIES.map((f) => f.id));
  const out = loadedFromLog(ctx.events);
  if (ctx.hasPdf) out.add("pdf");
  const said = ctx.said ?? "";
  if (said) for (const f of FAMILIES) if (f.words.test(said)) out.add(f.id);
  return out;
}

/** Tools out of the list: those of a family that is not loaded. */
export function withoutUnloaded<T extends { name: string }>(tools: readonly T[], loaded: ReadonlySet<string>): T[] {
  return tools.filter((t) => {
    const f = FAMILIES.find((x) => x.match(t.name));
    return !f || loaded.has(f.id);
  });
}

/** The one-line index of what is not in the list, or null when everything is. */
export function unloadedIndex(loaded: ReadonlySet<string>): string | null {
  const left = FAMILIES.filter((f) => !loaded.has(f.id));
  if (left.length === 0) return null;
  return [
    "More tools exist that are not in your list now, to keep it short. Load one with tools_enable (family), and its tools are there on your next step:",
    ...left.map((f) => `- ${f.id}: ${f.about}`),
  ].join("\n");
}

/** The families the model may ask for. */
export const familyIds = () => FAMILIES.map((f) => f.id);
