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
    id: "photo",
    about: "Autora Photo: open, look at, edit and export photos and images (layers, masks, adjustments, filters, PSD) in the photo window",
    match: (n) => n.startsWith("photo_"),
    words: /\bautora photo\b|\bphotocraft\b|\bphotoshop\b|\.(?:psd|psb|pcraft)\b|\bphotos?\b|\bretouch|\bcolou?r[- ]grad|\bcrop (?:the |this |my )?(?:photo|image|picture)|\bremove (?:the )?background\b|\blayers?\b.*\b(?:image|photo|picture)|\b(?:edit|fix|touch up|enhance|sharpen|blur) (?:the |this |my |a )?(?:photo|image|picture)/i,
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
    match: (n) => n === "notebook" || n === "notebook_create",
    words: /\bnotebooks?\b|\bgroup (?:these|my|the) (?:files|artifacts|documents)/i,
  },
  {
    id: "organization",
    about: "the agents set up on the Organization page (start one, in order), and Threads, where agents post and talk",
    match: (n) => n === "agents" || n === "agent_run" || n === "thread",
    words: /\borgani[sz]ation\b|\B@[a-z]|\bagents?\b.*\b(?:hand|trigger|run|ask|call|start)|\b(?:hand|pass) (?:it |this )?(?:off|on) to\b|\bthreads?\b.*\b(?:post|comment|like)|\bpost (?:on|to) threads\b/i,
  },
];

interface LoadEvent {
  kind: string;
  payload: Record<string, any>;
}

/**
 * An MCP tool is `mcp__<server>__<tool>` (server/mcp.ts). Each connected server
 * is a set of its own, `mcp:<server>`: one box had 192 such tools connected
 * (Google alone 110), and sending all of their schemas on every step cost far
 * more than every built-in tool put together.
 */
export function mcpServerOf(toolName: string): string | null {
  const m = /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(toolName);
  return m ? m[1] : null;
}

/** The tool's own name, without `mcp__<server>__`. */
export function shortName(toolName: string): string {
  const server = mcpServerOf(toolName);
  return server ? toolName.slice(`mcp__${server}__`.length) : toolName;
}

export interface McpBrief {
  name: string;
  description: string;
}

/* Words that name an action, not a subject: every server has a "create" and a "list", so on their own they say
   nothing about which tool a message is after. */
const ACTIONS = new Set("get list create update delete remove search read write send add set find new edit open close run start stop show make fetch query upload download move copy".split(" "));
const FILLER = new Set("the and for with that this from into your you are can please have has was were will would could should just then than them they their what when where which about some any all not but out use using via per its our get let too also more most".split(" "));

/** Lower-cased words of a text, camelCase and snake_case split, plurals folded. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !FILLER.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** How well a message fits a tool, 0 for not at all. A hit on what the tool is about counts far more than one on
    what it does; hitting only "create" or "list" is not a fit. */
function fit(tool: McpBrief, said: Set<string>): number {
  const named = new Set(words(shortName(tool.name)));
  const described = new Set(words(tool.description.slice(0, 300)));
  let subject = 0;
  let action = 0;
  for (const w of said) {
    if (named.has(w)) { if (ACTIONS.has(w)) action += 1; else subject += 3; }
    else if (described.has(w) && !ACTIONS.has(w)) subject += 1;
  }
  return subject === 0 ? 0 : subject + action * 0.5;
}

/** The most tools one message brings in on its own. */
export const PRELOAD_MAX = 12;

/**
 * Which of the tools not yet in the list the person's message is about, best first. A server the message names
 * (by its name, however spaced) lends its tools a small push, and a small server named outright comes in whole.
 */
export function preloadMcp(tools: readonly McpBrief[], said: string, loaded: ReadonlySet<string>, max = PRELOAD_MAX): string[] {
  if (!said.trim() || loaded.has("mcp:*")) return [];
  const mine = new Set(words(said));
  const flat = said.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const bySever = new Map<string, McpBrief[]>();
  for (const t of tools) {
    const server = mcpServerOf(t.name);
    if (!server || loaded.has(`mcp:${server}`) || loaded.has(`mcpt:${t.name}`)) continue;
    bySever.set(server, [...(bySever.get(server) ?? []), t]);
  }
  const scored: { name: string; score: number }[] = [];
  for (const [server, list] of bySever) {
    const named = server.length >= 3 && flat.includes(server.replace(/[^a-z0-9]+/g, ""));
    if (named && list.length <= 15) { for (const t of list) scored.push({ name: t.name, score: 100 }); continue; }
    for (const t of list) {
      const score = fit(t, mine);
      if (score > 0) scored.push({ name: t.name, score: score + (named ? 2 : 0) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.name);
}

/** Tools matching a free-text query, for tools_enable: the same ranking, whatever is loaded. */
export function searchMcp(tools: readonly McpBrief[], query: string, max = PRELOAD_MAX): McpBrief[] {
  const mine = new Set(words(query));
  return tools
    .map((t) => ({ t, score: fit(t, mine) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.t);
}

/** One line on a tool: its name, its arguments (required ones starred) and the start of what it does. */
export function signatureOf(tool: { name: string; description: string; parameters?: { properties?: Record<string, any>; required?: string[] } }): string {
  const props = tool.parameters?.properties ?? {};
  const required = new Set(tool.parameters?.required ?? []);
  const args = Object.entries(props).map(([key, def]) => `${key}${required.has(key) ? "*" : ""}: ${Array.isArray(def?.enum) ? def.enum.join("|") : (def?.type ?? "any")}`);
  const about = tool.description.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0].slice(0, 160);
  return `${tool.name}(${args.join(", ")}) -- ${about}`;
}

/** What the log says was brought in: asked for, or already used. */
export function loadedFromLog(events: readonly LoadEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === "tools.enable") {
      if (typeof e.payload?.family === "string") out.add(e.payload.family);
      if (Array.isArray(e.payload?.tools)) for (const t of e.payload.tools) out.add(`mcpt:${t}`);
    } else if (e.kind === "tool.call") {
      const name = String(e.payload?.name ?? "");
      for (const f of FAMILIES) if (f.match(name)) out.add(f.id);
      if (mcpServerOf(name)) out.add(`mcpt:${name}`);
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
    const server = mcpServerOf(t.name);
    if (server) return loaded.has("mcp:*") || loaded.has(`mcp:${server}`) || loaded.has(`mcpt:${t.name}`);
    const f = FAMILIES.find((x) => x.match(t.name));
    return !f || loaded.has(f.id);
  });
}

/** The one-line index of what is not in the list, or null when everything is. */
export function unloadedIndex(loaded: ReadonlySet<string>, mcp: readonly McpBrief[] = []): string | null {
  const left = FAMILIES.filter((f) => !loaded.has(f.id));
  const hidden = loaded.has("mcp:*") ? [] : mcp.filter((t) => {
    const server = mcpServerOf(t.name);
    return server && !loaded.has(`mcp:${server}`) && !loaded.has(`mcpt:${t.name}`);
  });
  if (left.length === 0 && hidden.length === 0) return null;
  const lines = [
    "More tools exist that are not in your list now, to keep it short. Load one with tools_enable (family), and its tools are there on your next step:",
    ...left.map((f) => `- ${f.id}: ${f.about}`),
  ];
  if (hidden.length > 0) {
    const byServer = new Map<string, string[]>();
    for (const t of hidden) byServer.set(mcpServerOf(t.name)!, [...(byServer.get(mcpServerOf(t.name)!) ?? []), shortName(t.name)]);
    lines.push(
      "Connected servers, tools not in your list yet (call one by its full name mcp__<server>__<tool> and you are shown how, or " +
      "tools_enable with query to find and load the ones for a job):",
    );
    let budget = 150;
    for (const [server, names] of byServer) {
      const shown = names.slice(0, Math.max(5, Math.min(names.length, budget)));
      budget -= shown.length;
      lines.push(`- ${server} (${names.length}): ${shown.join(", ")}${shown.length < names.length ? `, and ${names.length - shown.length} more` : ""}`);
    }
  }
  return lines.join("\n");
}

/** The families the model may ask for. */
export const familyIds = () => FAMILIES.map((f) => f.id);
