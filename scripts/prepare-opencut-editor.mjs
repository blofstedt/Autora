/**
 * Puts OpenCut's editor where opencut-editor/ builds it from:
 * opencut-editor/src/web/, which is not in this repository.
 *
 *   node scripts/prepare-opencut-editor.mjs
 *
 * The editor is ~90,000 lines of someone else's code (MIT). It is fetched from
 * the commit pinned in opencut/PIN.json (apps/web/src, less the site, the blog,
 * the API routes and the sign-in) and Autora's changes are laid over it:
 *
 *   opencut-editor/overlay/web/*   whole files that replace OpenCut's own at the
 *                                  same path (storage, the header, the font loader)
 *
 * Whole files rather than a patch: a patch breaks when a line beside it moves;
 * a replaced file breaks only when the interface it implements changes, and the
 * typecheck says so. To change what Autora does to OpenCut, edit the overlay,
 * never the fetched copy (it is replaced whenever the pin or the overlay
 * changes). To take a newer OpenCut, move the sha in opencut/PIN.json.
 *
 * Needs git and the network the first time; after that .cache/opencut holds it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkout, pin, root, src } from "./opencut-checkout.mjs";

const editor = path.join(root, "opencut-editor");
const target = path.join(editor, "src/web");
const overlay = path.join(editor, "overlay/web");
const publicTarget = path.join(editor, "src/web-public");
const stamp = path.join(editor, ".prepared");
const log = (m) => console.log(`[opencut-editor] ${m}`);

/** Parts of OpenCut's app that are the website or its server, not the editor. */
const DROP = ["blog", "site", "changelog", "auth", "db", "env", "feedback", "components/landing", "components/footer.tsx", "components/header.tsx", "components/gitHub-contribute-section.tsx"];

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
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === want && fs.existsSync(path.join(target, "core/index.ts"))) {
  process.exit(0);
}

checkout(log);
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(path.join(src, "apps/web/src"), target, { recursive: true });
fs.rmSync(path.join(target, "services/transcription"), { recursive: true, force: true });
for (const d of DROP) fs.rmSync(path.join(target, d), { recursive: true, force: true });
// The app directory is OpenCut's website; the editor page and the stylesheet are the two parts of it that are the editor.
for (const name of fs.readdirSync(path.join(target, "app"))) {
  if (name !== "globals.css" && name !== "editor") fs.rmSync(path.join(target, "app", name), { recursive: true, force: true });
}
// OpenCut's own tests run under bun and are not part of the editor.
const dropTests = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "__tests__") fs.rmSync(full, { recursive: true, force: true });
    else dropTests(full);
  }
};
dropTests(target);
fs.cpSync(overlay, target, { recursive: true });

// What the editor fetches by absolute path: effect previews, the font atlas, sticker flags and shapes.
fs.rmSync(publicTarget, { recursive: true, force: true });
for (const d of ["effects", "fonts", "shapes", "flags", "icons"]) {
  fs.cpSync(path.join(src, "apps/web/public", d), path.join(publicTarget, d), { recursive: true });
}

fs.writeFileSync(stamp, `${want}\n`);
log(`editor prepared from ${pin.sha.slice(0, 12)} (${fs.readdirSync(target).length} entries)`);
