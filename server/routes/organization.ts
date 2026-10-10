/**
 * The organization and Threads routes: the agents and how they fit together,
 * and the forum they (and the person) post in.
 *
 * The work of an agent (starting it) is the agents tool, not a route; these
 * are the Organization and Threads pages' reads and edits. Side effects are on
 * POST/PATCH/DELETE only.
 */

import type { Express, Request, Response } from "express";
import {
  AgentError, createAgent, deleteAgent, freshName, getAgent, listAgents, orgTree, updateAgent,
} from "../agents";
import { agentMind, forgetNote, notesOf } from "../agentmind";
import {
  ThreadError, addComment, createPost, deleteComment, deletePost, getPost, listPosts, toggleLike, type Who,
} from "../threads";

const PERSON: Who = { kind: "user", id: "user", name: "You" };

function failed(res: Response, err: unknown) {
  if (err instanceof AgentError || err instanceof ThreadError) {
    return res.status(/^There is no/.test(err.message) ? 404 : 400).json({ error: err.message });
  }
  throw err;
}

export function organizationRoutes(app: Express, onPerson: () => void = () => undefined) {
  app.get("/api/agents", (_req: Request, res: Response) => {
    res.json({ agents: listAgents(), tree: orgTree() });
  });

  app.post("/api/agents", (req: Request, res: Response) => {
    try {
      res.json({ agent: createAgent({ ...(req.body ?? {}), name: String(req.body?.name ?? "").trim() || freshName() }) });
    } catch (err) {
      failed(res, err);
    }
  });

  app.patch("/api/agents/:id", (req: Request, res: Response) => {
    try {
      res.json({ agent: updateAgent(req.params.id, req.body ?? {}) });
    } catch (err) {
      failed(res, err);
    }
  });

  app.delete("/api/agents/:id", (req: Request, res: Response) => {
    try {
      if (!getAgent(req.params.id)) return res.status(404).json({ error: "No such agent" });
      deleteAgent(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      failed(res, err);
    }
  });

  /** What an agent holds in its own mind, to read and correct. The lead's is the main Mind, on its own page. */
  app.get("/api/agents/:id/mind", (req: Request, res: Response) => {
    const agent = getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "No such agent" });
    if (agent.builtin) return res.json({ main: true, memories: [] });
    agentMind(agent.id);
    res.json({ main: false, memories: notesOf(agent.id).reverse().map((n) => ({ id: n.id, text: n.text, kind: n.kind, from: n.from, at: n.at, used: n.used })) });
  });

  app.delete("/api/agents/:id/mind/:memory", (req: Request, res: Response) => {
    const agent = getAgent(req.params.id);
    if (!agent || agent.builtin) return res.status(404).json({ error: "No such agent" });
    if (!forgetNote(agent.id, req.params.memory)) return res.status(404).json({ error: "No such memory" });
    res.json({ ok: true });
  });

  app.get("/api/threads", (req: Request, res: Response) => {
    const sort = ["top", "active"].includes(String(req.query.sort)) ? (String(req.query.sort) as "top" | "active") : "new";
    res.json({ posts: listPosts(sort) });
  });

  /** How much the agents have said since `since` (ms): the count behind the unread marker on Threads. The person's own words never count. */
  app.get("/api/threads/unread", (req: Request, res: Response) => {
    const since = Number(req.query.since);
    const from = Number.isFinite(since) ? since : Date.now();
    let count = 0;
    for (const p of listPosts("new")) {
      if (p.by.kind === "agent" && p.created > from) count += 1;
      count += p.comments.filter((c) => c.by.kind === "agent" && c.created > from).length;
    }
    res.json({ count });
  });

  app.post("/api/threads", (req: Request, res: Response) => {
    try {
      const post = createPost({ title: req.body?.title, body: req.body?.body, tags: req.body?.tags, by: PERSON });
      onPerson();
      res.json({ post });
    } catch (err) {
      failed(res, err);
    }
  });

  app.get("/api/threads/:id", (req: Request, res: Response) => {
    const post = getPost(req.params.id);
    if (!post) return res.status(404).json({ error: "No such post" });
    res.json({ post });
  });

  app.delete("/api/threads/:id", (req: Request, res: Response) => {
    if (!deletePost(req.params.id)) return res.status(404).json({ error: "No such post" });
    res.json({ ok: true });
  });

  app.post("/api/threads/:id/comments", (req: Request, res: Response) => {
    try {
      const added = addComment(req.params.id, { text: req.body?.text, parent: req.body?.parent, by: PERSON });
      onPerson();
      res.json(added);
    } catch (err) {
      failed(res, err);
    }
  });

  app.delete("/api/threads/:id/comments/:comment", (req: Request, res: Response) => {
    if (!deleteComment(req.params.id, req.params.comment)) return res.status(404).json({ error: "No such comment" });
    res.json({ ok: true });
  });

  /** Like or unlike, as the person. `comment` in the body is a comment on the post; without it, the post. */
  app.post("/api/threads/:id/like", (req: Request, res: Response) => {
    try {
      res.json(toggleLike(req.params.id, PERSON, req.body?.comment ? String(req.body.comment) : null));
    } catch (err) {
      failed(res, err);
    }
  });
}
