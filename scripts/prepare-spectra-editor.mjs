/**
 * Puts Spectra-PDF's renderer where spectra-editor/ builds it from:
 * spectra-editor/src/renderer/, which is not in this repository.
 *
 *   node scripts/prepare-spectra-editor.mjs
 *
 * The renderer is ~340,000 lines of someone else's code. It used to be copied
 * in whole; it is now fetched from the commit pinned in spectra/PIN.json (the
 * same pin as the engine) and Autora's changes to it are applied on top:
 *
 *   spectra-editor/overlay/renderer.patch   edits to three of Spectra's files
 *   spectra-editor/overlay/renderer/*       files Autora adds beside them
 *
 * To change what Autora does to Spectra, edit those, never the fetched copy
 * (it is replaced whenever the pin or the overlay changes). To take a newer
 * Spectra, move the sha in spectra/PIN.json and make the patch apply.
 *
 * Needs git and the network the first time; after that .cache/spectra holds it.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkout, pin, root, src } from "./spectra-checkout.mjs";

const editor = path.join(root, "spectra-editor");
const target = path.join(editor, "src/renderer");
const overlay = path.join(editor, "overlay");
const stamp = path.join(editor, ".prepared");
const log = (m) => console.log(`[spectra-editor] ${m}`);

/** What the prepared tree is made of: the pin and every byte of the overlay. */
function fingerprint() {
  const h = createHash("sha256").update(pin.sha);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else h.update(path.relative(overlay, full)).update(fs.readFileSync(full));
    }
  };
  walk(overlay);
  return h.digest("hex");
}

const want = fingerprint();
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === want && fs.existsSync(path.join(target, "index.tsx"))) {
  process.exit(0);
}

checkout(log);
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(path.join(src, "src/renderer"), target, { recursive: true });

// `git apply` outside a work tree applies relative to the current directory.
const applied = spawnSync("git", ["apply", "--unsafe-paths", "-p1", "--directory", "spectra-editor", path.join(overlay, "renderer.patch")], {
  cwd: root, stdio: "inherit",
});
if (applied.status !== 0) {
  throw new Error("overlay/renderer.patch no longer applies to the pinned Spectra: update the patch (see the header of this file)");
}
fs.cpSync(path.join(overlay, "renderer"), target, { recursive: true });

fs.writeFileSync(stamp, `${want}\n`);
log(`renderer prepared from ${pin.sha.slice(0, 12)} (${fs.readdirSync(target).length} entries)`);
