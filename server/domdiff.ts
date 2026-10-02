/**
 * What changed on a page between two looks, as places for a cursor to go.
 *
 * The preview reloads (or hot-updates) when the agent writes code, and the
 * person sees the page change for no visible reason. Comparing what was on the
 * page before and after says where: the elements that are new, and the ones
 * whose look changed. Elements are matched by what they are -- tag, words,
 * class -- and not by where they sit, so a heading pushed down by something
 * inserted above it is not "changed", only the new thing is.
 *
 * Pure: two lists in, a few cues out. The page-side collection that makes the
 * lists is `DOM_MAP_SCRIPT` in server/browser.ts.
 */

export interface DomItem {
  /** What it is: tag, its words, its class. */
  k: string;
  /** How it looks: colours, size, weight, opacity. */
  s: string;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChangeCue {
  kind: "added" | "changed";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_CUES = 5;
const MIN_SIDE = 6;

const counts = (items: DomItem[]) => {
  const m = new Map<string, DomItem[]>();
  for (const i of items) m.set(i.k, [...(m.get(i.k) ?? []), i]);
  return m;
};

function describe(kind: ChangeCue["kind"], tag: string): string {
  const word: Record<string, string> = {
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", p: "text", a: "link", button: "button", img: "image",
    input: "field", textarea: "field", select: "menu", li: "item", span: "text", div: "block", section: "section", nav: "nav",
    header: "header", footer: "footer", label: "label", svg: "graphic", canvas: "canvas", video: "video",
  };
  return `${kind === "added" ? "New" : "Changed"} ${word[tag] ?? tag}`;
}

/** The elements that are new or restyled, in reading order, those in view only. */
export function diffDom(before: DomItem[], after: DomItem[], view: { width: number; height: number }): ChangeCue[] {
  const was = counts(before);
  const now = counts(after);
  const found: { kind: ChangeCue["kind"]; item: DomItem }[] = [];

  for (const [key, items] of now) {
    const old = was.get(key) ?? [];
    if (items.length > old.length) {
      // More of it than before: the last ones are the new ones.
      for (const item of items.slice(old.length)) found.push({ kind: "added", item });
    }
    // The same things, looking different: matched in order.
    for (let i = 0; i < Math.min(items.length, old.length); i += 1) {
      if (items[i].s !== old[i].s) found.push({ kind: "changed", item: items[i] });
    }
  }

  const visible = found.filter(({ item }) =>
    item.w >= MIN_SIDE && item.h >= MIN_SIDE &&
    item.x + item.w > 0 && item.y + item.h > 0 && item.x < view.width && item.y < view.height);
  visible.sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);

  // One mark where several neighbours changed together: skip any that sits inside, or on, the last.
  const out: ChangeCue[] = [];
  for (const { kind, item } of visible) {
    const last = out[out.length - 1];
    if (last && item.x >= last.x - 4 && item.y >= last.y - 4 && item.x + item.w <= last.x + last.w + 4 && item.y + item.h <= last.y + last.h + 4) continue;
    out.push({ kind, label: describe(kind, item.tag), x: item.x, y: item.y, w: item.w, h: item.h });
    if (out.length >= MAX_CUES) break;
  }
  return out;
}
