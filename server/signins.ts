/**
 * The sites the browser has been signed in to, remembered across
 * conversations and restarts.
 *
 * The sign-in itself lives in the browser profile (see ./browser.ts, which
 * also keeps the cookies Chrome would drop). This is the agent's side of it:
 * a note of where it is signed in, put in front of it at the start of every
 * conversation, so that it opens the site and carries on instead of asking
 * the person to sign in to something they already signed in to.
 */

import fs from "node:fs";
import path from "node:path";
import { stateFilePath } from "./state";

export interface SignIn {
  /** "linkedin.com", not the page's full address. */
  site: string;
  /** Milliseconds since the epoch, of the latest sign-in. */
  ts: number;
  how: "handoff" | "import";
}

const file = () => path.join(path.dirname(stateFilePath()), "browser-signins.json");

let cache: SignIn[] | null = null;

function load(): SignIn[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    cache = Array.isArray(raw) ? raw.filter((s) => s && typeof s.site === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** "accounts.google.com" -> "google.com", "www.bbc.co.uk" -> "bbc.co.uk". */
export function siteOf(urlOrHost: string): string | null {
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (/^[a-z][a-z0-9+.-]*:/.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^\./, "");
  if (!host || !host.includes(".") || /^[\d.]+$/.test(host)) return null;
  const parts = host.split(".");
  const keep = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export function recordSignIn(urlOrHost: string, how: SignIn["how"], now = Date.now()) {
  const site = siteOf(urlOrHost);
  if (!site) return;
  const list = load().filter((s) => s.site !== site);
  list.push({ site, ts: now, how });
  cache = list;
  try {
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    // The sign-in itself is in the browser; only the note is lost.
  }
}

/** Newest first. */
export function signIns(): SignIn[] {
  return [...load()].sort((a, b) => b.ts - a.ts);
}

/** For the briefing: what to do about sign-ins, and where it already is. */
export function signInBriefing(): string {
  const list = signIns().slice(0, 40);
  const lines = [
    "  - The browser remembers every sign-in, across conversations and restarts. Never ask the " +
      "person to sign in to a site before opening it and seeing that it really asks for a sign-in; " +
      "a site signed in to before usually still is. Hand over only when the page in front of you " +
      "wants a password, a code or an approval.",
  ];
  if (list.length > 0) {
    lines.push(
      `  - Signed in before: ${list.map((s) => `${s.site} (${new Date(s.ts).toISOString().slice(0, 10)})`).join(", ")}.`,
    );
  }
  return lines.join("\n");
}
