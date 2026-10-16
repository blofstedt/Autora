/**
 * Roles: which model does which part of the work.
 *
 * Settings names the main model and, beside it, up to three more. The main one
 * builds: it does the many rounds of tool calls that make up most of a task, so
 * it is the one worth making cheap. The planner, when one is named, thinks the
 * task through while the chat is planning (Agent mode's planning rounds, and
 * every round of a chat in Plan mode). Talk mode's fast model speaks. The
 * background model folds old turns, learns and remarks. The planner and the
 * background model may be another provider's (a Claude planner over a DeepSeek
 * builder), so each is a whole Target: provider, model, key and address. Any of
 * them left empty falls back to the rule that held before roles existed, so an
 * install that names none behaves exactly as it did.
 *
 * Switching model only happens where the work already changes hands: at
 * set_mode, at a handover in talk mode, and in background calls that carry no
 * conversation. A model's prompt cache is its own, so every switch costs one
 * uncached read of the conversation by the model taking over; that is why
 * small talk keeps the main model (which already answers it without thinking)
 * rather than having a role of its own. Another vendor reading the history is
 * safe because the history is kept in one neutral shape (ChatMessage in
 * ./llm) and rebuilt in each vendor's own shape on every call.
 *
 * Escalation is what keeps a cheap builder safe. A cheap model is poor at
 * noticing that it is stuck, so the signals Autora already raises -- the loop
 * watch, the error budget, the stall checkpoint, a project check that keeps
 * failing -- hand the work back to the planner, which looks again (read-only)
 * and switches to build when it has a way forward. The stops behind those
 * signals stay where they were; escalation comes before them, a bounded number
 * of times per turn.
 */
import type { Phase, WorkMode } from "./modes";

/** One model, and where and how it is reached. */
export interface Target {
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
}

interface RoleModels {
  /** The main model, which builds, and its provider. */
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
  /** Talk mode's fast model, on the main provider, or empty. */
  fastModel: string;
  /** The planner, or null for the main model. */
  planner: Target | null;
  /** The background model, or null for the old rule. */
  background: Target | null;
}

/** The main model as a target. */
export function mainTarget(r: Pick<RoleModels, "provider" | "model" | "key" | "baseUrl">): Target {
  return { provider: r.provider, model: r.model, key: r.key, baseUrl: r.baseUrl };
}

const same = (a: Pick<Target, "provider" | "model">, b: Pick<Target, "provider" | "model">) =>
  a.provider === b.provider && a.model === b.model;

/** Whether a planner is named that is not simply the main model again. */
export function hasPlanner(r: Pick<RoleModels, "provider" | "model" | "planner">): boolean {
  return Boolean(r.planner?.model) && !same(r.planner!, r);
}

/** The model that does the work in a round of this phase. */
export function workTarget(r: RoleModels, phase: Phase): Target {
  return phase === "plan" && hasPlanner(r) ? r.planner! : mainTarget(r);
}

/** "deepseek-v4-pro", or "claude-sonnet-4-5 (Anthropic)" when it is not the main provider's. */
export function targetName(t: Pick<Target, "provider" | "model">, main: string, label: (id: string) => string = (id) => id): string {
  return t.provider === main ? t.model : `${t.model} (${label(t.provider)})`;
}

/**
 * The model for unwatched work: the environment's override (a model of the
 * main provider), then the background role, then talk mode's fast model, then
 * the main model -- the last two being the rule before roles existed.
 */
export function backgroundTarget(r: RoleModels, override?: string): Target {
  const main = mainTarget(r);
  const forced = (override || "").trim();
  if (forced) return { ...main, model: forced };
  if (r.background?.model) return r.background;
  return r.fastModel ? { ...main, model: r.fastModel } : main;
}

/**
 * Every model that may answer in one conversation this turn, for the context
 * window: they all hold the same conversation, so the smallest window binds.
 * The planner counts whatever mode the chat starts in, since Agent mode can
 * switch to planning at any round. The voice is the main provider's.
 */
export function conversationTargets(r: RoleModels, work: WorkMode, voice?: string): Pick<Target, "provider" | "model">[] {
  const out: Pick<Target, "provider" | "model">[] = [{ provider: r.provider, model: r.model }];
  if (work !== "build" && hasPlanner(r)) out.push({ provider: r.planner!.provider, model: r.planner!.model });
  if (voice && voice !== r.model) out.push({ provider: r.provider, model: voice });
  return out;
}

/** How many times one turn may hand the work back to the planner. */
export const MAX_ESCALATIONS = 2;

/** Project-check failures in a row, after an item was finished, that count as stuck. */
const CHECK_FAILS_TO_ESCALATE = 2;

/**
 * The stuck signals of one turn, and whether they hand the work to the planner.
 *
 * A signal is noted as it is raised; `take` is asked once at the end of a round
 * and answers with the reason to switch, or null. Only Agent mode switches by
 * itself (Build mode was chosen by the person, and Plan mode is planning
 * already), only while building, only with a planner that is a different model,
 * and only MAX_ESCALATIONS times a turn: a planner that cannot unstick the work
 * either is left to the loop watch's stop, as before.
 */
export class Escalation {
  private reason: string | null = null;
  private checkFails = 0;
  private used = 0;

  constructor(private readonly max = MAX_ESCALATIONS) {}

  /** A loop-watch, error-budget or stall warning was raised this round. */
  signal(reason: string) {
    if (!this.reason) this.reason = reason;
  }

  /** The project check ran after an item was finished. */
  check(ok: boolean) {
    this.checkFails = ok ? 0 : this.checkFails + 1;
    if (this.checkFails >= CHECK_FAILS_TO_ESCALATE) {
      this.signal(`the project check failed ${this.checkFails} times in a row`);
    }
  }

  /** How many times this turn has handed the work back. */
  get count(): number {
    return this.used;
  }

  /** At the end of a round: the reason to hand the work to the planner now, or null. */
  take(at: { work: WorkMode; phase: Phase; planner: boolean; spoken: boolean }): string | null {
    const reason = this.reason;
    this.reason = null;
    if (!reason) return null;
    if (at.work !== "agent" || at.phase !== "build" || !at.planner || at.spoken) return null;
    if (this.used >= this.max) return null;
    this.used += 1;
    this.checkFails = 0;
    return reason;
  }
}

/** What the model reads when the work is handed back to the planner. */
export function escalationNote(reason: string, planner: string, left: number): string {
  return (
    `[Escalated] The work stopped moving (${reason}), so it is back in planning, on ${planner}. ` +
    "Planning is read-only. Find the cause: re-read the errors and the code involved, check the plan's " +
    "assumptions, and fix the to-do list. Then call set_mode with to \"build\" and carry on. If there is " +
    "no way forward, say so and what you need from the person." +
    (left > 0 ? "" : " This is the last time this turn the work is handed back.")
  );
}

/**
 * An Organization agent's own model: it replaces the main model for that
 * agent's chat, so the agent builds on it, while the planner and the background
 * model stay Settings' own. An agent runs in a chat of its own, so its model
 * never shares a conversation (or a prompt cache) with the lead's.
 *
 * Models are named per vendor, so the choice carries its provider. Another
 * provider than the main one is used when it can be reached (`reach` gives its
 * key and address, or null without a key); otherwise the agent runs on the main
 * model and `note` says why, rather than sending a model id to a vendor that
 * does not know it.
 */
export function agentModelFor<R extends RoleModels>(
  active: R,
  agent: { name: string; model?: { provider: string; model: string } } | null | undefined,
  reach: (provider: string) => { key: string; baseUrl: string } | null,
  providerLabel: (id: string) => string = (id) => id,
): { active: R; note: string | null } {
  const own = agent?.model;
  if (!own?.model || !active.provider) return { active, note: null };
  if (own.provider === active.provider) return { active: { ...active, model: own.model }, note: null };
  const there = reach(own.provider);
  if (!there) {
    return {
      active,
      note: `${agent!.name}'s model (${own.model}) is on ${providerLabel(own.provider)}, which has no key now, ` +
        `so it runs on ${active.model}. Add the key in Settings, or choose it another model on the Organization page.`,
    };
  }
  /* Talk mode's fast model belongs to the main provider; an agent's chat is never spoken. */
  return {
    active: { ...active, provider: own.provider, model: own.model, key: there.key, baseUrl: there.baseUrl, fastModel: "" },
    note: null,
  };
}
