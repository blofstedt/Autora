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

export type KanbanTask = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  notes?: string;
  tag?: string;
  progress?: number;
  subtasks?: {
    id?: string;
    title: string;
    done: boolean;
  }[];
};

export type KanbanBoard = {
  id: string;
  title: string;
  tasks: KanbanTask[];
  autonomous: boolean;
  activeTaskId?: string | null;
};

export type PermissionPrompt = {
  requestId: string;
  tool: string;
  rendered: string;
  reason: string;
  inputType?: "boolean" | "text" | "choice";
  choices?: string[];
  placeholder?: string;
  settled: boolean;
  approved?: boolean;
  response?: string;
};

/** A question the agent put to the person, and where it stands. */
export type Ask = {
  id: string;
  kind: "question" | "browser";
  title: string;
  detail: string;
  options: { label: string; detail?: string }[];
  multi: boolean;
  allowText: boolean;
  placeholder: string;
  seq: number;
  /** Unanswered, and the turn is parked on it. */
  open: boolean;
  answer?: { cancelled: boolean; choices: string[]; text: string; who: string };
};

/** A memory, as the ribbon shows it: what it says, and what just happened to it. */
export type MemoryMark = {
  id: string;
  title: string;
  /** The event that last touched it, so the animation can key on something
      that changes exactly once per occurrence rather than on every render. */
  seq: number;
  kind: "written" | "recalled";
};

/** One captured frame, with the click it was showing, if any. */
export type Shot = {
  blob: string;
  seq: number;
  ts: number;
  mark?: { x: number; y: number };
};

/**
 * A picture the agent is showing you.
 *
 * Distinct from a `Shot`, which is a frame of something the agent was looking
 * at: this is the agent handing you an image because the image is the answer.
 * It carries either a blob the server is holding or a plain URL the agent
 * wrote, and both end up in the same card.
 */
export type Picture = {
  seq: number;
  /** One of these two is set. */
  blob: string | null;
  url: string | null;
  alt: string;
  caption: string | null;
  width: number | null;
  height: number | null;
};

/**
 * One thing that happened, in the place in the conversation where it happened.
 *
 * The stage used to be a dock under the thread: four tabs, one live pane each,
 * showing only the newest state. You could watch it, but you could not read
 * back through it -- the terminal from three questions ago had scrolled away
 * and the page the agent looked at had been replaced by the next one. So the
 * panes moved into the transcript. A command appears where it was run, with
 * its own output under it; a page appears where it was opened, with every
 * frame it produced; and scrolling up is how you review, which is what a
 * recording was for.
 */
export type Cell =
  | { kind: "reply"; seq: number; turn: TranscriptTurn }
  | {
      kind: "terminal"; seq: number; span: string; command: string;
      output: string; status: SpanState["status"];
      exitCode: number | null; durationMs: number | null;
    }
  | {
      kind: "screen"; seq: number; source: "browser" | "desktop";
      url: string | null; shots: Shot[]; actions: string[]; live: boolean;
    }
  | { kind: "images"; seq: number; pictures: Picture[] }
  | { kind: "file"; seq: number; file: FileChange }
  | { kind: "tool"; seq: number; span: SpanState }
  | { kind: "note"; seq: number; tone: "bad" | "warn" | "plain"; text: string }
  | { kind: "kanban"; seq: number; board: KanbanBoard }
  | { kind: "permission"; seq: number; prompt: PermissionPrompt }
  | { kind: "ask"; seq: number; ask: Ask };

/**
 * One prompt and everything the agent did about it.
 *
 * The log is flat, but the conversation is not: a request, some work, an
 * answer, then the next request. Bucketing restores that shape, and each
 * bucket's cells keep the order the work actually happened in.
 */
export type Bucket = {
  seq: number;
  prompt: string;
  cells: Cell[];
  replies: TranscriptTurn[];
  /** Still working on this one: the last bucket, while the agent runs. */
  open: boolean;
};

export type Derived = {
  transcript: TranscriptTurn[];
  buckets: Bucket[];
  memories: MemoryMark[];
  spansById: Map<string, SpanState>;
  approvals: Approval[];
  files: FileChange[];
  /** The page the browser is on now, for the element picker. */
  url: string | null;
  /** The newest browser cell, which is the only one still pointing at a live
      page -- picking an element in an older one would resolve against
      whatever is on screen now, which is not what it shows. */
  liveBrowserSeq: number | null;
  hasDesktop: boolean;
  busy: boolean;
  /** The question the turn is waiting on, if it is waiting on one. */
  asking: Ask | null;
  tokens: { in: number; out: number; cached: number };
  title: string;
};

/** Terminal tools, whose PTY output belongs in the card their call opened. */
const SHELL_TOOLS = new Set(["bash", "terminal", "shell"]);

/** Tools whose whole story is told by a cell of their own -- the screencast of
    the page or desktop they acted on, or the diff they produced. Matched by
    prefix as well as by name, because the real registry names them for what
    they do (`browser_click`, `computer_type`) and a one-line "tool called
    browser_click" card beside the video of that click is noise. */
const STAGED_TOOLS = new Set(["browser", "desktop", "computer", "edit", "write", "patch"]);

const isStaged = (name: string) =>
  STAGED_TOOLS.has(name) || STAGED_TOOLS.has(name.split("_")[0]);

/**
 * Fold the log into the conversation it records.
 *
 * A pure reduction over the events, so what you read is exactly what the log
 * says and nothing is held anywhere else. It runs from zero on every change,
 * which is O(n) per render and fine into the tens of thousands of events; if a
 * session ever outgrows that, memoize on checkpoints rather than mutating
 * state in place.
 */
export function derive(events: AutoraEvent[]): Derived {
  const spansById = new Map<string, SpanState>();
  const transcript: TranscriptTurn[] = [];
  const buckets: Bucket[] = [];
  // Anything before the first prompt -- the session opening, a recall, a
  // scheduled task's own setup -- belongs to a bucket with no prompt, so it is
  // still reachable rather than silently dropped.
  let bucket: Bucket = { seq: -1, prompt: "", cells: [], replies: [], open: false };
  buckets.push(bucket);

  const memoryById = new Map<string, MemoryMark>();
  let openAgentTurn: TranscriptTurn | null = null;
  const approvals: Approval[] = [];
  const asks = new Map<string, Ask>();
  const files: FileChange[] = [];
  let url: string | null = null;
  let hasDesktop = false;
  let busy = false;
  let title = "";
  const tokens = { in: 0, out: 0, cached: 0 };

  /** The cell still being added to, so consecutive work of one kind stays one
      card instead of becoming one card per frame. */
  let open: Cell | null = null;
  /** Read through a function: assignments happen inside `push`, which the
      compiler cannot see, so reading the variable directly narrows it to
      whatever was last assigned in plain sight and then disbelieves every
      other kind. */
  const current = (): Cell | null => open;
  /** Terminal cells by span: output can arrive after something else spoke. */
  const shells = new Map<string, Extract<Cell, { kind: "terminal" }>>();
  let pendingMark: { x: number; y: number } | null = null;

  const push = (cell: Cell): Cell => {
    bucket.cells.push(cell);
    open = cell;
    return cell;
  };

  const screenCell = (source: "browser" | "desktop", seq: number) => {
    const cell = current();
    if (cell && cell.kind === "screen" && cell.source === source) return cell;
    // While the agent waits on a sign-in, what the person does in the page
    // belongs to the page the card points at -- not to a new card below it,
    // which would move the page out from under their finger on first tap.
    if (cell && cell.kind === "ask" && cell.ask.open && source === "browser") {
      for (let i = bucket.cells.length - 1; i >= 0; i--) {
        const prior = bucket.cells[i];
        if (prior.kind === "screen" && prior.source === "browser") return prior;
      }
    }
    return push({
      kind: "screen", seq, source, url: source === "browser" ? url : null,
      shots: [], actions: [], live: false,
    }) as Extract<Cell, { kind: "screen" }>;
  };

  for (const e of events) {
    switch (e.kind) {
      case Kind.SessionStarted:
        title = e.payload.title || "";
        break;

      case Kind.UserMessage:
        transcript.push({ role: "user", text: e.payload.text ?? "", seq: e.seq });
        bucket = {
          seq: e.seq, prompt: e.payload.text ?? "",
          cells: [], replies: [], open: true,
        };
        buckets.push(bucket);
        openAgentTurn = null;
        open = null;
        busy = true;
        break;

      case Kind.MemoryRecall:
      case Kind.MemoryWrite: {
        const written = e.kind === Kind.MemoryWrite;
        const ids: string[] = e.payload.ids ?? [];
        const titles: string[] = e.payload.titles ?? [];
        ids.forEach((id, index) => {
          memoryById.set(id, {
            id,
            title: titles[index] ?? memoryById.get(id)?.title ?? "a memory",
            seq: e.seq,
            kind: written ? "written" : "recalled",
          });
        });
        break;
      }

      case Kind.AgentText: {
        // Deltas coalesce into the current reply rather than creating a cell
        // each -- otherwise a streamed sentence becomes 40 cards.
        if (openAgentTurn && current()?.kind === "reply") {
          openAgentTurn.text += e.payload.text ?? "";
        } else {
          openAgentTurn = { role: "agent", text: e.payload.text ?? "", seq: e.seq };
          transcript.push(openAgentTurn);
          bucket.replies.push(openAgentTurn);
          push({ kind: "reply", seq: e.seq, turn: openAgentTurn });
        }
        break;
      }

      case Kind.AgentThinking: {
        if (!openAgentTurn || current()?.kind !== "reply") {
          openAgentTurn = { role: "agent", text: "", seq: e.seq };
          transcript.push(openAgentTurn);
          bucket.replies.push(openAgentTurn);
          push({ kind: "reply", seq: e.seq, turn: openAgentTurn });
        }
        openAgentTurn.thinking = (openAgentTurn.thinking ?? "") + (e.payload.text ?? "");
        break;
      }

      case Kind.AgentDone:
        // A finished turn is waiting on nobody.
        for (const ask of asks.values()) ask.open = false;
        openAgentTurn = null;
        open = null;
        bucket.open = false;
        busy = false;
        break;

      case Kind.ToolCall: {
        openAgentTurn = null;
        const name = e.payload.name ?? "tool";
        const span: SpanState = {
          id: e.span ?? `seq-${e.seq}`,
          name,
          args: e.payload.args ?? {},
          status: "running",
          output: "",
          preview: "",
          durationMs: null,
          exitCode: null,
          seq: e.seq,
        };
        spansById.set(span.id, span);
        if (SHELL_TOOLS.has(name)) {
          const cell = push({
            kind: "terminal", seq: e.seq, span: span.id,
            command: String(span.args.command ?? ""),
            output: "", status: "running", exitCode: null, durationMs: null,
          }) as Extract<Cell, { kind: "terminal" }>;
          shells.set(span.id, cell);
        } else if (!isStaged(name)) {
          // Everything else gets a quiet one-liner, so nothing the agent did
          // is missing from the transcript -- the screencast and diff cells
          // say more about the staged tools than their arguments would.
          push({ kind: "tool", seq: e.seq, span });
        } else {
          open = null;
        }
        break;
      }

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
          const shell = shells.get(e.span);
          if (shell) {
            shell.status = span.status;
            shell.durationMs = span.durationMs;
            if (span.exitCode !== null) shell.exitCode = span.exitCode;
          }
        }
        break;

      case Kind.ToolError: {
        const span = e.span ? spansById.get(e.span) : undefined;
        if (span) {
          span.status = e.payload.denied ? "denied" : "error";
          span.preview = e.payload.error ?? e.payload.reason ?? "failed";
          span.durationMs = e.payload.duration_ms ?? span.durationMs;
          const shell = shells.get(span.id);
          if (shell) shell.status = span.status;
        }
        // A staged tool carries no cell of its own until it produces a frame
        // or a diff, so a browser call that failed outright would otherwise
        // fail silently -- which is the one outcome that must never be quiet.
        if (!span || (isStaged(span.name) && !shells.has(span.id))) {
          push({
            kind: "note", seq: e.seq,
            tone: e.payload.denied ? "warn" : "bad",
            text: `${span?.name ?? "tool"}: ${
              e.payload.error ?? e.payload.reason ?? "failed"}`,
          });
        }
        break;
      }

      case Kind.PtyOutput: {
        const shell = e.span ? shells.get(e.span) : undefined;
        const cell = current();
        if (shell) {
          shell.output += e.payload.data ?? "";
          open = shell;
        } else if (cell && cell.kind === "terminal") {
          cell.output += e.payload.data ?? "";
        } else {
          // Output with no call in front of it (a resumed log, a tool that
          // opened a PTY of its own) still belongs somewhere visible.
          const cell = push({
            kind: "terminal", seq: e.seq, span: e.span ?? `seq-${e.seq}`,
            command: "", output: e.payload.data ?? "", status: "running",
            exitCode: null, durationMs: null,
          }) as Extract<Cell, { kind: "terminal" }>;
          if (e.span) shells.set(e.span, cell);
        }
        break;
      }

      case Kind.PtyExit: {
        const shell = e.span ? shells.get(e.span) : undefined;
        const live = current();
        const target = shell
          ?? (live && live.kind === "terminal" ? live : null);
        if (target) {
          target.exitCode = e.payload.exit_code ?? null;
          target.durationMs = e.payload.duration_ms ?? target.durationMs;
          if (target.status === "running") {
            target.status = (e.payload.exit_code ?? 0) === 0 ? "ok" : "error";
          }
        }
        if (e.span && spansById.has(e.span)) {
          spansById.get(e.span)!.exitCode = e.payload.exit_code ?? null;
        }
        break;
      }

      case Kind.PolicyRequest:
      case Kind.PermissionRequest: {
        const reqId = e.payload.request_id || e.payload.requestId || `perm-${e.seq}`;
        const toolName = e.payload.tool || "action";
        const renderedText = e.payload.rendered ?? e.payload.command ?? "";
        const reasonText = e.payload.reason ?? "Permission required for this action.";
        approvals.push({
          requestId: reqId,
          tool: toolName,
          rendered: renderedText,
          reason: reasonText,
          seq: e.seq,
          settled: false,
        });
        push({
          kind: "permission",
          seq: e.seq,
          prompt: {
            requestId: reqId,
            tool: toolName,
            rendered: renderedText,
            reason: reasonText,
            inputType: e.payload.inputType || "boolean",
            choices: e.payload.choices,
            placeholder: e.payload.placeholder,
            settled: false,
          },
        });
        break;
      }

      case Kind.PolicyDecision:
      case Kind.PermissionDecision: {
        const reqId = e.payload.request_id || e.payload.requestId;
        const match = approvals.find((a) => a.requestId === reqId);
        const approved = e.payload.decision === "allow" || e.payload.approved === true;
        if (match) {
          match.settled = true;
          match.approved = approved;
        }
        for (const b of buckets) {
          for (const cell of b.cells) {
            if (cell.kind === "permission" && cell.prompt.requestId === reqId) {
              cell.prompt.settled = true;
              cell.prompt.approved = approved;
              cell.prompt.response = e.payload.response;
            }
          }
        }
        if (!approved) {
          push({
            kind: "note", seq: e.seq, tone: "warn",
            text: `You declined ${match?.rendered || match?.tool || "an action"}.`,
          });
        }
        break;
      }

      case Kind.AskRequest: {
        const id = String(e.payload.ask_id ?? `ask-${e.seq}`);
        const ask: Ask = {
          id,
          kind: e.payload.kind === "browser" ? "browser" : "question",
          title: String(e.payload.title ?? ""),
          detail: String(e.payload.detail ?? ""),
          options: Array.isArray(e.payload.options) ? e.payload.options : [],
          multi: Boolean(e.payload.multi),
          allowText: e.payload.allow_text !== false,
          placeholder: String(e.payload.placeholder ?? ""),
          seq: e.seq,
          open: true,
        };
        asks.set(id, ask);
        push({ kind: "ask", seq: e.seq, ask });
        break;
      }

      case Kind.AskAnswer: {
        const ask = asks.get(String(e.payload.ask_id));
        if (ask) {
          ask.open = false;
          ask.answer = {
            cancelled: Boolean(e.payload.cancelled),
            choices: Array.isArray(e.payload.choices) ? e.payload.choices : [],
            text: String(e.payload.text ?? ""),
            who: String(e.payload.who ?? "user"),
          };
        }
        break;
      }

      case Kind.KanbanUpdate: {
        const boardId = e.payload.id || "default";
        const boardData: KanbanBoard = {
          id: boardId,
          title: e.payload.title || "Autonomous Task Board",
          tasks: e.payload.tasks || [],
          autonomous: Boolean(e.payload.autonomous),
          activeTaskId: e.payload.activeTaskId,
        };
        const existing = bucket.cells.find(
          (c): c is Extract<Cell, { kind: "kanban" }> => c.kind === "kanban" && c.board.id === boardId
        );
        if (existing) {
          existing.board = boardData;
        } else {
          push({
            kind: "kanban",
            seq: e.seq,
            board: boardData,
          });
        }
        break;
      }

      /* Images the agent hands over. Consecutive ones become one card: three
         screenshots in a row is a contact sheet, not three sections of the
         conversation. */
      case Kind.MediaImage: {
        const picture: Picture = {
          seq: e.seq,
          blob: e.blob,
          url: typeof e.payload.url === "string" ? e.payload.url : null,
          alt: String(e.payload.alt ?? "image"),
          caption: e.payload.caption ? String(e.payload.caption) : null,
          width: typeof e.payload.w === "number" ? e.payload.w : null,
          height: typeof e.payload.h === "number" ? e.payload.h : null,
        };
        if (!picture.blob && !picture.url) break;
        const cell = current();
        if (cell && cell.kind === "images") cell.pictures.push(picture);
        else push({ kind: "images", seq: e.seq, pictures: [picture] });
        break;
      }

      case Kind.BrowserFrame:
        if (e.blob) {
          const cell = screenCell("browser", e.seq);
          cell.url = url;
          cell.shots.push({
            blob: e.blob, seq: e.seq, ts: e.ts,
            ...(pendingMark ? { mark: pendingMark } : {}),
          });
          pendingMark = null;
        }
        break;

      case Kind.BrowserNav: {
        url = e.payload.url ?? url;
        const cell = screenCell("browser", e.seq);
        cell.url = url;
        if (e.payload.url) cell.actions.push(`open ${e.payload.url}`);
        break;
      }

      case Kind.BrowserAction: {
        if (e.payload.url) url = e.payload.url;
        const cell = screenCell("browser", e.seq);
        cell.url = url;
        cell.actions.push(
          `${e.payload.action}${e.payload.selector ? ` ${e.payload.selector}` : ""}`.trim(),
        );
        if (e.payload.x != null && e.payload.y != null) {
          pendingMark = { x: e.payload.x, y: e.payload.y };
        }
        break;
      }

      case Kind.DesktopFrame: {
        hasDesktop = true;
        if (e.blob) {
          const cell = screenCell("desktop", e.seq);
          cell.shots.push({
            blob: e.blob, seq: e.seq, ts: e.ts,
            ...(pendingMark ? { mark: pendingMark } : {}),
          });
          pendingMark = null;
        }
        break;
      }

      case Kind.DesktopAction: {
        hasDesktop = true;
        const cell = screenCell("desktop", e.seq);
        const p = e.payload;
        cell.actions.push(
          `${p.action ?? ""}${p.key ? ` ${p.key}` : ""}${
            p.length ? ` ${p.length} chars` : ""}`.trim(),
        );
        if (p.x != null && p.y != null) pendingMark = { x: p.x, y: p.y };
        break;
      }

      case Kind.FileEdit: {
        const file: FileChange = {
          path: e.payload.path ?? "",
          diff: e.payload.diff ?? "",
          added: e.payload.added ?? 0,
          removed: e.payload.removed ?? 0,
          created: !!e.payload.created,
          seq: e.seq,
        };
        files.push(file);
        push({ kind: "file", seq: e.seq, file });
        break;
      }

      case Kind.ContextNote:
        if (e.payload.text) {
          push({ kind: "note", seq: e.seq, tone: "plain", text: e.payload.text });
        }
        break;

      case Kind.Error: {
        const lines = [e.payload.error ?? "Something failed."];
        if (e.payload.endpoint) lines.push(`${e.payload.model ?? "?"} @ ${e.payload.endpoint}`);
        if (e.payload.hint) lines.push(e.payload.hint);
        push({ kind: "note", seq: e.seq, tone: "bad", text: lines.join("\n") });
        break;
      }

      case Kind.Log:
        // Most log entries are bookkeeping -- token counts, compaction -- and
        // belong in the header, not the conversation. One kind is addressed to
        // the person: anything that arrives with a message, such as a desktop
        // relay connecting, which is otherwise invisible until something uses
        // it.
        if (typeof e.payload.message === "string" && e.payload.message) {
          push({ kind: "note", seq: e.seq, tone: "plain", text: e.payload.message });
        }
        if (e.payload.usage) {
          tokens.in += e.payload.usage.in ?? 0;
          tokens.out += e.payload.usage.out ?? 0;
          tokens.cached += e.payload.usage.cached ?? 0;
        }
        break;

      case Kind.SessionEnded:
        bucket.open = false;
        busy = false;
        break;
    }
  }

  // The newest browser cell is the only one whose page is still on screen.
  let liveBrowserSeq: number | null = null;
  for (let b = buckets.length - 1; b >= 0 && liveBrowserSeq === null; b--) {
    for (let c = buckets[b].cells.length - 1; c >= 0; c--) {
      const cell = buckets[b].cells[c];
      if (cell.kind === "screen" && cell.source === "browser") {
        liveBrowserSeq = cell.seq;
        break;
      }
    }
  }

  // Anything still streaming marks itself, so a card can say so without the
  // components having to know what the tail of the log looks like.
  const tail = buckets[buckets.length - 1];
  if (tail?.open) {
    const last = tail.cells[tail.cells.length - 1];
    if (last?.kind === "screen") last.live = true;
  }

  return {
    transcript,
    // The leading bucket exists only to catch events that precede any prompt;
    // drop it when nothing landed there, which is the usual case.
    buckets: buckets.filter((b, index) => index > 0 || b.cells.length > 0),
    memories: [...memoryById.values()].sort((a, b) => a.seq - b.seq),
    spansById,
    approvals,
    files,
    url,
    liveBrowserSeq,
    hasDesktop,
    busy,
    // Only the tail can still be waiting: a turn that ended released it.
    asking: [...asks.values()].reverse().find((a) => a.open && tail?.open) ?? null,
    tokens,
    title,
  };
}

/**
 * Is the agent working now?
 *
 * Read from the tail of the log rather than from a flag, so a reload mid-turn
 * comes back knowing a turn is in flight.
 */
export function isRunning(events: AutoraEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i].kind;
    if (kind === Kind.AgentDone || kind === Kind.SessionEnded) return false;
    if (kind === Kind.UserMessage) return true;
  }
  return false;
}
