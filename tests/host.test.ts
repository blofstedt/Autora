/**
 * The machine's vitals, for the sidebar.
 *
 *   npx tsx tests/host.test.ts
 */
import assert from "node:assert/strict";
import { cpuBetween, hostVitals } from "../server/host";

console.log("host");

assert.equal(cpuBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 0.5);
assert.equal(cpuBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null, "no time passed");
assert.equal(cpuBetween({ idle: 0, total: 0 }, { idle: 0, total: 100 }), 1);
console.log("  ok  CPU is the busy share of the time between two samples");

const first = hostVitals();
const second = hostVitals();
for (const v of [first, second]) {
  assert.ok(v.cpu >= 0 && v.cpu <= 1, `cpu ${v.cpu}`);
  assert.ok(v.cores >= 1);
  assert.ok(v.memory.total > 0 && v.memory.used >= 0 && v.memory.used <= v.memory.total);
  assert.ok(v.disk && v.disk.total > 0 && v.disk.used >= 0 && v.disk.used <= v.disk.total);
}
assert.equal(hostVitals("/no/such/place").disk, null);
console.log("  ok  readings are in range, and a missing data directory has no disk");
