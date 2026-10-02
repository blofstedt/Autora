/**
 * Sharing a PDF: what the person moves or selects is theirs for a moment; the
 * agent changes everything else in the same call and says what it left, and a
 * call that is all about held objects is not an error. The real server and a
 * scripted model.
 *
 *   npx tsx tests/e2e-pdfcollab.test.ts
 */
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app = await startApp();
  try {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]).drawText("Agreement", { x: 40, y: 250, size: 20, font: await doc.embedFont(StandardFonts.Helvetica) });
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "agreement.pdf" }, body: new Uint8Array(await doc.save()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Pdf", "build");
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
    const unesc = (t: string) => t.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const toolSaid = () => unesc(app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n"));
    const desk = async () => (await app.api("GET", `/api/pdfdesk/${s}`)).body;
    const person = (path: string, body: unknown) => fetch(`${app.base}/api/pdfdesk/${s}/${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });

    const run = async (call: Record<string, unknown>) => {
      app.seen.length = 0;
      let n = 0;
      app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [{ name: "pdf_edit", args: call }] } : { text: "Carrying on." });
      return app.turn(s, "work on the pdf", 60_000);
    };

    await run({ file, add: [
      { type: "text", text: "Alice", page: 1, x: 40, y: 80, size: 14 },
      { type: "stamp", stamp: "approved", page: 1, x: 220, y: 80 },
    ] });
    const items = (await desk()).items as { id: string; type: string; x: number; y: number }[];
    const text = items.find((i) => i.type === "text")!;
    const stamp = items.find((i) => i.type === "stamp")!;
    const working = (await desk()).working;

    console.log("sharing the file");
    await test("an object the person has just moved is left alone, the rest of the call goes ahead, and it says what it left", async () => {
      assert.equal((await person("changes", { upsert: [{ ...stamp, x: stamp.x + 60 }], remove: [] })).status, 200);
      const ev = await run({
        file: working,
        change: [{ id: text.id, text: "Alice Smith" }, { id: stamp.id, x: 10, y: 10 }],
      });
      const said = toolSaid();
      assert.match(said, /Left alone, because the person is working on it right now: change of /);
      assert.match(said, new RegExp(stamp.id));
      assert.match(said, /Everything else was done/);
      const now = (await desk()).items as { id: string; x: number; text?: string }[];
      assert.equal(now.find((i) => i.id === text.id)!.text, "Alice Smith", "the other object was changed");
      assert.equal(now.find((i) => i.id === stamp.id)!.x, stamp.x + 60, "theirs stayed where they put it");
      assert.ok(!ev.some((e) => e.kind === "tool.error"), "it was not an error");
    });

    await test("a call that is only about what they hold is not done, is not an error, and the turn goes on", async () => {
      await person("presence", { id: stamp.id, kind: "drag" });
      const ev = await run({ file: working, remove: [stamp.id] });
      assert.match(toolSaid(), /Not done: the person is working on that object right now/);
      assert.match(toolSaid(), /go on to something else/);
      assert.equal(ev.filter((e) => e.kind === "tool.error" && e.payload.held).length, 1);
      assert.match(ev.filter((e) => e.kind === "turn.agent.text").map((e) => e.payload.text).join(""), /Carrying on/);
      assert.ok(!ev.some((e) => e.kind === "system.log" && /Stopped|circles/.test(String(e.payload.message))));
      assert.ok((await desk()).items.some((i: any) => i.id === stamp.id), "still there");
    });

    await test("holding an object is only holding: selecting it changes nothing in the file, and it is free again after a pause", async () => {
      const before = (await desk()).rev;
      await person("presence", { id: text.id, kind: "select" });
      assert.equal((await desk()).rev, before);
      await sleep(8600);
      await run({ file: working, remove: [stamp.id] });
      assert.ok(!(await desk()).items.some((i: any) => i.id === stamp.id), "now it could be removed");
    });

    await test("a bad object id or kind is refused", async () => {
      assert.equal((await person("presence", { id: "../x", kind: "select" })).status, 400);
      assert.equal((await person("presence", { id: text.id, kind: "explode" })).status, 400);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
