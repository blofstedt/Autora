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
  AgentError, createAgent, deleteAgent, getAgent, listAgents, orgTree, updateAgent,
} from "../agents";
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
      res.json({ agent: createAgent(req.body ?? {}) });
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

  app.get("/api/threads", (req: Request, res: Response) => {
    const sort = ["top", "active"].includes(String(req.query.sort)) ? (String(req.query.sort) as "top" | "active") : "new";
    res.json({ posts: listPosts(sort) });
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
