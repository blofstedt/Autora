/**
 * The pure parts of telling a colleague (server/threadshare.ts): the answer is read strictly, a share needs a real
 * colleague named, and the limiter keeps the feature to a few small calls a day.
 *
 *   npx tsx tests/threadshare.test.ts
 */
import assert from "node:assert/strict";
import { ShareGate, listFinished, parseShare, shareBody, sharePrompt } from "../server/threadshare";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const team = [
  { id: "agent_a", name: "Sabrina", role: "Lawyer", when: "contracts and leases" },
  { id: "agent_b", name: "Tom", role: "Accountant", when: "tax" },
];

test("a share names real colleagues and carries a note", () => {
  const s = parseShare('Sure. {"share":true,"to":["sabrina","@Tom","Nobody"],"title":"Lease dates","text":"Break clauses count from signing."}', team)!;
  assert.deepEqual(s.to.map((c) => c.name), ["Sabrina", "Tom"]);
  assert.equal(shareBody(s), "@Sabrina @Tom Break clauses count from signing.");
});

test("no, nobody real, or no words is no share", () => {
  assert.equal(parseShare('{"share":false}', team), null);
  assert.equal(parseShare("no json", team), null);
  assert.equal(parseShare('{"share":true,"to":["Nobody"],"title":"t","text":"x"}', team), null);
  assert.equal(parseShare('{"share":true,"to":["Tom"],"title":"","text":"x"}', team), null);
  assert.equal(parseShare('{"share":true,"to":["Tom"],"title":"t","text":""}', team), null);
  assert.equal(parseShare('{"share":true,"title":"t","text":"x"}', team), null, "a note for nobody is not posted");
});

test("one to three names, and a name once", () => {
  const many = [...team, { id: "c", name: "Ann" }, { id: "d", name: "Bo" }];
  assert.equal(parseShare('{"share":true,"to":["Tom","Tom","Ann","Bo","Sabrina"],"title":"t","text":"x"}', many)!.to.length, 3);
});

test("the prompt lists the colleagues and says nothing is the usual answer", () => {
  const p = sharePrompt({ agent: { name: "Autora" }, request: "do it", steps: ["- terminal -> ok"], reply: "done", colleagues: team });
  assert.match(p, /- Sabrina, Lawyer -- contracts and leases/);
  assert.match(p, /No colleague in mind means no post/);
});

test("the gate keeps a gap between checks and a ceiling a day", () => {
  const g = new ShareGate(3, 60_000);
  assert.ok(g.room(0)); g.note(0);
  assert.ok(!g.room(30_000), "too soon");
  assert.ok(g.room(61_000)); g.note(61_000);
  assert.ok(g.room(130_000)); g.note(130_000);
  assert.ok(!g.room(300_000), "three a day is three");
  assert.ok(g.room(86_400_001 + 130_000), "and a day later it is open again");
});

test("only a list with items, all done, is finished", () => {
  assert.equal(listFinished(null), false);
  assert.equal(listFinished({ items: [] }), false);
  assert.equal(listFinished({ items: [{ status: "completed" }, { status: "in-progress" }] }), false);
  assert.equal(listFinished({ items: [{ status: "completed" }] }), true);
});

console.log(`${passed} passed`);
