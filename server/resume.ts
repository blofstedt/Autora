/**
 * Work that was cut off, so the next turn picks it up instead of starting
 * from the new message alone.
 *
 * A message sent while the agent is working stops that turn and starts a new
 * one, and a turn the person stops is followed by whatever they say next. The
 * model's history is rebuilt from the log as words only -- the typed requests
 * and replies, not the calls in between -- so the new turn saw one thing, the
 * latest message, and treated it as the whole job: the task it was halfway
 * through was dropped, or started again from the top.
 *
 * This reads the log and says what was cut off: the request, anything said
 * since that changed it, whether tools had run, and what the to-do list still
 * held. Pure -- a log in, a note out. The note tells the agent to do what the
 * new message asks, fold it into the interrupted work, and carry on from where
 * it stopped, unless the person says to drop it.
 */

import { latestTodos, type TodoEvent, type TodoItem } from "./todos";

export interface ResumeEvent extends TodoEvent {
  kind: string;
  payload: Record<string, any>;
}

export interface InterruptedWork {
  /** What was asked, oldest first: the task, then what changed it. */
  requests: string[];
  /** Tool calls made before the turn was cut off. */
  tools: number;
  /** To-do items not yet done. */
  open: TodoItem[];
  /** Stopped by the person (or a new message), or the server restarted. */
  cause: "stopped" | "restart";
  /** When the loop watch ended the turn: what it said. */
  reason: string | null;
}

const MAX_REQUEST = 600;
const MAX_REQUESTS = 5;

/** What a turn was asked, as the person worded it. */
function asked(event: ResumeEvent): string {
  const text = String(event.payload?.shown ?? event.payload?.text ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_REQUEST ? `${text.slice(0, MAX_REQUEST)}...` : text;
}

/**
 * What the last turn left unfinished, read before the new message is added to
 * the log. Null when the last turn finished, or was cut off before it had done
 * anything worth carrying on with.
 */
export function interruptedWork(events: readonly ResumeEvent[]): InterruptedWork | null {
  const starts: number[] = [];
  events.forEach((e, i) => {
    if (e.kind === "turn.user") starts.push(i);
  });

  const chain: { index: number; request: string; tools: number; cause: "stopped" | "restart"; reason: string | null }[] = [];
  for (let t = starts.length - 1; t >= 0; t -= 1) {
    const from = starts[t];
    const to = t + 1 < starts.length ? starts[t + 1] : events.length;
    const segment = events.slice(from, to);
    const done = segment.find((e) => e.kind === "turn.agent.done");
    const cause = done?.payload?.interrupted ? "restart" : done?.payload?.stopped ? "stopped" : null;
    if (!cause) break;
    chain.unshift({
      index: from,
      request: asked(events[from]),
      tools: segment.filter((e) => e.kind === "tool.call").length,
      cause,
      reason: typeof done?.payload?.reason === "string" ? done.payload.reason : null,
    });
  }
  if (chain.length === 0) return null;

  // A to-do list written before this chain began belongs to something finished.
  const since = chain[0].index;
  let list: TodoItem[] = [];
  for (let i = events.length - 1; i >= since; i -= 1) {
    if (events[i].kind === "todo.update" || events[i].kind === "kanban.update") {
      list = latestTodos(events.slice(0, i + 1))?.items ?? [];
      break;
    }
  }
  const open = list.filter((i) => i.status !== "completed");
  const tools = chain.reduce((n, c) => n + c.tools, 0);
  if (tools === 0 && open.length === 0) return null;

  return {
    requests: chain.map((c) => c.request).filter(Boolean).slice(-MAX_REQUESTS),
    tools,
    open,
    cause: chain[chain.length - 1].cause,
    reason: chain[chain.length - 1].reason,
  };
}

/** What the agent is told at the start of the turn that follows. */
export function resumeNote(work: InterruptedWork): string {
  const how = work.reason
    ? "Autora ended that turn because it was going in circles."
    : work.cause === "restart"
      ? "Autora restarted while you were working, so that turn stopped partway."
      : "The person stopped you, or sent a message, while you were working, so that turn stopped partway.";
  const asks = work.requests.length === 1
    ? [`What you were asked: ${JSON.stringify(work.requests[0])}`]
    : [
      `What you were first asked: ${JSON.stringify(work.requests[0])}`,
      "Said since, each cutting in before you finished:",
      ...work.requests.slice(1).map((r) => `- ${JSON.stringify(r)}`),
    ];
  return [
    `[Interrupted work] ${how}`,
    ...asks,
    work.tools > 0
      ? `You had made ${work.tools} tool call${work.tools === 1 ? "" : "s"} on it (listed under what you have already done).`
      : "",
    work.reason
      ? `${work.reason} Do not make those attempts again: find what is actually blocking you, take a different approach, or say what you need from the person.`
      : "",
    work.open.length > 0
      ? ["Still open on your to-do list:", ...work.open.map((i) => `- ${i.id}. ${i.title} (${i.status})`)].join("\n")
      : "",
    "The message below is what the person said next. It may add to that work, change it, or have nothing to do " +
    "with it. Do what it asks first and fold any change into the work. Then carry on with the interrupted work from " +
    "where it stopped: do not start it over, do not repeat what is already done, and do not treat the new message " +
    "as the whole job. Only if they say to drop it, or what they ask replaces it, leave it -- and say so in a line.",
  ].filter(Boolean).join("\n");
}
