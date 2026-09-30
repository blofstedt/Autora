/**
 * Solving the picture a CAPTCHA escalates to.
 *
 * Ticking the box is the easy half, and browser.ts does it. What a checkbox
 * does when it does not trust the browser is put a puzzle in front of it: nine
 * squares and "select all images with a bus", a piece to drag into a hole, or
 * a row of icons to put back in order. Those used to be the end of the road --
 * the agent handed the browser to the person and waited.
 *
 * They do not have to be, and this file is the difference. A challenge is
 * solved the way a person solves it, by looking at it, and there are three
 * ways to look, tried in the order the settings put them in:
 *
 *   local   arithmetic on the pictures, with nothing installed and nothing
 *           sent anywhere. It answers the slider family exactly (see
 *           captcha-images.ts) and has nothing to say about meaning.
 *   vision  the picture goes to the model the person already has connected,
 *           which reads images, with the tiles named, and comes back with the
 *           tiles to click or the distance to drag. This is the one that
 *           answers "select all images with a bus", and it needs no second
 *           account, no key and no subscription: it is the provider already
 *           paying for the turn.
 *   remote  a solver the person runs themselves, speaking the YesCaptcha
 *           shape (createTask / getTaskResult) that the self-hosted ones --
 *           ohmycaptcha and friends -- all speak. Off unless a URL is set, and
 *           a URL is the whole configuration.
 *
 * Every backend is optional and every one is free. A backend that cannot
 * answer says so in a line and the next one is tried; nothing here ever turns
 * a missing model or an empty setting into a silent wrong click, because the
 * click lands on a real page. Attempts are capped, the answer is checked
 * against the widget's own token between them, and the moment the challenge
 * passes this returns rather than trying again.
 *
 * Nothing here knows what a browser is: it is handed a page, a way to
 * photograph a region of it, a way to click and a way to drag, so the
 * arithmetic can be tested without one.
 */
import { identifyTiles } from "./captcha-labels";
import {
  colourShare,
  decodePng,
  detailShare,
  encodePng,
  findEdge,
  findGap,
  HUES,
  legible,
  upscale,
  type Bitmap,
} from "./captcha-images";

export type CaptchaBackend = "local" | "vision" | "remote";

/** What the settings panel writes and state.ts keeps. */
export interface CaptchaSettings {
  /** Off means browser_captcha keeps ticking boxes and hands the picture to
      the person, exactly as it did before this existed. */
  enabled: boolean;
  /** Which backends to try, best first. */
  backends: CaptchaBackend[];
  /** How many times to answer one challenge before giving up on it. */
  attempts: number;
  /** The person's own solver, speaking YesCaptcha's two calls. */
  remoteUrl: string;
  remoteKey: string;
}

export const DEFAULT_CAPTCHA: CaptchaSettings = {
  enabled: true,
  backends: ["local", "vision", "remote"],
  attempts: 3,
  remoteUrl: "",
  remoteKey: "",
};

const BACKENDS: readonly CaptchaBackend[] = ["local", "vision", "remote"];

/** Settings out of arbitrary JSON -- a hand-edited file or a stale panel both. */
export function mergeCaptcha(into: CaptchaSettings, patch: any): CaptchaSettings {
  if (!patch || typeof patch !== "object") return into;
  if (typeof patch.enabled === "boolean") into.enabled = patch.enabled;
  if (Array.isArray(patch.backends)) {
    const wanted = patch.backends
      .map((b: any) => String(b) as CaptchaBackend)
      .filter((b: CaptchaBackend) => BACKENDS.includes(b)) as CaptchaBackend[];
    // Never empty: an order with nothing in it is a solver that cannot solve,
    // and the panel has no way to say that back to the person.
    if (wanted.length) into.backends = [...new Set(wanted)];
  }
  if (patch.attempts !== undefined) {
    const n = Number(patch.attempts);
    if (Number.isFinite(n)) into.attempts = Math.max(1, Math.min(6, Math.round(n)));
  }
  if (typeof patch.remoteUrl === "string") into.remoteUrl = patch.remoteUrl.trim().replace(/\/+$/, "").slice(0, 300);
  if (typeof patch.remoteKey === "string") into.remoteKey = patch.remoteKey.trim().slice(0, 200);
  return into;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export type ChallengeKind = "grid" | "slider" | "words";

/** One clickable square of a grid, numbered as the widget numbers it. */
export interface Tile {
  index: number;
  box: Rect;
  /** What the page calls this square’s picture, when it says: the file name
      at the end of an image URL, an alt text, a data attribute, a CSS
      background-image. captcha-labels.ts reads it to answer a question of
      meaning without a model; absent when the page names nothing, which is
      every tile cut out of a sprite sheet. */
  label?: string;
}

export interface Challenge {
  kind: ChallengeKind;
  /** Which widget it is, for the report: "reCAPTCHA", "hCaptcha", "GeeTest". */
  widget: string;
  /** The whole challenge, in page coordinates. */
  box: Rect;
  /** The widget's own words: "Select all images with a bus". */
  prompt: string;
  /** Grid only: the squares, numbered from 1, row by row. */
  tiles: Tile[];
  /** Grid only: the Check/Verify button, when there is one. */
  verify: Rect | null;
  /** Slider only: the piece to drag. */
  handle: Rect | null;
  /** Slider only: the strip it travels along. */
  track: Rect | null;
  /** Words only: the picture of the letters, and the box they are typed into. */
  picture?: Rect | null;
  field?: Rect | null;
}

export interface SolverDeps {
  page: any;
  settings: CaptchaSettings;
  /** A picture of a region of the page, as PNG bytes. */
  shot(box: Rect): Promise<Buffer>;
  /** Pictures go to the model; the reply comes back as text. A words
      challenge is sent more than one picture of the same letters -- the crop
      enlarged, and the crop with the coloured noise taken out -- because the
      version a model reads best is not the version that came off the page. */
  vision: ((prompt: string, pngs: Buffer[]) => Promise<string>) | null;
  /** A click at a point, in page coordinates, moved to like a hand. */
  click(at: Point): Promise<void>;
  /** Words only: click into a field and type into it, when the host can. */
  type?: ((text: string, at: Point) => Promise<void>) | null;
  /** A drag from one point to another, in page coordinates. */
  drag(from: Point, to: Point): Promise<void>;
  /** Which model would read a picture, for the sight test’s cache and its
      report. */
  visionName?: (() => string | null) | null;
  /** Whether this browser can draw a canvas: false is why a picture is blank. */
  webgl?: boolean | null;
  /** Whether the challenge has passed, asked of the widget itself. */
  passed: () => Promise<boolean>;
  /** Something to say in the activity feed, with where it happened. */
  log: (what: string, at?: Point | null) => void;
  sleep: (ms: number) => Promise<void>;
  /** What challenge is showing now. The page's own frames unless a host says
      otherwise; here so the loop can be run against a scripted page. */
  find?: () => Promise<Challenge | null>;
  /** How long one backend may take to answer before it is given up on. */
  answerTimeoutMs?: number;
}

/** Where a frame sits on the page, so a rect inside it can be made absolute. */
async function frameOrigin(frame: any): Promise<Point> {
  let x = 0;
  let y = 0;
  let f = frame;
  for (let depth = 0; depth < 6 && f; depth += 1) {
    const parent = f.parentFrame?.();
    if (!parent || parent === f) break;
    const el = await f.frameElement?.().catch(() => null);
    const box = el ? await el.boundingBox().catch(() => null) : null;
    if (box) { x += box.x; y += box.y; }
    f = parent;
  }
  return { x, y };
}

/** Every rect a selector matches inside a frame, in page coordinates. */
async function rectsIn(frame: any, selectors: string[], origin: Point): Promise<Rect[]> {
  let found: { x: number; y: number; w: number; h: number }[] = [];
  try {
    /* Called, not just written: a string handed to evaluate is an expression,
       and an arrow function that is never invoked evaluates to nothing -- so
       this returned undefined, and every widget looked as if it had no
       squares at all. */
    const raw = await frame.evaluate(`((sels) => {
      const out = [];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width >= 4 && r.height >= 4) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        }
        if (out.length) break;
      }
      return out;
    })(${JSON.stringify(selectors)})`);
    found = Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
  return found.map((r) => ({ x: r.x + origin.x, y: r.y + origin.y, w: r.w, h: r.h }));
}

/** The widget's own instruction, read out of the frame. */
async function promptIn(frame: any, fallback: string): Promise<string> {
  const text: string = await frame
    .evaluate(`(() => {
      const sels = ['#rc-imageselect .rc-imageselect-desc', '.rc-imageselect-desc-wrapper',
                    '.prompt-text', '.prompt', '[class*=prompt]', '[class*=question]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        const said = el && (el.innerText || el.textContent || '').trim();
        if (said) return said.replace(/\\s+/g, ' ').slice(0, 300);
      }
      return '';
    })()`)
    .catch(() => "");
  return text || fallback;
}

/** The rects of the widget's squares, or none if it draws its own grid. */
async function gridIn(frame: any, origin: Point): Promise<Rect[]> {
  return rectsIn(frame, [
    "table.rc-imageselect-table td.rc-imageselect-tile",
    "td.rc-imageselect-tile",
    ".rc-imageselect-tile",
    "[class*=task-grid] [class*=task]",
    "[class*=challenge-view] [class*=tile]",
    "div[class*=grid] button",
    "table tr td img",
  ], origin);
}

/**
 * The challenge showing on the page, if one is.
 *
 * Only the widgets that actually escalate are looked for, by the frames they
 * live in and the markup they draw: reCAPTCHA's picture table, hCaptcha's
 * challenge frame, GeeTest, and the sliders that are not any of those. A
 * checkbox that is simply unticked is not a challenge and is not returned.
 */
export async function findChallenge(page: any): Promise<Challenge | null> {
  if (!page) return null;

  for (const frame of page.frames()) {
    let url: string = frame.url?.() ?? "";
    if (!url || url === "about:blank") {
      url = await frame.frameElement?.().then((el: any) => el?.getAttribute("src")).catch(() => null) ?? "";
    }
    const recaptchaGrid = /\/recaptcha\/(api2|enterprise)\/bframe/.test(url);
    const hcaptchaGrid = /hcaptcha\.com/.test(url) && /frame=challenge/.test(url);
    const geetest = /geetest|gt4|geetest\.com/i.test(url);
    const sliderish = /nc_1|aliyun|slider|yidun|dingxiang|geetest/i.test(url);

    if (!recaptchaGrid && !hcaptchaGrid && !geetest && !sliderish) continue;

    const origin = await frameOrigin(frame);
    const el = await frame.frameElement?.().catch(() => null);
    const frameBox = el ? await el.boundingBox().catch(() => null) : null;
    if (!frameBox || frameBox.width < 40 || frameBox.height < 40) continue;

    if (recaptchaGrid || hcaptchaGrid) {
      const widget = recaptchaGrid ? "reCAPTCHA" : "hCaptcha";
      const prompt = await promptIn(frame, recaptchaGrid ? "the picture challenge" : "the picture challenge");
      const tiles = await gridIn(frame, origin);
      const verify = (await rectsIn(frame, ["#recaptcha-verify-button", "button[type=submit]", ".button-submit"], origin))[0] ?? null;

      // hCaptcha draws its squares and leaves nothing to query, and reCAPTCHA
      // sometimes reports a table with no cells; both then get the geometry
      // the widget always draws: a square area under the prompt, three by
      // three (four by four when the prompt says so).
      if (tiles.length < 4) {
        const four = /4x4|sixteen|16\b|four by four/i.test(prompt);
        const n = four ? 4 : 3;
        const top = Math.max(frameBox.y + 84, frameBox.y + frameBox.height * 0.22);
        const bottom = frameBox.y + frameBox.height - (verify ? frameBox.height * 0.16 : 6);
        const side = Math.min(frameBox.width - 8, bottom - top);
        const inset = (frameBox.width - side) / 2;
        const size = side / n;
        const made: Tile[] = [];
        for (let r = 0; r < n; r += 1) {
          for (let c = 0; c < n; c += 1) {
            made.push({
              index: r * n + c + 1,
              box: { x: frameBox.x + inset + c * size, y: top + r * size, w: size, h: size },
            });
          }
        }
        return { kind: "grid", widget, box: { x: frameBox.x, y: frameBox.y, w: frameBox.width, h: frameBox.height }, prompt, tiles: made, verify, handle: null, track: null };
      }
      const ordered = [...tiles].sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
      return {
        kind: "grid",
        widget,
        box: { x: frameBox.x, y: frameBox.y, w: frameBox.width, h: frameBox.height },
        prompt,
        tiles: ordered.map((box, i) => ({ index: i + 1, box })),
        verify,
        handle: null,
        track: null,
      };
    }

    const handle = (await rectsIn(frame, [
      ".geetest_slider_button", "[class*=slider-button]", "[class*=sliderButton]", "[class*=slider-btn]",
      ".nc_iconfont.btn_slide", "#nc_1_n1z", "[class*=drag] [class*=btn]", "[role=slider]",
    ], origin))[0] ?? null;
    const track = (await rectsIn(frame, [
      ".geetest_slider", "[class*=slider-track]", "[class*=track]", ".nc_scale", "[class*=slider]",
    ], origin))[0] ?? null;
    if (handle) {
      return {
        kind: "slider",
        widget: geetest ? "GeeTest" : "the slider",
        box: { x: frameBox.x, y: frameBox.y, w: frameBox.width, h: frameBox.height },
        prompt: await promptIn(frame, "drag the piece into the gap"),
        tiles: [],
        verify: null,
        handle,
        track: track ?? { x: frameBox.x, y: handle.y, w: frameBox.width, h: handle.h },
      };
    }
    // GeeTest's nine-picture challenge, and the ones like it, put the pictures
    // in the challenge area with no table around them.
    if (geetest) {
      const items = await gridIn(frame, origin);
      if (items.length >= 4) {
        const ordered = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
        return {
          kind: "grid",
          widget: "GeeTest",
          box: { x: frameBox.x, y: frameBox.y, w: frameBox.width, h: frameBox.height },
          prompt: await promptIn(frame, "the icon challenge"),
          tiles: ordered.map((box, i) => ({ index: i + 1, box })),
          verify: (await rectsIn(frame, ["[class*=verify]", "[class*=submit]"], origin))[0] ?? null,
          handle: null,
          track: null,
        };
      }
    }
  }
  /* No widget frame is running this one. A page that draws its own puzzle is
     still a puzzle, and it is looked for last so that a real widget whose
     frames are the ones above always wins. */
  return pageChallenge(page);
}

/** The rect that covers all of these, or a zero rect when there are none. */
export function union(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A grid's squares, numbered the way a widget numbers them: row by row.
 *
 * The rects arrive in document order, which is not the order anybody counts
 * in -- a grid can be drawn column first, or with a row of odd ones at the
 * end. Two squares are on the same row when their centres are within half a
 * square of each other, which is loose enough for a grid that is a pixel or
 * two out and tight enough not to merge two rows.
 */
export function orderTiles(rects: Rect[], labels?: (string | undefined)[]): Tile[] {
  const items = rects.map((box, i) => ({ box, label: labels?.[i] }));
  const rows: { box: Rect; label?: string }[][] = [];
  for (const tile of [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const row = rows.find(
      (r) =>
        Math.abs(r[0].box.y + r[0].box.h / 2 - (tile.box.y + tile.box.h / 2)) <
        Math.max(4, Math.min(r[0].box.h, tile.box.h) / 2),
    );
    if (row) row.push(tile);
    else rows.push([tile]);
  }
  const lined = rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
  return lined.map((tile, i) => ({ index: i + 1, box: tile.box, label: tile.label }));
}

/**
 * The challenge a page draws itself.
 *
 * Not every picture puzzle arrives in a widget's frame. Games, demos and a
 * long tail of home-made CAPTCHAs draw the puzzle in their own document: a
 * line of words asking for squares, a square area of pictures under it, and a
 * button that confirms. None of that is any vendor's markup, so the markup is
 * not what is looked for here -- the shape is. The words that ask for
 * squares, the equal picture boxes arranged in a rectangle, the button: that
 * is a grid challenge wherever it is drawn, and it is answered by the same
 * backends, clicked the same way, and asked about afterwards the same way a
 * widget's own table is.
 *
 * A slider drawn in a page is found the same way and by the same rule: a
 * handle that says it is one, a track around it, and words nearby that ask
 * for something to be slid. The words matter, because the page's document is
 * the whole internet -- a drag handle that is part of a carousel or a map is
 * not a puzzle, and this must not drag one.
 */
/** A checkbox a page draws itself, with no widget anywhere near it. */
export interface PageCheckbox { x: number; y: number; w: number; h: number; checked: boolean }

/**
 * The checkbox a page draws in its own document.
 *
 * Not every site uses a widget. Some draw the box themselves, so there is no
 * iframe for a scan of frames to find and browser_captcha used to answer
 * "there is no checkbox CAPTCHA on this page" on a page that plainly has one.
 * This is that box: small, square-ish, saying it is a checkbox, with CAPTCHA
 * or "not a robot" somewhere in the markup around it. The smallest such box
 * wins, because the outside wrapper is not the thing to click.
 *
 * It is a guess, so it is only ever used to move the mouse. A click on a
 * stray box costs nothing; a missed CAPTCHA costs the whole page.
 */
export async function findPageCheckbox(page: any): Promise<PageCheckbox | null> {
  if (!page) return null;
  return page
    .evaluate(`(() => {
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.width > 90 || r.height > 90) return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.4) return null;
        return r;
      };
      const name = (el) => String(el.className || '') + ' ' + [el.id, el.getAttribute('aria-label'), el.getAttribute('name'), el.getAttribute('data-testid'), el.getAttribute('role')].filter(Boolean).join(' ');
      const around = (el) => {
        let said = name(el);
        let p = el;
        for (let i = 0; i < 3 && p; i += 1) {
          p = p.parentElement;
          if (p) said += ' ' + name(p) + ' ' + String(p.innerText || '').slice(0, 200);
        }
        return said;
      };
      const robot = /not a robot|are you (a )?(human|robot)|verify (that )?you are human/i;
      const captchaish = /captcha|robot|turnstile|hcaptcha/i;
      const found = [];
      for (const el of document.querySelectorAll('[role=checkbox], input[type=checkbox], [class*=checkbox], [class*=captcha], [aria-label]')) {
        const r = shown(el);
        if (!r) continue;
        const local = name(el);
        if (!(el.getAttribute('role') === 'checkbox' || el.tagName === 'INPUT' || /checkbox|check-box/i.test(local))) continue;
        const near = around(el);
        if (!captchaish.test(near) && !robot.test(near)) continue;
        found.push({ x: r.x, y: r.y, w: r.width, h: r.height, area: r.width * r.height,
          checked: el.getAttribute('aria-checked') === 'true' || el.checked === true || /checked|done|success|passed|verified|ticked/i.test(String(el.className || '')) });
      }
      if (!found.length) return null;
      found.sort((a, b) => a.area - b.area);
      const best = found[0];
      return { x: best.x, y: best.y, w: best.w, h: best.h, checked: best.checked };
    })()`)
    .catch(() => null);
}
async function pageChallenge(page: any): Promise<Challenge | null> {
  const found: {
    kind: "grid" | "slider" | "words";
    prompt: string;
    tiles: Rect[];
    labels?: (string | null)[] | null;
    verify: Rect | null;
    handle: Rect | null;
    track: Rect | null;
    picture?: Rect | null;
    field?: Rect | null;
  } | null = await page
    .evaluate(`(() => {
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) return null;
        if (r.bottom < 4 || r.top > innerHeight - 4 || r.right < 4 || r.left > innerWidth - 4) return null;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.5) return null;
        return r;
      };
      const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
      // What the page says about one square’s picture: its own image, its alt
      // text, its data attributes, a CSS background. Read here because this is
      // the only place the square’s element is in hand.
      const labelOf = (el) => {
        const bits = [];
        const im = el.tagName === "IMG" ? el : el.querySelector("img");
        if (im) bits.push(im.getAttribute("src"), im.getAttribute("alt"), im.getAttribute("title"), im.getAttribute("aria-label"));
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.indexOf("none") !== 0) bits.push(bg);
        for (const at of Array.from(el.attributes || [])) {
          if (at.name.indexOf("data-") === 0 && at.value && at.value.length < 120) bits.push(at.value);
        }
        return bits.filter(Boolean).join(" ").toLowerCase();
      };
      const said = (el) => String(el.innerText || el.textContent || '').replace(/[\\t\\n\\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
      const asks = /(select|click|choose|pick|tap)[^.]{0,30}(squares?|images?|tiles?|pictures?|cells?)/i;
      const slides = /(slide|drag)[^.]{0,30}(piece|puzzle|slider|unlock|fit|gap|into place)/i;
      const spells = /(enter|type|read|write)[^.]{0,30}(text|letters|characters|words|code|numbers?|answer)/i;

      let prompt = '';
      let words = null;
      const hits = [];
      for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,p,div,span,label,strong,b,legend')) {
        const line = said(el);
        if (!line || line.length > 200) continue;
        if (!asks.test(line) && !slides.test(line) && !spells.test(line)) continue;
        const r = shown(el);
        if (!r) continue;
        hits.push({ line, r, area: r.width * r.height });
      }
      if (hits.length) {
        hits.sort((a, b) => a.area - b.area);
        prompt = hits[0].line;
        words = hits[0].r;
      }
      if (!words) return null;

      // A text CAPTCHA, drawn by the page: words asking for the characters,
      // the picture they are drawn in, the box they go in and the button that
      // sends them. The words on their own are on every search box on the
      // web, so they are only believed where the markup calls itself a
      // CAPTCHA and a picture sits with the field.
      if (spells.test(prompt)) {
        const captchaish = (el) => {
          let probe = el;
          for (let i = 0; i < 4 && probe; i += 1) {
            const mark = probe.id + ' ' + String(probe.className || '');
            if (/captcha|robot|verify|human|words?Text|challenge/i.test(mark)) return true;
            probe = probe.parentElement;
          }
          return false;
        };
        let field = null;
        for (const el of document.querySelectorAll('input[type=text],input:not([type]),textarea')) {
          const r = shown(el);
          if (!r || r.width < 40) continue;
          if (!captchaish(el)) continue;
          if (el.value && el.value.length) continue;
          field = { el, r };
          if (Math.abs(r.top - words.bottom) < 200) break;
        }
        if (field) {
          let picture = null;
          const consider = (el, r) => {
            if (r.width < 60 || r.height < 24) return;
            if (r.width * r.height < 3000) return;
            if (el.closest('button,a')) return;
            const gap = Math.abs(r.top - field.r.top) + Math.abs(r.left - field.r.left);
            if (gap > 600) return;
            if (!picture || r.width * r.height > picture.area) picture = { r, area: r.width * r.height };
          };
          // The letters are drawn in the canvas; the speaker and refresh
          // icons are images beside it, and a picture of the whole strip puts
          // them in front of the model for nothing.
          for (const el of document.querySelectorAll('canvas')) { const r = shown(el); if (r) consider(el, r); }
          if (!picture) for (const el of document.querySelectorAll('img,svg')) { const r = shown(el); if (r) consider(el, r); }
          if (picture) {
            let verify = null;
            for (const el of document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')) {
              const label = said(el) || String(el.value || '').trim();
              if (!/^(submit|verify|check|confirm|send|go|answer)/i.test(label)) continue;
              const r = shown(el);
              if (!r) continue;
              verify = rect(r);
              break;
            }
            return { kind: 'words', prompt, tiles: [], verify, handle: null, track: null, picture: rect(picture.r), field: rect(field.r) };
          }
        }
      }

      if (asks.test(prompt)) {
        const grids = [];
        for (const el of document.querySelectorAll('div,section,ul,ol,table,tbody,tr,figure')) {
          const kids = [...el.children].filter((k) => shown(k));
          if (kids.length < 6 || kids.length > 36) continue;
          const boxes = kids.map((k) => k.getBoundingClientRect());
          const w = boxes[0].width;
          const h = boxes[0].height;
          if (Math.abs(w - h) > Math.max(4, w * 0.2)) continue;
          if (!boxes.every((r) => Math.abs(r.width - w) < 4 && Math.abs(r.height - h) < 4)) continue;
          const cols = new Set(boxes.map((r) => Math.round(r.left))).size;
          const rows = new Set(boxes.map((r) => Math.round(r.top))).size;
          if (rows < 3 || cols < 3 || cols > 8 || rows * cols !== kids.length) continue;
          const pictures = kids.filter((k) => {
            const st = getComputedStyle(k);
            return k.querySelector('img,canvas,svg') || /url\\(/.test(st.backgroundImage) ||
              /image|picture|tile|square|photo|cell|grid/i.test(String(k.className || ''));
          }).length;
          if (pictures < kids.length * 0.8) continue;
          grids.push({ tiles: boxes.map(rect), labels: kids.map(labelOf), distance: Math.max(0, Math.min(...boxes.map((r) => r.top)) - words.bottom) });
        }
        if (!grids.length) return null;
        grids.sort((a, b) => a.distance - b.distance);
        let verify = null;
        for (const el of document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')) {
          const label = said(el) || String(el.value || '').trim();
          if (!/^(verify|check|submit|confirm|next|continue|done)/i.test(label)) continue;
          const r = shown(el);
          if (!r) continue;
          verify = rect(r);
          break;
        }
        return { kind: 'grid', prompt, tiles: grids[0].tiles, verify, handle: null, track: null };
      }

      for (const el of document.querySelectorAll('[role=slider],[class*=slider-button],[class*=sliderButton],[class*=slider-btn],[class*=drag][class*=handle],[class*=slider] [class*=thumb]')) {
        const handle = shown(el);
        if (!handle) continue;
        const parent = el.parentElement;
        const track = parent ? shown(parent) : null;
        if (!track || track.width < handle.width * 1.5) continue;
        return { kind: 'slider', prompt, tiles: [], verify: null, handle: rect(handle), track: rect(track) };
      }
      return null;
    })()`)
    .catch(() => null);

  if (!found) return null;
  if (found.kind === "words") {
    if (!found.picture || !found.field) return null;
    return {
      kind: "words",
      widget: "the page's own text CAPTCHA",
      box: union([found.picture, found.field, ...(found.verify ? [found.verify] : [])]),
      prompt: found.prompt,
      tiles: [],
      verify: found.verify,
      handle: null,
      track: null,
      picture: found.picture,
      field: found.field,
    };
  }
  if (found.kind === "slider") {
    if (!found.handle || !found.track) return null;
    return {
      kind: "slider",
      widget: "the page's own slider",
      box: union([found.handle, found.track]),
      prompt: found.prompt,
      tiles: [],
      verify: null,
      handle: found.handle,
      track: found.track,
    };
  }
  if (!found.tiles?.length) return null;
  const tiles = orderTiles(found.tiles, found.labels?.map((l) => l ?? undefined) ?? undefined);
  return {
    kind: "grid",
    widget: "the page's own puzzle",
    box: union([...tiles.map((t) => t.box), ...(found.verify ? [found.verify] : [])]),
    prompt: found.prompt,
    tiles,
    verify: found.verify,
    handle: null,
    track: null,
  };
}

/** What a backend answered, in one shape. */
export interface Answer {
  /** Which squares to click, by the numbers the model was given. */
  tiles: number[];
  /** Straight points on the picture, 0-1 of its width and height. */
  points: Point[];
  /** Slider only: how far along the track the piece belongs, 0-1. */
  slide: number | null;
  /** Words only: the characters read out of the picture. */
  text?: string | null;
  /** The model said, outright, that nothing matches. */
  none?: boolean;
  /** Why it could not answer, when it could not. */
  why?: string;
}

/**
 * A model's reply, as an answer.
 *
 * Models wrap JSON in prose, in a code fence, or in both, and one that was
 * asked for tile numbers sometimes sends a list of coordinates instead. All of
 * that is read here rather than trusted, and anything unreadable is an empty
 * answer with a reason rather than a guess -- the caller clicks a real page.
 */
export function parseAnswer(text: string): Answer {
  const none: Answer = { tiles: [], points: [], slide: null };
  const said = String(text ?? "");
  const chars = (v: any): string | null => {
    if (typeof v !== "string") return null;
    const kept = v.replace(/[^A-Za-z0-9]/g, "");
    return kept.length >= 3 && kept.length <= 16 ? kept : null;
  };
  const start = said.indexOf("{");
  const end = said.lastIndexOf("}");
  if (start < 0 || end <= start) {
    // A readable picture of letters is answered with the letters, and a model
    // asked for those often sends nothing but them: "7fq3" is an answer.
    const bare = chars(said.trim());
    if (bare) return { ...none, text: bare };
    return { ...none, why: "the model did not answer with JSON" };
  }
  let body: any;
  try {
    body = JSON.parse(said.slice(start, end + 1));
  } catch {
    return { ...none, why: "the model's JSON did not parse" };
  }

  /* A list, a lone number, or digits in a sentence: the probe asks for
     {"tile":4} and the grid for {"tiles":[3,7]}, and a model answers either
     with either. A number that is not a whole square is dropped further on. */
  const numbers = (v: any): number[] => {
    if (Array.isArray(v)) return v.flatMap((n) => numbers(n));
    if (typeof v === "number") return Number.isFinite(v) ? [v] : [];
    if (typeof v === "string") return (v.match(/\d+/g) ?? []).map(Number);
    return [];
  };

  const listed = body.tiles ?? body.tile ?? body.squares ?? body.indices ?? body.answers;
  const tiles = numbers(listed).map((n) => Math.round(n));
  const points: Point[] = [];
  for (const raw of [body.points, body.clicks, body.click].flat().filter(Boolean)) {
    if (typeof raw === "object" && Number.isFinite(Number(raw?.x)) && Number.isFinite(Number(raw?.y))) {
      points.push({ x: Number(raw.x), y: Number(raw.y) });
    }
  }
  if (!tiles.length && !points.length && Number.isFinite(Number(body.x)) && Number.isFinite(Number(body.y))) {
    points.push({ x: Number(body.x), y: Number(body.y) });
  }

  let slide: number | null = null;
  for (const raw of [body.slide, body.offset, body.percent, body.fraction, body.distance]) {
    const n = Number(raw);
    if (Number.isFinite(n)) { slide = n > 1.5 ? n / 100 : n; break; }
  }
  const typed = chars(body.text ?? body.letters ?? body.characters ?? body.words ?? body.answer ?? body.captcha);
  /* "Nothing here matches" is an answer, and the only right one on the last
     round of a grid that replaces squares, or where the widget says to skip
     if there are none. It is said outright ({"tiles":[]}), which is not the
     same as saying nothing: a list that was given and is empty. */
  const nothing = Array.isArray(listed) && listed.length === 0 && !points.length && slide === null && !typed;
  return {
    tiles: [...new Set(tiles)].filter((n) => n >= 1 && n <= 64),
    points,
    slide,
    ...(typed ? { text: typed } : {}),
    ...(nothing ? { none: true } : {}),
    ...(tiles.length || points.length || slide !== null || typed || nothing ? {} : { why: "the model named nothing to click or type" }),
  };
}

/** The question put to the model, with every square named where it is. */
export function visionPrompt(challenge: Challenge, w: number, h: number, pictures = 1): string {
  const head =
    `This is a CAPTCHA picture, ${w} by ${h} pixels, cropped exactly around the challenge. ` +
    `Answer with JSON only, no prose.\nThe widget says: "${challenge.prompt}".\n`;
  if (challenge.kind === "words") {
    const how =
      pictures > 1
        ? `You are sent ${pictures} pictures of the same CAPTCHA. The first has the coloured noise taken out of it; ` +
          `the last is the crop of the page, enlarged and otherwise untouched. The letters are the same in each: ` +
          `read whichever one is clearest.\n`
        : "";
    return (
      head +
      `The picture is the distorted text of a CAPTCHA: letters and digits, drawn to be hard to read.\n` +
      how +
      `Read the characters. Reply as {"text":"7fq3"}. If they cannot be read, reply {"text":""}.`
    );
  }
  if (challenge.kind === "grid") {
    const named = challenge.tiles
      .map((t) => {
        const cx = ((t.box.x + t.box.w / 2 - challenge.box.x) / Math.max(1, challenge.box.w));
        const cy = ((t.box.y + t.box.h / 2 - challenge.box.y) / Math.max(1, challenge.box.h));
        return `${t.index} at ${cx.toFixed(2)},${cy.toFixed(2)}`;
      })
      .join("; ");
    return (
      head +
      `The picture shows a grid. The squares are numbered, each with its centre as a fraction of the picture ` +
      `(x,y across, down): ${named}.\n` +
      `Which squares match what the widget asked for? Where the widget asks for one square in particular, ` +
      `answer with just that one. Reply as {"tiles":[3,7]}. If nothing in the picture matches the question, ` +
      `reply {"tiles":[]}.`
    );
  }
  return (
    head +
    `The picture shows a sliding puzzle: a piece that must be dragged along a track into the matching hole in ` +
    `the picture behind it.\nWhere is the hole, as a fraction of the picture's width from its left edge? ` +
    `Reply as {"slide":0.42}. If you can see no hole, reply {"slide":null}.`
  );
}

/* ------------------------------------------------------------- backends -- */

/** A PNG turned into pixels, and how many pixels a page point became. */
async function pixels(deps: SolverDeps, box: Rect): Promise<{ bitmap: Bitmap; scale: number }> {
  const png = await deps.shot(box);
  const bitmap = decodePng(png);
  return { bitmap, scale: bitmap.w / Math.max(1, box.w) };
}

/**
 * The local backend: arithmetic on the pictures.
 *
 * It answers sliders and only sliders, on purpose. A grid is a question about
 * what the pictures mean -- is this a bus, is this a traffic light -- and there
 * is nothing to compute: a guess there would be a wrong click on a real page.
 * So it says so and lets the next backend answer.
 */
/** The one colour a prompt is asking for, when it names exactly one. */
export function wantedColour(prompt: string): string | null {
  const words = prompt.toLowerCase();
  const named = Object.keys(HUES).filter((c) => new RegExp(`\\b${c}\\b`).test(words));
  // "purple" and "violet" are the same band: naming both is still one colour.
  const bands = [...new Set(named.map((c) => HUES[c].map((b) => b.join("-")).join("|")))];
  if (bands.length === 1) return named[0];
  if (named.length) return null;
  // Objects that are one colour and cannot be mistaken for anything else.
  if (/stop sign|fire hydrant|octagonal sign/.test(words)) return "red";
  return null;
}

/**
 * A grid the arithmetic can answer: "select all the squares with a stop sign"
 * is a question about where the red is, and a screenshot says where the red
 * is. Tiles are scored by how much of them is that colour and the ones well
 * above the rest are clicked -- but only when the field is clear, because a
 * wrong click lands on a real page. When it is not clear the answer is empty
 * and the next backend gets the picture; see colourShare.
 */
async function colourAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const nothing: Answer = { tiles: [], points: [], slide: null };
  const colour = wantedColour(challenge.prompt);
  if (!colour) {
    return { ...nothing, why: `nothing in "${challenge.prompt}" can be counted without a model` };
  }
  const bands = HUES[colour];
  const { bitmap, scale } = await pixels(deps, challenge.box);
  const scored = challenge.tiles.map((tile) => ({
    index: tile.index,
    value: colourShare(bitmap, {
      x: (tile.box.x - challenge.box.x) * scale,
      y: (tile.box.y - challenge.box.y) * scale,
      w: tile.box.w * scale,
      h: tile.box.h * scale,
    }, bands),
  }));
  const top = Math.max(0, ...scored.map((s) => s.value));
  if (top < 0.05) return { ...nothing, why: `no ${colour} stood out in any square` };
  // A square holding a sign the photograph has mostly cut off scores a tenth
  // of one holding the whole thing: the bar is what stands out from empty
  // squares, not a share of the best one.
  const picked = scored.filter((s) => s.value >= Math.max(0.02, top * 0.12)).map((s) => s.index);
  // Most of the picture the same colour is a picture about something else, and
  // a set that wide is a guess, not a reading.
  if (picked.length > Math.max(4, Math.ceil(scored.length / 2))) {
    return { ...nothing, why: `${colour} is in ${picked.length} of ${scored.length} squares, which decides nothing` };
  }
  deps.log(`captcha: ${colour} in squares ${picked.join(", ")} (local)`);
  return { tiles: picked, points: [], slide: null };
}

/**
 * A grid whose squares say what they are.
 *
 * "Select all the squares with a vegetable" is answerable outright when each
 * square’s own picture is called carrot.webp: read the names off the page, keep
 * the squares whose name is one of the things asked about, and click those.
 * See captcha-labels.ts. null when the page named nothing usable, which hands
 * the picture to the next backend.
 */
function nameAnswer(deps: SolverDeps, challenge: Challenge): Answer | null {
  const found = identifyTiles(challenge.prompt, challenge.tiles);
  if (!found) return null;
  deps.log(
    `captcha: the page names the squares -- ${found.names.join(", ")} in ${found.indexes.join(", ")} (local)`,
    null,
  );
  return { tiles: found.indexes, points: [], slide: null };
}

async function localAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const nothing: Answer = { tiles: [], points: [], slide: null };
  if (challenge.kind === "words") {
    // Reading distorted letters is not arithmetic: there is no free reading
    // here, and guessing at one is a wrong answer typed into a real form.
    return { ...nothing, why: "letters have to be read by a model; there is nothing to compute" };
  }
  if (challenge.kind === "grid") {
    // A page that names its pictures has already answered the question, and a
    // name is a reading where a colour is an inference. Colour still runs
    // after this, because a question that really is about colour ("the red
    // ones") is one the names say nothing about.
    const byName = nameAnswer(deps, challenge);
    if (byName) return byName;
    return colourAnswer(deps, challenge);
  }
  if (!challenge.handle) {
    return { ...nothing, why: "a picture question needs the vision model; there is nothing to compute" };
  }
  const handle = challenge.handle;
  const track = challenge.track ?? {
    x: challenge.box.x,
    y: handle.y,
    w: challenge.box.w,
    h: handle.h,
  };
  const strip: Rect = {
    x: Math.max(0, Math.min(track.x, handle.x)),
    y: Math.min(track.y, handle.y),
    w: Math.max(track.w, handle.x + handle.w - track.x),
    h: Math.max(track.h, handle.h),
  };
  try {
    const whole = await pixels(deps, strip);
    const piece = await pixels(deps, handle);
    // Only to the right of where the piece already is: to its left, and under
    // it, the background has been painted over with the piece itself.
    const pieceRight = Math.round(((handle.x + handle.w) - strip.x) * whole.scale);
    const gap = findGap(whole.bitmap, piece.bitmap, {
      from: pieceRight + Math.round(handle.w * whole.scale * 0.35),
    });
    if (!gap) return { ...nothing, why: "the pictures could not be compared" };
    if (gap.confidence < 0.15 && gap.error > 24) {
      return { ...nothing, why: `no gap stood out (confidence ${gap.confidence.toFixed(2)})` };
    }
    const holeInPage = strip.x + gap.x / whole.scale;
    const travel = holeInPage - handle.x;
    if (travel < 6 || travel > track.w) {
      const edge = findEdge(whole.bitmap, Math.round(handle.w * whole.scale));
      if (!edge) return { ...nothing, why: `the gap is ${Math.round(travel)}px away, which is not a slider travel` };
      const fromEdge = strip.x + edge.x / whole.scale - handle.x;
      if (fromEdge < 6 || fromEdge > track.w) {
        return { ...nothing, why: `the gap is ${Math.round(travel)}px away, which is not a slider travel` };
      }
      return { ...nothing, slide: fromEdge / Math.max(1, track.w - handle.w) };
    }
    return { ...nothing, slide: travel / Math.max(1, track.w - handle.w) };
  } catch (err: any) {
    return { ...nothing, why: `the pictures could not be read (${err?.message ?? err})` };
  }
}

/**
 * The pictures a words challenge is worth sending.
 *
 * Two of the same letters: the cleaned one first, since that is the one a model
 * usually reads, and the page's own crop enlarged after it, so a model that
 * cannot see the letters in the cleaning still has the drawing itself to work
 * from. Duplicates are dropped -- when the picture is not one ink on paper,
 * cleaning leaves it exactly as the enlargement would.
 */
export function wordPictures(size: Bitmap, factor = 4): Buffer[] {
  const cleaned = encodePng(legible(size, factor));
  const enlarged = encodePng(upscale(size, factor));
  return cleaned.equals(enlarged) ? [enlarged] : [cleaned, enlarged];
}

const sight = new Map<string, { sees: boolean; at: number }>();

/** A picture with one of nine squares inked in, for the sight test. */
export function probeBitmap(cell: number): Bitmap {
  const size = 300;
  const cellSize = size / 3;
  const rgba = Buffer.alloc(size * size * 4, 255);
  const fx = ((cell - 1) % 3) * cellSize;
  const fy = Math.floor((cell - 1) / 3) * cellSize;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inked = x >= fx && x < fx + cellSize && y >= fy && y < fy + cellSize;
      const rule = x % cellSize < 2 || y % cellSize < 2;
      const ink = inked ? 40 : rule ? 150 : 250;
      rgba[i] = ink;
      rgba[i + 1] = ink;
      rgba[i + 2] = ink;
      rgba[i + 3] = 255;
    }
  }
  return { w: size, h: size, rgba };
}

/**
 * Whether the model on the other end can see a picture at all.
 *
 * A model with no eyes does not say so. Asked which squares hold a vegetable
 * it answers "1, 2, 3, 5, 6, 7, 9" -- seven confident numbers, every one of
 * them a wrong click on a real page -- which is exactly what happened before
 * this test existed. So it is asked two questions the answer to which is drawn
 * in the picture and written nowhere else: which of nine squares is inked in.
 * Only a model that gets both right is asked anything else, and the verdict is
 * remembered per model, so it costs one small picture each.
 */
/** How long "cannot see" is believed. A model that failed the test is not
    asked again for a while, and then is: a key, a model or a setting may have
    changed, and a verdict that outlived them would keep vision off for good. */
const NO_SIGHT_TTL_MS = 10 * 60_000;

/**
 * Can the connected model read a picture at all?
 *
 * Asked once per model with a picture of nine squares, one inked, and cached
 * -- but only what the model itself told us. A call that failed (the network,
 * a rate limit, a timeout) says nothing about its eyes, and used to be cached
 * as "blind" for the life of the process: one dropped connection switched
 * vision off until a restart.
 */
async function sightCheck(deps: SolverDeps): Promise<{ sees: boolean; error?: string }> {
  if (!deps.vision) return { sees: false };
  const name = deps.visionName?.() ?? "the connected model";
  const known = sight.get(name);
  if (known && (known.sees || Date.now() - known.at < NO_SIGHT_TTL_MS)) return { sees: known.sees };
  for (const cell of [4, 9]) {
    let said = "";
    try {
      said = await timed(
        deps.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
        deps.vision(
          `The picture is nine numbered squares, row by row, and exactly one of them is inked in. Which one? Reply as {"tile":N} with N from 1 to 9.`,
          [encodePng(probeBitmap(cell))],
        ),
        null,
      ) ?? "";
      if (!said) return { sees: false, error: "no answer in time" };
    } catch (err: any) {
      return { sees: false, error: String(err?.message ?? err) };
    }
    if (!parseAnswer(said).tiles.includes(cell)) {
      sight.set(name, { sees: false, at: Date.now() });
      return { sees: false };
    }
  }
  sight.set(name, { sees: true, at: Date.now() });
  return { sees: true };
}

/** The vision backend: the model that already runs this machine. */
async function visionAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const empty: Answer = { tiles: [], points: [], slide: null };
  if (!deps.vision) return { ...empty, why: "no image-reading model is connected" };
  const sees = await sightCheck(deps);
  if (sees.error) {
    return { ...empty, why: `the model could not be asked to prove it can see (${sees.error}); it is asked again next time` };
  }
  if (!sees.sees) {
    return {
      ...empty,
      why: `${deps.visionName?.() ?? "the connected model"} cannot see pictures -- it did not find the filled square in a test picture, and a model that cannot see answers a grid with confident wrong squares`,
    };
  }
  try {
    // A words challenge is the picture of letters and, under it, a box and a
    // button: only the letters are worth sending.
    const box = challenge.kind === "words" && challenge.picture ? challenge.picture : challenge.box;
    const png = await deps.shot(box);
    const size = decodePng(png);
    // A picture of nothing is not a question: say so rather than pay a model
    // to guess at letters that were never drawn.
    if (detailShare(size) < 0.02) {
      return {
        ...empty,
        why:
          deps.webgl === false
            ? "the picture is blank -- this browser has no WebGL, and a CAPTCHA the page draws with it (letters through a shader) never appears at all"
            : "the picture is blank -- the page has not drawn this CAPTCHA (a background tab, or it has not been given a moment)",
      };
    }
    // The crop off the page is the letters and, over them, coloured noise the
    // whole point of which is to stop a model reading them: twenty pixels tall
    // and speckled, a model answers "nothing" at best. What goes to the model
    // is the same letters enlarged, and enlarged again with everything that is
    // not the ink taken out -- the second reading being of the letters rather
    // than the speckle.
    const pictures = challenge.kind === "words" ? wordPictures(size) : [png];
    const said = await deps.vision(visionPrompt(challenge, size.w, size.h, pictures.length), pictures);
    const answer = parseAnswer(said);
    // A model given tile numbers sometimes sends coordinates anyway; a model
    // given a picture sometimes sends fractions of it instead of pixels.
    if (!answer.tiles.length && !answer.points.length && answer.slide === null && !answer.text && !answer.none) {
      return { ...empty, why: answer.why ?? "nothing usable came back" };
    }
    return answer;
  } catch (err: any) {
    return { ...empty, why: `the model could not be asked (${err?.message ?? err})` };
  }
}

/**
 * The remote backend: a solver the person runs.
 *
 * Two calls, the shape YesCaptcha published and every self-hosted solver
 * follows: createTask hands over the picture and the question, getTaskResult
 * collects the answer. Only a classification task is used -- the one that
 * takes a picture and returns which squares match -- because the others are
 * the solver driving a browser of its own, which is what this already does.
 */
async function remoteAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const empty: Answer = { tiles: [], points: [], slide: null };
  const base = deps.settings.remoteUrl;
  if (!base) return { ...empty, why: "no solver URL is set" };
  const type = /reCAPTCHA/i.test(challenge.widget)
    ? "ReCaptchaV2Classification"
    : /hCaptcha/i.test(challenge.widget)
      ? "HCaptchaClassification"
      : "";
  if (!type) return { ...empty, why: `${challenge.widget} is not something a classification task takes` };

  try {
    const png = await deps.shot(challenge.box);
    const ask = await fetch(`${base}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: deps.settings.remoteKey || undefined,
        task: { type, imageBase64: png.toString("base64"), question: challenge.prompt },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const made: any = await ask.json().catch(() => null);
    const id = made?.taskId;
    if (!id) return { ...empty, why: `${base} did not hand back a task (${made?.errorDescription ?? made?.errorCode ?? ask.status})` };

    for (let waited = 0; waited < 30_000; waited += 1500) {
      await deps.sleep(1500);
      const got = await fetch(`${base}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: deps.settings.remoteKey || undefined, taskId: id }),
        signal: AbortSignal.timeout(20_000),
      });
      const said: any = await got.json().catch(() => null);
      if (said?.status === "ready") {
        const objects = Array.isArray(said.solution?.objects) ? said.solution.objects : [];
        return objects.length ? { ...empty, tiles: objects.map((n: any) => Number(n) + 1) } : { ...empty, why: "the solver found no matching squares" };
      }
      if (said?.errorId) return { ...empty, why: `the solver refused: ${said.errorDescription ?? said.errorCode}` };
    }
    return { ...empty, why: "the solver did not answer in time" };
  } catch (err: any) {
    return { ...empty, why: `${base} could not be reached (${err?.message ?? err})` };
  }
}

/** How long one backend may take. A model that never answers must not hold
    the turn, and the click that follows would be on a stale page anyway. */
const ANSWER_TIMEOUT_MS = 60_000;

/** The promise's value, or `late` if it takes longer than `ms`. */
async function timed<T>(ms: number, promise: Promise<T>, late: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(late), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function answerFrom(deps: SolverDeps, backend: CaptchaBackend, challenge: Challenge): Promise<Answer> {
  const asked = backend === "local"
    ? localAnswer(deps, challenge)
    : backend === "vision"
      ? visionAnswer(deps, challenge)
      : remoteAnswer(deps, challenge);
  const late: Answer = { tiles: [], points: [], slide: null, why: `${backend} did not answer in time` };
  return timed(deps.answerTimeoutMs ?? ANSWER_TIMEOUT_MS, asked.catch((err): Answer => ({
    tiles: [], points: [], slide: null, why: `${backend} failed (${err?.message ?? err})`,
  })), late);
}

/* --------------------------------------------------------------- acting -- */

/** Turn an answer into clicks on the page, and say what was done. */
async function act(
  deps: SolverDeps,
  challenge: Challenge,
  backend: CaptchaBackend,
  answer: Answer,
  verify = true,
): Promise<string> {
  if (challenge.kind === "words") {
    if (!answer.text) return "no characters to type";
    if (!challenge.field) return "the box to type them into could not be found";
    if (!deps.type) return "nothing here can type";
    const at = { x: challenge.field.x + challenge.field.w / 2, y: challenge.field.y + challenge.field.h / 2 };
    deps.log(`captcha: type the characters in (as ${answer.text.length} of them) (${backend})`, at);
    await deps.type(answer.text, at);
    await deps.sleep(200);
    if (challenge.verify) {
      const press = { x: challenge.verify.x + challenge.verify.w / 2, y: challenge.verify.y + challenge.verify.h / 2 };
      deps.log("captcha: press Submit", press);
      await deps.click(press);
    }
    return `typed ${answer.text.length} characters`;
  }

  if (challenge.kind === "slider") {
    if (answer.slide === null) return "no distance to drag";
    const handle = challenge.handle;
    const track = challenge.track;
    if (!handle || !track) return "the slider's handle could not be found";
    const room = Math.max(1, track.w - handle.w);
    const from = { x: handle.x + handle.w / 2, y: handle.y + handle.h / 2 };
    const to = { x: track.x + Math.min(room, Math.max(0, answer.slide * room)) + handle.w / 2, y: from.y };
    deps.log(`captcha: drag the piece ${Math.round(to.x - from.x)}px (${backend})`, from);
    await deps.drag(from, to);
    return `dragged ${Math.round(to.x - from.x)}px`;
  }

  const chosen = pointsFor(challenge, answer);
  if (!chosen.length) {
    // Nothing matches is only ever an answer the widget can be given by
    // pressing its button with nothing chosen -- see solveChallenge.
    return "nothing to click";
  }

  for (const at of chosen) {
    deps.log(`captcha: click square ${chosen.indexOf(at) + 1} (${backend})`, at);
    await deps.click(at);
    await deps.sleep(320);
  }
  if (verify) await pressVerify(deps, challenge);
  return `clicked ${chosen.length} square${chosen.length === 1 ? "" : "s"}`;
}

/** Where an answer's squares and points are, on the page. */
function pointsFor(challenge: Challenge, answer: Answer): Point[] {
  const size = { w: challenge.box.w, h: challenge.box.h };
  const chosen: Point[] = [];
  for (const index of answer.tiles) {
    const tile = challenge.tiles.find((t) => t.index === index);
    if (!tile) continue;
    chosen.push({ x: tile.box.x + tile.box.w / 2, y: tile.box.y + tile.box.h / 2 });
  }
  for (const raw of answer.points) {
    // Fractions of the picture are what the model was asked for; anything
    // larger is a pixel count in the picture as it was shown to it.
    const frac = { x: raw.x > 1.5 ? raw.x / (challenge.box.w || 1) : raw.x, y: raw.y > 1.5 ? raw.y / (challenge.box.h || 1) : raw.y };
    chosen.push({ x: challenge.box.x + frac.x * size.w, y: challenge.box.y + frac.y * size.h });
  }
  return chosen;
}

async function pressVerify(deps: SolverDeps, challenge: Challenge): Promise<boolean> {
  if (!challenge.verify) return false;
  const at = { x: challenge.verify.x + challenge.verify.w / 2, y: challenge.verify.y + challenge.verify.h / 2 };
  deps.log("captcha: press Check", at);
  await deps.click(at);
  return true;
}

/** reCAPTCHA's grid that puts a new picture in each square you click, and
    wants you to go on until none of them match. Verifying after one round is
    an answer to a question the widget has already changed. */
const REPLACES = /once there are none left|until there are none|none left|no more (?:images|pictures)/i;
/** A grid that says the way out when nothing in it matches. */
const MAY_SKIP = /if there are none|click skip|press skip|\bskip\b/i;
/** Rounds of clicking on a grid that replaces its squares, at most. Each
    round is a fresh look and a fresh answer, so this is also the cost. */
const MAX_ROUNDS = 6;

export interface SolveReport {
  outcome: "none" | "solved" | "giveup";
  widget: string | null;
  /** Which backend answered, when one did. */
  backend: CaptchaBackend | null;
  /** What was done, and what stood in the way, for the tool's own reply. */
  detail: string;
}

/**
 * Solve the picture challenge on the page, or say why it could not be.
 *
 * Everything that could go wrong here is a wrong click, so the loop is
 * deliberately narrow: look at the challenge, ask each backend in turn, do
 * what one of them answers, ask the widget whether it passed, and only then
 * look again. Attempts are capped, a challenge that has gone is a pass, and
 * a challenge that is still there after every backend has had its say is a
 * give-up with the reasons written down -- never a fourth silent click.
 */
export async function solveChallenge(deps: SolverDeps): Promise<SolveReport> {
  const settings = deps.settings;
  const find = () => (deps.find ? deps.find() : findChallenge(deps.page));
  /* Nothing showing is a pass; a look that threw is not knowing. The two were
     one `null`, so a page that could not be read was reported as solved. */
  let lookFailed: string | null = null;
  const look = async (): Promise<Challenge | null> => {
    try {
      lookFailed = null;
      return await find();
    } catch (err: any) {
      lookFailed = String(err?.message ?? err);
      return null;
    }
  };
  if (!settings.enabled) {
    return { outcome: "none", widget: null, backend: null, detail: "Picture challenges are set to be handed to the person (Settings, CAPTCHA)." };
  }

  const reasons: string[] = [];
  const budget = Math.max(1, settings.attempts);
  /* Backends that answered, were acted on, and did not pass. The same answer
     to the same kind of challenge is not going to work the second time, so the
     next attempt starts with one that has not been tried. */
  const failed = new Set<CaptchaBackend>();
  /* Rounds of a replacing grid, across every attempt: one that never runs out
     of matching squares is a widget that will not be satisfied, and clicking at
     it for ever is a page being hammered. */
  let spare = MAX_ROUNDS + 2;

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const challenge = await look();
    if (!challenge) {
      if (lookFailed) {
        return { outcome: "giveup", widget: null, backend: null, detail: `The page could not be read for a challenge (${lookFailed}), so nothing was clicked.` };
      }
      return { outcome: "solved", widget: null, backend: null, detail: "The challenge is gone; the widget has passed." };
    }
    if (await deps.passed().catch(() => false)) {
      return { outcome: "solved", widget: challenge.widget, backend: null, detail: "The widget's own token says it passed." };
    }

    const fresh = settings.backends.filter((b) => !failed.has(b));
    if (fresh.length === 0) failed.clear();
    const order = fresh.length ? fresh : settings.backends;

    for (const backend of order) {
      const answer = await answerFrom(deps, backend, challenge);
      const skippable = challenge.kind === "grid" && !!challenge.verify &&
        (REPLACES.test(challenge.prompt) || MAY_SKIP.test(challenge.prompt));
      const spoke = answer.tiles.length || answer.points.length || answer.slide !== null || !!answer.text;
      if (!spoke && !(answer.none && challenge.kind === "grid")) {
        reasons.push(`${backend}: ${answer.why ?? "no answer"}`);
        continue;
      }
      // "Nothing here matches", to a widget with no way to say so, is not an
      // answer to press through: an empty Check is a wrong answer to it.
      if (!spoke && !skippable) {
        reasons.push(`${backend}: it found nothing that matches, and ${challenge.widget} has no way to skip`);
        continue;
      }

      const replaces = challenge.kind === "grid" && REPLACES.test(challenge.prompt);
      let did: string;
      if (!spoke) {
        await pressVerify(deps, challenge);
        did = "found nothing that matches, and pressed the button with nothing chosen";
      } else {
        did = await act(deps, challenge, backend, answer, !replaces).catch((err) => `could not act (${err?.message ?? err})`);
        if (replaces && /^clicked/.test(did)) {
          const more = await goOn(deps, backend, challenge, look, Math.min(MAX_ROUNDS, spare + 1));
          spare = Math.max(0, spare - (more.rounds - 1));
          did += more.note;
        }
      }
      deps.log(`captcha: answered by ${backend} -- ${did}`);
      // Nothing was clicked: the widget is exactly as it was, so what was
      // looked at is still what is there, and the next backend may have its go.
      if (/nothing to click|could not act|no characters|no distance|could not be found|nothing here can type/i.test(did)) {
        reasons.push(`${backend}: ${did}`);
        continue;
      }

      await deps.sleep(1400);
      const after = await deps.passed().catch(() => false);
      const still = await look();
      const stillFailed = lookFailed;
      if (after) {
        return { outcome: "solved", widget: challenge.widget, backend, detail: `${backend} answered it: ${did}.` };
      }
      // Its squares are redrawn between a click and the widget's verdict, so
      // one look that finds nothing is not a pass: ask again, and call it a
      // pass only when the second look finds nothing either.
      if (!still && stillFailed) {
        reasons.push(`${backend}: ${did}, and the page could not be read afterwards (${stillFailed})`);
      } else if (!still) {
        await deps.sleep(1200);
        const gone = await look();
        const token = await deps.passed().catch(() => false);
        if (token || (!gone && !lookFailed)) {
          return { outcome: "solved", widget: challenge.widget, backend, detail: `${backend} answered it: ${did}.` };
        }
        reasons.push(`${backend}: ${did}, and the challenge came back`);
      } else {
        reasons.push(`${backend}: ${did}, and ${challenge.widget} asked again`);
      }
      /* It was clicked and it did not pass, so what is on the page is now a
         new challenge -- new pictures, often a new question. The loop looks
         again from the top rather than handing the old one to the next
         backend, which is how a "buses" answer was once given to bicycles. */
      failed.add(backend);
      break;
    }
  }

  const worst = reasons.slice(-3).join("; ");
  return {
    outcome: "giveup",
    widget: (await look())?.widget ?? null,
    backend: null,
    detail: `Tried ${budget} time${budget === 1 ? "" : "s"}: ${worst || "no backend could answer"}.`,
  };
}

/**
 * The rest of a grid that replaces what is clicked.
 *
 * Each square that was clicked gets a new picture, which may be one that
 * matches too. So: wait for them to arrive, look, answer again, click what
 * matches, and only when a round finds nothing (or the widget has passed, or
 * the rounds are spent) press the button -- once.
 */
async function goOn(
  deps: SolverDeps,
  backend: CaptchaBackend,
  first: Challenge,
  look: () => Promise<Challenge | null>,
  limit: number,
): Promise<{ note: string; rounds: number }> {
  let rounds = 1;
  let last = first;
  for (; rounds < limit; rounds += 1) {
    await deps.sleep(2300);
    if (await deps.passed().catch(() => false)) break;
    const now = await look();
    if (!now || now.kind !== "grid") break;
    last = now;
    const answer = await answerFrom(deps, backend, now);
    const chosen = pointsFor(now, answer);
    if (!chosen.length) break;
    for (const at of chosen) {
      deps.log(`captcha: click square ${chosen.indexOf(at) + 1} of round ${rounds + 1} (${backend})`, at);
      await deps.click(at);
      await deps.sleep(320);
    }
  }
  await pressVerify(deps, last.verify ? last : first);
  return { note: ` and went on for ${rounds} round${rounds === 1 ? "" : "s"}`, rounds };
}
