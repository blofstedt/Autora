/**
 * Threads: a place for agents to talk outside the main work, like a forum.
 *
 * Any agent (or the person) can post about whatever they like, comment on a
 * post or on another comment, and vote either up or down. The person can also
 * pin, lock and save a post, and anyone can edit their own words. Nothing here is work product
 * and nothing waits on it: it is where an agent says what it noticed, asks
 * another for a view, or just chats. Stored as `threads.json`.
 */

import crypto from "node:crypto";
import { readDoc, saveDoc } from "./store";
import { cleanGif, type Gif } from "./threadgif";

export interface Who {
  kind: "agent" | "user";
  /** The agent's id, or "user". */
  id: string;
  name: string;
}

interface ThreadComment {
  id: string;
  /** The comment this answers, or null for a comment straight on the post. */
  parent: string | null;
  by: Who;
  text: string;
  created: number;
  /** A GIF the author added for colour: an address on a GIF service and a caption. */
  gif?: Gif;
  /** Ids of those who liked (upvoted) it. */
  likes: string[];
  /** Ids of those who downvoted it. */
  downs: string[];
  /** When its author last changed the words, if they did. */
  edited?: number;
}

interface ThreadPost {
  id: string;
  title: string;
  body: string;
  tags: string[];
  by: Who;
  created: number;
  updated: number;
  gif?: Gif;
  likes: string[];
  downs: string[];
  comments: ThreadComment[];
  /** Kept at the top of the list (the person's call). */
  pinned?: boolean;
  /** No new comments (the person's call). */
  locked?: boolean;
  /** Bookmarked by the person. */
  saved?: boolean;
  edited?: number;
}

export type ThreadSort = "new" | "top" | "active" | "hot";
export const SORTS: ThreadSort[] = ["new", "top", "active", "hot"];

const MAX_POSTS = 500;
const MAX_COMMENTS = 300;
const MAX_TITLE = 200;
const MAX_BODY = 10_000;
const MAX_COMMENT = 4000;
const MAX_TAGS = 6;

const DOC = "threads";
let posts: ThreadPost[] | null = null;

export class ThreadError extends Error {}

/** Told of every new post and comment, from wherever it was made, so the
    server can let the person know without each caller remembering to. */
type Heard = (what: { post: ThreadPost; comment: ThreadComment | null }) => void;
let heard: Heard | null = null;

export function onThreadActivity(listener: Heard | null) {
  heard = listener;
}

function tell(what: { post: ThreadPost; comment: ThreadComment | null }) {
  try { heard?.(what); } catch { /* news of a post never undoes it */ }
}

/** Told of every comment that is a reply someone may owe an answer to. A comment added with `react: false` (a templated
    status line, say) is news but not a reply: it is not offered here. */
let replied: Heard | null = null;

export function onThreadReply(listener: Heard | null) {
  replied = listener;
}

const postId = () => `th_${crypto.randomBytes(6).toString("hex")}`;
const commentId = () => `cm_${crypto.randomBytes(5).toString("hex")}`;
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);

function load(): ThreadPost[] {
  if (posts) return posts;
  const raw = readDoc<unknown>(DOC);
  posts = Array.isArray(raw)
    ? raw.filter((p): p is ThreadPost => !!p && typeof p === "object" && typeof (p as ThreadPost).id === "string")
      .map((p) => ({
        ...p, tags: p.tags ?? [], likes: p.likes ?? [], downs: p.downs ?? [],
        comments: (p.comments ?? []).map((c) => ({ ...c, likes: c.likes ?? [], downs: c.downs ?? [] })),
      }))
    : [];
  return posts;
}

function persist(post?: ThreadPost) {
  if (post) post.updated = Date.now();
  saveDoc(DOC, () => load());
}

function sane(who: Who): Who {
  return { kind: who.kind === "user" ? "user" : "agent", id: clip(who.id, 80) || "user", name: clip(who.name, 60) || "Someone" };
}

/** Up minus down: what a post or comment is worth to the forum. */
export const scoreOf = (t: { likes: string[]; downs: string[] }) => t.likes.length - t.downs.length;

/** Every word of `q` appears somewhere in the post: its title, text, tags or comments. */
function matches(p: ThreadPost, q: string): boolean {
  const hay = [p.title, p.body, ...p.tags, ...p.comments.map((c) => c.text)].join(" \n ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export interface ListOptions {
  /** Only posts with this tag. */
  tag?: string;
  /** Only posts that contain every word. */
  q?: string;
  /** Only posts the person saved. */
  saved?: boolean;
  /** Pinned posts first, whatever the order. For what the person and the agents browse; the forum's own bookkeeping leaves it off. */
  pinnedFirst?: boolean;
}

export function listPosts(sort: ThreadSort = "new", opts: ListOptions = {}): ThreadPost[] {
  const worth = (p: ThreadPost) => scoreOf(p) + p.comments.length * 0.5;
  /* Reddit's "hot": the order of magnitude of the score, plus the post's age, so a new post with a few votes
     passes an old one with a few more, and a heavily voted old one still holds on for a while. */
  const hot = (p: ThreadPost) => {
    const w = worth(p);
    return Math.sign(w) * Math.log10(Math.max(Math.abs(w), 1)) + p.created / 1000 / 45_000;
  };
  const order = new Map(load().map((p, i) => [p.id, i]));
  // Two posts in the same millisecond keep the order they were made in, newest first.
  const later = (a: ThreadPost, b: ThreadPost) => order.get(b.id)! - order.get(a.id)!;
  const by = {
    new: (a: ThreadPost, b: ThreadPost) => b.created - a.created || later(a, b),
    active: (a: ThreadPost, b: ThreadPost) => b.updated - a.updated || later(a, b),
    top: (a: ThreadPost, b: ThreadPost) => worth(b) - worth(a) || b.created - a.created || later(a, b),
    hot: (a: ThreadPost, b: ThreadPost) => hot(b) - hot(a) || later(a, b),
  }[sort] ?? ((a: ThreadPost, b: ThreadPost) => b.created - a.created || later(a, b));
  const tag = opts.tag?.trim().toLowerCase().replace(/^#/, "");
  const q = opts.q?.trim();
  const kept = load().filter((p) => (!tag || p.tags.includes(tag)) && (!q || matches(p, q)) && (!opts.saved || p.saved));
  const sorted = kept.sort(by);
  return opts.pinnedFirst ? [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)] : sorted;
}

/** Every tag in use and how many posts carry it, most used first. */
export function tagCounts(): { tag: string; count: number }[] {
  const n = new Map<string, number>();
  for (const p of load()) for (const t of p.tags) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function getPost(id: string): ThreadPost | null {
  return load().find((p) => p.id === id) ?? null;
}

function must(id: string): ThreadPost {
  const post = getPost(id);
  if (!post) throw new ThreadError(`There is no post "${id}".`);
  return post;
}

export function createPost(input: { title: unknown; body?: unknown; tags?: unknown; by: Who; gif?: unknown }): ThreadPost {
  const title = clip(input.title, MAX_TITLE);
  if (!title) throw new ThreadError("A post needs a title.");
  if (load().length >= MAX_POSTS) {
    // The oldest, lowest-scored post makes room (a pinned or saved one last): a forum nobody prunes should not stop taking posts.
    const kept = (p: ThreadPost) => (p.pinned || p.saved ? 1 : 0);
    const drop = [...load()].sort((a, b) => (kept(a) - kept(b)) || (scoreOf(a) - scoreOf(b)) || (a.updated - b.updated))[0];
    load().splice(load().indexOf(drop), 1);
  }
  const rawTags = Array.isArray(input.tags) ? input.tags : typeof input.tags === "string" ? input.tags.split(",") : [];
  const tags = [...new Set(rawTags.map((t) => clip(t, 24).toLowerCase().replace(/^#/, "")).filter(Boolean))].slice(0, MAX_TAGS);
  const now = Date.now();
  const post: ThreadPost = {
    id: postId(), title, body: clip(input.body, MAX_BODY), tags, by: sane(input.by),
    created: now, updated: now, likes: [], downs: [], comments: [],
    ...(cleanGif(input.gif) ? { gif: cleanGif(input.gif)! } : {}),
  };
  load().push(post);
  persist();
  tell({ post, comment: null });
  return post;
}

export function deletePost(id: string): boolean {
  const list = load();
  const at = list.findIndex((p) => p.id === id);
  if (at < 0) return false;
  list.splice(at, 1);
  persist();
  return true;
}

export function addComment(postIdRef: string, input: { text: unknown; parent?: unknown; by: Who; gif?: unknown; react?: boolean }): { post: ThreadPost; comment: ThreadComment } {
  const post = must(postIdRef);
  const text = clip(input.text, MAX_COMMENT);
  if (!text) throw new ThreadError("A comment needs some words.");
  if (post.locked) throw new ThreadError("This post is locked: it takes no new comments.");
  if (post.comments.length >= MAX_COMMENTS) throw new ThreadError("This post already has as many comments as it can hold.");
  const parent = clip(input.parent, 40) || null;
  if (parent && !post.comments.some((c) => c.id === parent)) throw new ThreadError(`There is no comment "${parent}" on this post.`);
  const comment: ThreadComment = { id: commentId(), parent, by: sane(input.by), text, created: Date.now(), likes: [], downs: [], ...(cleanGif(input.gif) ? { gif: cleanGif(input.gif)! } : {}) };
  post.comments.push(comment);
  persist(post);
  tell({ post, comment });
  if (input.react !== false) { try { replied?.({ post, comment }); } catch { /* a reply is never undone by what follows it */ } }
  return { post, comment };
}

/** Removes the comment and the replies under it. */
export function deleteComment(postIdRef: string, commentRef: string): boolean {
  const post = getPost(postIdRef);
  if (!post || !post.comments.some((c) => c.id === commentRef)) return false;
  const gone = new Set([commentRef]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of post.comments) if (c.parent && gone.has(c.parent) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
  }
  post.comments = post.comments.filter((c) => !gone.has(c.id));
  persist(post);
  return true;
}

/**
 * Vote on a post (or one of its comments) as `who`. Voting the way you already voted takes the vote back; voting
 * the other way swaps it, so nobody is both for and against.
 */
export function toggleLike(
  postIdRef: string, who: Who, commentRef?: string | null, dir: "up" | "down" = "up",
): { liked: boolean; disliked: boolean; likes: number; downs: number; score: number; post: ThreadPost } {
  const post = must(postIdRef);
  const target = commentRef ? post.comments.find((c) => c.id === commentRef) : post;
  if (!target) throw new ThreadError(`There is no comment "${commentRef}" on this post.`);
  const me = sane(who).id;
  const [mine, other] = dir === "down" ? [target.downs, target.likes] : [target.likes, target.downs];
  const at = mine.indexOf(me);
  if (at >= 0) mine.splice(at, 1);
  else {
    mine.push(me);
    const swap = other.indexOf(me);
    if (swap >= 0) other.splice(swap, 1);
  }
  persist();
  const voted = at < 0;
  return {
    liked: dir === "up" && voted, disliked: dir === "down" && voted,
    likes: target.likes.length, downs: target.downs.length, score: scoreOf(target), post,
  };
}

/** Change the words of a post or comment. Only its author may, and it is marked as edited. */
export function editWords(
  postIdRef: string, who: Who, change: { title?: unknown; body?: unknown; text?: unknown }, commentRef?: string | null,
): ThreadPost {
  const post = must(postIdRef);
  const me = sane(who).id;
  const now = Date.now();
  if (commentRef) {
    const c = post.comments.find((x) => x.id === commentRef);
    if (!c) throw new ThreadError(`There is no comment "${commentRef}" on this post.`);
    if (c.by.id !== me) throw new ThreadError("Only a comment's author can edit it.");
    const text = clip(change.text, MAX_COMMENT);
    if (!text) throw new ThreadError("A comment needs some words.");
    if (text !== c.text) { c.text = text; c.edited = now; }
  } else {
    if (post.by.id !== me) throw new ThreadError("Only a post's author can edit it.");
    const title = change.title === undefined ? post.title : clip(change.title, MAX_TITLE);
    if (!title) throw new ThreadError("A post needs a title.");
    const body = change.body === undefined ? post.body : clip(change.body, MAX_BODY);
    if (title !== post.title || body !== post.body) { post.title = title; post.body = body; post.edited = now; }
  }
  persist();
  return post;
}

/** The person's marks on a post: pinned to the top, locked against new comments, saved for later. */
export function setMarks(postIdRef: string, marks: { pinned?: unknown; locked?: unknown; saved?: unknown }): ThreadPost {
  const post = must(postIdRef);
  for (const k of ["pinned", "locked", "saved"] as const) {
    if (typeof marks[k] === "boolean") { if (marks[k]) post[k] = true; else delete post[k]; }
  }
  persist();
  return post;
}

/** A post in a line, for a list. */
export function postLine(p: ThreadPost): string {
  return `${p.id} "${p.title}" by ${p.by.name} -- ${p.likes.length} like${p.likes.length === 1 ? "" : "s"}` +
    `${p.downs.length ? `, ${p.downs.length} downvote${p.downs.length === 1 ? "" : "s"}` : ""}, ` +
    `${p.comments.length} comment${p.comments.length === 1 ? "" : "s"}${p.tags.length ? `, #${p.tags.join(" #")}` : ""}` +
    `${p.pinned ? " [pinned]" : ""}${p.locked ? " [locked: no new comments]" : ""}`;
}

/** A whole post with its comments indented under what they answer. */
export function describePost(p: ThreadPost): string {
  const out = [`${postLine(p)}`, "", p.body || "(no text)"];
  const render = (parent: string | null, depth: number) => {
    for (const c of p.comments.filter((x) => x.parent === parent)) {
      out.push(`${"  ".repeat(depth)}- ${c.id} ${c.by.name} (${c.likes.length} like${c.likes.length === 1 ? "" : "s"}${c.downs.length ? `, ${c.downs.length} down` : ""}${c.edited ? ", edited" : ""}): ${c.text}`);
      render(c.id, depth + 1);
    }
  };
  if (p.comments.length) out.push("", "Comments:");
  render(null, 0);
  return out.join("\n");
}

