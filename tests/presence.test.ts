/**
 * Working side by side: leases, control and what the agent is told.
 *
 *   npx tsx tests/presence.test.ts
 */
import assert from "node:assert/strict";
import { FILE_LEASE_MS, LEASE_MS, Presence, presenceFor } from "../server/presence";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const make = () => {
  let t = 1_000_000;
  const p = new Presence(() => t);
  return { p, tick: (ms: number) => { t += ms; } };
};

console.log("presence");

test("what the person touches is theirs for a while, and then it is not", () => {
  const { p, tick } = make();
  assert.equal(p.blocked("app"), null);
  p.touch("app", "*", "click", "clicked Buy now");
  assert.match(p.blocked("app") ?? "", /working on the app window right now/);
  assert.match(p.blocked("app") ?? "", /do not retry it straight away/);
  tick(LEASE_MS - 1);
  assert.ok(p.blocked("app"));
  tick(2);
  assert.equal(p.blocked("app"), null, "the lease ran out");
});

test("a lease on one object leaves the rest of the surface free", () => {
  const { p } = make();
  p.touch("pdf", "agent_ab12", "move", "moved the signature on page 1");
  assert.match(p.blocked("pdf", "agent_ab12") ?? "", /working on that right now/);
  assert.equal(p.blocked("pdf", "agent_zz99"), null);
  assert.equal(p.blocked("pdf"), null, "the PDF as a whole is not held");
});

test("a whole-surface lease holds every object on it", () => {
  const { p } = make();
  p.touch("pdf", "*", "pages", "rearranged the pages");
  assert.ok(p.blocked("pdf", "anything"));
});

test("a file is held longer than an object", () => {
  const { p, tick } = make();
  p.touch("code", "src/app.js", "edit", "edited src/app.js");
  tick(LEASE_MS + 1000);
  assert.ok(p.blocked("code", "src/app.js"), "still theirs after the short lease");
  tick(FILE_LEASE_MS);
  assert.equal(p.blocked("code", "src/app.js"), null);
});

test("taking control holds the surface until it is handed back", () => {
  const { p, tick } = make();
  p.hold("app", true);
  tick(10 * 60_000);
  assert.match(p.blocked("app") ?? "", /taken control of the app window/);
  assert.equal(p.blocked("pdf"), null, "only that surface");
  p.hold("app", false);
  assert.equal(p.blocked("app"), null);
});

test("the agent is told what they did, once, as a colleague would hear it", () => {
  const { p, tick } = make();
  p.touch("pdf", "a1", "move", "moved the signature on page 1");
  tick(3000);
  p.touch("app", "*", "type", 'typed "Ada" in the Your name field');
  const note = p.note()!;
  assert.match(note, /^\[The person, working alongside you:/);
  assert.match(note, /- moved the signature on page 1 \(just now\)|- moved the signature on page 1 \(3s ago\)/);
  assert.match(note, /typed "Ada" in the Your name field/);
  assert.match(note, /do not undo it/);
  assert.match(note, /one short natural thing/);
  assert.equal(p.note(), null, "said once");
});

test("a hold that is only attention is never told", () => {
  const { p } = make();
  p.touch("app", "*", "scroll", "scrolled", { tell: false });
  p.touch("pdf", "a1", "select", "selected the stamp", { tell: false });
  assert.equal(p.note(), null);
  assert.ok(p.blocked("app"), "but it is still a hold");
});

test("the same thing again straight away is one touch", () => {
  const { p, tick } = make();
  for (let i = 0; i < 6; i++) {
    p.touch("pdf", "a1", "move", `moved the stamp to ${i}`);
    tick(300);
  }
  const lines = p.note()!.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /moved the stamp to 5/);
});

test("control is said when it changes, both ways, and not every step", () => {
  const { p } = make();
  p.hold("app", true);
  assert.match(p.note()!, /taken control of the app window/);
  assert.equal(p.note(), null);
  p.hold("app", false);
  assert.match(p.note()!, /handed the app window back/);
  assert.equal(p.note(), null);
});

test("a long list is cut to the latest, and says how many came before", () => {
  const { p, tick } = make();
  for (let i = 0; i < 12; i++) {
    p.touch("pdf", `o${i}`, "move", `moved object ${i}`);
    tick(3000);
  }
  const note = p.note()!;
  assert.equal(note.split("\n").filter((l) => l.startsWith("- ")).length, 8);
  assert.match(note, /and 4 earlier/);
  assert.match(note, /moved object 11/);
});

test("the view says what is held and what is in use", () => {
  const { p, tick } = make();
  p.hold("app", true);
  p.touch("pdf", "a1", "move", "moved it");
  assert.deepEqual(p.view(), { held: ["app"], active: ["pdf", "app"] });
  tick(LEASE_MS + 1);
  assert.deepEqual(p.view(), { held: ["app"], active: ["app"] });
});

test("recent actions are for reacting to, newest last, and only what is told", () => {
  const { p, tick } = make();
  p.touch("pdf", "a", "move", "moved a");
  tick(40_000);
  p.touch("pdf", "b", "edit", "edited b");
  p.touch("app", "*", "scroll", "scrolled", { tell: false });
  assert.deepEqual(p.recent(30_000).map((t) => t.detail), ["edited b"]);
});

test("each chat has its own", () => {
  presenceFor("s1").touch("app", "*", "click", "clicked");
  assert.ok(presenceFor("s1").blocked("app"));
  assert.equal(presenceFor("s2").blocked("app"), null);
});

console.log(`${passed} passed`);
