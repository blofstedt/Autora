/**
 * Bringing a sign-in over from the person's own browser.
 *
 * Some sites will not let a server's browser sign in at all: Google's "This
 * browser or app may not be secure", a bank's "browser not supported". Typing
 * the password again changes nothing, and handing the page to the person
 * does not help either, because the site is refusing the browser rather than
 * the person. What does work is signing in where the site is happy -- the
 * person's own browser -- and bringing the result across: the cookies that
 * say "signed in". The person exports them for that site with a cookie
 * extension, uploads the file, and the agent's browser is signed in too.
 *
 * Three shapes are read, which between them cover what the usual tools write:
 *  - a JSON array of cookies (Cookie-Editor, EditThisCookie, most extensions);
 *  - a Playwright/Puppeteer storage state, `{ "cookies": [...] }`;
 *  - the Netscape cookies.txt format (curl, wget, "Get cookies.txt").
 */

/** A cookie in the shape Playwright's `addCookies` takes. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 for a cookie that lasts the session. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface ParsedCookies {
  cookies: BrowserCookie[];
  /** Entries that could not be used, and why, for the one-line report. */
  skipped: number;
  /** Already expired, so left out rather than imported dead. */
  expired: number;
}

const sameSiteOf = (raw: unknown, secure: boolean): BrowserCookie["sameSite"] => {
  const s = String(raw ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  // Chrome rejects SameSite=None without Secure; Lax is what it would treat
  // such a cookie as anyway.
  if ((s === "none" || s === "no_restriction") && secure) return "None";
  return "Lax";
};

function fromJson(entry: any, now: number): BrowserCookie | "skip" | "expired" {
  if (!entry || typeof entry !== "object") return "skip";
  const name = typeof entry.name === "string" ? entry.name : null;
  const value = entry.value === undefined || entry.value === null ? null : String(entry.value);
  let domain = typeof entry.domain === "string" ? entry.domain.trim() : "";
  if (!domain && typeof entry.url === "string") {
    try {
      domain = new URL(entry.url).hostname;
    } catch {
      // Unusable without one or the other.
    }
  }
  if (!name || value === null || !domain) return "skip";
  const secure = Boolean(entry.secure);
  const rawExpiry = entry.expirationDate ?? entry.expires ?? entry.expiry;
  const session = entry.session === true || rawExpiry === undefined || rawExpiry === null || Number(rawExpiry) <= 0;
  const expires = session ? -1 : Math.floor(Number(rawExpiry));
  if (!session && (!Number.isFinite(expires))) return "skip";
  if (!session && expires < now) return "expired";
  return {
    name,
    value,
    // A cookie for "example.com" with hostOnly false is sent to its
    // subdomains too, which Playwright spells with a leading dot.
    domain: entry.hostOnly === false && !domain.startsWith(".") ? `.${domain}` : domain,
    path: typeof entry.path === "string" && entry.path ? entry.path : "/",
    expires,
    httpOnly: Boolean(entry.httpOnly),
    secure,
    sameSite: sameSiteOf(entry.sameSite, secure),
  };
}

function fromNetscape(text: string, now: number): ParsedCookies {
  const out: ParsedCookies = { cookies: [], skipped: 0, expired: 0 };
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }
    const cols = line.split("\t");
    if (cols.length < 7) {
      out.skipped += 1;
      continue;
    }
    const [domain, , path, secureFlag, expiry, name, ...rest] = cols;
    const secure = secureFlag.toUpperCase() === "TRUE";
    const seconds = Number(expiry);
    const expires = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : -1;
    if (expires > 0 && expires < now) {
      out.expired += 1;
      continue;
    }
    if (!domain || !name) {
      out.skipped += 1;
      continue;
    }
    out.cookies.push({
      name, value: rest.join("\t"), domain, path: path || "/", expires,
      httpOnly, secure, sameSite: "Lax",
    });
  }
  return out;
}

/**
 * The cookies in an export file, whichever of the three shapes it is in.
 * Throws with something to tell the person when it is none of them.
 */
export function parseCookieExport(text: string, now = Math.floor(Date.now() / 1000)): ParsedCookies {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new Error("The file is empty.");
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: any;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error("The file looks like JSON but does not parse.");
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null;
    if (!list) throw new Error("The JSON has no list of cookies in it.");
    const out: ParsedCookies = { cookies: [], skipped: 0, expired: 0 };
    for (const entry of list) {
      const cookie = fromJson(entry, now);
      if (cookie === "skip") out.skipped += 1;
      else if (cookie === "expired") out.expired += 1;
      else out.cookies.push(cookie);
    }
    return out;
  }
  if (/^(#|[^\s]+\t(TRUE|FALSE)\t)/im.test(trimmed)) return fromNetscape(trimmed, now);
  throw new Error(
    "That is not a cookie export this understands: a JSON list of cookies " +
      "(Cookie-Editor's \"Export as JSON\"), a storage state, or a cookies.txt file.",
  );
}

/** The sites a set of cookies signs in to, for saying so: "google.com, github.com". */
export function sitesOf(cookies: BrowserCookie[]): string[] {
  const sites = new Set<string>();
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "").toLowerCase();
    const parts = host.split(".");
    // "bbc.co.uk" rather than "co.uk".
    const keep = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
    sites.add(parts.slice(-keep).join("."));
  }
  return [...sites].sort();
}
