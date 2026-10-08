/**
 * Autora Games: the game window, and the agent's hands on the same game.
 *
 * The window is GDevelop's editor (github.com/4ian/GDevelop, MIT; gdevelop-editor/ builds it into dist/gdevelop-editor/ with the
 * AI, the account and the shop taken out), in a frame beside the conversation. One game per chat lives here, as the project
 * file GDevelop itself saves -- plain JSON: scenes, objects, behaviours, instances, events, resources:
 *
 *   - the agent's `game_*` tools change it (`runGameTool`) and the window is told to take the new version;
 *   - the person works in the editor as in GDevelop on its own, and what they change is saved here a moment later
 *     (`PUT /api/game/:session/project`), so the agent's next call sees it.
 *
 * Who made a change travels with it (`by`), and a save made from an older version than the one kept here is refused (409):
 * the editor then takes the newer one. The agent's change wins over the last second of the person's, never the other way
 * round, because the person is watching and can redo theirs; the agent is not watching.
 *
 * The agent works on the JSON, not on the editor: GDevelop's engine is C++ compiled to WebAssembly and lives in the page, so
 * the server cannot ask it anything. What it would say is written down instead, once, by scripts/make-game-catalog.mjs from
 * the same engine: every action, condition and expression with its parameters, and what a new scene, object or behaviour looks
 * like when the editor saves it (server/game-catalog.json). `game_catalog` and `game_template` read it, and `game_edit` checks
 * what the agent wrote against it, so a made-up instruction is found when it is written and not when the game does not run.
 *
 * Files the person chose for the game (a picture, a sound) are kept beside it (`stateDir()/game-assets/<session>/`) and used
 * by address.
 */
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import catalogJson from "./game-catalog.json";
import starterJson from "./game-starter.json";
import { artifactPath, getArtifact } from "./artifacts";
import { stateDir } from "./state";
import { readDoc, saveDoc } from "./store";
import { staticDir } from "./staticfiles";

// ------------------------------------------------------------------ shapes --

type Json = any;

interface CatalogParam {
  i: number;
  type: string;
  description: string;
  optional?: boolean;
  extra?: string;
  default?: string;
}

interface CatalogInstruction {
  kind: "action" | "condition" | "expression" | "strExpression";
  type: string;
  extension: string;
  scope?: string;
  name: string;
  sentence: string;
  group: string;
  n: number;
  params: CatalogParam[];
}

interface CatalogExtension {
  name: string;
  fullName: string;
  description: string;
  objects: Array<{ type: string; name: string; description: string }>;
  behaviors: Array<{ type: string; name: string; description: string }>;
}

interface Catalog {
  extensions: CatalogExtension[];
  instructions: CatalogInstruction[];
  templates: {
    scene: Json;
    layer: Json;
    instance: Json;
    objects: Record<string, Json>;
    behaviors: Record<string, Json>;
    resources: Record<string, Json>;
  };
}

const catalog = catalogJson as unknown as Catalog;

/** What the page knows about the window. */
interface GameState {
  open: boolean;
  /** When it was opened, which orders it among the other windows. */
  since?: number;
  /** Goes up on every change to the game, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  name?: string;
  scenes?: number;
}

interface Entry {
  project: Json | null;
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
}

/** What is kept on disk for a chat: its game, and whether its window was open. */
interface Saved {
  project: Json;
  open: boolean;
  since: number;
  rev: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
const savedName = (session: string) => `game-${session}`;

/** The editor, built into this server (npm run build): without it the tools are not offered. */
const editorDir = (): string => path.join(process.cwd(), "dist", "gdevelop-editor");
export const gameAvailable = (): boolean => fs.existsSync(path.join(editorDir(), "index.html"));

/** A new game, as GDevelop makes an empty one: one scene, named, first to open. */
const starter = (): Json => JSON.parse(JSON.stringify(starterJson));

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    const saved = validSession(session) ? readDoc<Saved>(savedName(session)) : null;
    entry = {
      project: saved?.project ?? null,
      open: Boolean(saved?.open),
      since: saved?.since ?? 0,
      rev: saved?.rev ?? 0,
      by: "agent",
    };
    entries.set(session, entry);
  }
  return entry;
}

function projectOf(session: string): Json {
  const entry = entryFor(session);
  if (!entry.project) {
    entry.project = starter();
    persist(session);
  }
  return entry.project;
}

function persist(session: string) {
  const entry = entryFor(session);
  saveDoc(savedName(session), () => ({ project: entry.project, open: entry.open, since: entry.since, rev: entry.rev }) satisfies Saved);
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

/** A new version of the game, from the agent or the person: kept, saved, announced. */
function commit(session: string, project: Json, by: "agent" | "person") {
  const entry = entryFor(session);
  normalize(project);
  entry.project = project;
  entry.rev++;
  entry.by = by;
  persist(session);
  changed(session);
}

/** Remember the window being opened or put away. */
function setOpen(session: string, open: boolean) {
  const entry = entryFor(session);
  if (entry.open === open) return;
  entry.open = open;
  entry.since = open ? Date.now() : entry.since;
  if (entry.project) persist(session);
  changed(session);
}

export function gameState(session: string): GameState {
  if (!validSession(session)) return { open: false };
  const entry = entryFor(session);
  if (!entry.open) return { open: false };
  const project = entry.project;
  return {
    open: true,
    since: entry.since,
    rev: entry.rev,
    by: entry.by,
    name: project?.properties?.name || "Your game",
    scenes: Array.isArray(project?.layouts) ? project.layouts.length : 0,
  };
}

/** Told after every change to a chat's window or game, so the page can be told. */
export function onGameChange(fn: (session: string) => void) {
  listeners.add(fn);
}

/** The chat is gone: let go of its game, and of the file and the files it was kept in. */
export function dropGame(session: string) {
  entries.delete(session);
  previews.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(path.join(stateDir(), `${savedName(session)}.json`), { force: true });
  fs.rmSync(assetsDir(session), { recursive: true, force: true });
}

// ----------------------------------------------------------------- project --

const isObject = (v: unknown): v is Record<string, Json> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

/** What a project file needs to have for the editor to open it: the parts a hand-made edit tends to leave out. */
function normalize(project: Json) {
  if (!isObject(project.properties)) project.properties = {};
  for (const key of ["objects", "objectsGroups", "variables", "layouts", "externalEvents", "eventsFunctionsExtensions", "externalLayouts"]) {
    if (!Array.isArray(project[key])) project[key] = [];
  }
  if (!isObject(project.resources)) project.resources = { resources: [] };
  if (!Array.isArray(project.resources.resources)) project.resources.resources = [];
  if (!isObject(project.objectsFolderStructure)) project.objectsFolderStructure = { folderName: "__ROOT" };
  for (const layout of project.layouts) {
    if (!isObject(layout)) continue;
    for (const key of ["objects", "objectsGroups", "variables", "instances", "events", "layers", "behaviorsSharedData"]) {
      if (!Array.isArray(layout[key])) layout[key] = [];
    }
    if (!isObject(layout.uiSettings)) layout.uiSettings = {};
    if (!isObject(layout.objectsFolderStructure)) layout.objectsFolderStructure = { folderName: "__ROOT" };
    if (typeof layout.name === "string" && typeof layout.mangledName !== "string") layout.mangledName = layout.name.replace(/[^A-Za-z0-9_]/g, "_");
    if (!layout.layers.some((l: Json) => isObject(l) && l.name === "")) layout.layers.unshift(JSON.parse(JSON.stringify(catalog.templates.layer)));
  }
  if (typeof project.firstLayout !== "string" || !project.layouts.some((l: Json) => l?.name === project.firstLayout)) {
    project.firstLayout = project.layouts[0]?.name ?? "";
  }
}

/** A project the editor can be given: a game, and not some other JSON. */
function looksLikeGame(project: unknown): project is Json {
  return isObject(project) && Array.isArray(project.layouts) && isObject(project.properties) && project.layouts.every((l) => isObject(l) && typeof l.name === "string");
}

// -------------------------------------------------------------------- paths --

type Step = { key: string } | { select: string };

/** `layouts[Scene].objects[Player].behaviors[0]` as steps. A selector is an index, a name, or `property=value`. */
function parsePath(text: string): Step[] {
  // Outside the brackets only plain key characters; inside them a name may be anything but "]".
  if (/[^A-Za-z0-9_\-.]/.test(text.trim().replace(/\[[^\]]*\]/g, ""))) {
    throw new Error(`Cannot read the path "${text}". Use dots and [selectors], like layouts[Scene].objects[Player].`);
  }
  const steps: Step[] = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.trim())) !== null) {
    if (m[1] !== undefined) steps.push({ key: m[1] });
    else steps.push({ select: m[2] });
  }
  return steps;
}

/** Which element of an array a selector means; -1 when there is none. */
function findIn(list: Json[], select: string): number {
  if (/^-?\d+$/.test(select)) {
    const n = Number(select);
    const at = n < 0 ? list.length + n : n;
    return at >= 0 && at < list.length ? at : -1;
  }
  const eq = select.indexOf("=");
  if (eq > 0) {
    const prop = select.slice(0, eq);
    const want = select.slice(eq + 1);
    return list.findIndex((x) => isObject(x) && String(x[prop]) === want);
  }
  return list.findIndex((x) => isObject(x) && x.name === select);
}

function describeAt(steps: Step[], upTo: number): string {
  return steps.slice(0, upTo).map((s) => ("key" in s ? `.${s.key}` : `[${s.select}]`)).join("").replace(/^\./, "") || "the game";
}

/** Walk to the parent of the last step: where a value is read, written or removed. */
function resolve(root: Json, text: string): { parent: Json; last: Step; steps: Step[] } {
  const steps = parsePath(text);
  if (!steps.length) throw new Error("A path is needed, like layouts[Scene].objects.");
  let node: Json = root;
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    if ("key" in step) {
      if (!isObject(node) && !Array.isArray(node)) throw new Error(`${describeAt(steps, i)} is not something with parts.`);
      if (!(step.key in node)) throw new Error(`There is no "${step.key}" in ${describeAt(steps, i)}.`);
      node = (node as Record<string, Json>)[step.key];
    } else {
      if (!Array.isArray(node)) throw new Error(`${describeAt(steps, i)} is not a list, so [${step.select}] means nothing there.`);
      const at = findIn(node, step.select);
      if (at < 0) throw new Error(`There is nothing called [${step.select}] in ${describeAt(steps, i)} (${node.length} items${nameList(node)}).`);
      node = node[at];
    }
  }
  return { parent: node, last: steps[steps.length - 1], steps };
}

const nameList = (list: Json[]) => {
  const names = list.map((x) => (isObject(x) && typeof x.name === "string" ? x.name : null)).filter((n): n is string => n !== null);
  return names.length ? `: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}` : "";
};

function readAt(root: Json, text: string): Json {
  const { parent, last, steps } = resolve(root, text);
  if ("key" in last) {
    if (!(isObject(parent) || Array.isArray(parent)) || !(last.key in parent)) throw new Error(`There is no "${last.key}" in ${describeAt(steps, steps.length - 1)}.`);
    return (parent as Record<string, Json>)[last.key];
  }
  if (!Array.isArray(parent)) throw new Error(`${describeAt(steps, steps.length - 1)} is not a list.`);
  const at = findIn(parent, last.select);
  if (at < 0) throw new Error(`There is nothing called [${last.select}] in ${describeAt(steps, steps.length - 1)} (${parent.length} items${nameList(parent)}).`);
  return parent[at];
}

interface Op {
  op: "set" | "insert" | "remove" | "merge";
  path: string;
  value?: Json;
  index?: number;
}

function applyOp(root: Json, op: Op): string {
  if (!isObject(op) || typeof op.path !== "string") throw new Error("Each op needs a path.");
  const { parent, last, steps } = resolve(root, op.path);
  const where = describeAt(steps, steps.length);
  switch (op.op) {
    case "set": {
      if (op.value === undefined) throw new Error(`set ${where} needs a value.`);
      if ("key" in last) {
        if (!isObject(parent) && !Array.isArray(parent)) throw new Error(`${describeAt(steps, steps.length - 1)} has no parts to set.`);
        (parent as Record<string, Json>)[last.key] = op.value;
      } else {
        if (!Array.isArray(parent)) throw new Error(`${describeAt(steps, steps.length - 1)} is not a list.`);
        const at = findIn(parent, last.select);
        if (at < 0) throw new Error(`There is nothing called [${last.select}] to set in ${describeAt(steps, steps.length - 1)}. Use insert to add one.`);
        parent[at] = op.value;
      }
      return `set ${where}`;
    }
    case "merge": {
      const target = readAt(root, op.path);
      if (!isObject(target) || !isObject(op.value)) throw new Error(`merge ${where} needs an object there and an object as the value.`);
      Object.assign(target, op.value);
      return `merged into ${where}`;
    }
    case "insert": {
      if (op.value === undefined) throw new Error(`insert into ${where} needs a value.`);
      const target = readAt(root, op.path);
      if (!Array.isArray(target)) throw new Error(`${where} is not a list, so nothing can be inserted into it.`);
      const at = op.index === undefined ? target.length : Math.max(0, Math.min(target.length, Math.trunc(Number(op.index))));
      target.splice(at, 0, op.value);
      return `inserted into ${where} at ${at}`;
    }
    case "remove": {
      if ("key" in last) {
        if (!(isObject(parent) || Array.isArray(parent)) || !(last.key in parent)) throw new Error(`There is no "${last.key}" in ${describeAt(steps, steps.length - 1)} to remove.`);
        if (Array.isArray(parent)) throw new Error(`Remove from a list by position or name: ${describeAt(steps, steps.length - 1)}[...].`);
        delete parent[last.key];
      } else {
        if (!Array.isArray(parent)) throw new Error(`${describeAt(steps, steps.length - 1)} is not a list.`);
        const at = findIn(parent, last.select);
        if (at < 0) throw new Error(`There is nothing called [${last.select}] to remove in ${describeAt(steps, steps.length - 1)}.`);
        parent.splice(at, 1);
      }
      return `removed ${where}`;
    }
    default:
      throw new Error(`op is one of: set, insert, remove, merge (got "${String((op as Op).op)}").`);
  }
}

// -------------------------------------------------------------------- audit --

let instructionIndex: Map<string, CatalogInstruction> | null = null;
const indexed = (): Map<string, CatalogInstruction> => {
  if (!instructionIndex) {
    instructionIndex = new Map();
    for (const i of catalog.instructions) if (i.kind === "action" || i.kind === "condition") instructionIndex.set(`${i.kind}:${i.type}`, i);
  }
  return instructionIndex;
};

/** The event types the editor knows without an extension. */
const EVENT_TYPES = new Set([
  "BuiltinCommonInstructions::Standard",
  "BuiltinCommonInstructions::Comment",
  "BuiltinCommonInstructions::Group",
  "BuiltinCommonInstructions::Repeat",
  "BuiltinCommonInstructions::While",
  "BuiltinCommonInstructions::ForEach",
  "BuiltinCommonInstructions::ForEachChildVariable",
  "BuiltinCommonInstructions::Link",
  "BuiltinCommonInstructions::JsCode",
  "BuiltinCommonInstructions::Else",
]);

/** Names of the things the project's own extensions add: `Extension::Function` and so on are not in the catalog. */
function customTypes(project: Json): Set<string> {
  const out = new Set<string>();
  for (const ext of asArray(project.eventsFunctionsExtensions)) {
    if (!isObject(ext) || typeof ext.name !== "string") continue;
    for (const f of asArray(ext.eventsFunctions)) if (isObject(f) && typeof f.name === "string") out.add(`${ext.name}::${f.name}`);
    for (const b of asArray(ext.eventsBasedBehaviors)) {
      if (!isObject(b) || typeof b.name !== "string") continue;
      for (const f of asArray(b.eventsFunctions)) if (isObject(f) && typeof f.name === "string") out.add(`${ext.name}::${b.name}::${f.name}`);
    }
    for (const o of asArray(ext.eventsBasedObjects)) {
      if (!isObject(o) || typeof o.name !== "string") continue;
      for (const f of asArray(o.eventsFunctions)) if (isObject(f) && typeof f.name === "string") out.add(`${ext.name}::${o.name}::${f.name}`);
    }
  }
  return out;
}

const MOST_WARNINGS = 25;

/** What looks wrong in the game, in terms the agent can act on. Nothing here stops a change: the editor opens what it can. */
function audit(project: Json, scenes?: Set<string>): string[] {
  const warnings: string[] = [];
  const warn = (text: string) => {
    if (warnings.length < MOST_WARNINGS) warnings.push(text);
  };
  const custom = customTypes(project);
  const resources = new Set(asArray(project.resources?.resources).map((r: Json) => r?.name).filter((n: unknown) => typeof n === "string"));
  const globalObjects = new Set(asArray(project.objects).map((o: Json) => o?.name));
  const seenScenes = new Set<string>();

  for (const layout of asArray(project.layouts)) {
    if (!isObject(layout) || typeof layout.name !== "string") continue;
    if (seenScenes.has(layout.name)) warn(`Two scenes are called "${layout.name}".`);
    seenScenes.add(layout.name);
    if (scenes && !scenes.has(layout.name)) continue;
    const here = `scene "${layout.name}"`;
    const names = new Set<string>();
    for (const o of asArray(layout.objects)) {
      if (!isObject(o)) continue;
      if (typeof o.name !== "string" || !o.name) warn(`An object in ${here} has no name.`);
      else if (names.has(o.name) || globalObjects.has(o.name)) warn(`The object name "${o.name}" is used twice in ${here} (scene and global names must differ).`);
      else names.add(o.name);
      if (typeof o.type !== "string") warn(`The object "${o.name}" in ${here} has no type.`);
      else if (!objectTypeKnown(o.type, project)) warn(`The object "${o.name}" in ${here} has an unknown type "${o.type}" (game_catalog lists them).`);
      if (o.type === "Sprite") {
        for (const a of asArray(o.animations)) {
          for (const d of asArray(a?.directions)) {
            for (const s of asArray(d?.sprites)) {
              if (isObject(s) && typeof s.image === "string" && s.image && !resources.has(s.image)) warn(`The object "${o.name}" in ${here} uses the picture "${s.image}", which is not in the game's resources.`);
            }
          }
        }
      }
      for (const b of asArray(o.behaviors)) {
        if (isObject(b) && typeof b.type === "string" && !behaviorTypeKnown(b.type, project)) {
          warn(`The behavior "${b.name}" of "${o.name}" in ${here} has an unknown type "${b.type}".`);
        }
      }
    }
    const groups = new Set(asArray(layout.objectsGroups).map((g: Json) => g?.name));
    for (const i of asArray(layout.instances)) {
      if (isObject(i) && typeof i.name === "string" && !names.has(i.name) && !globalObjects.has(i.name)) warn(`An instance in ${here} is of "${i.name}", which is not an object of the scene or a global one.`);
    }
    const layers = new Set(asArray(layout.layers).map((l: Json) => l?.name));
    for (const i of asArray(layout.instances)) {
      if (isObject(i) && typeof i.layer === "string" && !layers.has(i.layer)) warn(`An instance of "${i.name}" in ${here} is on the layer "${i.layer}", which the scene does not have.`);
    }
    walkEvents(layout.events, `layouts[${layout.name}].events`, (kind, inst, where) => checkInstruction(kind, inst, where, custom, names, globalObjects, groups, warn), (event, where) => {
      if (isObject(event) && typeof event.type === "string" && !EVENT_TYPES.has(event.type) && !/::/.test(event.type)) warn(`${where} has an unknown event type "${event.type}".`);
    });
  }
  if (typeof project.firstLayout === "string" && project.firstLayout && !seenScenes.has(project.firstLayout)) warn(`firstLayout is "${project.firstLayout}", but there is no such scene.`);
  return warnings;
}

const objectTypeKnown = (type: string, project: Json): boolean =>
  catalog.extensions.some((e) => e.objects.some((o) => o.type === type)) || asArray(project.eventsFunctionsExtensions).some((e: Json) => asArray(e?.eventsBasedObjects).some((o: Json) => `${e.name}::${o?.name}` === type));
const behaviorTypeKnown = (type: string, project: Json): boolean =>
  catalog.extensions.some((e) => e.behaviors.some((b) => b.type === type)) || asArray(project.eventsFunctionsExtensions).some((e: Json) => asArray(e?.eventsBasedBehaviors).some((b: Json) => `${e.name}::${b?.name}` === type));

type InstructionVisitor = (kind: "action" | "condition", instruction: Json, where: string) => void;

/** Every instruction in an events list, nested events and sub-instructions included, with the path that finds it again. */
function walkEvents(events: unknown, prefix: string, onInstruction: InstructionVisitor, onEvent?: (event: Json, where: string) => void) {
  const walkInstructions = (list: unknown, kind: "action" | "condition", at: string) => {
    asArray(list).forEach((inst, n) => {
      if (!isObject(inst)) return;
      onInstruction(kind, inst, `${at}[${n}]`);
      walkInstructions(inst.subInstructions, kind, `${at}[${n}].subInstructions`);
    });
  };
  asArray(events).forEach((event, n) => {
    if (!isObject(event)) return;
    const here = `${prefix}[${n}]`;
    onEvent?.(event, here);
    walkInstructions(event.conditions, "condition", `${here}.conditions`);
    walkInstructions(event.whileConditions, "condition", `${here}.whileConditions`);
    walkInstructions(event.actions, "action", `${here}.actions`);
    walkEvents(event.events, `${here}.events`, onInstruction, onEvent);
  });
}

function checkInstruction(
  kind: "action" | "condition",
  inst: Json,
  where: string,
  custom: Set<string>,
  objects: Set<string>,
  globals: Set<unknown>,
  groups: Set<unknown>,
  warn: (text: string) => void,
) {
  const type = isObject(inst.type) ? inst.type.value : inst.type;
  if (typeof type !== "string" || !type) {
    warn(`${where} has no instruction type.`);
    return;
  }
  const known = indexed().get(`${kind}:${type}`);
  if (!known) {
    // What the game's own extensions add is not in the engine's list.
    if (!custom.has(type)) warn(`${where}: "${type}" is not ${kind === "action" ? "an action" : "a condition"} the engine has (game_catalog finds the right one).`);
    return;
  }
  const params = asArray(inst.parameters);
  if (params.length !== known.n) warn(`${where}: ${type} takes ${known.n} parameters, this has ${params.length} (parameter 0 comes first; internal ones are "").`);
  for (const p of known.params) {
    if (p.type === "objectList" || p.type === "object" || p.type === "objectListOrEmptyIfJustDeclared" || p.type === "objectListOrEmptyWithoutPicking" || p.type === "objectPtr") {
      const given = params[p.i];
      if (typeof given === "string" && given && !objects.has(given) && !globals.has(given) && !groups.has(given)) warn(`${where}: "${given}" is not an object or group of this scene.`);
    }
  }
}

// ----------------------------------------------------------------- overviews --

const MOST = 24_000;

const cut = (text: string, hint: string) => (text.length > MOST ? `${text.slice(0, MOST)}\n[cut: ${text.length} characters. ${hint}]` : text);

function sceneLine(layout: Json): string {
  const objects = asArray(layout.objects).length;
  const instances = asArray(layout.instances).length;
  const events = countEvents(layout.events);
  const layers = asArray(layout.layers).filter((l: Json) => l?.name).length;
  return `"${layout.name}": ${objects} objects, ${instances} instances, ${events} events${layers ? `, ${layers} extra layers` : ""}`;
}

function countEvents(events: unknown): number {
  let n = 0;
  for (const e of asArray(events)) {
    n += 1;
    if (isObject(e)) n += countEvents(e.events);
  }
  return n;
}

function describeProject(project: Json): string {
  const props = project.properties ?? {};
  const lines = [
    `Game "${props.name || "Untitled"}" -- ${props.windowWidth ?? 800}x${props.windowHeight ?? 600}, ${props.orientation ?? "landscape"}${props.author ? `, by ${props.author}` : ""}.`,
    `Scenes (${asArray(project.layouts).length}; first: "${project.firstLayout}"):`,
    ...asArray(project.layouts).map((l: Json) => `  ${sceneLine(l)}`),
  ];
  const globals = asArray(project.objects);
  if (globals.length) lines.push(`Global objects: ${globals.map((o: Json) => `${o.name} (${o.type})`).join(", ")}.`);
  const vars = asArray(project.variables);
  if (vars.length) lines.push(`Global variables: ${vars.map((v: Json) => v.name).join(", ")}.`);
  const resources = asArray(project.resources?.resources);
  if (resources.length) lines.push(`Resources: ${resources.length} (${countBy(resources, "kind")}).`);
  const exts = asArray(project.eventsFunctionsExtensions).map((e: Json) => e.name);
  if (exts.length) lines.push(`The game's own extensions: ${exts.join(", ")}.`);
  const used = asArray(project.layouts).flatMap((l: Json) => asArray(l.objects)).length;
  if (!used && !globals.length) lines.push("Nothing is in the game yet: no objects. Add some with game_edit (game_template gives the shape of each).");
  return lines.join("\n");
}

function countBy(list: Json[], key: string): string {
  const counts = new Map<string, number>();
  for (const x of list) counts.set(String(x?.[key] ?? "?"), (counts.get(String(x?.[key] ?? "?")) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
}

function findLayout(project: Json, name: unknown): Json {
  const layouts = asArray(project.layouts);
  if (typeof name !== "string" || !name) {
    if (layouts.length === 1) return layouts[0];
    throw new Error(`Say which scene (scene: ...). The scenes are: ${layouts.map((l: Json) => l.name).join(", ") || "none yet"}.`);
  }
  const found = layouts.find((l: Json) => l.name === name) ?? layouts.find((l: Json) => String(l.name).toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`There is no scene "${name}". The scenes are: ${layouts.map((l: Json) => l.name).join(", ") || "none yet"}.`);
  return found;
}

function describeScene(layout: Json): string {
  const lines = [`Scene ${sceneLine(layout)}.`];
  const bg = `background rgb(${layout.r},${layout.v},${layout.b})`;
  lines.push(`Title "${layout.title ?? ""}", ${bg}.`);
  const objects = asArray(layout.objects);
  if (objects.length) {
    lines.push("Objects:");
    for (const o of objects) {
      const behaviors = asArray(o.behaviors).map((b: Json) => `${b.name}:${b.type}`);
      const vars = asArray(o.variables).map((v: Json) => v.name);
      const counts = asArray(layout.instances).filter((i: Json) => i.name === o.name).length;
      lines.push(`  ${o.name} (${o.type}) x${counts}${behaviors.length ? ` behaviors [${behaviors.join(", ")}]` : ""}${vars.length ? ` variables [${vars.join(", ")}]` : ""}${o.tags ? ` tags "${o.tags}"` : ""}`);
    }
  }
  const groups = asArray(layout.objectsGroups);
  if (groups.length) lines.push(`Groups: ${groups.map((g: Json) => `${g.name} [${asArray(g.objects).map((m: Json) => m.name).join(", ")}]`).join("; ")}.`);
  const layers = asArray(layout.layers);
  lines.push(`Layers: ${layers.map((l: Json) => l.name || "(base)").join(", ")}.`);
  const vars = asArray(layout.variables);
  if (vars.length) lines.push(`Scene variables: ${vars.map((v: Json) => `${v.name}=${JSON.stringify(v.value ?? v.children ?? "")}`).join(", ")}.`);
  return lines.join("\n");
}

const brief = (v: unknown, limit = 90): string => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > limit ? `${s.slice(0, limit - 1)}...` : s;
};

function instructionText(inst: Json, kind: "action" | "condition"): string {
  const type = isObject(inst.type) ? inst.type.value : inst.type;
  const inverted = kind === "condition" && isObject(inst.type) && inst.type.inverted ? "NOT " : "";
  const params = asArray(inst.parameters).map((p) => (typeof p === "string" ? (p === "" ? "''" : p) : brief(p)));
  const subs = asArray(inst.subInstructions).length ? ` {+${asArray(inst.subInstructions).length} sub}` : "";
  return `${inverted}${type}(${params.join(", ")})${subs}`;
}

/** One event as a readable line, then what is under it; the path in front of each finds it again. */
function outlineOne(event: Json, path: string, depth: number, out: string[], maxDepth: number) {
  if (!isObject(event)) return;
  const pad = "  ".repeat(depth);
  const type = String(event.type ?? "?").replace("BuiltinCommonInstructions::", "");
  const off = event.disabled ? " (disabled)" : "";
  if (type === "Comment") {
    out.push(`${pad}${path} # ${String(event.comment ?? "").split("\n")[0].slice(0, 140)}${off}`);
  } else if (type === "Group") {
    out.push(`${pad}${path} GROUP "${event.name ?? ""}"${off}`);
  } else if (type === "Link") {
    out.push(`${pad}${path} LINK to "${event.target ?? ""}"${off}`);
  } else if (type === "JsCode") {
    out.push(`${pad}${path} JS (${String(event.inlineCode ?? "").split("\n").length} lines)${off}`);
  } else {
    const head = type === "Standard" ? "" : `${type.toUpperCase()}${event.repeatExpression ? ` ${event.repeatExpression}` : ""}${event.object ? ` ${event.object}` : ""} `;
    const whileConds = asArray(event.whileConditions).map((c) => instructionText(c, "condition"));
    const conds = asArray(event.conditions).map((c) => instructionText(c, "condition"));
    const acts = asArray(event.actions).map((a) => instructionText(a, "action"));
    out.push(`${pad}${path} ${head}${whileConds.length ? `WHILE ${whileConds.join(" & ")} ` : ""}IF ${conds.length ? conds.join(" & ") : "(always)"} DO ${acts.length ? acts.join("; ") : "(nothing)"}${off}`);
  }
  if (depth + 1 < maxDepth) outline(event.events, `${path}.events`, depth + 1, out, maxDepth);
  else if (asArray(event.events).length) out.push(`${pad}  ... ${countEvents(event.events)} nested events (look at path ${path}.events)`);
}

function outline(events: unknown, prefix: string, depth: number, out: string[], maxDepth: number) {
  asArray(events).forEach((event, n) => outlineOne(event, `${prefix}[${n}]`, depth, out, maxDepth));
}

// ---------------------------------------------------------------- the catalog --

const WORDS = (text: string) => text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

function scopeText(scope?: string): string {
  if (!scope) return "any";
  if (scope === "object:") return "any object";
  return scope.replace(/^object:/, "object ").replace(/^behavior:/, "behavior ");
}

function instructionLine(i: CatalogInstruction): string {
  const params = i.params.map((p) => `${p.i}:${p.type}${p.optional ? "?" : ""} "${p.description}"${p.extra ? ` [${p.extra}]` : ""}${p.default ? ` (default ${p.default})` : ""}`);
  return `${i.kind} ${JSON.stringify(i.type)} -- ${i.name}. ${i.sentence} (${scopeText(i.scope)}; ${i.extension}${i.group ? `, ${i.group}` : ""}) parameters (${i.n}): ${params.length ? params.join("; ") : "none"}`;
}

function searchCatalog(args: Record<string, any>): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const kind = typeof args.kind === "string" ? args.kind : "";
  const extension = typeof args.extension === "string" ? args.extension.trim() : "";
  const forType = typeof args.for === "string" ? args.for.trim() : "";
  const limit = Math.max(1, Math.min(40, Math.trunc(Number(args.limit ?? 12)) || 12));

  if (args.list === "extensions" || (!query && !extension && !forType && !kind)) {
    return `${catalog.extensions.length} extensions. Name: what it adds (objects / behaviors).\n` + catalog.extensions
      .map((e) => `${e.name}: ${e.fullName || e.name}${e.objects.length ? ` -- objects: ${e.objects.map((o) => o.type).join(", ")}` : ""}${e.behaviors.length ? ` -- behaviors: ${e.behaviors.map((b) => b.type).join(", ")}` : ""}`)
      .join("\n") + "\nSearch with query (words), and narrow with kind (action, condition, expression, strExpression), extension, or for (an object type like Sprite or a behavior type).";
  }
  if (args.list === "objects" || args.list === "behaviors") {
    const rows = catalog.extensions.flatMap((e) => (args.list === "objects" ? e.objects : e.behaviors).map((x) => `${x.type} -- ${x.name}${x.description ? `: ${x.description.slice(0, 140)}` : ""}`));
    return rows.join("\n");
  }
  const words = WORDS(query);
  const scored: Array<{ i: CatalogInstruction; score: number }> = [];
  for (const i of catalog.instructions) {
    if (kind && i.kind !== kind) continue;
    if (extension && i.extension.toLowerCase() !== extension.toLowerCase()) continue;
    if (forType) {
      const t = forType.toLowerCase();
      const scope = (i.scope ?? "").toLowerCase();
      // An instruction on "any object" works on every object type; one on a type or behavior only on that.
      if (scope && scope !== "object:" && !scope.endsWith(`:${t}`) && !scope.includes(`${t}`)) continue;
    }
    let score = 0;
    if (words.length) {
      const hay = `${i.type} ${i.name} ${i.sentence} ${i.group} ${i.extension}`.toLowerCase();
      const type = i.type.toLowerCase();
      for (const w of words) {
        if (type === w) score += 20;
        else if (type.includes(w)) score += 6;
        else if (hay.includes(w)) score += 3;
        else {
          score = -1;
          break;
        }
      }
      if (score < 0) continue;
    }
    scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score || a.i.type.length - b.i.type.length);
  if (!scored.length) return `Nothing matches. Try fewer or different words, or list extensions (list: "extensions"). In GDevelop an action reads like "Change the X position" and a condition like "Key pressed".`;
  const shown = scored.slice(0, limit);
  return cut(`${scored.length} match${scored.length === 1 ? "" : "es"}${scored.length > shown.length ? `, the first ${shown.length}` : ""}. Use "type" as instruction.type.value; parameters go in the order given (index:type), internal ones as "".\n` + shown.map((s) => instructionLine(s.i)).join("\n"), "Narrow it with kind, extension or for.");
}

/** The shapes of things the editor saves, for the agent to copy: engine-made where the engine can make them. */
const EVENT_TEMPLATES: Record<string, Json> = {
  event: { type: "BuiltinCommonInstructions::Standard", conditions: [], actions: [], events: [] },
  comment: { type: "BuiltinCommonInstructions::Comment", color: { b: 109, g: 230, r: 255, textB: 0, textG: 0, textR: 0 }, comment: "A note", comment2: "" },
  group: { type: "BuiltinCommonInstructions::Group", name: "A group", source: "", color: { b: 109, g: 230, r: 255, textB: 0, textG: 0, textR: 0 }, creationTime: 0, events: [] },
  repeat: { type: "BuiltinCommonInstructions::Repeat", repeatExpression: "3", conditions: [], actions: [], events: [] },
  while: { type: "BuiltinCommonInstructions::While", whileConditions: [], conditions: [], actions: [], events: [] },
  foreach: { type: "BuiltinCommonInstructions::ForEach", object: "ObjectName", conditions: [], actions: [], events: [] },
  condition: { type: { inverted: false, value: "TypeFromGameCatalog" }, parameters: ["", "..."], subInstructions: [] },
  action: { type: { value: "TypeFromGameCatalog" }, parameters: ["", "..."], subInstructions: [] },
  variable: { name: "Score", type: "number", value: 0 },
  "variable-structure": { name: "Player", type: "structure", children: [{ name: "Health", type: "number", value: 100 }] },
  "object-group": { name: "Enemies", objects: [{ name: "Enemy1" }, { name: "Enemy2" }] },
};

function templateFor(args: Record<string, any>): { ok: boolean; text: string } {
  const kind = String(args.kind ?? "").toLowerCase();
  const type = typeof args.type === "string" ? args.type.trim() : "";
  const t = catalog.templates;
  const json = (v: Json) => JSON.stringify(v, null, 1);
  switch (kind) {
    case "scene":
      return { ok: true, text: `A new scene. Give it a name (and mangledName: the name with letters, digits and _ only), then insert it into layouts.\n${json(t.scene)}` };
    case "layer":
      return { ok: true, text: `A layer, for a scene's layers list (the base layer is named "").\n${json({ ...t.layer, name: "Layer 2" })}` };
    case "instance":
      return { ok: true, text: `An instance: one placed copy of an object, for a scene's instances. name is the object's name; x, y in pixels (zOrder: higher is in front).\n${json({ ...t.instance, name: "ObjectName" })}` };
    case "object": {
      if (!type) return { ok: false, text: `Say which type. Object types: ${Object.keys(t.objects).join(", ")}.` };
      const found = t.objects[type] ?? t.objects[Object.keys(t.objects).find((k) => k.toLowerCase() === type.toLowerCase() || k.toLowerCase().endsWith(`::${type.toLowerCase()}`)) ?? ""];
      if (!found) return { ok: false, text: `No object type "${type}". Object types: ${Object.keys(t.objects).join(", ")}.` };
      return { ok: true, text: `A new ${found.type} object, for a scene's objects (or the game's, for a global one). Rename it; Sprites get their pictures in animations (see resources).\n${json({ ...found, name: "ObjectName" })}` };
    }
    case "behavior": {
      if (!type) return { ok: false, text: `Say which type. Behavior types: ${Object.keys(t.behaviors).join(", ")}.` };
      const key = Object.keys(t.behaviors).find((k) => k === type) ?? Object.keys(t.behaviors).find((k) => k.toLowerCase() === type.toLowerCase() || k.toLowerCase().endsWith(`::${type.toLowerCase()}`));
      if (!key) return { ok: false, text: `No behavior type "${type}". Behavior types: ${Object.keys(t.behaviors).join(", ")}.` };
      return { ok: true, text: `A ${key} behavior, for an object's behaviors list. Give it a name; the numbers are its defaults. Behaviors that share data across the scene (physics) also need an entry in the scene's behaviorsSharedData, which the editor adds when the scene opens.\n${json({ ...t.behaviors[key], name: key.split("::").pop() })}` };
    }
    case "resource": {
      const found = t.resources[type || "image"];
      if (!found) return { ok: false, text: `Resource kinds: ${Object.keys(t.resources).join(", ")}.` };
      return { ok: true, text: `A resource of kind ${found.kind}, for resources.resources: name is what objects refer to, file is its address. game_import makes these for a file.\n${json(found)}` };
    }
    default: {
      const found = EVENT_TEMPLATES[kind];
      if (!found) return { ok: false, text: `kind is one of: scene, layer, instance, object, behavior, resource, ${Object.keys(EVENT_TEMPLATES).join(", ")}.` };
      const extra = kind === "event" ? " Conditions all hold for the actions to run; with none the actions run every frame. Nested events run when their parent's conditions hold." : kind === "condition" || kind === "action" ? " Take type and the parameter list from game_catalog; parameters are strings, in order from 0." : "";
      return { ok: true, text: `${kind}:${extra}\n${json(found)}` };
    }
  }
}

// ----------------------------------------------------------------- previews --

/**
 * The files of the game being previewed (a page, its data, the code the editor generated), kept in memory: they are made again
 * by every preview and are nobody's to keep. Served from /api/game/:session/preview/<instance>/..., each in a box of its own
 * (`sandbox`: the game is code, and it runs without this app's origin, so it cannot reach the app's API or cookies).
 */
interface PreviewFile {
  bytes: Buffer;
  type: string;
}

const previews = new Map<string, Map<string, PreviewFile>>();
const PREVIEW_FILE_MAX = 32 * 1024 * 1024;
const PREVIEW_TOTAL_MAX = 192 * 1024 * 1024;

const previewTotal = (files: Map<string, PreviewFile>) => [...files.values()].reduce((n, f) => n + f.bytes.length, 0);

/** "/abc123/preview/index.html" cleaned to the same without anything that could climb out of it, or null. */
function previewPath(raw: string): string | null {
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.length > 12) return null;
  if (!parts.every((p) => /^[A-Za-z0-9._@~+,=()-]{1,160}$/.test(p) && p !== "." && p !== "..")) return null;
  return `/${parts.join("/")}`;
}

function keepPreview(session: string, file: string, bytes: Buffer, type: string) {
  let files = previews.get(session);
  if (!files) previews.set(session, (files = new Map()));
  files.delete(file);
  files.set(file, { bytes, type });
  // Old previews go first: the budget is the newest ones.
  for (const old of files.keys()) {
    if (previewTotal(files) <= PREVIEW_TOTAL_MAX) break;
    if (old !== file) files.delete(old);
  }
}

/** The page a preview is: the game's, in a box of its own, that may use the pointer, sound and the keyboard but not this app. */
const PREVIEW_CSP = "sandbox allow-scripts allow-modals allow-pointer-lock allow-forms allow-downloads";

// ------------------------------------------------------------------- assets --

const assetsDir = (session: string) => path.join(stateDir(), "game-assets", session);

/** What a game file may be, by its extension: the kinds of resource GDevelop has. */
const ASSET_TYPES: Record<string, { mime: string; kind: string }> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".webp": { mime: "image/webp", kind: "image" },
  ".svg": { mime: "image/svg+xml", kind: "image" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".aac": { mime: "audio/aac", kind: "audio" },
  ".ttf": { mime: "font/ttf", kind: "font" },
  ".otf": { mime: "font/otf", kind: "font" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".json": { mime: "application/json", kind: "json" },
  ".glb": { mime: "model/gltf-binary", kind: "model3D" },
  ".gltf": { mime: "model/gltf+json", kind: "model3D" },
  ".fnt": { mime: "application/octet-stream", kind: "bitmapFont" },
  ".xml": { mime: "application/xml", kind: "bitmapFont" },
};

const MAX_ASSET = 50 * 1024 * 1024;

/** A file name that is safe to keep and to put in an address. */
function assetName(wanted: string): string {
  const ext = path.extname(wanted).toLowerCase();
  const base = path.basename(wanted, path.extname(wanted)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 60) || "file";
  return `${base}${ext}`;
}

/** Keep a file with the game; the answer is the name it is kept under (a number is added if it is taken). */
function keepAsset(session: string, wanted: string, data: Buffer): { file: string; url: string; kind: string } {
  const ext = path.extname(wanted).toLowerCase();
  const type = ASSET_TYPES[ext];
  if (!type) throw new Error(`A game cannot use "${path.extname(wanted) || wanted}" files. It takes pictures (png, jpg, gif, webp, svg), sound (mp3, wav, ogg, m4a), fonts (ttf, otf), video (mp4, webm), 3D models (glb, gltf) and json.`);
  if (data.length > MAX_ASSET) throw new Error(`That file is ${(data.length / 1048576).toFixed(0)} MB; a game's files may be up to ${MAX_ASSET / 1048576} MB.`);
  const dir = assetsDir(session);
  fs.mkdirSync(dir, { recursive: true });
  let name = assetName(wanted);
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = assetName(wanted).replace(/(\.[^.]+)$/, `-${n}$1`);
  fs.writeFileSync(path.join(dir, name), data);
  return { file: name, url: `/api/game/${session}/assets/${encodeURIComponent(name)}`, kind: type.kind };
}

/** The entry for `resources.resources` that makes a kept file usable by name. */
function resourceFor(kind: string, name: string, url: string): Json {
  const base = catalog.templates.resources[kind] ?? catalog.templates.resources.image;
  return { ...JSON.parse(JSON.stringify(base)), name, file: url, userAdded: true, origin: { identifier: url, name: "url" } };
}

// -------------------------------------------------------------------- tools --

interface GameToolHooks {
  /** Where "the person's files" are: a path the agent gives is looked for here. */
  cwd?: string;
}

interface Outcome {
  ok: boolean;
  summary: string;
  preview?: string;
}

const need = (args: Record<string, any>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required.`);
  return v.trim();
};

/**
 * Runs one `game_*` tool on the chat's game. Never throws: a bad call comes back as { ok: false, summary } saying what was wrong
 * and what to try.
 */
export async function runGameTool(session: string, name: string, args: Record<string, any>, hooks: GameToolHooks = {}): Promise<Outcome> {
  if (!validSession(session)) return { ok: false, summary: "Autora Games needs a chat to work in." };
  try {
    switch (name) {
      case "game_open": {
        const project = projectOf(session);
        const entry = entryFor(session);
        if (typeof args.name === "string" && args.name.trim()) {
          const next = JSON.parse(JSON.stringify(project));
          next.properties.name = args.name.trim().slice(0, 120);
          commit(session, next, "agent");
        }
        entry.by = "agent";
        setOpen(session, true);
        changed(session);
        return { ok: true, summary: describeProject(entryFor(session).project), preview: `opened "${entryFor(session).project.properties?.name ?? "the game"}"` };
      }

      case "game_look": {
        const project = projectOf(session);
        const what = typeof args.what === "string" && args.what ? args.what : "overview";
        switch (what) {
          case "overview":
            return { ok: true, summary: describeProject(project), preview: "overview" };
          case "scene": {
            const layout = findLayout(project, args.scene);
            return { ok: true, summary: cut(describeScene(layout), "Look at one object with what: object."), preview: `scene ${layout.name}` };
          }
          case "object": {
            const object = need(args, "object");
            const layout = typeof args.scene === "string" && args.scene ? findLayout(project, args.scene) : null;
            const here = layout ? asArray(layout.objects).find((o: Json) => o.name === object) : null;
            const found = here ?? asArray(project.objects).find((o: Json) => o.name === object);
            if (!found) {
              const names = [...(layout ? asArray(layout.objects) : []), ...asArray(project.objects)].map((o: Json) => o.name);
              return { ok: false, summary: `There is no object "${object}"${layout ? ` in "${layout.name}" or among the global objects` : ""}. Objects: ${names.join(", ") || "none"}.` };
            }
            return { ok: true, summary: cut(JSON.stringify(found, null, 1), "Ask for a part with what: json and a path."), preview: `object ${object}` };
          }
          case "events": {
            const layout = findLayout(project, args.scene);
            const out: string[] = [];
            const depth = Math.max(1, Math.min(12, Math.trunc(Number(args.depth ?? 4)) || 4));
            const where = typeof args.path === "string" ? args.path.trim() : "";
            if (where) {
              // One event and what is under it, by the path an earlier look gave.
              outlineOne(readAt(layout, where), `layouts[${layout.name}].${where}`, 0, out, depth);
            } else {
              outline(layout.events, `layouts[${layout.name}].events`, 0, out, depth);
            }
            return { ok: true, summary: cut(out.length ? out.join("\n") : `"${layout.name}" has no events yet.`, "Look at part of it with path: events[3]."), preview: `events of ${layout.name}` };
          }
          case "instances": {
            const layout = findLayout(project, args.scene);
            const only = typeof args.object === "string" ? args.object : "";
            const list = asArray(layout.instances).map((i: Json, n: number) => ({ n, i })).filter(({ i }) => !only || i.name === only);
            const lines = list.slice(0, 300).map(({ n, i }) => `[${n}] ${i.name} at (${i.x}, ${i.y})${i.zOrder ? ` z${i.zOrder}` : ""}${i.layer ? ` layer "${i.layer}"` : ""}${i.customSize ? ` size ${i.width}x${i.height}` : ""}${i.angle ? ` angle ${i.angle}` : ""}`);
            return { ok: true, summary: cut(`${list.length} instances in "${layout.name}"${only ? ` of ${only}` : ""}:\n${lines.join("\n")}${list.length > 300 ? `\n... and ${list.length - 300} more` : ""}`, "Ask for one object."), preview: `instances in ${layout.name}` };
          }
          case "resources": {
            const list = asArray(project.resources?.resources);
            return { ok: true, summary: list.length ? list.map((r: Json) => `${r.name} (${r.kind}) ${String(r.file).slice(0, 100)}`).join("\n") : "The game has no resources yet. game_import adds a picture or sound.", preview: "resources" };
          }
          case "json": {
            const where = need(args, "path");
            return { ok: true, summary: cut(JSON.stringify(readAt(project, where), null, 1) ?? "undefined", "Ask for a smaller part of it."), preview: where };
          }
          default:
            return { ok: false, summary: "what is one of: overview, scene, object, events, instances, resources, json." };
        }
      }

      case "game_edit": {
        const ops = Array.isArray(args.ops) ? (args.ops as Op[]) : null;
        if (!ops || !ops.length) return { ok: false, summary: "ops is a list of { op, path, value }: op is set, insert, remove or merge." };
        if (ops.length > 200) return { ok: false, summary: "At most 200 ops in one call." };
        const base = projectOf(session);
        const next: Json = JSON.parse(JSON.stringify(base));
        const done: string[] = [];
        for (let n = 0; n < ops.length; n++) {
          try {
            done.push(applyOp(next, ops[n]));
          } catch (err) {
            return { ok: false, summary: `Op ${n + 1} of ${ops.length} did not work, so nothing was changed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        if (!looksLikeGame(next)) return { ok: false, summary: "That would leave something that is not a game (layouts and properties must stay, and every scene needs a name). Nothing was changed." };
        const touched = new Set<string>();
        for (const op of ops) {
          const m = /^layouts\[([^\]]+)\]/.exec(String(op.path));
          if (m) touched.add(m[1]);
          else if (/^layouts$/.test(String(op.path)) && isObject(op.value) && typeof op.value.name === "string") touched.add(op.value.name);
        }
        const warnings = audit(next, touched.size ? new Set([...touched].filter((t) => !/^\d+$/.test(t))) : undefined);
        const before = JSON.stringify(base);
        if (JSON.stringify(next) === before) return { ok: true, summary: "Nothing changed: the game already was like that.", preview: "no change" };
        entryFor(session).by = "agent";
        setOpen(session, true);
        commit(session, next, "agent");
        return {
          ok: true,
          summary: `${done.length === 1 ? done[0] : `${done.length} changes made`}.${warnings.length ? `\nCheck these (they are saved, and the editor shows them red where it can):\n- ${warnings.join("\n- ")}` : ""}`,
          preview: done.length === 1 ? done[0] : `${done.length} changes`,
        };
      }

      case "game_check": {
        const project = projectOf(session);
        const warnings = audit(project);
        return { ok: true, summary: warnings.length ? `${warnings.length} thing${warnings.length === 1 ? "" : "s"} to look at:\n- ${warnings.join("\n- ")}` : "Nothing looks wrong: every instruction exists with the right number of parameters, every instance has its object, every picture is in the resources.", preview: warnings.length ? `${warnings.length} to look at` : "all clear" };
      }

      case "game_catalog":
        return { ok: true, summary: searchCatalog(args), preview: typeof args.query === "string" && args.query ? args.query : "the engine's catalog" };

      case "game_template": {
        const t = templateFor(args);
        return { ok: t.ok, summary: t.text, preview: String(args.kind ?? "") };
      }

      case "game_import": {
        const given = need(args, "file");
        const art = /^file_[0-9a-f]{16}$/.test(given) ? getArtifact(given) : null;
        let file = art ? artifactPath(art.id) : path.resolve(hooks.cwd ?? process.cwd(), given);
        if (!art && !fs.existsSync(file)) {
          const named = hooks.cwd && fs.existsSync(path.resolve(hooks.cwd, path.basename(given))) ? path.resolve(hooks.cwd, path.basename(given)) : null;
          if (!named) return { ok: false, summary: `There is no file "${given}": give an artifact id (file_...) or a path on this host.` };
          file = named;
        }
        if (!fs.statSync(file).isFile()) return { ok: false, summary: `${file} is not a file.` };
        const wanted = String(args.name ?? art?.name ?? path.basename(file));
        const kept = keepAsset(session, wanted, fs.readFileSync(file));
        const project = JSON.parse(JSON.stringify(projectOf(session)));
        normalize(project);
        const resourceName = typeof args.resource === "string" && args.resource.trim() ? args.resource.trim() : kept.file;
        const list: Json[] = project.resources.resources;
        if (list.some((r) => r?.name === resourceName)) return { ok: false, summary: `The game already has a resource called "${resourceName}". Pass resource with another name, or look at what is there with game_look resources.` };
        list.push(resourceFor(kept.kind, resourceName, kept.url));
        entryFor(session).by = "agent";
        setOpen(session, true);
        commit(session, project, "agent");
        return { ok: true, summary: `Added the ${kept.kind} "${resourceName}" to the game's resources. Use that name where an object or an instruction takes a ${kept.kind}${kept.kind === "image" ? ` (a Sprite's animations[].directions[].sprites[].image; game_template object Sprite shows where)` : ""}.`, preview: `imported ${resourceName}` };
      }

      default:
        return { ok: false, summary: `Unknown tool "${name}".` };
    }
  } catch (err) {
    return { ok: false, summary: `Autora Games could not do that: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What the agent is told about the game window. */
export function gameBriefing(on: boolean): string {
  if (!on) {
    return "- Autora Games (the game window, GDevelop's editor): switched off on the Tools page. Do not try to make a game with it, and if asked, say it is off.";
  }
  return (
    "- Autora Games (the game window, GDevelop's editor): available. Tools: game_open, game_look, game_edit, game_check, game_catalog, " +
    "game_template and game_import. The game is the project file GDevelop saves (JSON: scenes, objects, behaviors, instances, events, " +
    "resources); you read and change it with game_look and game_edit (set, insert, remove, merge at a path such as " +
    "layouts[Scene].objects[Player].behaviors), and the person sees it change in the editor beside the chat and can change anything " +
    "by hand: call game_look again before relying on what you saw earlier. Never write an instruction from memory: search the engine's " +
    "own list with game_catalog (it has the exact type and the parameter order), copy shapes from game_template, and run game_check " +
    "before you say a game is done. The technical work (events, behaviors, physics, wiring, the settings that make it run) is yours: " +
    "do it completely. The creative choices (the idea, the story, the characters, the world, the look, how it feels, the levels) are " +
    "theirs: ask, suggest and explain, and let them choose; if they ask for an action or a property (\"make it slippery\", \"jump\"), " +
    "make it and leave every setting where they can change it."
  );
}

// ------------------------------------------------------------------ routes --

const bigJson = express.json({ limit: "64mb" });

/** The window's side of the wire: its state, its game, its files, and opening and putting it away. */
export function gameRoutes(app: Express, opts: { exists: (session: string) => boolean; incognito: (session: string) => boolean; off: () => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!gameAvailable()) {
      res.status(503).json({ error: "Autora Games is not built into this server." });
      return null;
    }
    return id;
  };

  app.get("/api/game/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(gameState(id));
  });

  app.get("/api/game/:session/project", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ project: projectOf(id), rev: entryFor(id).rev });
  });

  /* What the person did in the editor. Refused when the game moved on since the editor took it (the agent changed it), and
     when it is not a game at all, so a stale or malformed save is never kept. */
  app.put("/api/game/:session/project", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Games is switched off on the Tools page." });
    const project = req.body?.project;
    if (!looksLikeGame(project)) return res.status(400).json({ error: "That is not a game." });
    const entry = entryFor(id);
    const had = req.body?.ifRev;
    if (typeof had === "number" && had !== entry.rev) return res.status(409).json({ error: "The game changed since it was opened.", rev: entry.rev });
    if (JSON.stringify(project) === JSON.stringify(entry.project)) return res.json({ rev: entry.rev });
    commit(id, project, "person");
    res.json({ rev: entry.rev });
  });

  /* The person opens it from the toolbox: the game of this chat, started if there is none. */
  app.post("/api/game/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Games is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no game window." });
    projectOf(id);
    setOpen(id, true);
    res.json({ ...gameState(id), name: "Your game" });
  });

  app.post("/api/game/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(gameState(id));
  });

  /* The files of a preview, from the editor (which makes them: GDevelop's exporter writes the page, the data and the code),
     and the game running from them. */
  app.put("/api/game/:session/preview/*", express.raw({ type: () => true, limit: `${PREVIEW_FILE_MAX}b` }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Games is switched off on the Tools page." });
    const file = previewPath(String((req.params as Record<string, string>)[0] ?? ""));
    if (!file) return res.status(400).json({ error: "That is not a path a preview file can have." });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    keepPreview(id, file, body, String(req.headers["content-type"] ?? "application/octet-stream"));
    res.json({ ok: true });
  });

  app.delete("/api/game/:session/preview", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const prefix = previewPath(String(req.query.prefix ?? ""));
    const files = previews.get(id);
    let deleted = 0;
    if (prefix && files) {
      const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
      for (const name of [...files.keys()]) {
        if (name === prefix || name.startsWith(dir)) {
          files.delete(name);
          deleted++;
        }
      }
    }
    res.json({ deleted });
  });

  app.get("/api/game/:session/preview/*", (req, res) => {
    const id = String(req.params.session);
    if (!validSession(id)) return res.status(404).end();
    const file = previewPath(String((req.params as Record<string, string>)[0] ?? ""));
    const found = file ? previews.get(id)?.get(file) : undefined;
    if (!found) return res.status(404).end();
    res.setHeader("Content-Type", found.type);
    res.setHeader("Content-Security-Policy", PREVIEW_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The game in its box has no origin, so it reads its own files across origins.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.send(found.bytes);
  });

  /* A file the person chose in the editor, kept with the game. The answer is its address. */
  app.post("/api/game/:session/assets", express.raw({ type: () => true, limit: `${MAX_ASSET}b` }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Games is switched off on the Tools page." });
    try {
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: "No file was sent." });
      const kept = keepAsset(id, String(req.query.name ?? "file"), body);
      res.json({ url: kept.url, name: kept.file, kind: kept.kind });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* A file of the game, to the editor and to the game running from it. Never as a page of this origin: whatever it is, it
     is only ever shown as a picture, a sound or data, and `sandbox` keeps even a file opened by address in its own box. */
  app.get("/api/game/:session/assets/:file", (req, res) => {
    const id = String(req.params.session);
    if (!validSession(id)) return res.status(404).end();
    const file = path.basename(String(req.params.file));
    const type = ASSET_TYPES[path.extname(file).toLowerCase()];
    const full = path.join(assetsDir(id), file);
    if (!type || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader("Content-Type", type.mime);
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // A game running in a box of its own asks for these across origins.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(full).pipe(res);
  });
}

/**
 * The editor's page, served to the frame that holds it. It is Autora's own build of GDevelop's editor, in a frame of this
 * origin (the window talks to it by postMessage and it saves through the routes above), so it may be framed by this app and
 * by nothing else, and it may connect to this origin and nowhere else: GDevelop's editor asks its own servers for courses,
 * news and a shop, and none of that is wanted here.
 */
export function serveGame(app: Express, dist: string): void {
  // The runtime a game is made of, read by the game in its box (no origin, so across origins): it is code, public.
  app.use("/gdevelop-editor/GDJS", (_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  app.use(
    "/gdevelop-editor",
    (_req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          // The editor runs the engine (WebAssembly) and PIXI, which builds its shaders with `new Function` (without
          // `unsafe-eval` its renderer refuses to start: "Current environment does not allow unsafe-eval").
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self' data: blob:",
          "frame-src 'self' blob:",
          "frame-ancestors 'self'",
        ].join("; "),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    ...staticDir(path.join(dist, "gdevelop-editor"), { fallthrough: false }),
  );
}
