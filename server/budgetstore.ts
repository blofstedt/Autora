/**
 * The error budget each chat has used, kept on disk.
 *
 * It used to live for one turn, so a job failing the same way every run, or a
 * person saying "try again" after a stop, began from nothing and the agent
 * walked into the same wall. Keyed by chat; an incognito chat leaves nothing.
 */

import { readDoc, saveDoc } from "./store";
import { BUDGET_MAX_AGE_MS, type BudgetSnapshot } from "./errorbudget";

const KEEP_CHATS = 50;
const books: Record<string, BudgetSnapshot> = readDoc<Record<string, BudgetSnapshot>>("error-budget") ?? {};

export function loadBudget(session: string): BudgetSnapshot {
  return books[session] ?? {};
}

export function keepBudget(session: string, snapshot: BudgetSnapshot, now = Date.now()) {
  const fresh = Object.fromEntries(Object.entries(snapshot).filter(([, e]) => now - e.at <= BUDGET_MAX_AGE_MS));
  if (Object.keys(fresh).length === 0) delete books[session];
  else books[session] = fresh;
  // Oldest chats out first, so the file stays small.
  const ids = Object.keys(books);
  if (ids.length > KEEP_CHATS) {
    const latest = (id: string) => Math.max(...Object.values(books[id]).map((e) => e.at));
    for (const id of ids.sort((a, b) => latest(a) - latest(b)).slice(0, ids.length - KEEP_CHATS)) delete books[id];
  }
  saveDoc("error-budget", () => books);
}
