import { Kind, type AutoraEvent } from "./types";

export type SpanState = {
  id: string;
  name: string;
  args: Record<string, any>;
  status: "running" | "ok" | "error" | "denied";
  output: string;
  preview: string;
  durationMs: number | null;
  exitCode: number | null;
  seq: number;
};

export type TranscriptTurn = {
  role: "user" | "agent";
  text: string;
  seq: number;
  thinking?: string;
};

export type Approval = {
  requestId: string;
  tool: string;
  rendered: string;
  reason: string;
  seq: number;
  settled: boolean;
  approved?: boolean;
};

export type FileChange = {
  path: string;
  diff: string;
  added: number;
  removed: number;
  created: boolean;
  seq: number;
};

export type Derived = {
  transcript: TranscriptTurn[];
  spans: SpanState[];
  spansById: Map<string, SpanState>;
  approvals: Approval[];
  files: FileChange[];
  frame: { blob: string; seq: number } | null;
  url: string | null;
  lastAction: { action: string; x?: number; y?: number; seq: number } | null;
  terminal: string;
  busy: boolean;
  tokens: { in: number; out: number; cached: number };
  title: string;
};

/**
 * Fold an event prefix into renderable state.
 *
 * This is the function that makes live and replay the same thing: it is a pure
 * reduction over `events[0..cursor]`, so scrubbing the timeline back to step 12
 * produces byte-for-byte what was on screen at step 12. There is no separate
 * "replay mode" that can drift from the live view, because there is no separate
 * code path.
 *
 * Folding from zero on every scrub is O(n) per frame, which is fine up to tens
 * of thousands of events and keeps this honest -- no incremental cache to get
 * subtly wrong. If a session ever outgrows that, memoize on checkpoints rather
 * than mutating state in place.
 */
export function derive(events: AutoraEvent[], cursor: number): Derived {
  const spansById = new Map<string, SpanState>();
  const transcript: TranscriptTurn[] = [];
  // Text deltas coalesce into the current agent turn, but a tool call ends that
  // turn: the sentences before and after a tool ran are separate thoughts, and
  // running them together produces an unreadable paragraph.
  let openAgentTurn: TranscriptTurn | null = null;
  const approvals: Approval[] = [];
  const files: FileChange[] = [];
  const terminalChunks: string[] = [];
  let frame: Derived["frame"] = null;
  let url: string | null = null;
  let lastAction: Derived["lastAction"] = null;
  let busy = false;
  let title = "";
  const tokens = { in: 0, out: 0, cached: 0 };

  const limit = Math.min(cursor + 1, events.length);
  for (let i = 0; i < limit; i++) {
    const e = events[i];
    switch (e.kind) {
      case Kind.SessionStarted:
        title = e.payload.title || "";
        break;

      case Kind.UserMessage:
        transcript.push({ role: "user", text: e.payload.text ?? "", seq: e.seq });
        openAgentTurn = null;
        busy = true;
        break;

      case Kind.AgentText: {
        // Deltas coalesce into the current agent turn rather than creating a row
        // each -- otherwise a streamed sentence becomes 40 transcript entries.
        if (openAgentTurn) {
          openAgentTurn.text += e.payload.text ?? "";
        } else {
          openAgentTurn = { role: "agent", text: e.payload.text ?? "", seq: e.seq };
          transcript.push(openAgentTurn);
        }
        break;
      }

      case Kind.AgentThinking: {
        if (!openAgentTurn) {
          openAgentTurn = { role: "agent", text: "", seq: e.seq };
          transcript.push(openAgentTurn);
        }
        openAgentTurn.thinking = (openAgentTurn.thinking ?? "") + (e.payload.text ?? "");
        break;
      }

      case Kind.AgentDone:
        openAgentTurn = null;
        busy = false;
        break;

      case Kind.ToolCall:
        openAgentTurn = null;
        if (e.span) {
          spansById.set(e.span, {
            id: e.span,
            name: e.payload.name ?? "tool",
            args: e.payload.args ?? {},
            status: "running",
            output: "",
            preview: "",
            durationMs: null,
            exitCode: null,
            seq: e.seq,
          });
        }
        break;

      case Kind.ToolOutput:
        if (e.span && spansById.has(e.span)) {
          const span = spansById.get(e.span)!;
          span.output += e.payload.summary ?? e.payload.data ?? "";
        }
        break;

      case Kind.ToolResult:
        if (e.span && spansById.has(e.span)) {
          const span = spansById.get(e.span)!;
          span.status = e.payload.ok === false ? "error" : "ok";
          span.preview = e.payload.preview ?? "";
          span.durationMs = e.payload.duration_ms ?? null;
          if (e.payload.display?.exit_code !== undefined) {
            span.exitCode = e.payload.display.exit_code;
          }
        }
        break;

      case Kind.ToolError:
        if (e.span && spansById.has(e.span)) {
          const span = spansById.get(e.span)!;
          span.status = e.payload.denied ? "denied" : "error";
          span.preview = e.payload.error ?? e.payload.reason ?? "failed";
          span.durationMs = e.payload.duration_ms ?? span.durationMs;
        }
        break;

      case Kind.PtyOutput:
        terminalChunks.push(e.payload.data ?? "");
        break;

      case Kind.PtyExit:
        if (e.span && spansById.has(e.span)) {
          spansById.get(e.span)!.exitCode = e.payload.exit_code ?? null;
        }
        break;

      case Kind.PolicyRequest:
        approvals.push({
          requestId: e.payload.request_id,
          tool: e.payload.tool,
          rendered: e.payload.rendered ?? "",
          reason: e.payload.reason ?? "",
          seq: e.seq,
          settled: false,
        });
        break;

      case Kind.PolicyDecision: {
        const match = approvals.find((a) => a.requestId === e.payload.request_id);
        if (match) {
          match.settled = true;
          match.approved = e.payload.decision === "allow";
        }
        break;
      }

      case Kind.BrowserFrame:
        if (e.blob) frame = { blob: e.blob, seq: e.seq };
        break;

      case Kind.BrowserNav:
        url = e.payload.url ?? url;
        break;

      case Kind.BrowserAction:
        if (e.payload.url) url = e.payload.url;
        lastAction = { action: e.payload.action, x: e.payload.x, y: e.payload.y, seq: e.seq };
        break;

      case Kind.FileEdit:
        files.push({
          path: e.payload.path ?? "",
          diff: e.payload.diff ?? "",
          added: e.payload.added ?? 0,
          removed: e.payload.removed ?? 0,
          created: !!e.payload.created,
          seq: e.seq,
        });
        break;

      case Kind.Log:
        if (e.payload.usage) {
          tokens.in += e.payload.usage.in ?? 0;
          tokens.out += e.payload.usage.out ?? 0;
          tokens.cached += e.payload.usage.cached ?? 0;
        }
        break;

      case Kind.SessionEnded:
        busy = false;
        break;
    }
  }

  return {
    transcript,
    spans: [...spansById.values()],
    spansById,
    approvals,
    files,
    frame,
    url,
    lastAction,
    terminal: terminalChunks.join(""),
    busy,
    tokens,
    title,
  };
}

/** Which pane to show, inferred from what the agent most recently did. */
export function inferStage(
  events: AutoraEvent[],
  cursor: number,
): "terminal" | "browser" | "files" {
  const limit = Math.min(cursor + 1, events.length);
  for (let i = limit - 1; i >= 0; i--) {
    const kind = events[i].kind;
    if (kind === Kind.PtyOutput || kind === Kind.PtyExit) return "terminal";
    if (kind === Kind.BrowserFrame || kind === Kind.BrowserAction || kind === Kind.BrowserNav)
      return "browser";
    if (kind === Kind.FileEdit) return "files";
  }
  return "terminal";
}
