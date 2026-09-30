/**
 * The parts of the instructions that decide how the agent answers.
 *
 * Pure text, kept apart from server.ts so that what a person's standing
 * instructions ("be brief", "use bullet points") are up against can be tested.
 * The stored prompt was being read every turn and still lost: the console's
 * own style rules said "plain prose" and "give your final answer in full",
 * which are exactly what a request for bullets or brevity contradicts, and a
 * model settling a contradiction does not always side with the person. So the
 * console's rules are now defaults that say so, and short standing
 * instructions are repeated on the turn's own note, at the end of the
 * conversation, where a model attends to them most.
 */

/** Long enough for any house rules that are really about style; anything
    longer is a document, and is left in the instructions to be read there. */
export const REMINDER_LIMIT = 1200;

/**
 * How to answer, when the person has said nothing about it. With standing
 * instructions the defaults give way to them by name, in the same sentence
 * that states them, rather than relying on a "these win" header far below.
 */
export function replyStyle(hasRules: boolean): string[] {
  const yield_ = hasRules
    ? " These are defaults: the person's standing instructions, at the end of these instructions, decide length and format, and win where they differ."
    : "";
  return [
    "",
    "Answer as the console itself: direct, concrete, and short enough to read" +
      " between steps. By default plain prose, with no headings and no markdown" +
      " emphasis." + yield_,
    "While you are working -- any message that comes with tool calls -- write",
    "at most one short line saying what you are doing, or nothing at all. Do",
    "not restate tool output, repeat a plan you already gave, or narrate each",
    "step: the person sees every call and its result as it happens. When the",
    hasRules
      ? "work is done, give the person what they need, as briefly or fully as their standing instructions ask."
      : "work is done, give your final answer in full, with everything the person needs; brevity is for the steps in between, not for the answer.",
    "The person's latest message may end with a console note for the turn;",
    "the console wrote it, not the person, and it is context, not a request.",
  ];
}

/** The person's own rules, last in the instructions and said to be theirs. */
export function standingBlock(rules: string): string[] {
  if (!rules) return [];
  return [
    "",
    "=== THE PERSON'S STANDING INSTRUCTIONS ===",
    "Set by the person in Settings and in force on every turn and every step.",
    "Where they conflict with anything above, these win -- length, format and",
    "tone included.",
    "",
    rules,
    "=== END STANDING INSTRUCTIONS ===",
  ];
}

/**
 * The line on the turn's note that keeps the standing instructions in front of
 * the model while it writes. Short rules are repeated in full; a long set is
 * pointed at instead, so a page of them is not paid for on every round.
 */
export function standingReminder(rules: string): string | null {
  if (!rules) return null;
  if (rules.length <= REMINDER_LIMIT) {
    return (
      "The person's standing instructions apply to this reply -- its length " +
      "and format included, and while you work. They are:\n" + rules
    );
  }
  return (
    "The person's standing instructions (the last section of your " +
    "instructions) apply to this reply -- its length and format included, and " +
    "while you work. Re-read them before you answer."
  );
}
