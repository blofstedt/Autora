/**
 * Recorded flows: a browser job done once, replayed without a model.
 *
 * The agent does a job in the browser the slow way -- reading each page,
 * choosing what to click. If the person will want it again ("download this
 * month's statement", "check the order status"), that is a poor use of a
 * model on every run. So the agent can record the job as it does it, name
 * the parts that change (a month, an order number) as parameters, and from
 * then on run it by name: plain code replays the steps, each element found
 * again by what it is (its role and name, its link, its placeholder) and not
 * by its number, which changes with every page load. A step that cannot find
 * its element stops the run and says what it found instead -- it never
 * guesses and clicks something else. `expect` steps check the page said what
 * it should, so a flow that has drifted fails loudly rather than quietly
 * doing the wrong thing.
 *
 * A flow keeps no secrets. Text typed into a password field, or text that is
 * one of the person's stored secrets, is recorded as a parameter instead; a
 * {{cred:...}} placeholder is kept as it is and resolved at run time, on the
 * site it belongs to (see credentials.ts).
 *
 * Stored in the state directory (flows.json). A flow can be run by a
 * scheduled job: the job's prompt says to run it, and what comes back is the
 * final page and the checks.
 */

import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state";
import type { PageRead, RefInfo, ScrollRequest } from "./browser";

export type Step =
  | { type: "open"; url: string }
  | { type: "click"; target: RefInfo }
  | { type: "fill"; fields: { target: RefInfo; text: string }[]; submit: boolean }
  | { type: "press"; keys: string[]; target: RefInfo | null }
  | { type: "scroll"; how: ScrollRequest }
  | { type: "back" }
  | { type: "wait"; ms: number }
  | { type: "expect"; text?: string; url?: string };

export interface Flow {
  name: string;
  description: string;
  /** Parameter names, with their default (null: the run must give one). */
  params: Record<string, string | null>;
  steps: Step[];
  created: number;
  updated: number;
  runs: number;
  lastRun: { at: number; ok: boolean; note: string } | null;
}

const MAX_STEPS = 80;
const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const file = () => path.join(stateDir(), "flows.json");

function readAll(): Record<string, Flow> {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Flow>) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(all, null, 1), { mode: 0o600 });
}

export function listFlows(): Flow[] {
  return Object.values(readAll()).sort((a, b) => a.name.localeCompare(b.name));
}

export function getFlow(name: string): Flow | null {
  return readAll()[name.trim().toLowerCase()] ?? null;
}

export function deleteFlow(name: string): boolean {
  const all = readAll();
  const key = name.trim().toLowerCase();
  if (!all[key]) return false;
  delete all[key];
  writeAll(all);
  return true;
}

export function validName(name: string): boolean {
  return NAME.test(name.trim().toLowerCase());
}

// -------------------------------------------------------------- recording --

interface Recording {
  name: string;
  description: string;
  params: Record<string, string | null>;
  steps: Step[];
  /** Redacts what must not be kept: the person's stored secrets. */
  startedAt: number;
}

const recordings = new Map<string, Recording>();

export function startRecording(session: string, name: string, description: string): string | null {
  const key = name.trim().toLowerCase();
  if (!validName(key)) return "A flow's name is letters, numbers, - and _ (up to 48), e.g. monthly-statement.";
  recordings.set(session, { name: key, description: description.trim().slice(0, 300), params: {}, steps: [], startedAt: Date.now() });
  return null;
}

export function recordingOf(session: string): { name: string; steps: number } | null {
  const r = recordings.get(session);
  return r ? { name: r.name, steps: r.steps.length } : null;
}

export function cancelRecording(session: string): boolean {
  return recordings.delete(session);
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "value";

/** Add a step to the chat's recording, if there is one. */
export function recordStep(session: string, step: Step, opts: { isSecret?: (text: string) => boolean } = {}): boolean {
  const r = recordings.get(session);
  if (!r) return false;
  if (r.steps.length >= MAX_STEPS) return false;
  if (step.type === "fill") {
    step = {
      ...step,
      fields: step.fields.map((f) => {
        const secret = f.target.type === "password" || Boolean(opts.isSecret?.(f.text));
        if (!secret) return f;
        // Never kept: a parameter the run must be given.
        const base = slug(f.target.purpose || f.target.name || f.target.type || "secret");
        let name = base, n = 2;
        while (name in r.params && r.params[name] !== null) name = `${base}_${n++}`;
        r.params[name] = null;
        return { ...f, text: `{{${name}}}` };
      }),
    };
  }
  // A scroll or wait right after the same kind adds nothing.
  const last = r.steps[r.steps.length - 1];
  if (last && step.type === "back" && last.type === "back") return true;
  r.steps.push(step);
  return true;
}

const PARAM = /\{\{\s*(?!cred:)([A-Za-z_]\w*)\s*\}\}/g;

export function paramsIn(text: string): string[] {
  return [...text.matchAll(PARAM)].map((m) => m[1]);
}

/** Turn a literal that appears in the recorded steps into a named parameter. */
export function parametrize(session: string, name: string, literal: string): { ok: boolean; message: string } {
  const r = recordings.get(session);
  if (!r) return { ok: false, message: "No flow is being recorded." };
  if (!/^[A-Za-z_]\w{0,30}$/.test(name)) return { ok: false, message: "A parameter's name is letters, numbers and _ (e.g. month)." };
  if (!literal) return { ok: false, message: "param needs the exact text to replace (value)." };
  let count = 0;
  const swap = (text: string) => (text.includes(literal) ? (count++, text.split(literal).join(`{{${name}}}`)) : text);
  r.steps = r.steps.map((s) => {
    if (s.type === "open") return { ...s, url: swap(s.url) };
    if (s.type === "fill") return { ...s, fields: s.fields.map((f) => ({ ...f, text: swap(f.text) })) };
    if (s.type === "expect") return { ...s, text: s.text ? swap(s.text) : s.text, url: s.url ? swap(s.url) : s.url };
    return s;
  });
  if (!count) return { ok: false, message: `"${literal}" does not appear in any recorded step's address, typed text or check.` };
  r.params[name] = literal;
  return { ok: true, message: `Replaced it in ${count} place${count === 1 ? "" : "s"}; ${name} defaults to "${literal}" and can be given on each run.` };
}

export function stopRecording(session: string): { flow: Flow | null; message: string } {
  const r = recordings.get(session);
  if (!r) return { flow: null, message: "No flow is being recorded." };
  recordings.delete(session);
  if (!r.steps.length) return { flow: null, message: "Nothing was recorded, so nothing was saved. Do the job with the browser tools first." };
  const all = readAll();
  const had = all[r.name];
  const params: Record<string, string | null> = { ...r.params };
  for (const s of r.steps) {
    const texts = s.type === "open" ? [s.url] : s.type === "fill" ? s.fields.map((f) => f.text) : s.type === "expect" ? [s.text ?? "", s.url ?? ""] : [];
    for (const t of texts) for (const p of paramsIn(t)) if (!(p in params)) params[p] = null;
  }
  const flow: Flow = {
    name: r.name, description: r.description || had?.description || "", params, steps: r.steps,
    created: had?.created ?? Date.now(), updated: Date.now(), runs: had?.runs ?? 0, lastRun: had?.lastRun ?? null,
  };
  all[r.name] = flow;
  writeAll(all);
  return { flow, message: `Saved flow ${r.name} (${r.steps.length} steps${Object.keys(params).length ? `, parameters: ${Object.keys(params).join(", ")}` : ""}).` };
}

/** Add a check to the recording: what the page must say for the flow to count as done. */
export function recordExpect(session: string, check: { text?: string; url?: string }): string | null {
  const r = recordings.get(session);
  if (!r) return "No flow is being recorded.";
  if (!check.text && !check.url) return "expect needs text (words the page must show) or url (part of the address).";
  r.steps.push({ type: "expect", ...(check.text ? { text: check.text } : {}), ...(check.url ? { url: check.url } : {}) });
  return null;
}

// ----------------------------------------------------------------- reading --

const target = (t: RefInfo) => `${t.role} "${t.name.slice(0, 50)}"`;

export function describeStep(s: Step): string {
  switch (s.type) {
    case "open": return `open ${s.url}`;
    case "click": return `click ${target(s.target)}`;
    case "fill": return `fill ${s.fields.map((f) => `${target(f.target)} ← ${/^\{\{\w+\}\}$/.test(f.text) ? f.text : JSON.stringify(f.text.slice(0, 40))}`).join(", ")}${s.submit ? " and submit" : ""}`;
    case "press": return `press ${s.keys.join(" ")}${s.target ? ` on ${target(s.target)}` : ""}`;
    case "scroll": return `scroll ${s.how.to ?? (s.how.text ? `to "${s.how.text}"` : `${s.how.screens ?? s.how.dy ?? 1}`)}`;
    case "back": return "go back";
    case "wait": return `wait ${s.ms} ms`;
    case "expect": return `expect ${[s.text ? `the page to show "${s.text}"` : "", s.url ? `the address to contain "${s.url}"` : ""].filter(Boolean).join(" and ")}`;
  }
}

export function describeFlow(f: Flow): string {
  const params = Object.entries(f.params).map(([k, v]) => (v === null ? `${k} (required)` : `${k} (default "${v}")`));
  return [
    `${f.name}${f.description ? ` -- ${f.description}` : ""}`,
    params.length ? `Parameters: ${params.join(", ")}` : "No parameters.",
    ...f.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
    `Run ${f.runs} time${f.runs === 1 ? "" : "s"}${f.lastRun ? `; last ${f.lastRun.ok ? "worked" : "failed"}: ${f.lastRun.note}` : ""}.`,
  ].join("\n");
}

// ----------------------------------------------------------------- running --

/** The part of the browser a replay uses. */
export interface FlowBrowser {
  goto(url: string): Promise<PageRead>;
  snapshot(): Promise<PageRead>;
  click(ref: number): Promise<PageRead>;
  fill(values: { ref: number; text: string }[], submit: boolean): Promise<PageRead>;
  press(keys: string[], ref: number | null): Promise<PageRead>;
  scroll(how: ScrollRequest): Promise<PageRead>;
  back(): Promise<PageRead>;
}

export interface RunOptions {
  cancelled?: () => boolean;
  /** Resolve {{cred:...}} placeholders for the page the text is typed on. */
  resolve?: (text: string, pageUrl: string) => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunReport {
  ok: boolean;
  /** One line per step, as far as it got. */
  lines: string[];
  /** The page as the last step left it. */
  page: PageRead | null;
  message: string;
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** The element on this page that a recorded step meant, or why there is none. */
export function locate(refs: PageRead["refs"], want: RefInfo): { ref: number } | { error: string } {
  const sameRole = refs.filter((r) => r.role === want.role);
  const scored = sameRole.map((r, i) => {
    let score = 0;
    const a = norm(r.name), b = norm(want.name);
    if (a && b && a === b) score += 100;
    else if (a && b && (a.includes(b) || b.includes(a))) score += 45;
    if (want.href && r.href && r.href === want.href) score += 60;
    if (want.placeholder && r.placeholder && norm(r.placeholder) === norm(want.placeholder)) score += 35;
    if (want.purpose && r.purpose && norm(r.purpose) === norm(want.purpose)) score += 30;
    if (want.type && r.type === want.type) score += 5;
    if (i === want.nth) score += 3;
    if (r.disabled) score -= 20;
    return { r, score };
  }).filter((x) => x.score >= 40).sort((x, y) => y.score - x.score);
  if (scored.length === 0) {
    const seen = sameRole.slice(0, 8).map((r) => `[${r.ref}] "${r.name.slice(0, 40)}"`).join(", ");
    return { error: `no ${want.role} like "${want.name.slice(0, 60)}" on this page${seen ? `; the ${want.role}s here are ${seen}` : `; there is no ${want.role} at all`}` };
  }
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].score < 100) {
    return { error: `more than one ${want.role} fits "${want.name.slice(0, 60)}": ${scored.slice(0, 4).map((x) => `[${x.r.ref}] "${x.r.name.slice(0, 40)}"`).join(", ")}` };
  }
  return { ref: scored[0].r.ref };
}

function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PARAM, (_a, name: string) => values[name] ?? "");
}

/** The values a run will use: given, else the defaults; and what is missing. */
export function bindParams(flow: Flow, given: Record<string, unknown>): { values: Record<string, string>; missing: string[]; unknown: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, def] of Object.entries(flow.params)) {
    const v = given[name];
    if (v !== undefined && v !== null && String(v) !== "") values[name] = String(v);
    else if (def !== null) values[name] = def;
    else missing.push(name);
  }
  const unknown = Object.keys(given).filter((k) => !(k in flow.params));
  return { values, missing, unknown };
}

export async function runFlow(flow: Flow, given: Record<string, unknown>, b: FlowBrowser, opts: RunOptions = {}): Promise<RunReport> {
  const { values, missing, unknown } = bindParams(flow, given);
  if (missing.length) return { ok: false, lines: [], page: null, message: `${flow.name} needs ${missing.join(", ")}: pass ${missing.length === 1 ? "it" : "them"} in params.` };
  const lines: string[] = [];
  let page: PageRead | null = null;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = (i: number, why: string): RunReport => {
    lines.push(`${i + 1}. ${describeStep(flow.steps[i])} -- FAILED: ${why}`);
    return { ok: false, lines, page, message: `Stopped at step ${i + 1} of ${flow.steps.length}: ${why}` };
  };
  for (let i = 0; i < flow.steps.length; i++) {
    if (opts.cancelled?.()) return { ok: false, lines, page, message: `Stopped before step ${i + 1}.` };
    const s = flow.steps[i];
    try {
      switch (s.type) {
        case "open":
          page = await b.goto(substitute(s.url, values));
          break;
        case "click": {
          const now: PageRead = page ?? (await b.snapshot());
          const found = locate(now.refs, s.target);
          if ("error" in found) return fail(i, found.error);
          page = await b.click(found.ref);
          break;
        }
        case "fill": {
          const now: PageRead = page ?? (await b.snapshot());
          const rows: { ref: number; text: string }[] = [];
          for (const f of s.fields) {
            const found = locate(now.refs, f.target);
            if ("error" in found) return fail(i, found.error);
            let text = substitute(f.text, values);
            if (opts.resolve) text = opts.resolve(text, now.url);
            rows.push({ ref: found.ref, text });
          }
          page = await b.fill(rows, s.submit);
          break;
        }
        case "press": {
          let ref: number | null = null;
          if (s.target) {
            const now: PageRead = page ?? (await b.snapshot());
            const found = locate(now.refs, s.target);
            if ("error" in found) return fail(i, found.error);
            ref = found.ref;
          }
          page = await b.press(s.keys, ref);
          break;
        }
        case "scroll":
          page = await b.scroll(s.how);
          break;
        case "back":
          page = await b.back();
          break;
        case "wait":
          await sleep(Math.min(10_000, Math.max(0, s.ms)));
          break;
        case "expect": {
          const now: PageRead = page ?? (await b.snapshot());
          page = now;
          const hay = `${now.title}\n${now.outline}\n${now.text}`.toLowerCase();
          if (s.text && !hay.includes(substitute(s.text, values).toLowerCase())) return fail(i, `the page does not show "${substitute(s.text, values)}" (it is ${now.url})`);
          if (s.url && !now.url.toLowerCase().includes(substitute(s.url, values).toLowerCase())) return fail(i, `the address is ${now.url}, not one containing "${substitute(s.url, values)}"`);
          break;
        }
      }
    } catch (err: any) {
      return fail(i, String(err?.message ?? err).split("\n")[0]);
    }
    lines.push(`${i + 1}. ${describeStep(s)} -- ok`);
  }
  return {
    ok: true, lines, page,
    message: `Ran ${flow.name}: all ${flow.steps.length} steps worked${unknown.length ? ` (ignored unknown parameters: ${unknown.join(", ")})` : ""}.`,
  };
}

/** Keep the flow's tally of runs. */
export function noteRun(name: string, ok: boolean, note: string) {
  const all = readAll();
  const f = all[name];
  if (!f) return;
  f.runs += 1;
  f.lastRun = { at: Date.now(), ok, note: note.slice(0, 200) };
  writeAll(all);
}
