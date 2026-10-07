/**
 * The shapes server.ts keeps per chat, in a file of their own so that the route
 * modules in server/routes/ can name them without importing server.ts
 * (docs/REVIEW.md C1). Types only; nothing here runs.
 */

import type fs from "node:fs";
import type { LiveBrowser } from "./browser";
import type { ChangeCue, DomItem } from "./domdiff";
import type { Permissions, Phase, WorkMode } from "./modes";
import type { ReviewComment } from "./pick";
import type { Device, StaticServer } from "./preview";
import type { SessionCounts } from "./store";

export interface AutoraEvent {
  seq: number;
  ts: number;
  kind: string;
  actor: string;
  span: string | null;
  payload: Record<string, any>;
  blob: string | null;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  busy: boolean;
  /** Kept at the top of the session lists. */
  pinned?: boolean;
  /** A chat that is never written down and never listed: incognito. It is in
      this process's memory alone, and closing it closes it for good. */
  incognito?: boolean;
  /** How the agent goes about work in this chat: build, plan or agent (see
      server/modes.ts). Absent reads as agent. */
  mode?: WorkMode;
  /** What may run without a yes, and -- for ask -- when to ask, in the
      person's own words. */
  permissions?: Permissions;
  askWhen?: string;
  /** What Agent mode is doing right now. Not kept: every turn starts in plan. */
  phase?: Phase;
  events: AutoraEvent[];
  seqCounter: number;
  /** What the log holds, kept current as events are emitted, so neither the
      session list nor the storage sweep has to read the log to say. */
  counts: SessionCounts;
  /** Let go of the parsed log (it is read again from disk on the next use).
      Only a session that came from disk has one. */
  unloadEvents?: () => void;
}

export interface PreviewRun {
  live: LiveBrowser;
  opened: boolean;
  openedAt: number;
  url: string | null;
  title: string | null;
  device: Device;
  /** How it was started, for saying so and for stopping it. */
  how: "url" | "folder" | "command" | null;
  serve: StaticServer | null;
  /** Watching a served folder, so an edit shows without being asked for. */
  watch: fs.FSWatcher | null;
  job: string | null;
  comments: ReviewComment[];
  /** The dev server it started has exited: what it last said, for the window. */
  serverDown: { exit: number | null; last: string } | null;
  /** Pending work to cancel when it closes. */
  timers: { reload: NodeJS.Timeout | null; console: NodeJS.Timeout | null; job: NodeJS.Timeout | null; follow: NodeJS.Timeout | null };
  /** What was on the page at the last look, and at which address, to find
      what a change touched (server/domdiff.ts). */
  dom: DomItem[] | null;
  domUrl: string | null;
  /** A look at what changed is under way, and another was asked for meanwhile. */
  following: boolean;
  again: boolean;
  /** Where the cursor last went, and a number that goes up each time. */
  cues: { seq: number; items: ChangeCue[] };
}

/** A line in the app's corner that says something happened. */
export interface Notice {
  id: number;
  ts: number;
  tone: "ok" | "error" | "info";
  title: string;
  detail: string;
  session: string | null;
}
