/**
 * Which of a turn's cards fold together, and where the folds fall.
 *
 * Kept apart from the component that draws them because the rule is the part
 * worth testing: a turn is a long list of cards, and this decides which of
 * them become one line and which stay in place.
 */
import type { Cell } from "./derive";

/** The kinds that fold together: commands, and the smaller things the agent
    reached for. Everything else -- a page, a diff, a question, an answer --
    stays where it happened, so the shape of the turn still reads: you can
    see it was asked, worked, and answered, in that order. */
export const STEP_KINDS = new Set(["terminal", "tool"]);

/** A card is known by its kind and where it sits in the stream -- the same
    thing Thread.tsx calls a cell's key. */
const itemKey = (cell: Cell) => `${cell.kind}-${cell.seq}`;

export type TurnItem =
  | { kind: "cell"; key: string; cell: Cell }
  | { kind: "steps"; key: string; cells: Cell[] };

/**
 * Consecutive commands and small tools, gathered into one line.
 *
 * A turn that read a dozen files and ran six commands used to be eighteen
 * cards tall, and the answer at the end of it was a screenful away from the
 * question at the start. The work is all still here, in order, one click
 * down: what changed is that reading the conversation no longer means
 * reading every command that went into it.
 *
 * Anything that is not a command breaks the run, so a page the agent looked
 * at stays beside the commands that came before it rather than being buried
 * under the ones that came after.
 */
export function turnItems(cells: Cell[]): TurnItem[] {
  const items: TurnItem[] = [];
  let run: Cell[] = [];
  const flush = () => {
    if (run.length === 0) return;
    items.push({ kind: "steps", key: `${run[0].seq}-steps`, cells: run });
    run = [];
  };
  for (const cell of cells) {
    if (STEP_KINDS.has(cell.kind)) run.push(cell);
    else { flush(); items.push({ kind: "cell", key: itemKey(cell), cell }); }
  }
  flush();
  return items;
}
