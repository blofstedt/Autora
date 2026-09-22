/**
 * A real browser, driven programmatically and watched live.
 *
 * Two channels out of one page, deliberately kept apart:
 *
 *  - What the *model* gets is text. `outline()` returns the page's interactive
 *    elements the way a screen reader would announce them, numbered, and
 *    actions take those numbers. A sign-in page is ~110 tokens that way and
 *    ~1,300 as a screenshot, and you cannot click a screenshot.
 *  - What the *person* gets is video. Chrome's own screencast, streamed frame
 *    by frame over the session socket, so you watch the pointer travel, the
 *    click land and the page navigate as it happens -- not a screenshot after
 *    the fact.
 *
 * The second channel is the point of this file. Reading a page programmatically
 * is what makes an agent good at browsing; being unable to see what it did is
 * what makes it impossible to trust. So the pointer is drawn into the page
 * before every click and the click is performed as a real mouse event at real
 * coordinates -- the agent is not miming for the camera, it is genuinely
 * clicking there, and the camera is pointed at it.
 *
 * Frames are ephemeral: they go out over the socket and are never written to
 * the event log. What the log keeps is keyframes -- one after each navigation
 * and each action -- so scrolling back through a session still shows what the
 * page looked like at each step without the log becoming a video file.
 *
 * Playwright is an optional dependency and the browser binary is the system's.
 * Neither being present is an ordinary condition, not a crash: `status()` says
 * what is missing and the thread says so in words.
 */

import fs from "node:fs";
import path from "node:path";

import { stateFilePath } from "./state";

/* Playwright's types are not imported: the package is optional, and a type
   import would make the server half fail to compile wherever it is not
   installed. The surface used here is small enough to name locally. */
type Page = any;
type BrowserContext = any;
type CDPSession = any;

export interface BrowserStatus {
  /** Playwright and a browser binary are both present. */
  available: boolean;
  /** A page is open right now. */
  open: boolean;
  url: string | null;
  title: string | null;
  /** Why it is not available, in words fit to show someone. */
  detail: string | null;
  /** Live frames per second currently being sent. */
  fps: number;
  viewport: { width: number; height: number };
  /** Who currently holds control of the browser (agent, human, or shared). */
  control: { holder: "agent" | "human" | "shared"; reason: string | null };
}

/** One numbered, clickable thing on the page. */
export interface Ref {
  ref: number;
  role: string;
  name: string;
  value: string | null;
  /** Page coordinates of the element's centre, which is where a click goes
      and where the marker is painted in the transcript. */
  x: number;
  y: number;
  w: number;
  h: number;
  href: string | null;
  checked: boolean | null;
  disabled: boolean;
}

export interface PageRead {
  url: string;
  title: string;
  /** The numbered outline the model acts on. */
  outline: string;
  refs: Ref[];
  /** Readable prose, trimmed, for questions the outline cannot answer. */
  text: string;
}

export interface BrowserHooks {
  /** A live frame: base64 JPEG, ephemeral, never stored. */
  onFrame: (jpegBase64: string) => void;
  /** A frame worth keeping in the transcript. */
  onKeyframe: (jpeg: Buffer, url: string, title: string) => void;
  onNav: (url: string, title: string) => void;
  /** Something the agent did, with where it did it when that is meaningful. */
  onAction: (action: string, at: { x: number; y: number } | null, url: string) => void;
  /** Whether anyone is watching. The screencast is stopped while nobody is,
      because encoding JPEGs for an empty room is just heat. */
  watchers: () => number;
}

/** The capture size. Frame pixels map 1:1 to page pixels so a click at
    640,400 really is the middle of the picture -- the transcript's marker and
    the element picker both depend on that. */
export const VIEWPORT = { width: 1280, height: 800 };

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number((value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** How often live frames go out. Chrome offers about sixty a second; a LAN is
    not a video codec, and six is plenty to see a pointer move and a page
    change. */
const LIVE_FPS = Math.min(num(process.env.AUTORA_BROWSER_FPS, 6), 30);
const LIVE_QUALITY = Math.min(num(process.env.AUTORA_BROWSER_QUALITY, 50), 100);
/** Frames are sent narrower than the page is rendered: the picture is for
    watching, not for reading nine-point text, and halving the width quarters
    the bytes. */
const LIVE_WIDTH = num(process.env.AUTORA_BROWSER_STREAM_WIDTH, 960);

/**
 * Where Chrome is.
 *
 * Named outright by AUTORA_BROWSER_PATH; otherwise the usual system packages,
 * in the order a machine is likely to have them. Playwright's own downloaded
 * browsers are found by Playwright itself and need nothing here.
 */
const CANDIDATE_PATHS = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function systemBrowser(): string | null {
  const named = (process.env.AUTORA_BROWSER_PATH || "").trim();
  if (named) return named;
  for (const candidate of CANDIDATE_PATHS) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Unreadable is the same as absent for this purpose.
    }
  }
  return null;
}

/**
 * Where the browser keeps its profile.
 *
 * Beside the settings file, so it lands in whatever directory this
 * installation already treats as the one worth keeping -- `/data` in the
 * container, `.autora/` beside the app otherwise. Cookies and logins are as
 * sensitive as the API keys next door, so the directory is owner-only for the
 * same reason that one is.
 */
function profileDir(): string {
  const dir = path.join(path.dirname(stateFilePath()), "browser-profile");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Chrome will say so more precisely than we can guess at here.
  }
  return dir;
}

/**
 * The pointer, drawn into the page.
 *
 * A headless browser has no cursor, so a recording of one clicking is a
 * recording of a page changing for no visible reason. This paints one: a dot
 * that moves where the mouse moves and a ring that expands where it clicks,
 * inside a shadow root so the page cannot restyle it and `pointer-events:
 * none` so it cannot intercept the click it is illustrating.
 *
 * Marked `data-autora` and skipped by the element scan below, so it never
 * appears in what the model reads -- a cursor that the agent could click on
 * would be a very funny bug to debug.
 */
const CURSOR_SCRIPT = `
(() => {
  if (window.__autoraCursor) return;
  const mount = () => {
    if (!document.body || document.getElementById("__autora_cursor")) return;
    const host = document.createElement("div");
    host.id = "__autora_cursor";
    host.setAttribute("data-autora", "cursor");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<style>' +
      '.dot{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(139,124,246,.9);box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 10px rgba(0,0,0,.45);' +
      'transition:left .18s cubic-bezier(.4,0,.2,1),top .18s cubic-bezier(.4,0,.2,1);opacity:0}' +
      '.ring{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;' +
      'border:2px solid rgba(139,124,246,.95);opacity:0}' +
      '@keyframes tap{from{transform:scale(.4);opacity:.95}to{transform:scale(4.2);opacity:0}}' +
      '.ring.go{animation:tap .45s ease-out forwards}' +
      '</style><div class="dot"></div><div class="ring"></div>';
    const dot = root.querySelector(".dot");
    const ring = root.querySelector(".ring");
    document.body.appendChild(host);
    window.__autoraCursor = (x, y, tap) => {
      dot.style.left = x + "px";
      dot.style.top = y + "px";
      dot.style.opacity = "1";
      if (tap) {
        ring.style.left = x + "px";
        ring.style.top = y + "px";
        ring.classList.remove("go");
        void ring.offsetWidth;
        ring.classList.add("go");
      }
    };
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  window.__autoraCursorMount = mount;
})();
`;

/**
 * Everything on the page you could act on, numbered.
 *
 * The accessibility layer rather than the DOM, for the reason the README
 * gives: the DOM is wrapper soup, a button is six nested divs, and the a11y
 * role and name are what a person perceiving this page without looking at it
 * would be given. Elements are collected in document order so the numbers are
 * stable across a read that changed nothing, and each carries the centre of
 * its box, which is where a click goes.
 */
const SCAN_SCRIPT = `
(() => {
  const SELECTOR = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=tab]", "[role=menuitem]", "[role=switch]", "[role=option]",
    "[contenteditable=true]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const named = (el) => {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map((n) => n.textContent || "");
      if (parts.length) return parts.join(" ").trim();
    }
    if (el.id) {
      const wrapped = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (wrapped && wrapped.textContent) return wrapped.textContent.trim();
    }
    const closest = el.closest("label");
    if (closest && closest.textContent) return closest.textContent.trim();
    const alt = el.getAttribute("alt") || el.getAttribute("title")
      || el.getAttribute("placeholder") || el.getAttribute("name");
    if (alt) return alt.trim();
    return (el.innerText || el.value || "").trim();
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return tag;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "password") return "password";
    return "textbox";
  };

  const refs = [];
  const elements = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (el.closest("[data-autora]")) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    const name = named(el).replace(/\\s+/g, " ").slice(0, 120);
    const role = roleOf(el);
    if (!name && role !== "textbox" && role !== "password") continue;
    const ref = refs.length;
    refs.push({
      ref,
      role,
      name,
      value: typeof el.value === "string" && el.type !== "password" ? el.value.slice(0, 80) : null,
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
      w: Math.round(box.width),
      h: Math.round(box.height),
      href: el.tagName === "A" ? (el.getAttribute("href") || null) : null,
      checked: typeof el.checked === "boolean" ? el.checked : null,
      disabled: !!el.disabled,
    });
    elements.push(el);
  }
  window.__autoraRefs = elements;

  const body = document.body ? (document.body.innerText || "") : "";
  return {
    url: location.href,
    title: document.title,
    refs,
    text: body.replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 6000),
  };
})();
`;

/**
 * Is there a browser to drive at all?
 *
 * Asked once and remembered. It cannot be answered synchronously -- the only
 * honest test that `playwright-core` is installed is importing it, and this
 * file is loaded as ESM in development and bundled to CJS in the container, so
 * `require.resolve` is available in exactly one of those. The probe therefore
 * runs at startup and everything afterwards reads the answer it left.
 */
let probed: { ok: boolean; detail: string | null } | null = null;

export async function probeBrowser(): Promise<{ ok: boolean; detail: string | null }> {
  if (probed) return probed;
  try {
    await import("playwright-core");
  } catch {
    probed = {
      ok: false,
      detail:
        "Browsing needs the optional `playwright-core` package, which is not installed here. " +
        "Run `npm install playwright-core` beside the app and restart.",
    };
    return probed;
  }
  if (!systemBrowser() && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    probed = {
      ok: false,
      detail:
        "No Chromium was found. Install one (apk add chromium, apt install chromium, or Chrome), " +
        "or point AUTORA_BROWSER_PATH at the binary.",
    };
    return probed;
  }
  probed = { ok: true, detail: null };
  return probed;
}

/**
 * What is at this point on the page.
 *
 * The click lands on whatever is topmost, which is routinely the label inside
 * a button rather than the button -- so the hit is walked up to the nearest
 * thing you could plausibly have meant, and the walk is reported rather than
 * hidden, because "I clicked the text and got the form" is worth knowing.
 *
 * Where the framework left a trail -- React's dev fiber, a `data-source`
 * attribute -- it resolves to the file and line that rendered the element.
 * Where it did not, it says so instead of guessing at a file, which is the
 * difference between a useful answer and a confident wrong one.
 */
const PICK_SCRIPT = (x: number, y: number) => `
(() => {
  const hit = document.elementFromPoint(${x}, ${y});
  if (!hit || hit.closest("[data-autora]")) return { ok: false, error: "Nothing there." };

  const ACTIONABLE = "a[href],button,input,select,textarea,summary,label,[role],[onclick]";
  let el = hit;
  let retargeted = null;
  const up = hit.closest(ACTIONABLE);
  if (up && up !== hit) { el = up; retargeted = { tag: hit.tagName.toLowerCase() }; }

  const selector = (() => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      const cls = (n.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      parts.unshift(part);
      if (n.id) { parts[0] = "#" + CSS.escape(n.id); break; }
    }
    return parts.join(" > ");
  })();

  /* React keeps the element that rendered a node on a __reactFiber key in
     development builds. Production strips it, which is why the absence of a
     file is reported rather than filled in. */
  const source = (() => {
    const attr = el.getAttribute("data-source") || el.getAttribute("data-testid-source");
    if (attr) {
      const [file, line] = attr.split(":");
      return { file, line: Number(line) || undefined, via: "data-source" };
    }
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return null;
    let fiber = el[key];
    for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return) {
      const debug = fiber._debugSource || fiber._debugInfo;
      const name = typeof fiber.type === "function"
        ? (fiber.type.displayName || fiber.type.name) : null;
      if (debug && debug.fileName) {
        return {
          file: String(debug.fileName).split("/").slice(-3).join("/"),
          line: debug.lineNumber,
          component: name || undefined,
          via: "react",
        };
      }
      if (name) return { component: name, via: "react" };
    }
    return null;
  })();

  const style = getComputedStyle(el);
  const pick = (names) => {
    const out = {};
    for (const n of names) {
      const v = style.getPropertyValue(n);
      if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px") out[n] = v;
    }
    return out;
  };

  const box = el.getBoundingClientRect();
  const refs = window.__autoraRefs || [];
  const index = refs.indexOf(el);
  const text = (el.innerText || el.value || "").trim().replace(/\\s+/g, " ");

  return {
    ok: true,
    pick: {
      kind: el.tagName.toLowerCase(),
      ref: index >= 0 ? index : null,
      selector,
      box: {
        x: Math.round(box.left), y: Math.round(box.top),
        w: Math.round(box.width), h: Math.round(box.height),
      },
      source,
      fingerprint: {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 6),
        text: text ? text.slice(0, 80) : null,
      },
      params: {
        /* Only what this element sets, not the whole inherited cascade --
           forty resolved properties is not an answer, it is a haystack. */
        layout: pick(["display", "position", "width", "height", "padding", "margin", "gap"]),
        type: pick(["font-family", "font-size", "font-weight", "line-height", "color"]),
        paint: pick(["background-color", "border", "border-radius", "box-shadow", "opacity"]),
      },
      retargeted,
    },
  };
})();
`;

const STEALTH_SCRIPT = `
(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = {
      runtime: {},
      app: {},
      csi: () => {},
      loadTimes: () => {}
    };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ]
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  } catch {}
})();
`;

/** One page, one screencast, one session's worth of browsing. */
export class LiveBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private streaming = false;
  private lastFrameAt = 0;
  private refs: Ref[] = [];
  private closing = false;
  private control: { holder: "agent" | "human" | "shared"; reason: string | null } = {
    holder: "agent",
    reason: null,
  };
  /** Serialises actions: two clicks racing on one page is a bug report that
      is impossible to read afterwards. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private hooks: BrowserHooks) {}

  // ------------------------------------------------------------- lifecycle --

  status(): BrowserStatus {
    return {
      available: probed?.ok ?? false,
      open: !!this.page,
      url: this.page ? (this.currentUrl ?? null) : null,
      title: this.currentTitle,
      detail: probed?.detail ?? null,
      fps: this.streaming ? LIVE_FPS : 0,
      viewport: VIEWPORT,
      control: this.control,
    };
  }

  getControl() {
    return this.control;
  }

  setControl(holder: "agent" | "human" | "shared", reason: string | null = null) {
    this.control = { holder, reason: reason ?? null };
  }

  private currentUrl: string | null = null;
  private currentTitle: string | null = null;

  /**
   * Start Chrome, if it is not already running.
   *
   * A persistent profile rather than a fresh one each time, because the
   * alternative is signing in to everything again on every restart -- and an
   * agent that cannot stay signed in to your mail is an agent that cannot
   * read your mail. The profile lives beside the settings file, which in the
   * container is the one directory that survives an update.
   *
   * Headed when asked: on a desktop that means a real window you can watch
   * beside the app, which is sometimes exactly what someone wants and costs
   * nothing to allow.
   */
  private async ensure(): Promise<Page> {
    if (this.page) return this.page;

    const { ok, detail } = await probeBrowser();
    if (!ok) throw new Error(detail ?? "No browser available.");

    const { chromium } = await import("playwright-core");
    const executablePath = systemBrowser();
    this.context = await chromium.launchPersistentContext(profileDir(), {
      headless: process.env.AUTORA_BROWSER_HEADED !== "1",
      ...(executablePath ? { executablePath } : {}),
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-infobars",
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      ],
    });
    await this.context.addInitScript(STEALTH_SCRIPT);
    await this.context.addInitScript(CURSOR_SCRIPT);
    // A persistent context opens with a page already in it; taking that one
    // rather than adding a second avoids leaving an orphan about:blank behind
    // that the screencast would happily photograph.
    this.page = this.context.pages()[0] ?? (await this.context.newPage());

    this.page.on("framenavigated", (frame: any) => {
      if (frame !== this.page?.mainFrame()) return;
      this.currentUrl = frame.url();
      void this.announceNav();
    });
    this.page.on("close", () => {
      this.page = null;
      this.streaming = false;
    });

    await this.startStream();
    return this.page;
  }

  /** The last nav that was announced, so the several `framenavigated` events
      one navigation produces become the one line they describe. */
  private announced = "";

  private async announceNav() {
    if (!this.page) return;
    const title = await this.page.title().catch(() => "");
    this.currentTitle = title;
    const url = this.currentUrl ?? "";
    const signature = `${url}\u0000${title}`;
    if (signature === this.announced) return;
    this.announced = signature;
    this.hooks.onNav(url, title);
  }

  /**
   * Chrome's screencast, throttled.
   *
   * Every frame is acknowledged -- Chrome stops sending until it is -- but
   * only every so many are forwarded, and none at all while nobody is
   * watching. That keeps a browsing session at a few hundred kilobytes a
   * second on the wire and near nothing when the tab is closed.
   */
  private async startStream() {
    if (!this.page || !this.context || this.streaming) return;
    this.cdp = await this.context.newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (frame: any) => {
      this.cdp
        ?.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => undefined);
      if (this.hooks.watchers() === 0) return;
      const now = Date.now();
      if (now - this.lastFrameAt < 1000 / LIVE_FPS) return;
      this.lastFrameAt = now;
      this.hooks.onFrame(frame.data);
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: LIVE_QUALITY,
      maxWidth: LIVE_WIDTH,
      maxHeight: Math.round((LIVE_WIDTH / VIEWPORT.width) * VIEWPORT.height),
      everyNthFrame: 1,
    });
    this.streaming = true;
  }

  /**
   * Send one frame right now, whether or not the page has moved.
   *
   * Chrome's screencast is change-driven: a page that is sitting still emits
   * nothing, which is the right behaviour for a video codec and the wrong one
   * for someone who has just opened the app. Without this, joining a session
   * whose browser is parked on a static page shows the last *stored*
   * screenshot and calls it live -- or shows nothing and waits for the page to
   * happen to move.
   */
  async nudge() {
    if (!this.page || this.hooks.watchers() === 0) return;
    try {
      const shot: Buffer = await this.page.screenshot({
        type: "jpeg",
        quality: LIVE_QUALITY,
        scale: "css",
      });
      this.hooks.onFrame(shot.toString("base64"));
    } catch {
      // Mid-navigation. The next real frame is a moment away.
    }
  }

  async close() {
    this.closing = true;
    // The context owns the browser when it is a persistent one, so closing it
    // is what actually stops Chrome -- and it is also what flushes the profile
    // to disk, which is the whole point of having one.
    const context = this.context;
    this.page = null;
    this.context = null;
    this.cdp = null;
    this.streaming = false;
    this.announced = "";
    this.currentUrl = null;
    this.currentTitle = null;
    this.refs = [];
    await context?.close().catch(() => undefined);
    this.closing = false;
  }

  // ---------------------------------------------------------------- acting --

  /** One at a time, in the order asked. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A frame worth keeping: taken after the page has settled, so the log
      shows the result of an action rather than the middle of it. */
  private async keyframe() {
    if (!this.page || this.closing) return;
    try {
      const shot: Buffer = await this.page.screenshot({ type: "jpeg", quality: 70 });
      this.hooks.onKeyframe(shot, this.currentUrl ?? "", this.currentTitle ?? "");
    } catch {
      // A page that navigated out from under the shot is not an error worth
      // reporting; the next action takes another one.
    }
  }

  /** Let whatever the action started finish painting before we photograph it.
      Short, because this sits in front of every action and a browser that
      feels like a slideshow is worse than one frame early. */
  private async settle(ms = 450) {
    await this.page?.waitForTimeout?.(ms).catch(() => undefined);
  }

  goto(rawUrl: string): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const url = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      this.hooks.onAction(`open ${url}`, null, url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.settle();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  back(): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      this.hooks.onAction("back", null, this.currentUrl ?? "");
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await this.settle();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /**
   * Click the numbered thing, visibly.
   *
   * The pointer is drawn travelling to the target and a ring is played where
   * it lands, then the click is dispatched as a real mouse event at those
   * coordinates. The drawing is for the person watching; the event is the
   * actual click, at the actual place, so what the recording shows and what
   * the page received are the same thing.
   */
  click(ref: number): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const target = this.refs.find((r) => r.ref === ref);
      if (!target) throw new Error(`No element [${ref}] on this page. Read it again.`);

      await this.showCursor(target.x, target.y, false);
      await page.mouse.move(target.x, target.y, { steps: 12 });
      await this.showCursor(target.x, target.y, true);
      this.hooks.onAction(
        `click [${ref}] ${target.role} "${target.name}"`.trim(),
        { x: target.x, y: target.y },
        this.currentUrl ?? "",
      );
      await page.mouse.click(target.x, target.y);
      await this.settle(700);
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /** Fill fields by number, then optionally submit. A form is one round trip
      rather than one per field, which is the difference between an agent that
      fills in a login and one that spends six turns on it. */
  fill(values: { ref: number; text: string }[], submit = false): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      for (const { ref, text } of values) {
        const target = this.refs.find((r) => r.ref === ref);
        if (!target) throw new Error(`No field [${ref}] on this page. Read it again.`);
        await this.showCursor(target.x, target.y, true);
        await page.mouse.click(target.x, target.y);
        await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
        await page.keyboard.type(text, { delay: 18 });
        this.hooks.onAction(
          `fill [${ref}] "${target.name}"`,
          { x: target.x, y: target.y },
          this.currentUrl ?? "",
        );
      }
      if (submit) {
        await page.keyboard.press("Enter");
        this.hooks.onAction("submit", null, this.currentUrl ?? "");
        await this.settle(900);
      } else {
        await this.settle();
      }
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  scroll(dy: number): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      await page.mouse.wheel(0, dy);
      this.hooks.onAction(`scroll ${dy > 0 ? "down" : "up"}`, null, this.currentUrl ?? "");
      await this.settle(300);
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /** A picture of the page as it is, for the thread. The one case where the
      screenshot is the answer rather than the fallback. */
  capture(): Promise<Buffer> {
    return this.run(async () => {
      const page = await this.ensure();
      return (await page.screenshot({ type: "png", fullPage: false })) as Buffer;
    });
  }

  /**
   * What is at this point, without clicking it.
   *
   * Pointing at an element is how you ask about one without describing it in
   * prose and hoping the agent finds the same one. Deliberately read-only:
   * the page is not touched, so pointing at a Delete button is safe.
   */
  pickAt(x: number, y: number): Promise<any> {
    return this.run(async () => {
      const page = this.page;
      if (!page) return { ok: false, error: "No page is open." };
      // Refresh the numbering first, so the ref this comes back with is one
      // the agent can actually act on rather than one from two pages ago.
      await this.read().catch(() => undefined);
      return page.evaluate(PICK_SCRIPT(Math.round(x), Math.round(y)));
    });
  }

  /** Read the page without touching it. Safe to call at any time; refreshes
      the numbering the actions above resolve against. */
  snapshot(): Promise<PageRead> {
    return this.run(async () => {
      await this.ensure();
      return this.read();
    });
  }

  /** Direct mouse click from user or agent at screen coordinates */
  mouseClick(
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
    double = false,
  ): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const clampedX = Math.max(0, Math.min(VIEWPORT.width, Math.round(x)));
      const clampedY = Math.max(0, Math.min(VIEWPORT.height, Math.round(y)));
      await this.showCursor(clampedX, clampedY, true);
      this.hooks.onAction(
        `${double ? "double-click" : "click"} at ${clampedX},${clampedY}`,
        { x: clampedX, y: clampedY },
        this.currentUrl ?? "",
      );
      if (double) {
        await page.mouse.dblclick(clampedX, clampedY, { button });
      } else {
        await page.mouse.click(clampedX, clampedY, { button });
      }
      await this.settle(600);
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /** Direct mouse move from user */
  mouseMove(x: number, y: number): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      const clampedX = Math.max(0, Math.min(VIEWPORT.width, Math.round(x)));
      const clampedY = Math.max(0, Math.min(VIEWPORT.height, Math.round(y)));
      await this.showCursor(clampedX, clampedY, false);
      await page.mouse.move(clampedX, clampedY);
    });
  }

  /** Direct typing from user into focused element */
  keyboardType(text: string): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      this.hooks.onAction(`typed text (${text.length} chars)`, null, this.currentUrl ?? "");
      await page.keyboard.type(text, { delay: 15 });
      await this.settle(200);
      await this.keyframe();
    });
  }

  /** Direct keystroke from user (Enter, Tab, Escape, Backspace, etc.) */
  keyboardPress(key: string): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      this.hooks.onAction(`press key ${key}`, null, this.currentUrl ?? "");
      await page.keyboard.press(key);
      await this.settle(300);
      await this.keyframe();
    });
  }

  /** Direct mouse wheel scrolling from user */
  mouseWheel(deltaX: number, deltaY: number): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      await page.mouse.wheel(deltaX, deltaY);
      await this.settle(150);
      await this.keyframe();
    });
  }

  /** Reload current page */
  reload(): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      this.hooks.onAction("reloaded page", null, this.currentUrl ?? "");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await this.settle();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /** Go back in browser history */
  goBack(): Promise<PageRead | null> {
    return this.run(async () => {
      const page = await this.ensure();
      this.hooks.onAction("navigated back", null, this.currentUrl ?? "");
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      await this.settle();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  private async showCursor(x: number, y: number, tap: boolean) {
    await this.page
      ?.evaluate(
        `(() => { if (window.__autoraCursorMount) window.__autoraCursorMount();
           if (window.__autoraCursor) window.__autoraCursor(${x}, ${y}, ${tap ? "true" : "false"}); })()`,
      )
      .catch(() => undefined);
    // Long enough for the dot's own transition to play, so the pointer is seen
    // arriving rather than teleporting.
    if (!tap) await this.page?.waitForTimeout?.(200).catch(() => undefined);
  }

  /** The scan, folded into the shape the model is given. */
  private async read(): Promise<PageRead> {
    const page = this.page;
    if (!page) throw new Error("No page is open.");
    const scanned = await page.evaluate(SCAN_SCRIPT);
    this.refs = scanned.refs;
    this.currentUrl = scanned.url;
    this.currentTitle = scanned.title;
    return {
      url: scanned.url,
      title: scanned.title,
      refs: scanned.refs,
      text: scanned.text,
      outline: outlineOf(scanned.refs),
    };
  }
}

/**
 * The numbered outline, as a screen reader would read it.
 *
 * Capped, because a search results page has four hundred links and the first
 * forty are the ones anybody acts on; the count is printed so the model knows
 * it is looking at the top of a list rather than all of it.
 */
export function outlineOf(refs: Ref[], limit = 60): string {
  const lines = refs.slice(0, limit).map((r) => {
    const bits = [`[${r.ref}]`, r.role];
    if (r.name) bits.push(JSON.stringify(r.name));
    if (r.value) bits.push(`value=${JSON.stringify(r.value)}`);
    if (r.checked === true) bits.push("checked");
    if (r.disabled) bits.push("disabled");
    if (r.href) bits.push(`-> ${r.href}`);
    return bits.join(" ");
  });
  if (refs.length > limit) {
    lines.push(`… ${refs.length - limit} more elements below; scroll to reach them.`);
  }
  return lines.join("\n");
}
