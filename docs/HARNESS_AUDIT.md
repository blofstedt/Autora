# Harness audit: Autora against the six dimensions

Scope: the harness only (turn loop, context, state, tools, guardrails). Read:
`server.ts` (`startTurn` loop, ~L2875-4100), `server/loopwatch.ts`,
`server/context.ts`, `server/tools.ts` (`runTool`), `server/todos.ts`,
`server/guard.ts`, `server/toolhealth.ts`, `server/modes.ts`.

> Line numbers in this file are from when it was written and have drifted;
> search for the function or file named instead (`runTurn` in `server.ts`,
> `server/loopwatch.ts`).

## Status after remediation

The sections below are the audit as first written. What has been done since,
each with tests, and one correction.

| Finding | Now |
|---|---|
| G3.1/G3.2 varied retries never add up | `server/errorbudget.ts`: counts *different* attempts by error signature, names them in the note, stops at six. Repeats of one command are left to the loop watch (a failing test run after each edit is ordinary work). |
| G3.3 loop state dies with the turn | Kept per chat (`server/budgetstore.ts`), eased by a success, forgotten after 6 hours, none for incognito chats. |
| G3.4 stop is terminal, no handover | A turn the loop watch ends records why; the next turn is told, and told not to repeat those attempts (`server/resume.ts`). The same mechanism carries work through Stop and through a message sent mid-turn. |
| Dim 1 no evaluator | `server/verify.ts`: the person's project check (Settings) runs when the agent says it is finished after a command that changes things; the raw failure goes back, up to `tries` runs a turn. Off until a command is set, because Autora is not tied to one kind of project. |
| Dim 2 no sub-agents | `research` tool (`server/subagent.ts`): clean context, read-only tools, step limit, own loop watch and schema check; only a short report returns. |
| Dim 4 schemas not enforced | `server/argcheck.ts`, before the guard, the approval card and the tool. |
| Dim 6 no deterministic narrowing | `code_search` (`server/codesearch.ts`): exact, regex and BM25-ranked search in plain code. |
| Dim 5 "no read-only mode for the terminal" | **Wrong as first written.** Plan mode is exactly that: it refuses everything that is not looking, and lets only read-only commands run (`readOnlyCommand` in `server/modes.ts`). `code_search` and `research` are allowed there. Nothing to build. |

Still open, by choice: reflowing text after `pdf_replace_text` (see its tool
description), and a sandbox per command (the container is the sandbox).

---

## Summary

| # | Dimension | Verdict | One line |
|---|-----------|---------|----------|
| 1 | Deterministic verification | **Weak** | Nothing independent checks "done"; the todo list is self-reported. |
| 2 | Context curation | **Strong** | Background compaction, vault offloading, durable memory graph. No sub-agents. |
| 3 | Anti-drift / anti-loop | **Good base, 4 gaps** | `LoopWatch` is real; failures only add up for byte-identical calls, and no loop state survives the turn. |
| 4 | Tool interface | **Mixed** | Good schemas and error text, but schemas are never enforced at runtime. |
| 5 | Authority boundaries | **Good (by design)** | Irreversible tier always asks; Yolo default is a documented product decision. |
| 6 | Offloading deterministic work | **Adequate** | Tools are code, not LLM; no pre-index of the codebase. |

Not "crappy harness" overall: the loop is uncapped *on purpose* and replaced by
a watcher, which is the right trade. The gaps are below, worst first.

---

## Dimension 3: anti-drift and anti-loop (priority)

### What exists (`server/loopwatch.ts`, wired at `server.ts:3597-3627`)
- Fingerprint of `name + stable(args)` and of `call + normalised result`
  (digits and whitespace collapsed, so timestamps and pids don't hide a repeat).
- Escalation: note at 3 identical call+result pairs, stop at 8; a "stale"
  note after 10 calls with nothing new; a checkpoint every 20 rounds listing
  the most repeated calls.
- The note is appended to the tool result, where the model reliably reads it.
- Scheduled runs also have a spend cap (`overRun`).

### Gaps

**G3.1 Failure budget is per exact call, so varied retries never add up.**
`failures` is keyed by `name\0stable(args)` (`loopwatch.ts:93,102`). The
classic stuck pattern is the same error with slightly different arguments:
`npm test -- a`, `npm test -- b`, `npm test -- c`, all `Cannot find module`.
Each is a new key; `warnAt` is never reached; the "small variations are not
working" note at L141 is therefore only reachable for *identical* calls, which
the repeat branch above it already handles. The text promises behaviour the
code can't deliver.

**G3.2 The intervention is advisory text only.** On loop the harness appends a
note and eventually ends the turn. It never changes state: no forced replan,
no withholding of the tool that keeps failing, no listing of what was already
tried. The note should name the attempts (the model in a loop has forgotten it
is looping), and the budget should be per error type, not only a global stop.

**G3.3 Loop state dies with the turn.** `new LoopWatch(state.loop)` (L3597) is
per turn. A scheduled job that fails the same way every run, or a user who
says "try again" after a loop stop, starts from zero. `toolhealth.ts` persists
outcomes per tool+target and tells the model, but it does not feed back into
the stop decision.

**G3.4 Stop is terminal and recovery is manual.** `loopStop` ends the turn with
"Tell it what to try instead". The transcript and todo list persist, and
`closeInterruptedTurn` handles a restart, so state is recoverable. But the next
turn gets no machine-written handover (what was tried, what failed, why it
stopped). Cheap fix: append the `ErrorBudget` tried-list to the stop message
and keep it in the turn note of the next turn.

### Refactor: error-signature budget (tested)

Drop-in beside `LoopWatch`; call from `watched()` in `server.ts` next to
`watch.record(...)` and merge `note`/`stop` the same way. Verified with a
scratch test: three different `npm test -- x` failures with the same error
produce the note; the sixth stops; a success is ignored.

```ts
/** Failures of one tool that say the same thing, however the arguments were
    varied. LoopWatch keys failures on the exact call, so `npm test -- a`,
    `npm test -- b`, `npm test -- c` failing identically never adds up. */
export class ErrorBudget {
  private byKey = new Map<string, { n: number; tried: string[] }>();
  constructor(private readonly warnAt = 3, private readonly stopAt = 6) {}

  /** The first line of an error with the parts that vary taken out. */
  static signature(tool: string, result: string): string {
    const line = result.split("\n").find((l) => l.trim()) ?? "";
    return `${tool}|${line.replace(/(["'`]).*?\1/g, "<q>").replace(/\/[\w./-]+/g, "<path>").replace(/\d+/g, "#").trim().slice(0, 120)}`;
  }

  record(tool: string, attempt: string, ok: boolean, result: string):
    { note: string | null; stop: string | null } {
    if (ok) return { note: null, stop: null };
    const key = ErrorBudget.signature(tool, result);
    const e = this.byKey.get(key) ?? { n: 0, tried: [] };
    e.n += 1;
    if (!e.tried.includes(attempt)) e.tried.push(attempt);
    this.byKey.set(key, e);
    if (e.n >= this.stopAt) {
      return { note: null, stop: `Stopped: ${tool} failed ${e.n} times with the same error across ${e.tried.length} variations.` };
    }
    if (e.n >= this.warnAt) {
      return {
        note: `[Error budget] ${tool} has failed ${e.n} times with the same error, with ${e.tried.length} different ` +
          `arguments:\n${e.tried.slice(-3).map((t) => `  - ${t}`).join("\n")}\nThe arguments are not the problem. ` +
          "Discard this approach, step back, and use a different tool or find the cause before another try.",
        stop: null,
      };
    }
    return { note: null, stop: null };
  }
}
```

Wiring (in `watched()`, `server.ts:3610`):

```ts
const verdict = watch.record(name, args, ok, raw);
const budget = errors.record(name, describeArgs(args), ok, raw);   // errors = new ErrorBudget() once per turn
if (budget.stop && !loopStop) loopStop = budget.stop;
return [shown, verdict.note, budget.note, known].filter(Boolean).join("\n\n");
```

To fix G3.3, construct `errors` from a small per-session doc in `store.ts`
(`readDoc`/`saveDoc`, as `toolhealth.ts` does) instead of fresh per turn, and
decay it after a success.

---

## Dimension 1: deterministic verification vs blind trust (weakest)

- **No evaluator.** Grep for a verifier or post-edit check finds none. A turn
  ends when the model stops calling tools (`turn.calls.length === 0`,
  `server.ts:3690`). "Done" is the model's word.
- **Nearest thing is self-reported.** `unfinishedTodos` (L3722) re-asks once
  if the to-do list has open items, but items are marked `completed` by the
  model itself (`todos.ts`), so it checks consistency of a claim, not truth.
- **What is good:** exit codes and raw output go back to the model unfiltered
  (L3998-4043); a non-zero exit is a result, not an error. PDF tools return
  artifacts that can be re-read.

Recommendation (no code written; it needs a product decision because the repo
is project-agnostic): when a turn that ran file-changing tools ends in Build
mode, run the project's own check command if one is declared (e.g.
`AUTORA_VERIFY` or detected `npm run lint`), and if it fails feed the raw
output back as a user turn exactly the way the todo nudge does (L3733), once
or twice, then report. Keep it opt-in; Autora is general-purpose.

## Dimension 2: context curation (strong)

- Compaction: `context.maybeCompact` folds older turns in the background with a
  summariser, never awaited, never lands mid-write (`beginWriting`/`endWriting`).
- Offloading: `context.ingest` strips ANSI/control codes and repeated lines,
  and over the cap keeps head and tail with the full text in the vault,
  readable with `vault_read` (`context.ts:540-575`).
- Superseding stale page snapshots and pictures (`supersedePages`,
  `supersedePictures`).
- Persistent state: memory graph (`memory.ts`), notebooks, todo list, all on
  disk under `AUTORA_HOME`.
- **Gap: no sub-agent isolation.** Every task runs in one thread. The only
  hand-over is Talk mode's `think_longer` (voice vs reasoning model), which is
  not context isolation. For large searches or browsing, a read-only worker
  with a fresh window that returns a summary would cut context growth.
- Ledger format: the todo list is JSON events (good); no per-task progress
  file beyond that.

## Dimension 4: tool interface

- **Good:** every tool has a typed JSON schema with `required`, long
  model-facing descriptions, atomic tools, and an unknown-tool path that lists
  the available tools (`server.ts:3828`). Truncated calls (`use.incomplete`)
  are refused with advice to split the work (L3789).
- **Gap G4.1: schemas are decoration at runtime.** `runToolUnredacted` is a
  `switch` that coerces (`String(args.command ?? "")`). A wrong type is
  silently stringified; an unknown argument is silently ignored; a missing one
  gets a per-tool message, or none. The schema is only ever shown to the
  vendor. Nothing validates before the guard, so a bad call can also pass
  through approval prompts.
- **Gap G4.2: raw exceptions.** The `catch` at the end of `runToolUnredacted`
  turns thrown errors into a summary string; its content depends on the
  throwing library, not on what the model should change.

### Refactor: validate against the tool's own schema (tested)

New `server/argcheck.ts`; call it right after `findTool` and before the
permission and guard tiers (around `server.ts:3840`). The result is a
"Not run" reply that names every problem and the accepted arguments, which is
also fed through `watched()` so repeated bad calls count toward the loop watch.

```ts
/**
 * Checking a call's arguments against the tool's own schema before it runs.
 *
 * Every tool declares a JSON Schema, and the vendors read it, but the handlers
 * coerce whatever arrives (`String(args.command ?? "")`), so a missing or
 * mistyped argument reaches the tool and comes back as a tool-specific
 * message, or does something. This says exactly what is wrong, in the
 * model's terms, before anything runs.
 */

import type { ToolSpec } from "./tools";

type Schema = ToolSpec["parameters"];

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fits(want: string, value: unknown): boolean {
  if (want === "integer") return Number.isInteger(value);
  return kind(value) === want;
}

/** Null when the arguments fit; otherwise one message naming every problem. */
export function checkArgs(name: string, schema: Schema, args: unknown): string | null {
  if (kind(args) !== "object") {
    return `Not run: ${name} takes an object of arguments, got ${kind(args)}.`;
  }
  const given = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (given[key] === undefined || given[key] === null) {
      const spec = schema.properties[key] ?? {};
      problems.push(`missing required "${key}"${spec.type ? ` (${spec.type})` : ""}`);
    }
  }
  for (const [key, value] of Object.entries(given)) {
    const spec = schema.properties[key];
    if (!spec) {
      problems.push(`unknown argument "${key}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const want = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
    if (want.length > 0 && !want.some((t: string) => fits(t, value))) {
      problems.push(`"${key}" must be ${want.join(" or ")}, got ${kind(value)}`);
    } else if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${spec.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    }
  }
  if (problems.length === 0) return null;
  const accepts = Object.entries(schema.properties)
    .map(([k, v]) => `${k}${schema.required?.includes(k) ? "*" : ""}: ${v?.type ?? "any"}`)
    .join(", ");
  return `Not run: ${name} was called wrongly -- ${problems.join("; ")}. Arguments (* required): ${accepts}.`;
}
```

Wiring:

```ts
const bad = checkArgs(spec.name, spec.parameters, use.args);
if (bad) {
  emitEvent(session, "tool.call", "agent", { name: use.name, args: use.args }, span);
  emitEvent(session, "tool.error", "agent", { error: bad }, span);
  reply(false, watched(use.name, use.args, false, bad, bad));
  continue;
}
```

Check before wiring: a few tools may rely on accepting extras or numeric
strings. Run `npm test` (the e2e agent tests exercise the loop) and loosen
`unknown argument` to a warning if any fail. Test, verified in scratch:

```ts
/**
 * Arguments are checked against the tool's schema before it runs.
 *
 *   npx tsx tests/argcheck.test.ts
 */
import assert from "node:assert/strict";
import { checkArgs } from "../server/argcheck";

const schema = {
  type: "object" as const,
  properties: { command: { type: "string" }, cwd: { type: "string" }, n: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] } },
  required: ["command"],
};

console.log("argument check");
assert.equal(checkArgs("terminal", schema, { command: "ls" }), null);
assert.match(checkArgs("terminal", schema, {}) ?? "", /missing required "command" \(string\)/);
assert.match(checkArgs("terminal", schema, { command: 5 }) ?? "", /"command" must be string, got number/);
assert.match(checkArgs("terminal", schema, { command: "x", extra: 1 }) ?? "", /unknown argument "extra"/);
assert.match(checkArgs("terminal", schema, { command: "x", n: 1.5 }) ?? "", /"n" must be integer/);
assert.match(checkArgs("terminal", schema, { command: "x", mode: "c" }) ?? "", /one of "a", "b"/);
assert.match(checkArgs("terminal", schema, "ls") ?? "", /takes an object/);
console.log("  ok  argument check");
```

## Dimension 5: authority boundaries

- **HITL for irreversible actions: yes.** `irreversible()` (`guard.ts`) always
  asks, with `remember: false`, whatever the permission mode (`server.ts:3951`).
  A model-based guard (`modelGuard`) holds unclear risky calls and tells the
  agent to `ask_user`. Opt-in Ask mode adds approval for every risky tool.
- **Yolo default is deliberate** (CLAUDE.md standing decision), so the
  audit's "gate destructive actions" is met by the irreversible tier, not by
  universal approval. I'd leave it.
- **Sandboxing:** `terminal` is "a real shell on a real host"; isolation is the
  Umbrel container, not per-command. Acceptable for a self-hosted single-user
  tool; the cross-site and secret-redaction rules (CLAUDE.md) bound the rest.
- **Least privilege:** Plan mode is read-only and refused, not asked. Scheduled
  runs have a spend cap. No read-only credential mode for the terminal.

## Dimension 6: offloading deterministic work

- Tools are code (Playwright, pdf-lib, pdf.js, shell); the model isn't used to
  parse. `suggest.ts` is explicitly "pure, no model call". Memory recall is
  ranked, not model-scored.
- **Gap:** no codebase pre-index (BM25/exact) ahead of the model; the agent
  greps through the terminal. For a general-purpose agent this is a low
  priority.

---

## Priority list

1. **G3.1/G3.2** `ErrorBudget` (above): small, tested, closes the loop gap the
   existing note text already claims to cover.
2. **G4.1** `checkArgs` before execution (above).
3. **G3.3/G3.4** persist the error budget per session and write the tried-list
   into the stop message and next turn's note.
4. **Dim 1** optional post-change verify step, fed back once or twice.
5. **Dim 2** read-only research sub-agent with its own window.

Nothing here has been wired into `src/`, `server/` or `server.ts`, so no
release bump applies; the two snippets are verified only in isolation.


## Second pass: making the agent smarter with its tools

- **Working notes** (`server/ledger.ts`, `ledger` tool): goal, decisions, facts
  and next steps kept in the log (`ledger.update`), plus an automatic record of
  files, pages and PDFs touched. Said every turn, so an interrupt cannot drop
  what the agent had worked out. Every event is written as it happens, so each
  round of tool calls is already a checkpoint.
- **Reusable results**: a long output's vault artifact is written to the log
  (`tool.stored`) and named in the next turn's recap; `read_file` (range,
  outline, symbol) and `code_search` naming the enclosing function replace
  `cat`/`sed` round trips (`server/readfile.ts`).
- **Errors that say what to do** (`server/hints.ts`): nearest real paths for a
  missing file (read_file and shell errors), nearest text for a PDF
  `pdf_replace_text` that found nothing.
- **Shorter tool list** (`server/toolload.ts`, `tools_enable`): PDF, widgets,
  connectors, scheduling and notebooks (about 8k of the 18k tokens of schemas)
  load on the person's words, a PDF in the chat, a call, or a request; kept via
  `tools.enable`. Since 0.9.181 it is off by default; `AUTORA_LAZY_TOOLS=1` turns it on.
- **Cheaper unwatched calls**: `backgroundCall` uses the provider's fast model
  when Settings names one.
- **Parallel research**: `research` takes up to three `questions`, each its own
  clean-context worker, run at once.
- **Checking the app**: after code changes the app window's console is read
  before the agent may finish (`previewProblems`); errors go back to it, up to
  two looks a turn. Passing checks and the agent's notes are shown to the
  learning step, so procedures that ended in a pass are the ones kept.
- **Trace** (`server/trace.ts`, `GET /api/sessions/:id/trace`): turns, rounds,
  tokens, cache share, per-tool time and failures, loop stops.

- **PDF read-back**: `pdf_replace_text` reads the saved file back with pdf.js and
  says whether the new words read and the old ones are gone.

Not done: switching to a stronger model for one hard step; a trace view in the
UI (the route exists).
