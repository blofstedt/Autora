/**
 * A worker with a clean head, for questions that would otherwise fill the
 * main thread with search results.
 *
 * "Where is the retry logic and what does it do?" costs a dozen searches and
 * file reads, and every one of them stays in the main agent's context for the
 * rest of the turn, crowding out the task. This runs that work in its own
 * loop: a fresh context, read-only tools, a hard step limit, and the same loop
 * watch and schema check as the main one. Only a short report comes back; the
 * pages it read never reach the thread's context.
 *
 * Pure apart from what it is given: the model and the tools are passed in, so
 * the loop is the same whatever provider answers and is tested with a script.
 */

import type { ChatMessage, ChatTurn, ToolReply, ToolUse } from "./llm";
import { checkArgs } from "./argcheck";
import { ErrorBudget } from "./errorbudget";
import { describe, LoopWatch } from "./loopwatch";
import type { ToolSpec } from "./tools";

export const WORKER_SYSTEM = [
  "You are a research worker for another agent. You have read-only tools and a clean context.",
  "Answer only the question you are given: look, then report. You cannot change anything; if the answer would need a change,",
  "say what it would be and leave it.",
  "Your reply is the only thing the other agent will see of your work, so make it complete and short:",
  "- Findings first, each with where you saw it (path:line, a URL, a command you ran).",
  "- Then what you could not determine, and why.",
  "- No long quotations and never a whole file; a few lines at most, only where the exact words matter.",
  "- Under 400 words. No preamble and no account of the steps you took.",
  "Be efficient: search before you read, read only the part that answers, and stop when you can answer.",
].join("\n");

export interface SubagentDeps {
  /** One model call: the worker's own system prompt, its own messages, the tools it may use. */
  ask(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn>;
  /** Run an allowed tool. Refusals (a call that would change something) come back as a failure. */
  run(name: string, args: Record<string, any>): Promise<{ ok: boolean; summary: string }>;
  /** What the worker may call. */
  tools: ToolSpec[];
  cancelled(): boolean;
}

interface SubagentOptions {
  /** Most rounds of tool calls before it must report. */
  maxSteps?: number;
  /** Most characters of one tool's output the worker reads. */
  maxOutput?: number;
  /** Most characters of report handed back. */
  maxReport?: number;
}

interface SubagentResult {
  report: string;
  steps: number;
  calls: number;
  /** Why it stopped before it chose to, if it did. */
  ended: "answered" | "step limit" | "stopped" | "loop" | "empty";
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[...${text.length - max} more characters were cut; ask for a narrower look]`;

export async function runSubagent(task: string, deps: SubagentDeps, opts: SubagentOptions = {}): Promise<SubagentResult> {
  const maxSteps = opts.maxSteps ?? 10;
  const maxOutput = opts.maxOutput ?? 5000;
  const maxReport = opts.maxReport ?? 4000;
  const watch = new LoopWatch({ warnAt: 3, stopAt: 5 });
  const errors = new ErrorBudget(3, 5);
  const known = new Map(deps.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [{ role: "user", text: task }];
  let calls = 0;
  let steps = 0;
  let ended: SubagentResult["ended"] = "step limit";
  let report = "";

  for (; steps < maxSteps; steps += 1) {
    if (deps.cancelled()) {
      ended = "stopped";
      break;
    }
    const turn = await deps.ask(WORKER_SYSTEM, messages, deps.tools);
    if (turn.calls.length === 0) {
      report = turn.text.trim();
      ended = report ? "answered" : "empty";
      break;
    }
    messages.push({ role: "assistant", text: turn.text, calls: turn.calls, reasoning: turn.reasoning });
    const replies: ToolReply[] = [];
    let loop: string | null = null;
    for (const use of turn.calls as ToolUse[]) {
      calls += 1;
      const spec = known.get(use.name);
      let ok = false;
      let text: string;
      if (use.incomplete) {
        text = `Not run: this ${use.name} call was cut off before its arguments were complete. Make it again with less in it.`;
      } else if (!spec) {
        text = `There is no tool called "${use.name}" here. You have: ${[...known.keys()].join(", ")}.`;
      } else {
        const bad = checkArgs(spec.name, spec.parameters, use.args ?? {});
        if (bad) text = bad;
        else {
          const out = await deps.run(use.name, use.args ?? {});
          ok = out.ok;
          text = out.summary;
        }
      }
      text = clip(text, maxOutput);
      const verdict = watch.record(use.name, use.args, ok, text);
      const budget = errors.record(use.name, describe(use.name, use.args), ok, text);
      if (verdict.stop || budget.stop) loop = verdict.stop ?? budget.stop;
      replies.push({ id: use.id, name: use.name, ok, result: [text, verdict.note, budget.note].filter(Boolean).join("\n\n") });
    }
    messages.push({ role: "tool", replies });
    if (loop) {
      ended = "loop";
      break;
    }
  }

  // Out of steps, or stopped going in circles: ask once, with no tools, for what it has.
  if (ended === "step limit" || ended === "loop") {
    messages.push({
      role: "user",
      text: "Stop looking now. Report what you found so far, and what you could not determine. No tool calls.",
    });
    try {
      const turn = await deps.ask(WORKER_SYSTEM, messages, []);
      report = turn.text.trim();
    } catch {
      report = "";
    }
  }
  if (ended === "stopped") report = "The person stopped the turn before the worker finished.";
  if (!report) report = "The worker found nothing it could report.";
  return { report: clip(report, maxReport), steps: steps + (ended === "answered" || ended === "empty" ? 1 : 0), calls, ended };
}
