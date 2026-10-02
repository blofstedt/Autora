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

export interface Family {
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
    words: /\bpdfs?\b|\.pdf\b|\bacrobat\b|\bfill (?:in |out )?(?:the |this |a )?form\b|\bredact|\bsignature\b|\bstamp\b/i,
  },
  {
    id: "git",
    about: "work with a git repository: status, diff, log, blame, commit, branch, merge, push",
    match: (n) => n === "git",
    words: /\bgit\b|\bcommit\b|\bbranch(?:es)?\b|\bmerge\b|\bpull request\b|\brepo(?:sitory)?\b|\bdiff\b|\bblame\b|\bstash\b/i,
  },
  {
    id: "python",
    about: "a Python kernel that remembers its variables, for analysing data and drawing charts",
    match: (n) => n === "python",
    words: /\bpython\b|\bpandas\b|\bnumpy\b|\bdataframe\b|\bcsv\b|\bspreadsheet\b|\banaly[sz]e (?:the |this |my )?data\b|\bstatistic|\bregression\b|\bplot\b|\bmatplotlib\b/i,
  },
  {
    id: "library",
    about: "search the person's own documents and notes, with citations",
    match: (n) => n === "library",
    words: /\blibrary\b|\bmy (?:documents|files|notes|contracts?|manuals?)\b|\bsearch (?:my|the) (?:documents|files|notes)\b|\bwhat does (?:the|my) (?:contract|lease|manual|policy)\b|\bcite\b|\bcitations?\b/i,
  },
  {
    id: "media",
    about: "audio, video and images: info, frames, transcribe, OCR, trim, convert",
    match: (n) => n === "media",
    words: /\b(?:video|audio|recording|podcast|mp3|mp4|wav|mov|webm)\b|\btranscri(?:be|pt)|\bocr\b|\bscanned?\b|\bsubtitles?\b|\bffmpeg\b|\bconvert (?:the |this )?(?:image|video|audio)/i,
  },
  {
    id: "browserdev",
    about: "the browser's network log, and recorded browser flows replayed by name",
    match: (n) => n === "browser_network" || n === "browser_flow",
    words: /\bnetwork (?:tab|log|requests?)\b|\bapi calls?\b|\bhar\b|\brecord (?:a |this |the )?(?:flow|workflow|macro)\b|\breplay\b|\bmacro\b|\bflows?\b/i,
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

export interface LoadEvent {
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

export interface LoadContext {
  events: readonly LoadEvent[];
  /** What the person just said (this turn's message). */
  said?: string;
  /** A PDF is open in the window, or was uploaded: the pdf set is wanted. */
  hasPdf?: boolean;
  /** Everything on, whatever else is true. */
  all?: boolean;
}

/** The families in the model's list this step. */
export function loadedFamilies(ctx: LoadContext): Set<string> {
  if (ctx.all) return new Set(FAMILIES.map((f) => f.id));
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
