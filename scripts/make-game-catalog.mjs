/**
 * Writes server/game-catalog.json: every action, condition and expression GDevelop's engine knows, the
 * objects and behaviors they belong to, and their parameters. The agent looks things up in it
 * (game_catalog, server/gamedesk.ts) so that it writes the instruction GDevelop really has ("MettreX",
 * "KeyPressed") rather than one it guesses.
 *
 *   node scripts/make-game-catalog.mjs
 *
 * It runs GDevelop's own engine (libGD.js) and loads the extensions the editor loads (the prepared tree,
 * gdevelop-editor/work), so it reads the same metadata the editor shows. Run it when the pin moves and
 * commit the result; tests/game.test.ts checks that it is the shape the server reads.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "gdevelop-editor/work/newIDE/app");
spawnSync("node", [path.join(root, "scripts/prepare-gdevelop-editor.mjs")], { stdio: "inherit" });
const require = createRequire(path.join(app, "scripts/x.js"));

const mapFor = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const initializeGDevelopJs = require(path.join(app, "public/libGD.js"));
const makeExtensionsLoader = require(path.join(app, "src/JsExtensionsLoader/LocalJsExtensionsLoader.js"));

const gd = await initializeGDevelopJs();
// The loader finds the extensions' JsExtension.js files in the runtime that was imported beside the editor.
const loaded = await makeExtensionsLoader({ gd, objectsEditorService: null, objectsRenderingService: null, filterExamples: true, onFindGDJS: async () => ({ gdjsRoot: path.join(app, "resources/GDJS") }) }).loadAllExtensions((s) => s);
if (loaded.messages?.length) console.log(loaded.messages.join("\n"));

const text = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function params(meta) {
  const list = meta.getParameters();
  return mapFor(list.getParametersCount(), (i) => {
    const p = list.getParameterAt(i);
    if (p.isCodeOnly()) return null;
    // `i` is the place in the instruction's parameters list: code-only parameters keep theirs (as ""), so it is not always the count so far.
    const out = { i, type: p.getType(), description: text(p.getDescription()) };
    if (p.isOptional()) out.optional = true;
    const extra = text(p.getExtraInfo());
    if (extra) out.extra = extra;
    const def = text(p.getDefaultValue());
    if (def) out.default = def;
    return out;
  }).filter(Boolean);
}

const instructions = [];

function addInstructions(map, kind, scope, ext) {
  for (const type of map.keys().toJSArray()) {
    const meta = map.get(type);
    if (meta.isHidden() || meta.isPrivate()) continue;
    instructions.push({
      kind,
      type,
      extension: ext,
      ...(scope ? { scope } : {}),
      name: text(meta.getFullName()),
      sentence: text(meta.getSentence()),
      group: text(meta.getGroup()),
      n: meta.getParameters().getParametersCount(),
      params: params(meta),
    });
  }
}

function addExpressions(map, kind, scope, ext) {
  for (const type of map.keys().toJSArray()) {
    const meta = map.get(type);
    if (!meta.isShown() || meta.isPrivate()) continue;
    instructions.push({
      kind,
      type,
      extension: ext,
      ...(scope ? { scope } : {}),
      name: text(meta.getFullName()),
      sentence: text(meta.getDescription()),
      group: text(meta.getGroup()),
      n: meta.getParameters().getParametersCount(),
      params: params(meta),
    });
  }
}

const extensions = [];
const all = gd.JsPlatform.get().getAllPlatformExtensions();
for (let i = 0; i < all.size(); i++) {
  const ext = all.at(i);
  const name = ext.getName();
  if (ext.isHidden?.()) continue;
  const objectTypes = ext.getExtensionObjectsTypes().toJSArray().filter((t) => !ext.getObjectMetadata(t).isPrivate());
  const behaviorTypes = ext.getBehaviorsTypes().toJSArray().filter((t) => !ext.getBehaviorMetadata(t).isPrivate());
  extensions.push({
    name,
    fullName: text(ext.getFullName()),
    description: text(ext.getDescription()),
    objects: objectTypes.map((t) => ({ type: t, name: text(ext.getObjectMetadata(t).getFullName()), description: text(ext.getObjectMetadata(t).getDescription()) })),
    behaviors: behaviorTypes.map((t) => ({ type: t, name: text(ext.getBehaviorMetadata(t).getFullName()), description: text(ext.getBehaviorMetadata(t).getDescription()) })),
  });
  addInstructions(ext.getAllActions(), "action", "", name);
  addInstructions(ext.getAllConditions(), "condition", "", name);
  addExpressions(ext.getAllExpressions(), "expression", "", name);
  addExpressions(ext.getAllStrExpressions(), "strExpression", "", name);
  for (const t of objectTypes) {
    addInstructions(ext.getAllActionsForObject(t), "action", `object:${t}`, name);
    addInstructions(ext.getAllConditionsForObject(t), "condition", `object:${t}`, name);
    addExpressions(ext.getAllExpressionsForObject(t), "expression", `object:${t}`, name);
    addExpressions(ext.getAllStrExpressionsForObject(t), "strExpression", `object:${t}`, name);
  }
  for (const t of behaviorTypes) {
    addInstructions(ext.getAllActionsForBehavior(t), "action", `behavior:${t}`, name);
    addInstructions(ext.getAllConditionsForBehavior(t), "condition", `behavior:${t}`, name);
    addExpressions(ext.getAllExpressionsForBehavior(t), "expression", `behavior:${t}`, name);
    addExpressions(ext.getAllStrExpressionsForBehavior(t), "strExpression", `behavior:${t}`, name);
  }
}

/* What a new thing looks like when the editor saves it: the engine makes one of each, in a scratch game, and it is
   serialized the way a project file is. The agent copies these rather than remembering the format. */
const serialize = (o) => {
  const el = new gd.SerializerElement();
  o.serializeTo(el);
  return JSON.parse(gd.Serializer.toJSON(el));
};
const scratch = gd.ProjectHelper.createNewGDJSProject();
const layout = scratch.insertNewLayout("Scratch", 0);
const objects = {};
for (const e of extensions) {
  for (const o of e.objects) {
    try {
      layout.getObjects().insertNewObject(scratch, o.type, "Thing", 0);
      objects[o.type] = serialize(layout).objects[0];
      layout.getObjects().removeObject("Thing");
    } catch (error) {
      console.log(`no template for object ${o.type}: ${error}`);
    }
  }
}
const behaviors = {};
for (const e of extensions) {
  for (const b of e.behaviors) {
    for (const host of ["Sprite", ...Object.keys(objects)]) {
      try {
        layout.getObjects().insertNewObject(scratch, host, "Host", 0);
        const object = layout.getObjects().getObject("Host");
        if (object.addNewBehavior(scratch, b.type, "Behavior")) {
          behaviors[b.type] = serialize(layout).objects[0].behaviors?.[0];
          layout.getObjects().removeObject("Host");
          break;
        }
        layout.getObjects().removeObject("Host");
      } catch {
        try { layout.getObjects().removeObject("Host"); } catch { /* it was never made */ }
      }
    }
    if (!behaviors[b.type]) console.log(`no template for behavior ${b.type}`);
  }
}
const resources = {};
for (const [kind, ctor] of [["image", "ImageResource"], ["audio", "AudioResource"], ["font", "FontResource"], ["video", "VideoResource"], ["json", "JsonResource"], ["model3D", "Model3DResource"], ["bitmapFont", "BitmapFontResource"], ["javascript", "JavaScriptResource"]]) {
  try {
    const r = new gd[ctor]();
    r.setName("thing");
    r.setFile("thing");
    scratch.getResourcesManager().addResource(r);
    resources[kind] = serialize(scratch).resources.resources.find((x) => x.name === "thing");
    scratch.getResourcesManager().removeResource("thing");
  } catch (error) {
    console.log(`no template for resource ${kind}: ${error}`);
  }
}
const instance = layout.getInitialInstances().insertNewInitialInstance();
instance.setObjectName("Thing");
const layer = serialize(layout).layers?.[0];
const templates = {
  scene: serialize(layout),
  layer,
  instance: serialize(instance),
  objects,
  behaviors,
  resources,
};
delete templates.instance.persistentUuid;
templates.scene.instances = [];
templates.scene.name = "New scene";
templates.scene.mangledName = "New_scene";

const out = path.join(root, "server/game-catalog.json");
fs.writeFileSync(out, JSON.stringify({ extensions, instructions, templates }) + "\n");
console.log(`${extensions.length} extensions, ${instructions.length} instructions -> ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
process.exit(0);
