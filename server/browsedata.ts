/**
 * What the browser remembers for the person using it: pages they visited,
 * pages they bookmarked, files it downloaded. One list for the install, like
 * the profile it sits beside -- the browser is shared by every chat.
 *
 * Files themselves are artifacts (see ./artifacts.ts); this keeps only the
 * address they came from and which artifact they became.
 */

import fs from "node:fs";
import path from "node:path";
import { stateFilePath } from "./state";

interface HistoryItem { url: string; title: string; ts: number }
interface Bookmark { url: string; title: string; ts: number }
interface DownloadItem { artifact: string; name: string; url: string; size: number; ts: number }

interface Data { history: HistoryItem[]; bookmarks: Bookmark[]; downloads: DownloadItem[] }

const MAX_HISTORY = 500;
const MAX_DOWNLOADS = 50;

const file = () => path.join(path.dirname(stateFilePath()), "browser-data.json");

let cache: Data | null = null;
let timer: NodeJS.Timeout | null = null;

function load(): Data {
  if (cache) return cache;
  cache = { history: [], bookmarks: [], downloads: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    for (const key of ["history", "bookmarks", "downloads"] as const) {
      if (Array.isArray(raw?.[key])) (cache[key] as unknown[]) = raw[key];
    }
  } catch {
    // None yet.
  }
  return cache;
}

function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(load()), { mode: 0o600 });
    } catch {
      // Not being able to remember is not worth a failure.
    }
  }, 500);
  timer.unref?.();
}

/** Write what is pending now (tests, shutdown). */
export function flushBrowseData() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load()), { mode: 0o600 });
  } catch { /* see persist */ }
}

/** Only pages a person would recognise as visited: not a blank tab, not an
    internal address. */
const visitable = (url: string) => /^https?:\/\//i.test(url);

export function recordVisit(url: string, title: string, now = Date.now()) {
  if (!visitable(url)) return;
  const { history } = load();
  const last = history[history.length - 1];
  if (last && last.url === url) {
    if (title) last.title = title;
    last.ts = now;
  } else {
    history.push({ url, title, ts: now });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  }
  persist();
}

export function history(query = ""): HistoryItem[] {
  const q = query.trim().toLowerCase();
  const all = load().history;
  return (q ? all.filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)) : all).slice().reverse();
}

export function clearHistory() {
  load().history = [];
  persist();
}

export function bookmarks(): Bookmark[] {
  return load().bookmarks.slice();
}

export function isBookmarked(url: string): boolean {
  return load().bookmarks.some((b) => b.url === url);
}

export function addBookmark(url: string, title: string, now = Date.now()): Bookmark | null {
  if (!visitable(url)) return null;
  const data = load();
  const existing = data.bookmarks.find((b) => b.url === url);
  if (existing) return existing;
  const mark = { url, title: title || url, ts: now };
  data.bookmarks.push(mark);
  persist();
  return mark;
}

export function removeBookmark(url: string) {
  const data = load();
  data.bookmarks = data.bookmarks.filter((b) => b.url !== url);
  persist();
}

export function recordDownload(item: DownloadItem) {
  const data = load();
  data.downloads.push(item);
  if (data.downloads.length > MAX_DOWNLOADS) data.downloads.splice(0, data.downloads.length - MAX_DOWNLOADS);
  persist();
}

export function downloads(): DownloadItem[] {
  return load().downloads.slice().reverse();
}

/** For tests: forget the cache so another AUTORA_HOME is read. */
export function resetBrowseData() {
  cache = null;
  if (timer) { clearTimeout(timer); timer = null; }
}
