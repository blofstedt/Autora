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
  DesktopFrame: "desktop.frame",
  DesktopAction: "desktop.action",
  ContextNote: "context.note",
  FileEdit: "file.edit",
  Log: "system.log",
  Error: "system.error",
} as const;
