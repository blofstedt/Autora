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
  /** No model was connected: the reply carries a button to Settings. */
  setup?: boolean;
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
/** What an MCP offer would set up, as the card shows it. Key names only. */
export type AskOffer = {
  name: string;
  title: string;
  summary: string;
  runs: string;
  kind: string;
  needs: { env: string; label: string; url?: string; hint?: string; set: boolean }[];
};

export type Ask = {
  id: string;
  kind: "question" | "browser" | "offer";
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
  offer?: AskOffer;
};

/** A decision Jev Mode scored (or declined to), as the thread shows it. */
export type JevDecision = {
  task: string;
  mode: "jev" | "fallback";
  ms: number;
  threshold: number;
  min: number | null;
  reason: string | null;
  model: string | null;
  cachedTokens: number;
  fields: { name: string; value: unknown; confidence: number; coverage: number }[];
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

/** A memory named where the agent reached for it. `kind` is the bucket
    (preference, skill...) when the server said which. */
export type MemoryItem = {
  id: string; title: string; kind: string | null;
  /** Why it was recalled ("matched deploy, docker", "pinned"). */
  reason?: string;
  /** For a write: added, merged, updated, forgotten. */
  action?: string;
};

/** A memory the agent learned after a turn, up for keeping or discarding. */
export type LearnedItem = {
  id: string; title: string; kind: string;
  /** added, proposed (a rewrite of `revises`), merged, reinforced. */
  action: string;
  status: string;
  revises: string | null;
};

/** One reach into memory: what was recalled or written, and when. */
export type MemoryTouch = { seq: number; action: "recalled" | "written"; items: MemoryItem[] };

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

/** An interactive explainer the agent wrote (see src/lib/widget.ts). */
export type Widget = {
  seq: number;
  title: string;
  html: string;
  height: number;
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
  | {
      kind: "reply"; seq: number; turn: TranscriptTurn;
      /** Memories touched while this reply was being thought, shown beside
          its reasoning rather than as a line of their own. */
      memories: MemoryTouch[];
    }
  | {
      kind: "terminal"; seq: number; span: string; command: string;
      output: string; status: SpanState["status"];
      exitCode: number | null; durationMs: number | null;
    }
  | {
      kind: "screen"; seq: number; source: "browser" | "desktop";
      url: string | null; shots: Shot[]; actions: string[]; live: boolean;
      /** What the agent said and did while it worked this page or desktop,
          shown inside the card rather than under it. See gatherScreenWork. */
      log: Cell[];
    }
  | { kind: "images"; seq: number; pictures: Picture[] }
  | { kind: "widget"; seq: number; widget: Widget }
  | { kind: "file"; seq: number; file: FileChange }
  | { kind: "tool"; seq: number; span: SpanState }
  | { kind: "note"; seq: number; tone: "bad" | "warn" | "plain"; text: string }
  | { kind: "kanban"; seq: number; board: KanbanBoard }
  | { kind: "permission"; seq: number; prompt: PermissionPrompt }
  | { kind: "ask"; seq: number; ask: Ask }
  | { kind: "jev"; seq: number; decision: JevDecision }
  | {
      kind: "learned"; seq: number; items: LearnedItem[];
      changes: { id: string; title: string; change: string }[];
    }
  | ({ kind: "memory" } & MemoryTouch);

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
  /** How full the model's context is, from the newest reading; null before
      the first model call. */
  context: ContextGauge | null;
  title: string;
};

/** The prompt against the window it is kept inside (server/context.ts). */
export type ContextGauge = {
  used: number;
  limit: number;
  /** The fraction of `limit` at which older turns start being condensed. */
  compactAt: number;
  /** How many times older turns have been condensed so far. */
  condensed: number;
};

/** Terminal tools, whose PTY output belongs in the card their call opened. */
const SHELL_TOOLS = new Set(["bash", "terminal", "shell"]);

/** Tools whose whole story is told by a cell of their own -- the screencast of
    the page or desktop they acted on, or the diff they produced. Matched by
    prefix as well as by name, because the real registry names them for what
    they do (`browser_click`, `computer_type`) and a one-line "tool called
    browser_click" card beside the video of that click is noise. */
/** A page's address, as older builds captioned their browser screenshots.
    Nothing else the agent shows is captioned like one. */
const PAGE_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/|about:)\S*$/i;

const STAGED_TOOLS = new Set(["browser", "desktop", "computer", "edit", "write", "patch"]);

const isStaged = (name: string) =>
  STAGED_TOOLS.has(name) || STAGED_TOOLS.has(name.split("_")[0]);

/**
 * Fold the log into the conversation it records.
 *
 * A pure reduction over the events, so what you read is exactly what the log
 * says and nothing is held anywhere else. It runs from zero on every change,
 * which is O(n) per update -- a few milliseconds at twenty thousand events.
 * Every object it returns is new, so App passes the result through `share`
 * (./share.ts), which hands back the previous object wherever nothing
 * changed; that is what lets the thread redraw only the card that grew. Keep
 * the output plain objects and arrays so that comparison stays meaningful.
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
  let context: ContextGauge | null = null;
  let condensed = 0;
  const gauge = (raw: any) => {
    const used = Number(raw?.used);
    const limit = Number(raw?.limit);
    if (!Number.isFinite(used) || !(limit > 0)) return;
    if (raw.condensed) condensed += 1;
    context = { used, limit, compactAt: Number(raw.compact_at) || 0.75, condensed };
  };

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

  /** Fold a memory touch into `into`, merging with the last one when it is
      the same sort, so back-to-back recalls are one pulse naming them all. */
  const touch = (into: MemoryTouch[], next: MemoryTouch) => {
    const last = into[into.length - 1];
    if (last && last.action === next.action) {
      for (const item of next.items) {
        if (!last.items.some((known) => known.id === item.id)) last.items.push(item);
      }
      last.seq = next.seq;
    } else {
      into.push(next);
    }
  };

  /** Start a new reply. A memory pulse sitting just before it moves into it,
      so what the agent recalled shows where its reasoning is. */
  const openReply = (seq: number, text: string): TranscriptTurn => {
    const turn: TranscriptTurn = { role: "agent", text, seq };
    transcript.push(turn);
    bucket.replies.push(turn);
    const memories: MemoryTouch[] = [];
    const before = current();
    if (before && before.kind === "memory" && bucket.cells[bucket.cells.length - 1] === before) {
      bucket.cells.pop();
      memories.push({ seq: before.seq, action: before.action, items: before.items });
    }
    push({ kind: "reply", seq, turn, memories });
    return turn;
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
      shots: [], actions: [], live: false, log: [],
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
        // A recall names several at once; a write names the one it wrote.
        const ids: string[] = e.payload.ids ?? (e.payload.id ? [e.payload.id] : []);
        const titles: string[] = e.payload.titles ?? (e.payload.title ? [e.payload.title] : []);
        const kinds: (string | undefined)[] = e.payload.kinds ?? (e.payload.kind ? [e.payload.kind] : []);
        const reasons: (string | undefined)[] = Array.isArray(e.payload.reasons) ? e.payload.reasons : [];
        const items: MemoryItem[] = ids.map((id, index) => ({
          id,
          title: titles[index] ?? memoryById.get(id)?.title ?? "a memory",
          kind: kinds[index] ?? null,
          reason: reasons[index],
          action: written ? e.payload.action : undefined,
        }));
        items.forEach((item) => {
          memoryById.set(item.id, {
            id: item.id,
            title: item.title,
            seq: e.seq,
            kind: written ? "written" : "recalled",
          });
        });
        if (items.length === 0) break;
        // Shown in the thread where it happened: beside the reasoning of the
        // reply being written, or on its own line until the next one starts.
        const next: MemoryTouch = { seq: e.seq, action: written ? "written" : "recalled", items };
        const last = current();
        if (last && last.kind === "reply") {
          touch(last.memories, next);
        } else if (last && last.kind === "memory") {
          const merged: MemoryTouch[] = [last];
          touch(merged, next);
          if (merged.length > 1) push({ kind: "memory", ...next });
        } else {
          push({ kind: "memory", ...next });
        }
        break;
      }

      case Kind.MemoryLearned: {
        const items: LearnedItem[] = Array.isArray(e.payload.items) ? e.payload.items : [];
        const changes = Array.isArray(e.payload.changes) ? e.payload.changes : [];
        if (items.length || changes.length) push({ kind: "learned", seq: e.seq, items, changes });
        break;
      }

      case Kind.AgentText: {
        // Deltas coalesce into the current reply rather than creating a cell
        // each -- otherwise a streamed sentence becomes 40 cards.
        if (openAgentTurn && current()?.kind === "reply") {
          openAgentTurn.text += e.payload.text ?? "";
        } else {
          openAgentTurn = openReply(e.seq, e.payload.text ?? "");
        }
        if (e.payload.setup) openAgentTurn.setup = true;
        break;
      }

      case Kind.AgentThinking: {
        // Older servers opened every turn with a canned `Analyzing: "<the
        // request>"`, which drew a "reasoning" toggle over replies that had
        // no reasoning behind them -- a failure message included.
        if (typeof e.payload.text === "string" && e.payload.text.startsWith('Analyzing: "')) break;
        if (!openAgentTurn || current()?.kind !== "reply") {
          openAgentTurn = openReply(e.seq, "");
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
        // A tool the agent wrote (my_*) is a saved script: shown as the
        // terminal it runs in, headed by the call that ran it.
        const script = name.startsWith("my_");
        if (SHELL_TOOLS.has(name) || script) {
          const shown = Object.entries(span.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
          const cell = push({
            kind: "terminal", seq: e.seq, span: span.id,
            command: script ? `${name}${shown ? ` ${shown}` : ""}` : String(span.args.command ?? ""),
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
        // The guard stopping a call is said in words wherever the call was.
        if (e.payload.guarded) {
          push({ kind: "note", seq: e.seq, tone: "warn", text: String(e.payload.error ?? "Held by the guard.") });
        } else if (!span || (isStaged(span.name) && !shells.has(span.id))) {
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
          // Output from a command that is still the newest thing extends it.
          // Output landing late, after the agent has started talking again,
          // goes to its card without taking the reply's place: making the
          // shell "current" there cut the reply in two mid-word, the rest of
          // the sentence starting a second reply underneath.
          if (cell?.kind !== "reply") open = shell;
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
          kind: e.payload.kind === "browser" ? "browser" : e.payload.kind === "offer" ? "offer" : "question",
          title: String(e.payload.title ?? ""),
          detail: String(e.payload.detail ?? ""),
          options: Array.isArray(e.payload.options) ? e.payload.options : [],
          multi: Boolean(e.payload.multi),
          allowText: e.payload.allow_text !== false,
          placeholder: String(e.payload.placeholder ?? ""),
          seq: e.seq,
          open: true,
          ...(e.payload.offer && typeof e.payload.offer === "object"
            ? {
                offer: {
                  ...e.payload.offer,
                  needs: Array.isArray(e.payload.offer.needs) ? e.payload.offer.needs : [],
                } as AskOffer,
              }
            : {}),
        };
        asks.set(id, ask);
        push({ kind: "ask", seq: e.seq, ask });
        break;
      }

      case Kind.JevDecision: {
        push({
          kind: "jev",
          seq: e.seq,
          decision: {
            task: String(e.payload.task ?? "decision"),
            mode: e.payload.mode === "jev" ? "jev" : "fallback",
            ms: Number(e.payload.ms) || 0,
            threshold: Number(e.payload.threshold) || 0.75,
            min: typeof e.payload.min === "number" ? e.payload.min : null,
            reason: e.payload.reason ? String(e.payload.reason) : null,
            model: e.payload.model ? String(e.payload.model) : null,
            cachedTokens: Number(e.payload.cached_tokens) || 0,
            fields: Array.isArray(e.payload.fields) ? e.payload.fields : [],
          },
        });
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
        // A picture of a screen belongs on that screen's card, never in a
        // second one beside it. Older builds logged the screenshot tools this
        // way: the page's address as the caption (whatever the thread last
        // knew the address to be), or "the relayed desktop" as the alt.
        const screenOf = !picture.blob || e.payload.inline ? null
          : picture.caption && (picture.caption === url || PAGE_ADDRESS.test(picture.caption)) ? "browser"
          : picture.alt === "the page as it looks now" ? "browser"
          : picture.alt === "the relayed desktop" ? "desktop"
          : null;
        if (screenOf && picture.blob) {
          if (screenOf === "browser" && picture.caption && PAGE_ADDRESS.test(picture.caption)) {
            url = picture.caption;
          }
          if (screenOf === "desktop") hasDesktop = true;
          const screen = screenCell(screenOf, e.seq);
          if (screenOf === "browser") screen.url = url;
          screen.shots.push({ blob: picture.blob, seq: e.seq, ts: e.ts });
          break;
        }
        const cell = current();
        if (cell && cell.kind === "images") cell.pictures.push(picture);
        else push({ kind: "images", seq: e.seq, pictures: [picture] });
        break;
      }

      case Kind.MediaWidget: {
        const html = typeof e.payload.html === "string" ? e.payload.html : "";
        if (!html) break;
        push({
          kind: "widget", seq: e.seq,
          widget: {
            seq: e.seq,
            title: String(e.payload.title ?? "Explainer"),
            html,
            height: typeof e.payload.height === "number" ? e.payload.height : 440,
          },
        });
        break;
      }

      case Kind.BrowserFrame:
        if (e.blob) {
          if (e.payload.url) url = e.payload.url;
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
        if (e.payload.context) gauge(e.payload.context);
        break;

      case Kind.UsageTurn:
        if (e.payload.context) gauge(e.payload.context);
        break;

      case Kind.SessionEnded:
        bucket.open = false;
        busy = false;
        break;
    }
  }

  gatherScreenWork(buckets);

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
    const box = runningBox(tail);
    if (box) box.live = true;
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
    context,
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

type ScreenCell = Extract<Cell, { kind: "screen" }>;

/** Stay in the conversation even while a page is being worked: things the
    person has to answer or act on, and the pictures handed over. They sit
    beside the card without ending it -- a sign-in is part of working the
    page. Everything else said or done meanwhile is shown inside the card. */
const KEPT_OUT = new Set<Cell["kind"]>(["ask", "permission", "kanban", "images", "widget"]);

/** The screen card a still-running turn is working in, if it is in one. */
const openBoxes = new WeakMap<Bucket, ScreenCell>();
function runningBox(bucket: Bucket): ScreenCell | null {
  return openBoxes.get(bucket) ?? null;
}

/**
 * One card per open browser (and one for the desktop), with what the agent
 * says while it works there shown inside that card.
 *
 * The browser is one window: going to a second page is that window moving
 * on, not a new window. So every stretch of work on the page -- later in the
 * same turn, after a command in between, or several prompts later -- lands in
 * the card that already shows it, and that card moves down to where the work
 * is happening now, carrying its history with it. Only closing the browser
 * ends the card; the next page after that gets a new one.
 *
 * What the agent says while a card is being worked is a side conversation
 * about that page and scrolls inside the card, like a chat thread, so the page
 * you are watching stays put. What it says after its last action on the page
 * is the answer, not narration: once the turn is over it goes back in the
 * conversation. While the turn is still running there is no telling yet, so
 * it stays in the card.
 */
function gatherScreenWork(buckets: Bucket[]) {
  /** The card each screen is shown in, until the browser closes. */
  const boxes: Record<ScreenCell["source"], ScreenCell | null> = { browser: null, desktop: null };
  /** Which bucket each card currently sits in, so it can be moved on. */
  const home = new Map<ScreenCell, Cell[]>();

  for (const bucket of buckets) {
    const out: Cell[] = [];
    const moved = new Set<Cell>();
    /** The card being worked in this bucket. A new prompt starts outside
        any card: what is said before the page is touched again is not about
        the page. */
    let box = null as ScreenCell | null;
    /** Said since the box's last action: in the box if the page is used
        again, in the conversation if it is not. */
    let pending: Cell[] = [];

    for (const cell of bucket.cells) {
      if (cell.kind === "screen") {
        const prior = boxes[cell.source];
        if (prior) {
          if (box === prior) {
            for (const c of pending) { prior.log.push(c); moved.add(c); }
          }
          prior.shots.push(...cell.shots);
          prior.actions.push(...cell.actions);
          if (cell.url) prior.url = cell.url;
          const from = home.get(prior);
          if (from !== out) {
            // Worked again in a later turn: bring the card down to here.
            if (from) from.splice(from.indexOf(prior), 1);
            out.push(prior);
            home.set(prior, out);
          }
          box = prior;
        } else {
          box = cell;
          boxes[cell.source] = cell;
          home.set(cell, out);
          out.push(cell);
        }
        pending = [];
        // Closed: the page is gone, and the next one is a new window.
        if (cell.actions.includes("close")) boxes[cell.source] = null;
        continue;
      }
      out.push(cell);
      if (box && !KEPT_OUT.has(cell.kind)) pending.push(cell);
    }

    if (box && bucket.open) {
      for (const c of pending) { box.log.push(c); moved.add(c); }
      openBoxes.set(bucket, box);
    }
    if (moved.size) {
      const kept = out.filter((c) => !moved.has(c));
      out.length = 0;
      out.push(...kept);
    }
    bucket.cells = out;
  }
}
