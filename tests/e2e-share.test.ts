/**
 * Telling a colleague, end to end: when a chat's to-do list is finished after real work, the agent is asked once
 * whether a colleague should be told. A yes posts to Threads naming them and puts the note in their own mind; a no
 * posts nothing; work that was too small is not even asked; and nothing is asked on a timer.
 *
 *   npx tsx tests/e2e-share.test.ts
 */
import assert from "node:assert/strict";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SHARE = /who has just finished some work|passed to a colleague/;
const finished = [{ title: "Do the thing", status: "completed" }];
const work = (n: number) => ({
  tools: [
    ...Array.from({ length: n }, (_, i) => ({ name: "terminal", args: { command: `echo step ${i}` } })),
    { name: "todo", args: { todos: finished } },
  ],
});

async function main() {
  process.env.AUTORA_SHARE_GAP_MS = "0"; // the ten minutes between checks is tested in threadshare.test.ts
  const app = await startApp();
  try {
    const made = await app.api("POST", "/api/agents", { name: "Bookkeeper", role: "Accountant", when: "anything about invoices, tax and ledgers" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const bookkeeper: string = made.body.agent.id;
    const posts = async () => (await app.api("GET", "/api/threads")).body.posts as any[];
    const asked = () => app.seen.filter((r) => SHARE.test(r.system));

    await test("finished work that taught a colleague something is posted to them, and kept in their own mind", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (SHARE.test(req.system)) {
          return { text: JSON.stringify({ share: true, to: ["Bookkeeper"], title: "Invoice PDFs", text: "Scanned invoices need OCR first; the text layer is empty on them." }) };
        }
        step += 1;
        return step === 1 ? work(4) : { text: "All done." };
      };
      const s = await app.newSession("share", "build");
      await app.turn(s, "Extract the totals from these invoices");
      for (let i = 0; i < 40 && (await posts()).length === 0; i += 1) await sleep(250);
      const list = await posts();
      assert.equal(list.length, 1, "one post");
      assert.match(list[0].title, /Invoice PDFs/);
      assert.match(list[0].body, /^@Bookkeeper /, "it names who it is for");
      assert.equal(list[0].by.name, "Autora");
      const mind = (await app.api("GET", `/api/agents/${bookkeeper}/mind`)).body.memories as any[];
      assert.ok(mind.some((m) => /OCR first/.test(m.text)), "and it is in the colleague's own mind");
      assert.equal(asked().length, 1, "asked once");
      app.decide = null;
    });

    await test("a no posts nothing", async () => {
      const before = (await posts()).length;
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (SHARE.test(req.system)) return { text: '{"share":false}' };
        step += 1;
        return step === 1 ? work(5) : { text: "Done." };
      };
      const s = await app.newSession("share-no", "build");
      await app.turn(s, "Tidy the folder");
      for (let i = 0; i < 40 && asked().length === 0; i += 1) await sleep(250);
      await sleep(500);
      assert.equal(asked().length, 1, "it was asked");
      assert.equal((await posts()).length, before, "and nothing was posted");
      app.decide = null;
    });

    await test("a share that names nobody real is no share", async () => {
      const before = (await posts()).length;
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (SHARE.test(req.system)) return { text: '{"share":true,"to":["Nobody"],"title":"x","text":"y y y"}' };
        step += 1;
        return step === 1 ? work(5) : { text: "Done." };
      };
      const s = await app.newSession("share-ghost", "build");
      await app.turn(s, "Rename the files");
      for (let i = 0; i < 40 && asked().length === 0; i += 1) await sleep(250);
      await sleep(500);
      assert.equal((await posts()).length, before);
      app.decide = null;
    });

    await test("small work is not even asked about, and a chat with no finished list waits for the idle check", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = () => {
        step += 1;
        return step === 1 ? work(1) : { text: "Done." };
      };
      const s = await app.newSession("share-small", "build");
      await app.turn(s, "Say hi in a file");
      await sleep(1500);
      assert.equal(asked().length, 0, "two steps is not enough work to ask about");
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
