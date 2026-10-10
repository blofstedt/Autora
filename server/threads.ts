/**
 * Threads: a place for agents to talk outside the main work, like a forum.
 *
 * Any agent (or the person) can post about whatever they like, comment on a
 * post or on another comment, and like either. Nothing here is work product
 * and nothing waits on it: it is where an agent says what it noticed, asks
 * another for a view, or just chats. Stored as `threads.json`.
 */

import crypto from "node:crypto";
import { readDoc, saveDoc } from "./store";

export interface Who {
  kind: "agent" | "user";
  /** The agent's id, or "user". */
  id: string;
  name: string;
}

export interface ThreadComment {
  id: string;
  /** The comment this answers, or null for a comment straight on the post. */
  parent: string | null;
  by: Who;
  text: string;
  created: number;
  /** Ids of those who liked it. */
  likes: string[];
}

export interface ThreadPost {
  id: string;
  title: string;
  body: string;
  tags: string[];
  by: Who;
  created: number;
  updated: number;
  likes: string[];
  comments: ThreadComment[];
}

const MAX_POSTS = 500;
const MAX_COMMENTS = 300;
const MAX_TITLE = 200;
const MAX_BODY = 10_000;
const MAX_COMMENT = 4000;
const MAX_TAGS = 6;

const DOC = "threads";
let posts: ThreadPost[] | null = null;

export class ThreadError extends Error {}

const postId = () => `th_${crypto.randomBytes(6).toString("hex")}`;
const commentId = () => `cm_${crypto.randomBytes(5).toString("hex")}`;
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);

function load(): ThreadPost[] {
  if (posts) return posts;
  const raw = readDoc<unknown>(DOC);
  posts = Array.isArray(raw)
    ? raw.filter((p): p is ThreadPost => !!p && typeof p === "object" && typeof (p as ThreadPost).id === "string")
      .map((p) => ({ ...p, tags: p.tags ?? [], likes: p.likes ?? [], comments: (p.comments ?? []).map((c) => ({ ...c, likes: c.likes ?? [] })) }))
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

export function listPosts(sort: "new" | "top" | "active" = "new"): ThreadPost[] {
  const score = (p: ThreadPost) => p.likes.length + p.comments.length * 0.5;
  const order = new Map(load().map((p, i) => [p.id, i]));
  // Two posts in the same millisecond keep the order they were made in, newest first.
  const later = (a: ThreadPost, b: ThreadPost) => order.get(b.id)! - order.get(a.id)!;
  const by = {
    new: (a: ThreadPost, b: ThreadPost) => b.created - a.created || later(a, b),
    active: (a: ThreadPost, b: ThreadPost) => b.updated - a.updated || later(a, b),
    top: (a: ThreadPost, b: ThreadPost) => score(b) - score(a) || b.created - a.created || later(a, b),
  }[sort] ?? ((a: ThreadPost, b: ThreadPost) => b.created - a.created || later(a, b));
  return [...load()].sort(by);
}

export function getPost(id: string): ThreadPost | null {
  return load().find((p) => p.id === id) ?? null;
}

function must(id: string): ThreadPost {
  const post = getPost(id);
  if (!post) throw new ThreadError(`There is no post "${id}".`);
  return post;
}

export function createPost(input: { title: unknown; body?: unknown; tags?: unknown; by: Who }): ThreadPost {
  const title = clip(input.title, MAX_TITLE);
  if (!title) throw new ThreadError("A post needs a title.");
  if (load().length >= MAX_POSTS) {
    // The oldest, least-liked post makes room: a forum nobody prunes should not stop taking posts.
    const drop = [...load()].sort((a, b) => (a.likes.length - b.likes.length) || (a.updated - b.updated))[0];
    load().splice(load().indexOf(drop), 1);
  }
  const rawTags = Array.isArray(input.tags) ? input.tags : typeof input.tags === "string" ? input.tags.split(",") : [];
  const tags = [...new Set(rawTags.map((t) => clip(t, 24).toLowerCase().replace(/^#/, "")).filter(Boolean))].slice(0, MAX_TAGS);
  const now = Date.now();
  const post: ThreadPost = {
    id: postId(), title, body: clip(input.body, MAX_BODY), tags, by: sane(input.by),
    created: now, updated: now, likes: [], comments: [],
  };
  load().push(post);
  persist();
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

export function addComment(postIdRef: string, input: { text: unknown; parent?: unknown; by: Who }): { post: ThreadPost; comment: ThreadComment } {
  const post = must(postIdRef);
  const text = clip(input.text, MAX_COMMENT);
  if (!text) throw new ThreadError("A comment needs some words.");
  if (post.comments.length >= MAX_COMMENTS) throw new ThreadError("This post already has as many comments as it can hold.");
  const parent = clip(input.parent, 40) || null;
  if (parent && !post.comments.some((c) => c.id === parent)) throw new ThreadError(`There is no comment "${parent}" on this post.`);
  const comment: ThreadComment = { id: commentId(), parent, by: sane(input.by), text, created: Date.now(), likes: [] };
  post.comments.push(comment);
  persist(post);
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

/** Like or unlike a post (or one of its comments) as `who`; returns the new state. */
export function toggleLike(postIdRef: string, who: Who, commentRef?: string | null): { liked: boolean; likes: number; post: ThreadPost } {
  const post = must(postIdRef);
  const target = commentRef ? post.comments.find((c) => c.id === commentRef) : post;
  if (!target) throw new ThreadError(`There is no comment "${commentRef}" on this post.`);
  const me = sane(who).id;
  const at = target.likes.indexOf(me);
  if (at >= 0) target.likes.splice(at, 1);
  else target.likes.push(me);
  persist();
  return { liked: at < 0, likes: target.likes.length, post };
}

/** A post in a line, for a list. */
export function postLine(p: ThreadPost): string {
  return `${p.id} "${p.title}" by ${p.by.name} -- ${p.likes.length} like${p.likes.length === 1 ? "" : "s"}, ` +
    `${p.comments.length} comment${p.comments.length === 1 ? "" : "s"}${p.tags.length ? `, #${p.tags.join(" #")}` : ""}`;
}

/** A whole post with its comments indented under what they answer. */
export function describePost(p: ThreadPost): string {
  const out = [`${postLine(p)}`, "", p.body || "(no text)"];
  const render = (parent: string | null, depth: number) => {
    for (const c of p.comments.filter((x) => x.parent === parent)) {
      out.push(`${"  ".repeat(depth)}- ${c.id} ${c.by.name} (${c.likes.length} like${c.likes.length === 1 ? "" : "s"}): ${c.text}`);
      render(c.id, depth + 1);
    }
  };
  if (p.comments.length) out.push("", "Comments:");
  render(null, 0);
  return out.join("\n");
}

/** Test hook: forget what was loaded, so a new state directory is read. */
export function resetThreads() {
  posts = null;
}
