/**
 * Roles: which of a provider's models does which part of the work.
 *
 * Settings names up to four models per provider. The main one builds: it does
 * the many rounds of tool calls that make up most of a task, so it is the one
 * worth making cheap. The planner, when one is named, thinks the task through
 * while the chat is planning (Agent mode's planning rounds, and every round of a
 * chat in Plan mode). Talk mode's fast model speaks. The background model folds
 * old turns, learns and remarks. Any of them left empty falls back to the rule
 * that held before roles existed, so an install that names none behaves exactly
 * as it did.
 *
 * Switching model only happens where the work already changes hands: at
 * set_mode, at a handover in talk mode, and in background calls that carry no
 * conversation. A model's prompt cache is its own, so every switch costs one
 * uncached read of the conversation by the model taking over; that is why
 * small talk keeps the main model (which already answers it without thinking)
 * rather than having a role of its own.
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

export interface RoleModels {
  /** The main model: it builds. */
  model: string;
  /** The planner, or empty for the main model. */
  plannerModel: string;
  /** Talk mode's fast model, or empty. */
  fastModel: string;
  /** The background model, or empty. */
  backgroundModel: string;
}

/** Whether a planner is named that is not simply the main model again. */
export function hasPlanner(r: Pick<RoleModels, "model" | "plannerModel">): boolean {
  return Boolean(r.plannerModel) && r.plannerModel !== r.model;
}

/** The model that does the work in a round of this phase. */
export function workModel(r: Pick<RoleModels, "model" | "plannerModel">, phase: Phase): string {
  return phase === "plan" && hasPlanner(r) ? r.plannerModel : r.model;
}

/**
 * The model for unwatched work: the environment's override, then the background
 * role, then talk mode's fast model, then the main model -- the last two being
 * the rule before roles existed.
 */
export function backgroundModelOf(r: RoleModels, override?: string): string {
  return (override || "").trim() || r.backgroundModel || r.fastModel || r.model;
}

/**
 * Every model that may answer in one conversation this turn, for the context
 * window: they all hold the same conversation, so the smallest window binds.
 * The planner counts whatever mode the chat starts in, since Agent mode can
 * switch to planning at any round.
 */
export function conversationModels(r: RoleModels, work: WorkMode, voice?: string): string[] {
  const models = [r.model];
  if (work !== "build" && hasPlanner(r)) models.push(r.plannerModel);
  if (voice && voice !== r.model) models.push(voice);
  return models;
}

/** How many times one turn may hand the work back to the planner. */
export const MAX_ESCALATIONS = 2;

/** Project-check failures in a row, after an item was finished, that count as stuck. */
export const CHECK_FAILS_TO_ESCALATE = 2;

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
 * An Organization agent's own model (step 2 of roles): it replaces the main
 * model for that agent's chat, so the agent builds on it, while the planner and
 * the background model stay Settings' own. An agent runs in a chat of its own,
 * so its model never shares a conversation (or a prompt cache) with the lead's.
 *
 * Models are named per vendor, so the choice carries the provider it was made
 * for and applies only while that provider is in use. Otherwise the agent runs
 * on the main model and `note` says why, rather than sending one vendor a
 * model id only another one knows.
 */
export function agentModelFor<R extends { provider: string; model: string }>(
  active: R,
  agent: { name: string; model?: { provider: string; model: string } } | null | undefined,
  providerLabel: (id: string) => string = (id) => id,
): { active: R; note: string | null } {
  const own = agent?.model;
  if (!own?.model || !active.provider) return { active, note: null };
  if (own.provider !== active.provider) {
    return {
      active,
      note: `${agent!.name}'s model (${own.model}) is for ${providerLabel(own.provider)}, and ${providerLabel(active.provider)} ` +
        `is in use now, so it runs on ${active.model}. Choose it a model again on the Organization page.`,
    };
  }
  return { active: { ...active, model: own.model }, note: null };
}
