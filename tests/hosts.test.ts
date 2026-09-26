/**
 * The host's own name, in the container's /etc/hosts.
 *
 * The socket is not there in a test, so what is checked is the file itself:
 * the name goes in, an address that changed is corrected, and everything else
 * in the file is left exactly as it was.
 *
 *   npx tsx tests/hosts.test.ts
 */
import assert from "node:assert/strict";
import { ensureHostNames, withHostNames } from "../server/hosts";

console.log("hosts");

const self = { names: ["umbrel-1.tail16900.ts.net", "umbrel-1"], ip: "100.122.77.59" };

const bare = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost\n10.21.0.8\t73f6420c24fa\n";
const added = withHostNames(bare, self);
assert.ok(added, "the name should have been added");
assert.ok(added.endsWith("100.122.77.59\tumbrel-1.tail16900.ts.net umbrel-1\n"), added);
for (const kept of ["127.0.0.1\tlocalhost", "::1\tlocalhost ip6-localhost", "10.21.0.8\t73f6420c24fa"]) {
  assert.ok(added.includes(kept), `kept ${kept}: ${added}`);
}
console.log("  ok  the tailnet name is appended and the file's own lines are kept");

assert.equal(withHostNames(added, self), null, "a second run should change nothing");
console.log("  ok  a file that already has it is left alone");

const stale = `${bare}127.0.0.1\tumbrel-1.tail16900.ts.net\n`;
const fixed = withHostNames(stale, self);
assert.ok(fixed && !fixed.includes("127.0.0.1\tumbrel-1"), "the stale line should be gone");
assert.ok(fixed.includes("100.122.77.59\tumbrel-1.tail16900.ts.net umbrel-1"), fixed);
console.log("  ok  a name pointing at the wrong address is replaced, not duplicated");

/* Nothing to do here: either there is no tailscaled socket to ask (CI), or the
   container already has the name (which is the case on the machine this runs
   on). Either way the real file must come back untouched. */
const untouched = await ensureHostNames(() => undefined, "/etc/hosts");
assert.deepEqual(untouched, [], `nothing should have been added, got ${JSON.stringify(untouched)}`);
console.log("  ok  without a tailnet socket the real file is left alone");

console.log("hosts: all passed");
