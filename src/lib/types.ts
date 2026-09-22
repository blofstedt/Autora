/**
 * A live video frame, straight off the browser.
 *
 * Not an event: it carries no seq, is never replayed, and is gone the moment
 * the next one arrives. The log is the record of what happened; this is what
 * is happening, which is a different thing and is kept on a different channel
 * for that reason.
 */
export type LiveFrame = {
  source: "browser" | "desktop";
  /** base64, no data: prefix -- the mime is alongside. */
  data: string;
  mime: string;
  ts: number;
};

/** What the session's browser is doing, if it has one. */
export type BrowserState = {
  available: boolean;
  open: boolean;
  url: string | null;
  title: string | null;
  detail: string | null;
  fps: number;
  viewport: { width: number; height: number };
};

export type AutoraEvent = {
  seq: number;
  ts: number;
  kind: string;
  actor: string;
  span: string | null;
  payload: Record<string, any>;
  blob: string | null;
};

export const Kind = {
  SessionStarted: "session.started",
  SessionEnded: "session.ended",
  UserMessage: "turn.user",
  AgentText: "turn.agent.text",
  AgentThinking: "turn.agent.thinking",
  AgentDone: "turn.agent.done",
  ToolCall: "tool.call",
  ToolOutput: "tool.output",
  ToolResult: "tool.result",
  ToolError: "tool.error",
  PolicyRequest: "policy.request",
  PolicyDecision: "policy.decision",
  PtyOutput: "pty.output",
  PtyExit: "pty.exit",
  BrowserFrame: "browser.frame",
  BrowserNav: "browser.nav",
  BrowserAction: "browser.action",
  /** A picture the agent is showing you, as opposed to a frame of something
      it was looking at. Screenshots it was asked for, images it produced,
      images it inlined into a reply. */
  MediaImage: "media.image",
  DesktopFrame: "desktop.frame",
  DesktopAction: "desktop.action",
  ContextNote: "context.note",
  MemoryRecall: "memory.recall",
  MemoryWrite: "memory.write",
  FileEdit: "file.edit",
  KanbanUpdate: "kanban.update",
  PermissionRequest: "permission.request",
  PermissionDecision: "permission.decision",
  Log: "system.log",
  Error: "system.error",
} as const;
