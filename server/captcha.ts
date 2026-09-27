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
import { decodePng, findEdge, findGap, type Bitmap } from "./captcha-images";

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

export type ChallengeKind = "grid" | "slider";

/** One clickable square of a grid, numbered as the widget numbers it. */
export interface Tile { index: number; box: Rect }

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
}

export interface SolverDeps {
  page: any;
  settings: CaptchaSettings;
  /** A picture of a region of the page, as PNG bytes. */
  shot(box: Rect): Promise<Buffer>;
  /** The picture goes to the model; the reply comes back as text. */
  vision: ((prompt: string, png: Buffer) => Promise<string>) | null;
  /** A click at a point, in page coordinates, moved to like a hand. */
  click(at: Point): Promise<void>;
  /** A drag from one point to another, in page coordinates. */
  drag(from: Point, to: Point): Promise<void>;
  /** Whether the challenge has passed, asked of the widget itself. */
  passed: () => Promise<boolean>;
  /** Something to say in the activity feed, with where it happened. */
  log: (what: string, at?: Point | null) => void;
  sleep: (ms: number) => Promise<void>;
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
    found = await frame.evaluate(`((sels) => {
      const out = [];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width >= 4 && r.height >= 4) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        }
        if (out.length) break;
      }
      return out;
    })`, selectors);
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
  return null;
}

/** What a backend answered, in one shape. */
export interface Answer {
  /** Which squares to click, by the numbers the model was given. */
  tiles: number[];
  /** Straight points on the picture, 0-1 of its width and height. */
  points: Point[];
  /** Slider only: how far along the track the piece belongs, 0-1. */
  slide: number | null;
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
  const start = said.indexOf("{");
  const end = said.lastIndexOf("}");
  if (start < 0 || end <= start) return { ...none, why: "the model did not answer with JSON" };
  let body: any;
  try {
    body = JSON.parse(said.slice(start, end + 1));
  } catch {
    return { ...none, why: "the model's JSON did not parse" };
  }

  const numbers = (v: any): number[] =>
    Array.isArray(v) ? v.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];

  const tiles = numbers(body.tiles ?? body.tile ?? body.squares ?? body.indices ?? body.answers).map((n) => Math.round(n));
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
  return { tiles: [...new Set(tiles)].filter((n) => n >= 1 && n <= 64), points, slide, ...(tiles.length || points.length || slide !== null ? {} : { why: "the model named nothing to click" }) };
}

/** The question put to the model, with every square named where it is. */
export function visionPrompt(challenge: Challenge, w: number, h: number): string {
  const head =
    `This is a CAPTCHA picture, ${w} by ${h} pixels, cropped exactly around the challenge. ` +
    `Answer with JSON only, no prose.\nThe widget says: "${challenge.prompt}".\n`;
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
async function localAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const nothing: Answer = { tiles: [], points: [], slide: null };
  if (challenge.kind !== "slider" || !challenge.handle) {
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

/** The vision backend: the model that already runs this machine. */
async function visionAnswer(deps: SolverDeps, challenge: Challenge): Promise<Answer> {
  const empty: Answer = { tiles: [], points: [], slide: null };
  if (!deps.vision) return { ...empty, why: "no image-reading model is connected" };
  try {
    const png = await deps.shot(challenge.box);
    const size = decodePng(png);
    const said = await deps.vision(visionPrompt(challenge, size.w, size.h), png);
    const answer = parseAnswer(said);
    // A model given tile numbers sometimes sends coordinates anyway; a model
    // given a picture sometimes sends fractions of it instead of pixels.
    if (!answer.tiles.length && !answer.points.length && answer.slide === null) {
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

async function answerFrom(deps: SolverDeps, backend: CaptchaBackend, challenge: Challenge): Promise<Answer> {
  if (backend === "local") return localAnswer(deps, challenge);
  if (backend === "vision") return visionAnswer(deps, challenge);
  return remoteAnswer(deps, challenge);
}

/* --------------------------------------------------------------- acting -- */

/** Turn an answer into clicks on the page, and say what was done. */
async function act(deps: SolverDeps, challenge: Challenge, backend: CaptchaBackend, answer: Answer): Promise<string> {
  const size = { w: challenge.box.w, h: challenge.box.h };

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
  if (!chosen.length) return "nothing to click";

  for (const at of chosen) {
    deps.log(`captcha: click square ${chosen.indexOf(at) + 1} (${backend})`, at);
    await deps.click(at);
    await deps.sleep(320);
  }
  if (challenge.verify) {
    const at = { x: challenge.verify.x + challenge.verify.w / 2, y: challenge.verify.y + challenge.verify.h / 2 };
    deps.log("captcha: press Check", at);
    await deps.click(at);
  }
  return `clicked ${chosen.length} square${chosen.length === 1 ? "" : "s"}`;
}

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
  if (!settings.enabled) {
    return { outcome: "none", widget: null, backend: null, detail: "Picture challenges are set to be handed to the person (Settings, CAPTCHA)." };
  }

  const reasons: string[] = [];
  const budget = Math.max(1, settings.attempts);

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const challenge = await findChallenge(deps.page).catch(() => null);
    if (!challenge) {
      return { outcome: "solved", widget: null, backend: null, detail: "The challenge is gone; the widget has passed." };
    }
    if (await deps.passed().catch(() => false)) {
      return { outcome: "solved", widget: challenge.widget, backend: null, detail: "The widget's own token says it passed." };
    }

    for (const backend of settings.backends) {
      const answer = await answerFrom(deps, backend, challenge);
      const spoke = answer.tiles.length || answer.points.length || answer.slide !== null;
      if (!spoke) {
        reasons.push(`${backend}: ${answer.why ?? "no answer"}`);
        continue;
      }
      const did = await act(deps, challenge, backend, answer).catch((err) => `could not act (${err?.message ?? err})`);
      deps.log(`captcha: answered by ${backend} -- ${did}`);
      await deps.sleep(1400);
      const after = await deps.passed().catch(() => false);
      const still = await findChallenge(deps.page).catch(() => null);
      if (after || !still) {
        return { outcome: "solved", widget: challenge.widget, backend, detail: `${backend} answered it: ${did}.` };
      }
      if (still.kind === "grid" && /nothing to click|could not act/i.test(did)) {
        reasons.push(`${backend}: ${did}`);
        continue;
      }
      reasons.push(`${backend}: ${did}, and ${challenge.widget} asked again`);
    }
  }

  const worst = reasons.slice(-3).join("; ");
  return {
    outcome: "giveup",
    widget: (await findChallenge(deps.page).catch(() => null))?.widget ?? null,
    backend: null,
    detail: `Tried ${budget} time${budget === 1 ? "" : "s"}: ${worst || "no backend could answer"}.`,
  };
}
