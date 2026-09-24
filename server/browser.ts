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
import os from "node:os";
import path from "node:path";

import { stateFilePath } from "./state";
import type { BrowserCookie } from "./cookies";
import { humanClick, humanMove, humanType, pointIn, wander, type Point } from "./human";

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
  /** Where the page's typeable fields are, as [x, y, w, h] in page pixels, so
      a phone can raise its keyboard for a tap on one -- and only on one --
      without waiting for the click to come back. */
  fields: Array<[number, number, number, number]>;
}

/** A file to put into an upload field, bytes and all. */
export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
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
  /** On screen (or within a little of it) when the page was read. The model
      is shown these; the rest are counted, keeping their numbers. */
  inView?: boolean;
  /** An input type other than plain text: email, tel, date, number... */
  type?: string;
  /** What the field is for, from its autocomplete hint or its own name:
      "first name", "shipping ZIP / postal code". */
  purpose?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  /** min..max, for numbers and dates. */
  range?: string;
  /** What the page says is wrong with the value, when it says anything. */
  invalid?: string;
  /** The help text the page attaches to the field. */
  hint?: string;
  /** The fieldset, group or heading the field sits under. */
  section?: string;
  /** A dropdown's choices, the first fifteen, and how many there are. */
  options?: string[];
  optionCount?: number;
  expanded?: boolean;
  selected?: boolean;
  current?: boolean;
  /** The open dialog the element is inside, by name. */
  dialog?: string;
}

/** Where the page is scrolled to: of the page itself, or of the pane that
    does the scrolling in an app whose page never moves. */
export interface ScrollState {
  y: number;
  max: number;
  view: number;
  pane: boolean;
}

export interface PageRead {
  url: string;
  title: string;
  /** The numbered outline the model acts on. */
  outline: string;
  refs: Ref[];
  /** The page's main content as readable text -- the article rather than
      the menus around it -- whole, up to a generous cap. The model reads it
      a part at a time (see textParts). */
  text: string;
  /** Checkbox CAPTCHAs on the page. They live in cross-origin iframes the
      outline cannot see into, so they are found separately. */
  captchas: { kind: CaptchaKind; solved: boolean; challenge: boolean }[];
  /** The dialog open on top of the page, by name. */
  dialog?: string | null;
  scroll?: ScrollState;
  /** The site turned the sign-in away, in its own words. */
  blocked?: string | null;
  /** What the action that produced this read did, field by field, or why
      it did nothing. */
  notes?: string[];
}

/** Where to scroll: by screens (or pixels), to the top or bottom, inside a
    numbered element, or to some text. */
export interface ScrollRequest {
  screens?: number;
  dy?: number;
  to?: "top" | "bottom";
  ref?: number | null;
  text?: string;
}

export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile";

/** A checkbox CAPTCHA found on the page, with where its box is. */
interface CaptchaHit {
  kind: CaptchaKind;
  /** The checkbox itself, in page coordinates. */
  box: { x: number; y: number; w: number; h: number };
  solved: boolean;
  /** An image or puzzle challenge is showing -- the checkbox was not enough. */
  challenge: boolean;
}

export interface CaptchaResult {
  outcome: "none" | "solved" | "challenge" | "pending";
  kind: CaptchaKind | null;
  page: PageRead;
}

export interface BrowserHooks {
  /** A live frame: base64 JPEG, ephemeral, never stored. */
  onFrame: (jpegBase64: string) => void;
  /** A frame worth keeping in the transcript. */
  onKeyframe: (jpeg: Buffer, url: string, title: string) => void;
  onNav: (url: string, title: string) => void;
  /** Something the agent did, with where it did it when that is meaningful. */
  onAction: (action: string, at: { x: number; y: number } | null, url: string) => void;
  /** The typeable fields on the page moved, appeared or went. */
  onFields: () => void;
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
    not a video codec, and ten is enough to follow the pointer travelling to
    what it is about to click. */
/** How long typing has to stop before it is logged and a frame is kept. */
const TYPING_PAUSE_MS = 1200;
const LIVE_FPS = Math.min(num(process.env.AUTORA_BROWSER_FPS, 10), 30);
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
  // Init scripts run in every frame; one pointer, drawn over the whole page,
  // is the one that belongs to the top frame.
  if (window.__autoraCursor || window.top !== window) return;
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
      'transition:left .06s linear,top .06s linear;opacity:0}' +
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
    /* Follow the real pointer. The agent moves the mouse with genuine input
       events along a curved path, so the dot tracks every step of it rather
       than jumping to where the click will land. */
    window.addEventListener("mousemove", (e) => {
      if (e.isTrusted) window.__autoraCursor(e.clientX, e.clientY, false);
    }, { capture: true, passive: true });
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
 * Everything on the page you could act on, numbered, and described well
 * enough to act on correctly.
 *
 * The accessibility layer rather than the DOM, for the reason the README
 * gives: the DOM is wrapper soup, a button is six nested divs, and the a11y
 * role and name are what a person perceiving this page without looking at it
 * would be given. Elements are collected in document order so the numbers are
 * stable across a read that changed nothing, and each carries the centre of
 * its box, which is where a click goes.
 *
 * A name alone was not enough to fill a form with. A box labelled "Name" is a
 * first name, a last name or both, and the page says which -- in its
 * autocomplete hint, its input type, the section it sits in, the text beside
 * it -- so all of that is carried too: what the field is for, what kind of
 * value it takes, whether it is required, and what the page said was wrong
 * with it. Dropdowns list their choices. Open shadow roots and same-origin
 * frames are walked, because a modern site's sign-in form is as likely to be
 * inside one as not, and a div that is only clickable because of its cursor
 * is still something to click.
 */
const SCAN_SCRIPT = `
(() => {
  const SELECTOR = [
    "a[href]", "button", "input", "select", "textarea", "summary", "label",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
    "[role=switch]", "[role=option]", "[role=combobox]", "[role=textbox]",
    "[role=searchbox]", "[role=slider]", "[role=spinbutton]", "[role=treeitem]",
    "[contenteditable=true]", "[contenteditable='']", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const FIELD_TAGS = { INPUT: 1, SELECT: 1, TEXTAREA: 1 };
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const short = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s; };
  const textOf = (el) => clean(el.innerText !== undefined ? el.innerText : el.textContent);

  /* What an autocomplete token or a field's own name says it is for. The
     single most useful thing to know about a box labelled "Name". */
  const PURPOSES = {
    "given-name": "first name", "family-name": "last name", "additional-name": "middle name",
    "name": "full name", "nickname": "nickname", "honorific-prefix": "title (Mr, Ms...)",
    "email": "email", "tel": "phone", "tel-national": "phone", "tel-country-code": "phone country code",
    "street-address": "street address", "address-line1": "address line 1",
    "address-line2": "address line 2 (apt, suite)", "address-line3": "address line 3",
    "address-level2": "city", "address-level1": "state / province", "postal-code": "ZIP / postal code",
    "country": "country", "country-name": "country", "organization": "company",
    "organization-title": "job title", "bday": "date of birth", "bday-day": "birth day",
    "bday-month": "birth month", "bday-year": "birth year", "sex": "gender",
    "username": "username", "current-password": "current password",
    "new-password": "new password (being set)", "one-time-code": "one-time code",
    "cc-name": "name on card", "cc-number": "card number", "cc-exp": "card expiry",
    "cc-exp-month": "card expiry month", "cc-exp-year": "card expiry year",
    "cc-csc": "card security code", "url": "website",
  };
  const GUESSES = [
    [/first.?name|fname|given|forename/i, "first name"],
    [/last.?name|lname|surname|family.?name/i, "last name"],
    [/middle.?name|mname/i, "middle name"],
    [/full.?name/i, "full name"],
    [/e.?mail/i, "email"],
    [/phone|mobile|\\btel\\b|cell/i, "phone"],
    [/zip|postal|postcode/i, "ZIP / postal code"],
    [/\\bcity\\b|town|locality/i, "city"],
    [/\\bstate\\b|province|region|county/i, "state / province"],
    [/country/i, "country"],
    [/address.?(line)?.?2|apt|suite|unit/i, "address line 2 (apt, suite)"],
    [/address|street/i, "street address"],
    [/birth|\\bdob\\b|bday/i, "date of birth"],
    [/user.?name|login.?id/i, "username"],
    [/company|organi[sz]ation|employer/i, "company"],
    [/otp|one.?time|verification.?code|2fa|mfa/i, "one-time code"],
  ];
  const purposeOf = (el) => {
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/)
      .filter((t) => t && t !== "on" && t !== "off" && !t.startsWith("section-"));
    const scope = auto.find((t) => t === "shipping" || t === "billing");
    const token = auto.find((t) => PURPOSES[t]);
    if (token) return (scope ? scope + " " : "") + PURPOSES[token];
    const hint = (el.getAttribute("name") || "") + " " + (el.id || "");
    for (const [re, what] of GUESSES) if (re.test(hint)) return what;
    return "";
  };

  const rootOf = (el) => el.getRootNode ? el.getRootNode() : el.ownerDocument;
  const byIds = (el, ids) => {
    const root = rootOf(el);
    return clean(String(ids || "").split(/\\s+/).map((id) => {
      const n = (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id);
      return n ? textOf(n) : "";
    }).join(" "));
  };

  /* Text just before the element: the "First name" in
     <div><span>First name</span><input></div>, which is how a great many
     forms are labelled and which no attribute records. */
  const nearbyText = (el) => {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++) {
      let sib = node.previousElementSibling;
      for (let hops = 0; sib && hops < 3; hops++) {
        // Another field before this one: whatever is before that is its label.
        if (isField(sib) || sib.querySelector("input,select,textarea")) return "";
        if (!sib.matches(SELECTOR) || sib.tagName === "LABEL") {
          const t = textOf(sib);
          if (t && t.length <= 80) return t;
          if (t) return "";
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
      if (node && node.querySelectorAll("input,select,textarea").length > 1) break;
    }
    return "";
  };

  const isField = (el) => !!FIELD_TAGS[el.tagName];
  const named = (el) => {
    const label = el.getAttribute("aria-label");
    if (label && clean(label)) return clean(label);
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = byIds(el, by); if (t) return t; }
    if (el.labels && el.labels.length) {
      const t = clean(Array.from(el.labels).map(textOf).join(" "));
      if (t) return t;
    }
    const wrapping = el.closest("label");
    if (wrapping && textOf(wrapping)) return textOf(wrapping);
    if (isField(el) || el.isContentEditable) {
      const t = el.getAttribute("title") || nearbyText(el) || el.getAttribute("placeholder");
      if (t) return clean(t);
      const raw = el.getAttribute("name") || el.id || "";
      return clean(raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\\-\\[\\].]+/g, " "));
    }
    const img = el.querySelector && el.querySelector("img[alt]");
    return clean(textOf(el) || el.getAttribute("alt") || el.getAttribute("title")
      || (img && img.getAttribute("alt")) || el.value || "");
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "label") return "label";
    if (el.isContentEditable) return "textbox";
    if (tag !== "input") return "clickable";
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "range" || type === "file") return type === "range" ? "slider" : type;
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    if (type === "password") return "password";
    return "textbox";
  };

  /* The section a field belongs to: its fieldset's legend, a labelled group,
     or the nearest heading above it. "Name" under "Billing address" and
     "Name" under "Cardholder" are different fields. */
  // A legend names its own fieldset only, which closest() handles; in the
  // walk back it would name the neighbouring one.
  const HEADING = "h1,h2,h3,h4,h5,h6,[role=heading]";
  const sectionOf = (el) => {
    const set = el.closest("fieldset");
    if (set) { const legend = set.querySelector("legend"); if (legend && textOf(legend)) return short(textOf(legend), 60); }
    const group = el.closest("[role=group],[role=radiogroup]");
    if (group) {
      const t = group.getAttribute("aria-label") || byIds(group, group.getAttribute("aria-labelledby"));
      if (t) return short(t, 60);
    }
    let node = el;
    for (let steps = 0; node && steps < 60; steps++) {
      let prev = node.previousElementSibling;
      while (prev && steps < 60) {
        steps++;
        if (prev.matches(HEADING)) return short(textOf(prev), 60);
        const inner = prev.querySelectorAll(HEADING);
        if (inner.length) return short(textOf(inner[inner.length - 1]), 60);
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
      if (!node || node.tagName === "BODY" || node.tagName === "FORM" || node.tagName === "MAIN") break;
    }
    return "";
  };

  const dialogOf = (el) => {
    const d = el.closest("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]");
    if (!d) return null;
    return d;
  };
  const dialogName = (d) => short(d.getAttribute("aria-label")
    || byIds(d, d.getAttribute("aria-labelledby"))
    || (d.querySelector(HEADING) ? textOf(d.querySelector(HEADING)) : "") || "dialog", 60);

  const visible = (el, box) => {
    if (box.width < 2 || box.height < 2) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return !(style.visibility === "hidden" || style.display === "none" || style.opacity === "0");
  };

  /* Every candidate, in document order, through open shadow roots and into
     frames on this origin, with the offset of the frame each is in. */
  const found = [];
  const walk = (root, dx, dy, depth) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.closest("[data-autora]")) continue;
      found.push([el, dx, dy]);
      if (el.shadowRoot && depth < 8) walk(el.shadowRoot, dx, dy, depth + 1);
      if ((el.tagName === "IFRAME" || el.tagName === "FRAME") && depth < 4) {
        let doc = null;
        try { doc = el.contentDocument; } catch (e) {}
        if (doc && doc.documentElement) {
          const r = el.getBoundingClientRect();
          walk(doc, dx + r.left + el.clientLeft, dy + r.top + el.clientTop, depth + 1);
        }
      }
    }
  };
  walk(document, 0, 0, 0);

  /* A modal makes the rest of the page inert: listing what is behind it
     only invites clicks that land on nothing. */
  let modal = null;
  for (const d of document.querySelectorAll("dialog,[aria-modal=true]")) {
    const isModal = d.tagName === "DIALOG" ? d.matches(":modal") : true;
    if (!isModal) continue;
    const b = d.getBoundingClientRect();
    if (visible(d, b)) { modal = d; break; }
  }

  const refs = [];
  const elements = [];
  const taken = new Set();
  const within = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (taken.has(p)) return p; return null; };
  for (const [el, dx, dy] of found) {
    if (modal && el.ownerDocument === document && !modal.contains(el)) continue;
    let target = el;
    let matched = el.matches(SELECTOR);
    // A label is only worth listing when it stands in for a control that
    // has been hidden to be restyled -- the usual custom checkbox.
    if (matched && el.tagName === "LABEL") {
      const control = el.control;
      if (!control || !/^(checkbox|radio)$/i.test(control.type || "")) continue;
      const cbox = control.getBoundingClientRect();
      if (visible(control, cbox)) continue;
      target = control;
    }
    /* A div that is only clickable because a script says so still looks
       clickable to a person: a pointer cursor, a little text, and not inside
       something already listed. */
    if (!matched) {
      if (!el.parentElement || el.children.length > 6) continue;
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.cursor !== "pointer") continue;
      const parentStyle = el.ownerDocument.defaultView.getComputedStyle(el.parentElement);
      if (parentStyle.cursor === "pointer") continue;
      const t = textOf(el);
      if (!t || t.length > 80) continue;
      if (within(el)) continue;
      matched = true;
    }
    const box = el.getBoundingClientRect();
    if (!visible(el, box)) continue;
    // A span with tabindex inside a link is the link.
    const outer = within(el);
    if (outer && outer.tagName === "A" && !isField(el)) continue;
    const role = roleOf(target);
    const name = short(named(target) || named(el), 120);
    const field = isField(target) || role === "textbox" || role === "combobox" || role === "searchbox";
    if (!name && !field && role !== "password") continue;
    const ref = refs.length;
    const x = box.left + dx, y = box.top + dy;
    const inView = y + box.height > -40 && y < innerHeight + 40 && x + box.width > 0 && x < innerWidth;
    const type = target.tagName === "INPUT" ? (target.getAttribute("type") || "text").toLowerCase() : null;
    const info = {
      ref, role, name,
      value: null, x: Math.round(x + box.width / 2), y: Math.round(y + box.height / 2),
      w: Math.round(box.width), h: Math.round(box.height),
      href: el.tagName === "A" ? (el.getAttribute("href") || null) : null,
      checked: null, disabled: !!(target.disabled || target.getAttribute("aria-disabled") === "true"),
      inView,
    };
    if (target.tagName === "SELECT") {
      const opts = Array.from(target.options).map((o) => clean(o.text || o.value));
      const chosen = Array.from(target.selectedOptions || []).map((o) => clean(o.text || o.value));
      info.value = chosen.join(", ") || null;
      info.options = opts.filter(Boolean).slice(0, 15);
      info.optionCount = opts.filter(Boolean).length;
    } else if (typeof target.value === "string" && type !== "password" && role !== "button" && role !== "checkbox" && role !== "radio") {
      info.value = target.value.slice(0, 80) || null;
    } else if (target.isContentEditable || role === "textbox" || role === "combobox" || role === "searchbox") {
      info.value = short(textOf(target), 80) || null;
      if (info.value === name) info.value = null;
    }
    if (typeof target.checked === "boolean" && (type === "checkbox" || type === "radio")) info.checked = target.checked;
    else if (target.hasAttribute("aria-checked")) info.checked = target.getAttribute("aria-checked") === "true";
    else if (role === "switch" || role === "menuitemcheckbox") info.checked = target.getAttribute("aria-pressed") === "true";
    if (field || role === "checkbox" || role === "radio" || role === "password" || role === "switch") {
      if (type && !/^(text|checkbox|radio|submit|button|hidden|password)$/.test(type)) info.type = type;
      const purpose = purposeOf(target);
      if (purpose && purpose.toLowerCase() !== name.toLowerCase()) info.purpose = purpose;
      const ph = target.getAttribute("placeholder");
      if (ph && clean(ph) !== name && clean(ph) !== info.value) info.placeholder = short(ph, 60);
      if (target.required || target.getAttribute("aria-required") === "true") info.required = true;
      const max = Number(target.getAttribute("maxlength"));
      if (max > 0 && max <= 12) info.maxLength = max;
      if (type === "number" || type === "date" || type === "range") {
        const lo = target.getAttribute("min"), hi = target.getAttribute("max");
        if (lo || hi) info.range = (lo || "") + ".." + (hi || "");
      }
      const hint = byIds(target, target.getAttribute("aria-describedby"));
      const invalid = target.getAttribute("aria-invalid") === "true"
        || (target.validity && !target.validity.valid && (target.value || "") !== "");
      if (invalid) {
        info.invalid = short(byIds(target, target.getAttribute("aria-errormessage")) || hint
          || target.validationMessage || "the page marks this as invalid", 120);
      } else if (hint && hint !== name) {
        info.hint = short(hint, 100);
      }
      if (role === "radio" || role === "checkbox" || field) {
        const section = sectionOf(target);
        if (section && section !== name) info.section = section;
      }
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded === "true" || expanded === "false") info.expanded = expanded === "true";
    if (el.getAttribute("aria-selected") === "true" && role !== "option") info.selected = true;
    if (role === "option" && el.getAttribute("aria-selected") === "true") info.selected = true;
    if (el.getAttribute("aria-current") && el.getAttribute("aria-current") !== "false") info.current = true;
    const dialog = dialogOf(el);
    if (dialog) info.dialog = dialogName(dialog);
    refs.push(info);
    // The label, for a restyled checkbox: it is what is on screen to click.
    elements.push(el);
    taken.add(el);
  }
  window.__autoraRefs = elements;

  /* An open dialog sits on top of the page: whatever it asks comes first,
     and clicks behind it tend to land on it instead. */
  let dialog = null;
  for (const d of document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")) {
    const b = d.getBoundingClientRect();
    if (visible(d, b) && b.width > 100 && b.height > 60) { dialog = dialogName(d); break; }
  }

  /* Where the reader is on the page -- or in the pane that does the
     scrolling, on the many apps whose page itself never moves. */
  const scroller = (() => {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > innerHeight + 20) return doc;
    let best = null, area = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 150) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const b = el.getBoundingClientRect();
      const a = b.width * b.height;
      if (a > area) { area = a; best = el; }
    }
    return best || doc;
  })();
  const scroll = {
    y: Math.round(scroller.scrollTop),
    max: Math.max(0, Math.round(scroller.scrollHeight - scroller.clientHeight)),
    view: Math.round(scroller === (document.scrollingElement || document.documentElement) ? innerHeight : scroller.clientHeight),
    pane: scroller !== (document.scrollingElement || document.documentElement),
  };

  /* The main content rather than the whole body: a site's menus, header and
     footer are the same on every page and are most of the text on many. A
     <main> or <article> that holds a fair share of the page is taken as it
     is; otherwise the body with its navigation, header, footer and asides
     cut out -- unless that leaves almost nothing, when the body it is. */
  const body = document.body ? (document.body.innerText || "") : "";
  const MENU_WORDS = /(^|[\\s_-])(nav|navbar|navigation|menu|sidebar|breadcrumbs?|toc|lang|languages|footer|cookie|cookies|skip)([\\s_-]|$)/i;
  const menuish = (el, outside) =>
    el.tagName === "NAV" || el.tagName === "ASIDE" || el.tagName === "FOOTER" ||
    (outside && el.tagName === "HEADER") ||
    /^(navigation|banner|contentinfo|complementary|search)$/i.test(el.getAttribute("role") || "") ||
    MENU_WORDS.test((el.getAttribute("class") || "") + " " + (el.id || ""));
  /* The root's text with its menus, language lists, tables of contents and
     the like taken out -- each once, as its outermost element. */
  const withoutMenus = (root, outside) => {
    let text = root.innerText || "";
    const cut = new Set();
    for (const el of root.querySelectorAll("*")) {
      if (!menuish(el, outside)) continue;
      let up = el.parentElement, nested = false;
      while (up && up !== root) { if (cut.has(up)) { nested = true; break; } up = up.parentElement; }
      if (nested) continue;
      cut.add(el);
      const chunk = (el.innerText || "").trim();
      if (chunk) text = text.replace(chunk, "");
    }
    return text.trim().length >= 200 ? text : (root.innerText || "");
  };
  const mainText = (() => {
    if (!document.body) return "";
    const main = document.querySelector("main, [role=main]") || document.querySelector("article");
    const own = main ? (main.innerText || "") : "";
    if (main && own.trim().length >= Math.min(400, body.length * 0.3)) return withoutMenus(main, false);
    return withoutMenus(document.body, true);
  })();
  return {
    url: location.href,
    title: document.title,
    refs,
    dialog,
    scroll,
    text: mainText.replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, 150000),
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

/**
 * Clear a profile lock nobody is holding.
 *
 * Chrome marks a profile in use with `SingletonLock`, a symlink to
 * `<hostname>-<pid>`. A container that was restarted or recreated leaves that
 * behind with the old container's hostname, and Chrome then refuses the
 * profile outright ("in use by another Chromium process on another computer")
 * and exits. A browser left running by an earlier run of this server holds it
 * for real; that one is an orphan nobody can reach, so it is stopped. Either
 * way nothing else should be using this profile: it is Autora's.
 */
function clearStaleLock(dir: string) {
  const lock = path.join(dir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    return; // No lock, or not a symlink: nothing to clear.
  }
  const dash = target.lastIndexOf("-");
  const host = dash > 0 ? target.slice(0, dash) : "";
  const pid = Number(target.slice(dash + 1));
  if (host === os.hostname() && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // Gone already.
    }
    if (alive) {
      let ours = false;
      try {
        ours = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir);
      } catch {
        // No /proc (not Linux): leave a live process alone.
      }
      if (!ours) return;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited between the two calls.
      }
    }
  }
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // Chrome will say so if it still minds.
    }
  }
}

/**
 * The one Chrome every session shares.
 *
 * A persistent profile can be open in one browser at a time, so a browser per
 * session meant the second conversation to open a page found the profile
 * locked by the first and failed. Instead there is one browser on the profile
 * -- one set of sign-ins -- and each session gets a tab of its own in it. It
 * stays up while any session has a tab and closes, flushing the profile, when
 * the last one lets go.
 */
let shared: { context: BrowserContext; users: number } | null = null;
let launching: Promise<BrowserContext> | null = null;
/** Pages some session has taken, so the tab Chrome opens with is handed out
    once rather than to everyone. */
const claimed = new WeakSet<object>();

async function launchShared(): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  const executablePath = systemBrowser();
  const dir = profileDir();
  const launch = () =>
    chromium.launchPersistentContext(dir, {
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
  clearStaleLock(dir);
  let context: BrowserContext;
  try {
    context = await launch();
  } catch (err) {
    // Once more after clearing again: a browser that was still shutting down
    // a moment ago may have released the profile by now.
    await new Promise((resolve) => setTimeout(resolve, 500));
    clearStaleLock(dir);
    try {
      context = await launch();
    } catch {
      throw new Error(`The browser would not start: ${firstLine(err)}`);
    }
  }
  await restoreCookies(context);
  await context.addInitScript(STEALTH_SCRIPT);
  await context.addInitScript(CURSOR_SCRIPT);
  context.on("close", () => {
    if (shared?.context === context) shared = null;
  });
  return context;
}

/** Playwright's launch errors carry the whole command line and browser log;
    the first line is the part worth reading. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].trim();
}

async function acquireContext(): Promise<BrowserContext> {
  if (!shared) {
    if (!launching) {
      launching = launchShared()
        .then((context) => {
          shared = { context, users: 0 };
          return context;
        })
        .finally(() => {
          launching = null;
        });
    }
    await launching;
  }
  if (!shared) throw new Error("The browser closed while it was starting.");
  shared.users += 1;
  return shared.context;
}

async function releaseContext(context: BrowserContext) {
  if (!shared || shared.context !== context) return;
  shared.users -= 1;
  if (shared.users > 0) return;
  // The last tab is gone: closing the context is what stops Chrome and
  // flushes the profile to disk.
  shared = null;
  await saveCookies(context);
  await context.close().catch(() => undefined);
}

/**
 * Every sign-in the browser holds, kept beside the profile.
 *
 * The profile keeps cookies with an expiry date, but Chrome drops the ones
 * without -- "session" cookies, which is how a good many sites (and parts of
 * Google, LinkedIn and Microsoft sign-in) hold you signed in -- every time it
 * stops, and it stops whenever the last conversation lets go of it. It also
 * writes its cookie store to disk only now and then, so a container that is
 * stopped rather than shut down loses the last sign-in. Both meant being asked
 * to sign in again to something you had signed in to. So every cookie is
 * saved here after each page load and when the browser closes, and on the
 * next start any the profile has lost are put back. Only missing ones: a
 * cookie the profile still has is newer than this copy.
 */
function cookieFile(): string {
  return path.join(path.dirname(stateFilePath()), "browser-cookies.json");
}

async function saveCookies(context: BrowserContext) {
  try {
    const cookies = await context.cookies();
    const file = cookieFile();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cookies), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A browser mid-close, or a full disk: the profile still has most of it.
  }
}

async function restoreCookies(context: BrowserContext) {
  let saved: BrowserCookie[];
  try {
    const raw = JSON.parse(fs.readFileSync(cookieFile(), "utf8"));
    saved = Array.isArray(raw) ? raw : [];
  } catch {
    return;
  }
  const now = Date.now() / 1000;
  const key = (c: BrowserCookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`;
  const have = new Set(((await context.cookies().catch(() => [])) as BrowserCookie[]).map(key));
  const missing = saved.filter((c) =>
    c && typeof c.name === "string" && typeof c.domain === "string" &&
    (c.expires === -1 || c.expires > now) && !have.has(key(c)));
  if (missing.length === 0) return;
  try {
    await context.addCookies(missing);
  } catch {
    for (const cookie of missing) await context.addCookies([cookie]).catch(() => undefined);
  }
}

let cookieSave: NodeJS.Timeout | null = null;

/** Save the sign-ins a moment after a page loads: a sign-in ends in a page
    load, and a moment later its cookies are all set. */
function cookiesChanged() {
  if (cookieSave) return;
  cookieSave = setTimeout(() => {
    cookieSave = null;
    if (shared) void saveCookies(shared.context);
  }, 3000);
}

/** One page, one screencast, one session's worth of browsing. */
export class LiveBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private streaming = false;
  private lastFrameAt = 0;
  /** The newest frame that arrived too soon after the last one sent. It goes
      out when the interval is up, so the feed always ends on the page as it
      finally is rather than one step before it. */
  private pendingFrame: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Where the mouse is, so the next move starts from here rather than
      appearing out of nowhere. */
  private pointer: Point = {
    x: Math.round(VIEWPORT.width * (0.3 + Math.random() * 0.4)),
    y: Math.round(VIEWPORT.height * (0.3 + Math.random() * 0.4)),
  };
  private refs: Ref[] = [];
  private closing = false;
  /** A new tab's address being followed into this one. */
  private following: Promise<void> | null = null;
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
      fields: this.page ? this.fields : [],
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

    const context = await acquireContext();
    this.context = context;
    // Chrome opens with a tab already in it; the first session to arrive
    // takes that one rather than leaving an orphan about:blank behind.
    const idle = context.pages().find((p: Page) => !claimed.has(p));
    try {
      this.page = idle ?? (await context.newPage());
    } catch (err) {
      this.context = null;
      await releaseContext(context);
      throw err;
    }
    claimed.add(this.page);
    this.wire(this.page);
    await this.startStream();
    return this.page;
  }

  /** Windows a sign-in opened, the newest last, over the tab that opened
      them: when one closes the page under it is the one watched again. */
  private openers: Page[] = [];
  private wired = new WeakSet<object>();

  /** The listeners every page this session shows needs, once per page. */
  private wire(page: Page) {
    if (this.wired.has(page)) return;
    this.wired.add(page);

    page.on("popup", (popup: Page) => {
      claimed.add(popup);
      this.following = (async () => {
        /* A window the page keeps a hold of -- "Sign in with Google", a
           LinkedIn or Microsoft sign-in, a bank's 2FA -- has to stay open:
           it reports back to the page that opened it and then closes
           itself, and loading its address here instead leaves the sign-in
           with nobody to report to. So it is shown in place of this tab
           until it closes. A plain link to a new tab has no hold on this
           page and is followed here, the tab being watched. */
        const opener = await popup.opener().catch(() => null);
        if (opener && this.page === page && !popup.isClosed()) {
          await this.show(popup, page);
          await popup.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
          return;
        }
        await popup.waitForLoadState("commit").catch(() => undefined);
        const next = popup.url();
        await popup.close().catch(() => undefined);
        if (next && next !== "about:blank" && this.page === page) {
          await page.goto(next, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        }
      })().finally(() => { this.following = null; });
    });

    page.on("framenavigated", (frame: any) => {
      if (this.page !== page || frame !== page.mainFrame()) return;
      this.currentUrl = frame.url();
      void this.announceNav();
    });
    page.on("close", () => {
      const waiting = this.openers.indexOf(page);
      if (waiting >= 0) this.openers.splice(waiting, 1);
      if (this.page !== page || this.closing) return;
      // A sign-in window that closed itself, done: back to the page it
      // opened from, which now has the sign-in.
      const back = this.openers.pop();
      if (back && !back.isClosed()) {
        this.following = this.show(back, null).finally(() => { this.following = null; });
        return;
      }
      this.page = null;
      this.streaming = false;
      // The tab went on its own (Chrome crashed, or the page closed itself):
      // let go of the browser so it is not held open for nobody.
      const held = this.context;
      this.context = null;
      if (held) void releaseContext(held);
    });
  }

  /**
   * Make `next` the page this session shows and acts on: the screencast
   * moves to it, its elements are the ones numbered, and the person watching
   * sees it and can type into it. `from`, when given, is kept underneath to
   * come back to.
   */
  private async show(next: Page, from: Page | null) {
    if (from) this.openers.push(from);
    // Switched at once, so whatever reads the page next reads this one.
    const cdp = this.cdp;
    this.cdp = null;
    this.streaming = false;
    this.page = next;
    this.refs = [];
    this.wire(next);
    await cdp?.send("Page.stopScreencast").catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    await next.setViewportSize(VIEWPORT).catch(() => undefined);
    await next.bringToFront().catch(() => undefined);
    this.currentUrl = next.url();
    this.hooks.onAction(from ? "a sign-in window opened" : "the window closed; back to the page", null, this.currentUrl ?? "");
    await this.startStream().catch(() => undefined);
    await this.announceNav();
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
    cookiesChanged();
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
    const cdp = await this.context.newCDPSession(this.page);
    this.cdp = cdp;
    this.cdp.on("Page.screencastFrame", (frame: any) => {
      // Acknowledged on the session it came from: after a switch to a
      // sign-in window, a late frame of the old page is not the new one's.
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      if (this.hooks.watchers() === 0 || this.cdp !== cdp) return;
      this.forward(frame.data);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: LIVE_QUALITY,
      maxWidth: LIVE_WIDTH,
      maxHeight: Math.round((LIVE_WIDTH / VIEWPORT.width) * VIEWPORT.height),
      everyNthFrame: 1,
    });
    this.streaming = true;
  }

  /** Throttle with a trailing edge: a burst of frames is thinned to the
      frame rate, and the last one of the burst is always delivered. Dropping
      it left the feed parked on the page mid-change until something else
      happened to move. */
  private forward(data: string) {
    const wait = 1000 / LIVE_FPS - (Date.now() - this.lastFrameAt);
    if (wait <= 0) {
      this.lastFrameAt = Date.now();
      this.pendingFrame = null;
      this.hooks.onFrame(data);
      return;
    }
    this.pendingFrame = data;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const next = this.pendingFrame;
      if (next && this.hooks.watchers() > 0) this.forward(next);
    }, wait);
    this.flushTimer.unref?.();
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
    // This session's tab, and its hold on the shared browser. The browser
    // itself stops when the last session lets go.
    const context = this.context;
    const page = this.page;
    const cdp = this.cdp;
    this.page = null;
    this.context = null;
    this.cdp = null;
    this.streaming = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pendingFrame = null;
    this.announced = "";
    this.currentUrl = null;
    this.currentTitle = null;
    this.refs = [];
    this.fields = [];
    if (this.typed.timer) clearTimeout(this.typed.timer);
    this.typed = { chars: 0, keys: [], timer: null };
    const openers = this.openers;
    this.openers = [];
    await cdp?.detach().catch(() => undefined);
    await page?.close().catch(() => undefined);
    for (const under of openers) await under.close().catch(() => undefined);
    if (context) await releaseContext(context);
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
    await this.mapFields();
  }

  /** Last known typeable fields, for `status()`. */
  private fields: Array<[number, number, number, number]> = [];

  /** Find the fields you can type into, and tell the watchers if they moved.
      Taken alongside every kept frame, which is after every action. */
  private async mapFields() {
    if (!this.page || this.closing) return;
    // A string, because this file is compiled without the DOM's types.
    const found: Array<[number, number, number, number]> = await this.page
      .evaluate(`(() => {
        const skip = ["button", "submit", "reset", "checkbox", "radio", "range",
          "color", "file", "image", "hidden"];
        const out = [];
        const vw = window.innerWidth, vh = window.innerHeight;
        for (const el of document.querySelectorAll("input, textarea, [contenteditable], iframe")) {
          if (el.tagName === "INPUT" && skip.includes((el.type || "text").toLowerCase())) continue;
          if (el.hasAttribute("contenteditable") && !el.isContentEditable) continue;
          if (el.disabled || el.readOnly) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
          const style = getComputedStyle(el);
          if (style.visibility === "hidden" || style.display === "none") continue;
          out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
          if (out.length >= 400) break;
        }
        return out;
      })()`)
      .catch(() => null);
    if (!found) return;
    if (JSON.stringify(found) === JSON.stringify(this.fields)) return;
    this.fields = found;
    this.hooks.onFields();
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

      // Said before the pointer sets off, so the caption on the feed names
      // what it is heading for while you watch it travel there.
      this.hooks.onAction(
        `click [${ref}] ${target.role} "${target.name}"`.trim(),
        { x: target.x, y: target.y },
        this.currentUrl ?? "",
      );
      await this.humanClickAt(pointIn(await this.aim(target)));
      await this.settle(700);
      await this.arrive();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /**
   * Whatever a click or a key started, finished: a navigation (or the new
   * tab a link opened, which is followed in this one) given the moment it
   * needs to show its content, so the page read next is the page arrived at
   * rather than the one being left.
   */
  private async arrive() {
    const page = this.page;
    if (!page) return;
    if (this.following) await this.following.catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  }

  /**
   * Fill fields by number, then optionally submit. A form is one round trip
   * rather than one per field, which is the difference between an agent that
   * fills in a login and one that spends six turns on it.
   *
   * "Fill" means whatever setting that field takes: typing into a box,
   * choosing a dropdown's option by its text, ticking or clearing a checkbox,
   * setting a date. Each field is read back afterwards and what it now holds
   * is reported, so a phone box that reformatted the number, a dropdown with
   * no such choice or a field the page rejected is seen at once rather than
   * three steps later.
   */
  fill(values: { ref: number; text: string }[], submit = false): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const notes: string[] = [];
      let lastKind = "text";
      for (const { ref, text } of values) {
        const target = this.refs.find((r) => r.ref === ref);
        if (!target) throw new Error(`No field [${ref}] on this page. Read it again.`);
        const kind: string = await page.evaluate(`(() => {
          const el0 = (window.__autoraRefs || [])[${Number(ref)}];
          if (!el0 || !el0.isConnected) return "gone";
          const el = el0.tagName === "LABEL" && el0.control ? el0.control : el0;
          if (el.tagName === "SELECT") return "select";
          const role = (el.getAttribute("role") || "").toLowerCase();
          const type = el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : "";
          if (type === "checkbox" || role === "checkbox" || role === "switch" || role === "menuitemcheckbox") return "check";
          if (type === "radio" || role === "radio" || role === "menuitemradio") return "radio";
          if (type === "file") return "file";
          if (/^(date|time|month|week|datetime-local|color|range)$/.test(type)) return "native:" + type;
          return "text";
        })()`).catch(() => "gone");
        lastKind = kind;
        this.hooks.onAction(
          `fill [${ref}] "${target.name}"`,
          { x: target.x, y: target.y },
          this.currentUrl ?? "",
        );
        const label = `[${ref}]${target.name ? ` "${target.name}"` : ""}`;

        if (kind === "gone") {
          notes.push(`${label}: no longer on the page; read it again.`);
          continue;
        }
        if (kind === "file") {
          notes.push(`${label}: a file upload. Put a file in it with browser_upload and the file's artifact id.`);
          continue;
        }
        if (kind === "select") {
          const picked = await page.evaluate(SELECT_SCRIPT(ref, text)).catch(() => null);
          if (!picked?.ok) {
            const list = (picked?.options ?? []).slice(0, 30).map((o: string) => JSON.stringify(o)).join(", ");
            notes.push(`${label}: no option matches ${JSON.stringify(text)}. Its options: ${list || "(none)"}.`);
          } else {
            notes.push(`${label}: chose ${JSON.stringify(picked.chosen)}.`);
          }
          continue;
        }
        if (kind === "check" || kind === "radio") {
          const want = kind === "radio" || !/^(false|no|off|0|uncheck(ed)?|unticked?|clear(ed)?|unselect(ed)?|none)$/i.test(text.trim());
          const now = await this.checkedState(ref);
          if (now !== want) {
            await this.humanClickAt(pointIn(await this.aim(target)));
            await this.settle(200);
          }
          const after = await this.checkedState(ref);
          notes.push(`${label}: ${after === null ? "clicked" : after ? "checked" : "not checked"}${
            after !== null && after !== want ? " -- it did not take; look at the page" : ""}.`);
          continue;
        }
        if (kind.startsWith("native:")) {
          const value = normaliseNative(kind.slice(7), text);
          const held = await page.evaluate(SET_VALUE_SCRIPT(ref, value)).catch(() => null);
          notes.push(`${label}: ${held === value ? `set to ${JSON.stringify(value)}` : `wanted ${JSON.stringify(value)}, holds ${JSON.stringify(held ?? "")}`}.`);
          continue;
        }

        await this.humanClickAt(pointIn(await this.aim(target)));
        /* What is already in the field is selected so the typing replaces
           it -- selected by the field itself rather than with Ctrl+A, which
           on a click that did not land in the box selected the whole page. */
        await page.evaluate(SELECT_FIELD_SCRIPT(ref)).catch(() => undefined);
        // A person's typing rhythm for whoever is watching; nobody watching,
        // it is typed straight in.
        if (this.hooks.watchers() > 0) await humanType(page, text);
        else await page.keyboard.type(text);
        let held = await this.valueOf(ref);
        /* A field that swallowed the typing (a script that rebuilds it on
           focus, an input that ignores synthetic keys) gets its value set
           the way the page's own code would see it being set. */
        if (held !== null && !sameValue(held, text)) {
          const set = await page.evaluate(SET_VALUE_SCRIPT(ref, text)).catch(() => null);
          if (typeof set === "string") held = set;
        }
        if (target.role === "password" || held === null) notes.push(`${label}: filled.`);
        else if (sameValue(held, text)) notes.push(`${label}: holds ${JSON.stringify(held)}.`);
        else notes.push(`${label}: typed ${JSON.stringify(text)} but it holds ${JSON.stringify(held)} -- the page reformatted or rejected it.`);
      }
      if (submit) {
        /* Enter submits from a text box. From a dropdown or a checkbox it
           does not, so the form is asked to submit itself, the way its
           submit button would. */
        if (lastKind === "text") {
          await page.keyboard.press("Enter");
        } else {
          const last = values[values.length - 1];
          await page.evaluate(`(() => {
            const el0 = (window.__autoraRefs || [])[${Number(last?.ref)}];
            const el = el0 && el0.tagName === "LABEL" && el0.control ? el0.control : el0;
            const form = el && (el.form || el.closest("form"));
            if (form && form.requestSubmit) form.requestSubmit();
          })()`).catch(() => undefined);
        }
        this.hooks.onAction("submit", null, this.currentUrl ?? "");
        await this.settle(900);
        await this.arrive();
      } else {
        await this.settle();
      }
      const read = await this.read();
      read.notes = notes;
      await this.keyframe();
      return read;
    });
  }

  /**
   * Put files into a numbered upload field, the way choosing them in the
   * file picker would. The number can be the file input itself or the
   * button a site draws over a hidden one ("Upload CV", "Attach"): that is
   * clicked, and the file picker it opens is answered with the files
   * instead of being shown.
   */
  upload(ref: number, files: UploadFile[]): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const target = this.refs.find((r) => r.ref === ref);
      if (!target) throw new Error(`No element [${ref}] on this page. Read it again.`);
      const names = files.map((f) => f.name).join(", ");
      this.hooks.onAction(
        `upload ${names} to [${ref}] "${target.name}"`,
        { x: target.x, y: target.y },
        this.currentUrl ?? "",
      );
      const payload = files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer }));
      const notes: string[] = [];
      const handle = await page.evaluateHandle(`(() => {
        const el = ${REF_EL(ref)};
        if (!el || !el.isConnected) return null;
        const isFile = (n) => n && n.tagName === "INPUT" && (n.type || "").toLowerCase() === "file";
        if (isFile(el)) return el;
        // A label or wrapper around the input it stands for.
        const inner = el.querySelector && el.querySelector('input[type="file" i]');
        return isFile(inner) ? inner : null;
      })()`).catch(() => null);
      const input = handle?.asElement?.() ?? null;
      let done = false;
      if (input) {
        await input.setInputFiles(payload).then(() => { done = true; }).catch(() => undefined);
      }
      if (!done) {
        const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
        await this.humanClickAt(pointIn(await this.aim(target)));
        const picker = await chooser;
        if (!picker) {
          throw new Error(
            `Clicking [${ref}] did not open a file picker, so there was nothing to put the file in. ` +
            `Give the number of the upload field or the button that opens the picker.`,
          );
        }
        if (files.length > 1 && !picker.isMultiple()) {
          throw new Error(`[${ref}] takes one file; ${files.length} were given.`);
        }
        await picker.setFiles(payload);
      }
      notes.push(`[${ref}]${target.name ? ` "${target.name}"` : ""}: attached ${names}.`);
      await this.settle(900);
      await this.arrive();
      const read = await this.read();
      read.notes = notes;
      await this.keyframe();
      return read;
    });
  }

  private async checkedState(ref: number): Promise<boolean | null> {
    return (await this.page?.evaluate(`(() => {
      const el0 = (window.__autoraRefs || [])[${Number(ref)}];
      if (!el0) return null;
      const el = el0.tagName === "LABEL" && el0.control ? el0.control : el0;
      if (typeof el.checked === "boolean") return el.checked;
      const aria = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed");
      return aria === null ? null : aria === "true";
    })()`).catch(() => null)) ?? null;
  }

  private async valueOf(ref: number): Promise<string | null> {
    return (await this.page?.evaluate(`(() => {
      const el = (window.__autoraRefs || [])[${Number(ref)}];
      if (!el) return null;
      if (typeof el.value === "string") return el.value;
      if (el.isContentEditable) return el.innerText;
      return null;
    })()`).catch(() => null)) ?? null;
  }

  /**
   * Press a key, or a few, as a person would at the keyboard: Escape to
   * close a dialog, Tab to move on, the arrows to walk a suggestion list,
   * Enter to pick from it. With a field named, it is focused first.
   */
  press(keys: string[], ref: number | null = null): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      if (ref !== null) {
        const target = this.refs.find((r) => r.ref === ref);
        if (!target) throw new Error(`No element [${ref}] on this page. Read it again.`);
        await page.evaluate(`(() => {
          const el = (window.__autoraRefs || [])[${Number(ref)}];
          if (el && el.focus) el.focus();
        })()`).catch(() => undefined);
      }
      for (const key of keys) {
        /* Select-all with the focus outside any field highlights the whole
           page and does nothing useful, so it is not pressed there. */
        if (SELECT_ALL_KEY.test(key) && !(await page.evaluate(FOCUS_TYPEABLE_SCRIPT).catch(() => true))) {
          continue;
        }
        this.hooks.onAction(`press ${key}`, null, this.currentUrl ?? "");
        await page.keyboard.press(key);
        await page.waitForTimeout(120).catch(() => undefined);
      }
      await this.settle(400);
      await this.arrive();
      const read = await this.read();
      await this.keyframe();
      return read;
    });
  }

  /**
   * Scroll to where something is.
   *
   * By screens rather than pixels, in whichever part of the page actually
   * scrolls -- the page, or on the many apps whose page never moves, the pane
   * that does -- or inside an element named by number, or straight to some
   * text. What it reports is where that left the reader and whether it moved
   * at all, because an agent told only "scrolled" scrolls a page that is
   * already at the bottom forever.
   */
  scroll(how: ScrollRequest): Promise<PageRead> {
    return this.run(async () => {
      const page = await this.ensure();
      const notes: string[] = [];
      const moved = await page.evaluate(SCROLL_SCRIPT(how)).catch((err: unknown) => ({ error: String(err) }));
      const said = how.text
        ? `scroll to "${how.text}"`
        : how.to
          ? `scroll to ${how.to}`
          : `scroll ${(how.screens ?? how.dy ?? 1) < 0 ? "up" : "down"}`;
      this.hooks.onAction(said, null, this.currentUrl ?? "");
      if (moved?.error) {
        notes.push(`Could not scroll: ${moved.error}`);
      } else if (how.text) {
        notes.push(moved?.found
          ? `Found ${JSON.stringify(how.text)} and scrolled it to the middle of the screen: "${moved.found}".`
          : `${JSON.stringify(how.text)} is not in the page's text. It may be further down (not loaded yet), in a different wording, or not on this page.`);
      } else if (moved && moved.after === moved.before && moved.max !== undefined) {
        notes.push(moved.max <= 0
          ? "Nothing moved: there is nothing to scroll here."
          : moved.after <= 0
            ? "Nothing moved: already at the top."
            : "Nothing moved: already at the bottom.");
      }
      await this.settle(350);
      /* At the bottom of a feed, more is often loaded in as you arrive.
         Wait a moment for it and say so, or it looks like the end. */
      if (moved && moved.max !== undefined && moved.after >= moved.max - 2 && moved.max > 0) {
        await page.waitForTimeout(900).catch(() => undefined);
        const grown = await page.evaluate(SCROLL_SCRIPT({ screens: 0, ref: how.ref })).catch(() => null);
        if (grown && grown.max > moved.max + 50) notes.push("More content loaded in at the bottom; scroll down again to see it.");
      }
      const read = await this.read();
      read.notes = notes;
      await this.keyframe();
      return read;
    });
  }

  /**
   * Sign-ins brought over from the person's own browser (see ./cookies).
   * Into the shared profile, so every session is signed in from then on and
   * they survive a restart. Returns how many took; a cookie Chrome refuses
   * is skipped rather than taking the rest down with it.
   */
  importCookies(cookies: BrowserCookie[]): Promise<{ added: number; refused: number }> {
    return this.run(async () => {
      await this.ensure();
      const context = this.context;
      if (!context) throw new Error("The browser is not running.");
      try {
        await context.addCookies(cookies);
        await saveCookies(context);
        return { added: cookies.length, refused: 0 };
      } catch {
        let added = 0;
        for (const cookie of cookies) {
          try {
            await context.addCookies([cookie]);
            added += 1;
          } catch {
            // Malformed for Chrome: the rest still go in.
          }
        }
        await saveCookies(context);
        return { added, refused: cookies.length - added };
      }
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
      this.pointer = { x: clampedX, y: clampedY };
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

  /**
   * A click from the person's own hand, on the picture of the page.
   *
   * Lighter than the agent's click -- no page read, a short settle -- because
   * someone tapping through a sign-in feels every hundred milliseconds. Says
   * whether the tap landed in something you type into, so a phone knows
   * whether to keep its keyboard up.
   */
  userClick(
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
    double = false,
  ): Promise<{ editable: boolean }> {
    return this.run(async () => {
      const page = await this.ensure();
      const cx = Math.max(0, Math.min(VIEWPORT.width, Math.round(x)));
      const cy = Math.max(0, Math.min(VIEWPORT.height, Math.round(y)));
      this.pointer = { x: cx, y: cy };
      await this.showCursor(cx, cy, true);
      this.hooks.onAction(`you clicked at ${cx},${cy}`, { x: cx, y: cy }, this.currentUrl ?? "");
      if (double) await page.mouse.dblclick(cx, cy, { button });
      else await page.mouse.click(cx, cy, { button });
      await this.settle(150);
      // A string, because this file is compiled without the DOM's types.
      const editable: boolean = await page
        .evaluate(`(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return false;
          if (el.isContentEditable) return true;
          const tag = el.tagName;
          if (tag === "TEXTAREA" || tag === "IFRAME") return true;
          if (tag !== "INPUT") return false;
          const type = (el.type || "text").toLowerCase();
          return !["button", "submit", "reset", "checkbox", "radio", "range",
            "color", "file", "image", "hidden"].includes(type);
        })()`)
        .catch(() => false);
      await this.keyframe();
      return { editable };
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
      this.pointer = { x: clampedX, y: clampedY };
    });
  }

  /** Direct typing from user into focused element.

      No per-letter delay, no settle and no screenshot: the live feed already
      shows each letter land, and waiting on any of those held up the next
      keys behind it, which is what made typing into the page lag. The log
      gets one entry and one kept frame once the typing stops. */
  keyboardType(text: string): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      await page.keyboard.type(text);
      this.noteTyping(text.length, null);
    });
  }

  /** Direct keystroke from user (Enter, Tab, Escape, Backspace, etc.) */
  keyboardPress(key: string): Promise<void> {
    return this.run(async () => {
      const page = await this.ensure();
      await page.keyboard.press(key);
      this.noteTyping(0, key);
    });
  }

  /** What a run of typing adds up to, logged once it pauses. */
  private typed = { chars: 0, keys: [] as string[], timer: null as NodeJS.Timeout | null };

  private noteTyping(chars: number, key: string | null) {
    this.typed.chars += chars;
    if (key) this.typed.keys.push(key);
    if (this.typed.timer) clearTimeout(this.typed.timer);
    this.typed.timer = setTimeout(() => {
      const { chars: count, keys } = this.typed;
      this.typed = { chars: 0, keys: [], timer: null };
      const parts: string[] = [];
      if (count > 0) parts.push(`typed text (${count} chars)`);
      const named = [...new Set(keys)];
      if (named.length > 0) parts.push(`pressed ${named.join(", ")}`);
      if (parts.length === 0) return;
      void this.run(async () => {
        if (!this.page || this.closing) return;
        this.hooks.onAction(parts.join("; "), null, this.currentUrl ?? "");
        await this.keyframe();
      });
    }, TYPING_PAUSE_MS);
    this.typed.timer.unref?.();
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

  /**
   * Where an element is now, scrolled into view first if it is off screen.
   *
   * Elements keep their numbers wherever the page is scrolled, so the agent
   * can click one it saw several screens ago; the box recorded then is no
   * longer where it is. Falls back to that box if the element is gone.
   */
  private async aim(target: Ref): Promise<{ x: number; y: number; w: number; h: number }> {
    const page = this.page;
    const fresh = page && await page.evaluate(`(() => {
      const el = (window.__autoraRefs || [])[${Number(target.ref)}];
      if (!el || !el.isConnected) return null;
      // In a frame, its box is relative to the frame: add where each
      // enclosing frame sits, out to the page.
      const place = () => {
        const b = el.getBoundingClientRect();
        let x = b.left, y = b.top;
        for (let win = el.ownerDocument.defaultView; win && win.frameElement; win = win.parent) {
          const f = win.frameElement, fb = f.getBoundingClientRect();
          x += fb.left + f.clientLeft;
          y += fb.top + f.clientTop;
        }
        return { x, y, w: b.width, h: b.height };
      };
      let b = place();
      if (b.y < 0 || b.y + b.h > innerHeight || b.x < 0 || b.x + b.w > innerWidth) {
        el.scrollIntoView({ block: "center", inline: "center" });
        b = place();
      }
      return { ...b, moved: true };
    })()`).catch(() => null);
    if (!fresh || fresh.w < 1 || fresh.h < 1) return boxOf(target);
    return { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h };
  }

  /** Travel to a point the way a hand would and click there, with the ring
      played at the moment the button goes down. With nobody watching there
      is no one to show the journey to, so the click goes straight there --
      unless `always` asks for the hand regardless, as a CAPTCHA does. */
  private async humanClickAt(to: Point, always = false) {
    const page = this.page;
    if (!page) return;
    if (!always && this.hooks.watchers() === 0) {
      await page.mouse.click(to.x, to.y);
      this.pointer = to;
      return;
    }
    await this.showCursor(this.pointer.x, this.pointer.y, false);
    this.pointer = await humanClick(page, this.pointer, to, {
      before: () => this.showCursor(to.x, to.y, true),
    });
  }

  // --------------------------------------------------------------- captcha --

  /**
   * Checkbox CAPTCHAs on the page, found by the frames that carry them.
   *
   * reCAPTCHA, hCaptcha and Turnstile all put their checkbox in a cross-origin
   * iframe, which is exactly where the element scan cannot reach -- so without
   * this the agent was told about a page with nothing to click on it. The
   * frame's URL says which widget it is; its box says where to click.
   */
  private loadingCaptchas: CaptchaKind[] = [];

  private async findCaptchas(): Promise<CaptchaHit[]> {
    const page = this.page;
    if (!page) return [];
    const hits: CaptchaHit[] = [];
    let recaptchaChallenge = false;
    let hcaptchaChallenge = false;

    const visibleBox = async (frame: any) => {
      try {
        const el = await frame.frameElement();
        const box = await el.boundingBox();
        if (!box || box.width < 20 || box.height < 20) return null;
        return { el, box };
      } catch {
        return null;
      }
    };
    const boxIn = async (frame: any, selector: string) => {
      try {
        const handle = await frame.$(selector);
        const box = handle ? await handle.boundingBox() : null;
        const checked = handle ? await handle.getAttribute("aria-checked") : null;
        return { box, checked };
      } catch {
        return { box: null, checked: null };
      }
    };

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      let url: string = frame.url();
      // A widget frame that has not finished loading reports no URL yet, but
      // the iframe already carries the address it is loading.
      if (!url || url === "about:blank") {
        url = await frame
          .frameElement()
          .then((el: any) => el.getAttribute("src"))
          .catch(() => null) ?? "";
      }

      if (/\/recaptcha\/(api2|enterprise)\/bframe/.test(url)) {
        const shown = await visibleBox(frame);
        if (shown && shown.box.height > 150 && shown.box.y > -1000) recaptchaChallenge = true;
        continue;
      }
      if (/hcaptcha\.com/.test(url) && /frame=challenge/.test(url)) {
        const shown = await visibleBox(frame);
        if (shown && shown.box.height > 150 && shown.box.y > -1000) hcaptchaChallenge = true;
        continue;
      }

      let kind: CaptchaKind | null = null;
      let selector = "";
      if (/\/recaptcha\/(api2|enterprise)\/anchor/.test(url)) {
        kind = "recaptcha";
        selector = "#recaptcha-anchor";
      } else if (/hcaptcha\.com/.test(url) && /frame=checkbox/.test(url)) {
        kind = "hcaptcha";
        selector = "#checkbox";
      } else if (/challenges\.cloudflare\.com/.test(url)) {
        kind = "turnstile";
        selector = "input[type=checkbox]";
      }
      if (!kind) continue;

      const shown = await visibleBox(frame);
      if (!shown) continue;
      await shown.el.scrollIntoViewIfNeeded?.().catch(() => undefined);
      const frameBox = (await shown.el.boundingBox().catch(() => null)) ?? shown.box;
      const inner = await boxIn(frame, selector);

      // Turnstile keeps its checkbox in a closed shadow root that nothing can
      // query, so when the lookup comes back empty the box is where the widget
      // always draws it: a small square near the left, vertically centred.
      const box = inner.box
        ? { x: inner.box.x, y: inner.box.y, w: inner.box.width, h: inner.box.height }
        : kind === "turnstile"
          ? { x: frameBox.x + 18, y: frameBox.y + frameBox.height / 2 - 12, w: 24, h: 24 }
          : { x: frameBox.x + 12, y: frameBox.y + frameBox.height / 2 - 14, w: 28, h: 28 };

      hits.push({ kind, box, solved: inner.checked === "true", challenge: false });
    }

    // A response token in the page is the widget's own word that it passed,
    // and the only one Turnstile gives.
    const found: { tokens: Record<string, boolean>; markup: Record<string, boolean> } = await page
      .evaluate(`(() => {
        const has = (sel) => [...document.querySelectorAll(sel)].some((el) => (el.value || "").length > 20);
        const on = (sel) => !!document.querySelector(sel);
        return {
          tokens: {
            recaptcha: has('textarea[name="g-recaptcha-response"]'),
            hcaptcha: has('textarea[name="h-captcha-response"]'),
            turnstile: has('input[name="cf-turnstile-response"]'),
          },
          markup: {
            recaptcha: on('.g-recaptcha, iframe[src*="/recaptcha/api2/anchor"], iframe[src*="/recaptcha/enterprise/anchor"]'),
            hcaptcha: on('.h-captcha, iframe[src*="hcaptcha.com"]'),
            turnstile: on('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'),
          },
        };
      })()`)
      .catch(() => ({ tokens: {}, markup: {} }));
    const tokens = found.tokens;
    /** Widgets declared in the page whose frame has not drawn yet. */
    this.loadingCaptchas = (Object.keys(found.markup) as CaptchaKind[]).filter(
      (kind) => found.markup[kind] && !tokens[kind] && !hits.some((h) => h.kind === kind),
    );

    for (const hit of hits) {
      if (tokens[hit.kind]) hit.solved = true;
      if (hit.kind === "recaptcha" && recaptchaChallenge && !hit.solved) hit.challenge = true;
      if (hit.kind === "hcaptcha" && hcaptchaChallenge && !hit.solved) hit.challenge = true;
    }
    return hits;
  }

  /**
   * Tick the "I'm not a robot" box, like a person would.
   *
   * The pointer drifts a little first -- these widgets watch the mouse from
   * the moment the page loads, and one that has never moved before the click
   * is the giveaway -- then travels to the box on a curved, uneven path, lands
   * off-centre, pauses and clicks. After that the widget decides: it ticks,
   * it throws up a picture puzzle, or it thinks about it. Each is reported as
   * what it is, because a picture puzzle is the person's to solve.
   */
  /**
   * Whether the page carries a CAPTCHA, and whether every one on it has passed.
   *
   * Read-only and deliberately outside the action queue: it is what watches a
   * page the person is working in, so it must neither wait behind their clicks
   * nor move anything on the page.
   */
  async captchaStatus(): Promise<{ present: boolean; passed: boolean; url: string | null }> {
    const hits = await this.findCaptchas().catch(() => [] as CaptchaHit[]);
    const loading = this.loadingCaptchas.length > 0;
    let url: string | null = null;
    try { url = this.page?.url?.() ?? null; } catch { /* closing */ }
    return {
      present: hits.length > 0 || loading,
      passed: hits.length > 0 && !loading && hits.every((h) => h.solved),
      url,
    };
  }

  solveCaptcha(): Promise<CaptchaResult> {
    return this.run(async () => {
      const page = await this.ensure();
      let hits = await this.findCaptchas();
      // The widget script loads after the page does; give a declared one a
      // few seconds to draw its checkbox before concluding there is none.
      for (let waited = 0; waited < 12_000 && this.loadingCaptchas.length; waited += 500) {
        await page.waitForTimeout(500).catch(() => undefined);
        hits = await this.findCaptchas();
      }
      const target = hits.find((h) => !h.solved);
      if (!target) {
        const loading = this.loadingCaptchas[0] ?? null;
        const read = await this.read();
        return {
          outcome: loading ? "pending" : hits.length ? "solved" : "none",
          kind: loading ?? hits[0]?.kind ?? null,
          page: read,
        };
      }

      const aim = pointIn(target.box);
      this.hooks.onAction(`captcha: tick the ${labelOf(target.kind)} checkbox`, aim, this.currentUrl ?? "");
      await this.showCursor(this.pointer.x, this.pointer.y, false);
      this.pointer = await wander(page, this.pointer, VIEWPORT);
      await this.humanClickAt(aim, true);

      // Give the widget time to decide. It usually does within a couple of
      // seconds; Turnstile and a slow connection can take longer.
      let outcome: CaptchaResult["outcome"] = "pending";
      for (let waited = 0; waited < 15_000; waited += 500) {
        await page.waitForTimeout(500).catch(() => undefined);
        hits = await this.findCaptchas();
        const same = hits.find((h) => h.kind === target.kind) ?? null;
        if (!same || same.solved) { outcome = "solved"; break; }
        if (same.challenge) { outcome = "challenge"; break; }
      }

      // Rest the pointer somewhere nearby rather than leaving it parked on
      // the box -- people move off what they just clicked.
      this.pointer = await humanMove(page, this.pointer, {
        x: Math.min(VIEWPORT.width - 10, Math.max(10, this.pointer.x + Math.round((Math.random() - 0.3) * 200))),
        y: Math.min(VIEWPORT.height - 10, Math.max(10, this.pointer.y + Math.round((Math.random() - 0.5) * 120))),
      });
      this.hooks.onAction(`captcha: ${outcome}`, null, this.currentUrl ?? "");
      await this.settle(400);
      const read = await this.read();
      await this.keyframe();
      return { outcome, kind: target.kind, page: read };
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
    let page = this.page;
    if (!page) throw new Error("No page is open.");
    let scanned;
    try {
      scanned = await page.evaluate(SCAN_SCRIPT);
    } catch (err) {
      // A sign-in window that closed itself as it was being read: the page
      // under it is the one to read now.
      if (!page.isClosed()) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.following) await this.following.catch(() => undefined);
      if (!this.page || this.page === page) throw err;
      page = this.page;
      scanned = await page.evaluate(SCAN_SCRIPT);
    }
    this.refs = scanned.refs;
    this.currentUrl = scanned.url;
    this.currentTitle = scanned.title;
    const captchas = [
      ...(await this.findCaptchas().catch(() => [] as CaptchaHit[])).map(
        ({ kind, solved, challenge }) => ({ kind, solved, challenge }),
      ),
      ...this.loadingCaptchas.map((kind) => ({ kind, solved: false, challenge: false })),
    ];
    const blocked = signInRefusal(scanned.text);
    return {
      url: scanned.url,
      title: scanned.title,
      refs: scanned.refs,
      text: scanned.text,
      outline: outlineOf(scanned.refs, 80, { dialog: scanned.dialog, scroll: scanned.scroll }),
      captchas,
      dialog: scanned.dialog ?? null,
      scroll: scanned.scroll,
      blocked,
    };
  }
}

/** The element a numbered ref stands for, as page script: a label that
    stands in for a hidden checkbox resolves to the checkbox. */
const REF_EL = (ref: number) => `(() => {
  const el0 = (window.__autoraRefs || [])[${Number(ref)}];
  return el0 && el0.tagName === "LABEL" && el0.control ? el0.control : el0;
})()`;

/**
 * Choose a dropdown's option by what it says. Exact text first, then the
 * option's value, then one that starts with or contains what was asked --
 * "Canada" finds "Canada (CA)" -- and the change is announced the way a
 * person's choice would be, so the page's own code sees it.
 */
const SELECT_SCRIPT = (ref: number, wanted: string) => `(() => {
  const el = ${REF_EL(ref)};
  if (!el || el.tagName !== "SELECT") return { ok: false, options: [] };
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const want = norm(${JSON.stringify(wanted)});
  const opts = Array.from(el.options);
  const texts = opts.map((o) => (o.text || "").replace(/\\s+/g, " ").trim());
  const pick =
    opts.find((o, i) => norm(texts[i]) === want) ||
    opts.find((o) => norm(o.value) === want) ||
    opts.find((o, i) => want && norm(texts[i]).startsWith(want)) ||
    opts.find((o, i) => want && norm(texts[i]).includes(want)) ||
    opts.find((o, i) => want.length > 2 && norm(texts[i]).length > 1 && want.includes(norm(texts[i])));
  if (!pick) return { ok: false, options: texts.filter(Boolean) };
  const set = Object.getOwnPropertyDescriptor(el.ownerDocument.defaultView.HTMLSelectElement.prototype, "value").set;
  set.call(el, pick.value);
  pick.selected = true;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, chosen: (pick.text || pick.value).trim() };
})()`;

/**
 * Set a field's value through the setter the page's framework watches, then
 * announce it: what a date picker, a colour well or a field that ignores
 * typed keys needs, since there is nothing sensible to type into those.
 */
const SET_VALUE_SCRIPT = (ref: number, value: string) => `(() => {
  const el = ${REF_EL(ref)};
  if (!el) return null;
  const view = el.ownerDocument.defaultView;
  if (el.isContentEditable && typeof el.value !== "string") {
    el.focus();
    const sel = view.getSelection();
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    el.ownerDocument.execCommand("insertText", false, ${JSON.stringify(value)});
    return el.innerText;
  }
  const proto = el.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc || !desc.set) return null;
  desc.set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return el.value;
})()`;

/**
 * Select what a field holds, so what is typed next replaces it. The field
 * is the numbered element, or the box inside it the click put the caret in.
 * When neither is something that takes typing, whatever the click selected
 * is cleared and nothing is selected: select-all outside a field is the
 * whole page, highlighted, and that is what the person watching saw.
 */
const SELECT_FIELD_SCRIPT = (ref: number) => `(() => {
  const el0 = ${REF_EL(ref)};
  const doc = (el0 && el0.ownerDocument) || document;
  const view = doc.defaultView;
  const typeable = (el) => el && el.isConnected && !el.disabled && !el.readOnly &&
    ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") || el.isContentEditable);
  const active = doc.activeElement;
  const el = typeable(el0) ? el0 : typeable(active) ? active : null;
  const sel = view.getSelection();
  if (!el) {
    if (sel) sel.removeAllRanges();
    return false;
  }
  if (doc.activeElement !== el) el.focus();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    try { el.select(); } catch (e) {}
    return true;
  }
  const range = doc.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`;

/** Keys that select everything wherever the focus is. */
const SELECT_ALL_KEY = /^(control|meta|controlormeta)\+a$/i;

/** Whether the focus is somewhere typing goes, as page script. */
const FOCUS_TYPEABLE_SCRIPT = `(() => {
  let el = document.activeElement;
  while (el && el.tagName === "IFRAME") {
    try { el = el.contentDocument && el.contentDocument.activeElement; } catch (e) { return true; }
  }
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
})()`;

/** Scroll as asked and say where that left things; see LiveBrowser.scroll. */
const SCROLL_SCRIPT = (how: ScrollRequest) => `((o) => {
  const doc = document.scrollingElement || document.documentElement;
  const scrollable = (el) => {
    if (!el || el === doc) return false;
    if (el.scrollHeight <= el.clientHeight + 20) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  };
  const pane = () => {
    if (doc.scrollHeight > innerHeight + 20) return doc;
    let best = null, area = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (el.clientHeight < 150 || !scrollable(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.bottom < 0 || b.top > innerHeight) continue;
      if (b.width * b.height > area) { area = b.width * b.height; best = el; }
    }
    return best || doc;
  };
  if (o.text) {
    const want = o.text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let first = null, below = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue || "";
      if (!t.toLowerCase().includes(want)) continue;
      const el = n.parentElement;
      if (!el || el.closest("[data-autora]")) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (!first) first = el;
      // The next one further down, so asking again moves on.
      if (b.top > innerHeight * 0.55) { below = el; break; }
    }
    const hit = below || first;
    if (!hit) return { found: null };
    hit.scrollIntoView({ block: "center", inline: "nearest" });
    const text = (hit.innerText || hit.textContent || "").replace(/\\s+/g, " ").trim();
    return { found: text.length > 160 ? text.slice(0, 159) + "\\u2026" : text };
  }
  let target = pane();
  if (o.ref !== null && o.ref !== undefined) {
    const el0 = (window.__autoraRefs || [])[o.ref];
    if (!el0 || !el0.isConnected) return { error: "there is no element [" + o.ref + "] now; read the page again" };
    let up = el0;
    while (up && up !== document.body && !scrollable(up)) up = up.parentElement;
    if (up && up !== document.body && scrollable(up)) target = up;
    else if (!o.to && !o.screens && !o.dy) {
      el0.scrollIntoView({ block: "center", inline: "nearest" });
      return { into: true };
    }
  }
  const view = target === doc ? innerHeight : target.clientHeight;
  const max = Math.max(0, target.scrollHeight - (target === doc ? innerHeight : target.clientHeight));
  const before = Math.round(target.scrollTop);
  if (o.to === "top") target.scrollTop = 0;
  else if (o.to === "bottom") target.scrollTop = target.scrollHeight;
  else if (o.dy) target.scrollTop = before + o.dy;
  else if (o.screens) target.scrollTop = before + Math.round(o.screens * view * 0.85);
  return { before, after: Math.round(target.scrollTop), max, view };
})(${JSON.stringify(how)})`;

/** A date typed as a person would say it, as the value a date field holds. */
export function normaliseNative(type: string, text: string): string {
  const t = text.trim();
  if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }
  return t;
}

/** Whether a field holds what was typed, allowing for the reformatting a
    phone, card or date box does to it: "(555) 123-4567" is "5551234567". */
export function sameValue(held: string, typed: string): boolean {
  const loose = (s: string) => s.toLowerCase().replace(/[\s\-().\/+,]/g, "");
  if (held === typed || loose(held) === loose(typed)) return true;
  const digits = (s: string) => s.replace(/\D/g, "");
  return digits(typed).length >= 4 && digits(held) === digits(typed) && !/[a-z]/i.test(typed);
}

/**
 * The site turning a sign-in away because of the browser it is in, found by
 * what those pages say. Each of these means the same thing -- trying again
 * here will not work -- and the agent needs to know that rather than retype
 * the password until the account is locked.
 */
const REFUSALS: RegExp[] = [
  /this browser or app may not be secure[^\n]*/i,
  /couldn[’']t sign you in[^\n]*/i,
  /try using a different browser[^\n]*/i,
  /our systems have detected unusual traffic[^\n]*/i,
  /(?:your )?browser is not supported[^\n]*/i,
  /we (?:couldn[’']t|could not) verify (?:that )?you(?:['’]re| are) (?:a )?(?:human|not a robot)[^\n]*/i,
  /access to this page has been denied[^\n]*/i,
  /automated (?:access|queries|requests) (?:is|are) not allowed[^\n]*/i,
];

export function signInRefusal(text: string): string | null {
  for (const re of REFUSALS) {
    const hit = re.exec(text);
    if (hit) return hit[0].trim().slice(0, 200);
  }
  return null;
}

/** A ref's box, from the centre and size the scan recorded. */
function boxOf(r: Ref) {
  return { x: r.x - r.w / 2, y: r.y - r.h / 2, w: r.w, h: r.h };
}

function labelOf(kind: CaptchaKind): string {
  return kind === "recaptcha" ? "reCAPTCHA" : kind === "hcaptcha" ? "hCaptcha" : "Cloudflare Turnstile";
}

/** The CAPTCHA line for the model, or nothing when there is none. */
export function describeCaptchas(captchas: PageRead["captchas"]): string {
  if (!captchas.length) return "";
  return captchas
    .map((c) =>
      c.solved
        ? `CAPTCHA: ${labelOf(c.kind)} is passed.`
        : c.challenge
          ? `CAPTCHA: ${labelOf(c.kind)} is showing a picture challenge. Hand the browser to the person (browser_handoff).`
          : `CAPTCHA: ${labelOf(c.kind)} checkbox is on the page and not ticked. It is not in the numbered list; call browser_captcha to tick it.`,
    )
    .join("\n");
}

const FIELD_ROLES = new Set([
  "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "password", "spinbutton",
]);

/** One element, as the model reads it. */
export function refLine(r: Ref): string {
  const bits = [`[${r.ref}]`, r.role];
  if (r.name) bits.push(JSON.stringify(r.name));
  if (r.purpose) bits.push(`(${r.purpose})`);
  if (r.type) bits.push(`type=${r.type}`);
  if (r.value) bits.push(`value=${JSON.stringify(r.value)}`);
  else if (r.placeholder) bits.push(`placeholder=${JSON.stringify(r.placeholder)}`);
  if (r.options?.length) {
    const more = (r.optionCount ?? r.options.length) - r.options.length;
    bits.push(`options: ${r.options.map((o) => JSON.stringify(o)).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  if (r.maxLength) bits.push(`max ${r.maxLength} chars`);
  if (r.range) bits.push(`range ${r.range}`);
  if (r.checked === true) bits.push("checked");
  else if (r.checked === false) bits.push("not checked");
  if (r.expanded === true) bits.push("expanded");
  else if (r.expanded === false) bits.push("collapsed");
  if (r.selected) bits.push("selected");
  if (r.current) bits.push("current");
  if (r.required) bits.push("required");
  if (r.disabled) bits.push("disabled");
  if (r.invalid) bits.push(`INVALID: ${JSON.stringify(r.invalid)}`);
  else if (r.hint) bits.push(`hint: ${JSON.stringify(r.hint)}`);
  if (r.href) bits.push(`-> ${r.href}`);
  return bits.join(" ");
}

/** Where the reader is, in words: how far down, and how much is left. */
export function scrollLine(s: ScrollState): string {
  const where = s.pane ? "The scrolling pane" : "The page";
  if (s.max <= 0) return `${where} fits on one screen; there is nothing to scroll.`;
  const screensBelow = (s.max - s.y) / Math.max(1, s.view);
  const pct = Math.round((s.y / s.max) * 100);
  const pos = s.y <= 2 ? "at the top" : s.y >= s.max - 2 ? "at the bottom" : `${pct}% of the way down`;
  const left = s.y >= s.max - 2
    ? "nothing more below"
    : `about ${screensBelow < 1 ? "less than one screen" : `${Math.round(screensBelow * 10) / 10} screens`} more below`;
  return `${where} is ${pos}, ${left}.`;
}

/**
 * The numbered outline, as a screen reader would read it.
 *
 * Capped, because a search results page has four hundred links and the first
 * forty are the ones anybody acts on; the count is printed so the model knows
 * it is looking at the top of a list rather than all of it.
 */
export function outlineOf(
  refs: Ref[],
  limit = 80,
  around: { dialog?: string | null; scroll?: ScrollState } = {},
): string {
  // What is on screen, by the numbers every element keeps wherever the page
  // is scrolled. A read made before this was tracked shows everything.
  const shown = refs.some((r) => r.inView !== undefined) ? refs.filter((r) => r.inView) : refs;
  const firstShown = shown[0]?.ref ?? Infinity;
  const lastShown = shown[shown.length - 1]?.ref ?? -Infinity;
  const above = refs.filter((r) => !r.inView && r.ref < firstShown).length;
  const below = refs.filter((r) => !r.inView && r.ref > lastShown).length;
  const lines: string[] = [];
  if (around.dialog) {
    lines.push(
      `A dialog is open on top of the page: "${around.dialog}". Deal with it first ` +
        "(answer it, or close it with its button or Escape); what is behind it may not respond " +
        "and, while it blocks the page, is not listed.",
    );
  }
  /* Fields under a heading are introduced by it once, rather than each
     carrying it: "Shipping address" then the six fields in it. */
  let section = "";
  for (const r of shown.slice(0, limit)) {
    const under = r.dialog ? `in dialog "${r.dialog}"${r.section ? ` / ${r.section}` : ""}` : r.section ?? "";
    if (under && under !== section) lines.push(`-- ${under} --`);
    // A field outside the section closes it, so it is not read as part of it.
    else if (!under && section && FIELD_ROLES.has(r.role)) lines.push("-- (end of section) --");
    if (under || FIELD_ROLES.has(r.role)) section = under;
    lines.push(refLine(r));
  }
  if (shown.length > limit) {
    lines.push(`… ${shown.length - limit} more on screen after these.`);
  }
  if (above > 0 || below > 0) {
    lines.push(
      `(${above} more above and ${below} more below, off screen. Scroll to list them; ` +
        "every element keeps its number wherever the page is scrolled, and clicking " +
        "one you saw earlier scrolls it into view first.)",
    );
  }
  if (around.scroll) lines.push(scrollLine(around.scroll));
  return lines.join("\n");
}
