/**
 * What the phone's bar and grid are made of: every tool the editor has, once, with the colour and glyph it wears.
 *
 * Colours are SecurePDF's (blue, emerald, amber, purple, indigo, sky, gold, rose, cyan); a tool Autora adds takes the
 * nearest one of its group. A tile is one of three things: a canvas mode (`tools.<mode>`, which also opens the tool that
 * owns it), a whole tool (`tools.open.<id>`, the ones with a pane in the dock) or a plain command (`command`). The ids
 * are Spectra's own (commands/registry.ts, commands/tools.ts), so a typo is a failed type check, not a dead button.
 */
import type { CommandId } from "../renderer/commands/registry";

export interface Tile {
  id: string;
  label: string;
  icon: string;
  color: string;
  /** The canvas mode this arms. */
  mode?: string;
  /** The tool this opens. */
  tool?: string;
  /** A command that is neither of those. */
  command?: CommandId;
}

const BLUE = "#2563eb", EMERALD = "#059669", AMBER = "#f59e0b", PURPLE = "#9333ea", INDIGO = "#4f46e5", SKY = "#0284c7", GOLD = "#d97706", ROSE = "#e11d48", CYAN = "#0891b2";

const t = (id: string, label: string, icon: string, color: string, rest: Partial<Tile> = {}): [string, Tile] => [id, { id, label, icon, color, ...rest }];

export const TOOLS: Record<string, Tile> = Object.fromEntries([
  // Mark up
  t("select", "Select", "select", BLUE),
  t("text", "Text", "text", EMERALD, { mode: "freetext" }),
  t("highlight", "Highlight", "highlight", AMBER, { mode: "highlight" }),
  t("inkhighlight", "Pen highlight", "pen-highlight", AMBER, { mode: "inkhighlight" }),
  t("draw", "Draw", "draw", PURPLE, { mode: "ink" }),
  t("shape", "Shapes", "shape", INDIGO, { mode: "shape" }),
  t("note", "Note", "note", SKY, { mode: "note" }),
  t("stamp", "Stamps", "stamp", GOLD, { mode: "stamp" }),
  t("callout", "Callout", "callout", SKY, { mode: "callout" }),
  t("erase", "Erase", "erase", ROSE, { mode: "inkerase" }),
  t("comments", "Comments", "comments", SKY, { command: "tools.panel.comments" }),
  // Fill and sign
  t("sign", "Sign", "sign", CYAN, { mode: "signature" }),
  t("digitalsign", "Digital ID", "badge", CYAN, { mode: "signature" }),
  t("forms", "Fill fields", "forms", EMERALD, { mode: "forms" }),
  t("edit", "Edit text", "edit", BLUE, { mode: "edit" }),
  t("addtext", "Add text", "text", EMERALD, { mode: "addtext" }),
  t("addimage", "Add image", "image", CYAN, { mode: "addimage" }),
  t("link", "Link", "link", BLUE, { mode: "linkdraw" }),
  t("prepareform", "Make a form", "prepareform", CYAN, { tool: "prepareform" }),
  // Protect
  t("redact", "Redact", "redact", ROSE, { mode: "redact" }),
  t("protect", "Password", "lock", CYAN, { tool: "protect" }),
  t("watermark", "Watermark", "watermark", GOLD, { tool: "watermark" }),
  t("headerfooter", "Header & footer", "header", INDIGO, { tool: "headerfooter" }),
  // Pages
  t("organize", "Organize", "organize", BLUE, { tool: "organize" }),
  t("optimize", "Compress", "compress", EMERALD, { tool: "optimize" }),
  t("export", "Export", "export", INDIGO, { tool: "export" }),
  t("compare", "Compare", "compare", PURPLE, { tool: "compare" }),
  t("repair", "Repair", "repair", ROSE, { tool: "repair" }),
  t("pagebox", "Crop", "crop", PURPLE, { tool: "pagebox" }),
  t("pagelabels", "Page labels", "tag", GOLD, { tool: "pagelabels" }),
  // More
  t("measure", "Measure", "ruler", AMBER, { tool: "measure" }),
  t("takeoff", "Count", "hash", EMERALD, { tool: "takeoff" }),
  t("ocr", "Make searchable", "ocr", SKY, { tool: "ocr" }),
  t("snapshot", "Snapshot", "camera", PURPLE, { tool: "snapshot" }),
  t("layers", "Layers", "layers", INDIGO, { tool: "layers" }),
  t("attachments", "Attachments", "clip", GOLD, { tool: "attachments" }),
  t("portfolio", "Portfolio", "folder", BLUE, { tool: "portfolio" }),
  t("accessibility", "Accessibility", "access", CYAN, { tool: "accessibility" }),
  t("printproduction", "Print prep", "printer", INDIGO, { tool: "printproduction" }),
  t("actions", "Actions", "zap", AMBER, { tool: "actions" }),
]);

/** What a phone's bar is, in order; as many as fit are shown, and the rest are in the grid. Note and Stamps are in the grid so the icons can be bigger. */
export const PHONE_DEFAULT = ["select", "text", "highlight", "draw", "shape", "redact", "sign"];

/** What a desktop's bar starts with: the same tools, then the ones the room allows. The person pins their own from the grid; as many as fit are shown. */
export const DESKTOP_DEFAULT = [
  "select", "text", "highlight", "inkhighlight", "draw", "shape", "note", "stamp", "callout", "erase", "redact", "sign",
  "forms", "edit", "addimage", "link", "organize", "measure",
];

/** The grid's sections. Every tool above is in exactly one. */
export const GRID: { title: string; ids: string[] }[] = [
  { title: "Basics", ids: ["select"] },
  { title: "Mark up", ids: ["text", "highlight", "inkhighlight", "draw", "shape", "note", "stamp", "callout", "erase", "comments"] },
  { title: "Fill and sign", ids: ["sign", "digitalsign", "forms", "edit", "addtext", "addimage", "link", "prepareform"] },
  { title: "Protect", ids: ["redact", "protect", "watermark", "headerfooter"] },
  { title: "Pages", ids: ["organize", "optimize", "export", "compare", "repair", "pagebox", "pagelabels"] },
  { title: "More", ids: ["measure", "takeoff", "ocr", "snapshot", "layers", "attachments", "portfolio", "accessibility", "printproduction", "actions"] },
];

/** Glyphs, 24px, stroke only (lucide's shapes, which SecurePDF uses). */
export const ICONS: Record<string, string> = {
  select: '<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  "pen-highlight": '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/><path d="M3 23h18"/>',
  draw: '<path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  shape: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="9"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M9 5h10v10"/>',
  polygon: '<path d="M12 3 21 9.5 17.5 20h-11L3 9.5z"/>',
  polyline: '<path d="M3 17 9 9l4 6 8-10"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  callout: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 8h8M8 12h5"/>',
  comments: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  stamp: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
  erase: '<path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2ZM18 9l-6 6M12 9l6 6"/>',
  sign: '<path d="m21 17-2.156-1.868A.5.5 0 0 0 18 15.5v.5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1c0-2.545-3.991-3.97-8.5-4a1 1 0 0 0 0 5c4.153 0 4.745-11.295 5.708-13.5a2.5 2.5 0 1 1 3.31 3.284"/><path d="M3 21h18"/>',
  badge: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  forms: '<path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7M9 7v10"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  prepareform: '<path d="M9 2h6v4H9zM5 4h2M17 4h2M5 4v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4M9 12h6M9 16h4"/>',
  redact: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  watermark: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  header: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>',
  organize: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  compress: '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5M5 21h14"/>',
  compare: '<rect width="8" height="18" x="2" y="3" rx="1"/><rect width="8" height="18" x="14" y="3" rx="1"/>',
  repair: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"/>',
  tag: '<path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2ZM7 7h.01"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  ocr: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8h8M7 12h10M7 16h6"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  access: '<circle cx="12" cy="4.5" r="1.5"/><path d="M5 8h14M12 8v6l-3 6M12 14l3 6"/>',
  printer: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 9V3h12v6M6 14h12v8H6z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  "folder-open": '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/>',
  "file-down": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M12 18v-6M9 15l3 3 3-3"/>',
  "file-plus": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M12 18v-6M9 15h6"/>',
  split: '<path d="M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.17-2.87L3 3M15 9l6-6"/>',
  bookmark: '<path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  lines: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
  undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"/>',
  find: '<circle cx="11" cy="11" r="7"/><path d="m21 21-5-5"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  cycle: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
};
