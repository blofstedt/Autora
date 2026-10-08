/**
 * The pinned OpenCut checkout (opencut/PIN.json), cloned once into
 * .cache/opencut/opencut and reused. prepare-opencut-editor.mjs reads the
 * editor's source from it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pin = JSON.parse(fs.readFileSync(path.join(root, "opencut/PIN.json"), "utf8"));
const cache = path.join(root, ".cache/opencut");
export const src = path.join(cache, "opencut");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
}

/** The pinned checkout, cloned once and reused; a cached tree from another pin is refetched. */
export function checkout(log = () => undefined) {
  const head = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status === 0 && head.stdout.trim() === pin.sha) {
    log(`checkout already at ${pin.sha.slice(0, 12)}`);
    return;
  }
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  log(`cloning ${pin.repo} at ${pin.sha.slice(0, 12)}`);
  run("git", ["clone", "--filter=blob:none", "--no-checkout", pin.repo, src]);
  run("git", ["-C", src, "fetch", "--depth", "1", "origin", pin.sha]);
  run("git", ["-C", src, "checkout", "--detach", pin.sha]);
}
