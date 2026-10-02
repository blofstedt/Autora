/**
 * The agent saying a word about what you just did: only between turns, only for
 * what is worth it, once, spaced out, switchable, and remembered as its own
 * words. The real server and a scripted model; a websocket stands in for the
 * page that is being looked at.
 *
 *   npx tsx tests/e2e-remark.test.ts
 */
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import WebSocket from "ws";
import { sleep, startApp, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app = await startApp();
  const sockets: WebSocket[] = [];
  try {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]).drawText("Lease", { x: 40, y: 250, size: 20, font: await doc.embedFont(StandardFonts.Helvetica) });
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "lease.pdf" }, body: new Uint8Array(await doc.save()),
    });
    const file = (await up.json()).artifact.id;
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
    let reply = "Nice -- I'll leave the signature where you put it.";
    const standard = (req: { system: string; messages: { role: string }[] }) => {
      const g = guard(req);
      if (g) return g;
      if (/collaborator at the next desk/.test(req.system)) return { text: reply };
      return req.messages.some((m) => m.role === "tool") ? { text: "Placed." } : { tools: [{ name: "pdf_edit", args: { file, add: [{ type: "text", text: "Sign here", page: 1, x: 40, y: 80, size: 14 }] } }] };
    };
    app.decide = standard;

    /** A chat with a PDF open and a page looking at it. */
    const scene = async (title: string, watching = true) => {
      app.decide = standard;
      const s = await app.newSession(title, "build");
      await app.turn(s, "put a signature line on the lease", 60_000);
      const item = ((await app.api("GET", `/api/pdfdesk/${s}`)).body.items as any[]).find((i) => i.type === "text");
      if (watching) {
        const ws = new WebSocket(`${app.base.replace("http", "ws")}/ws/${s}`);
        sockets.push(ws);
        await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); });
      }
      const move = () => fetch(`${app.base}/api/pdfdesk/${s}/changes`, {
        method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ upsert: [{ ...item, x: item.x + 50 }], remove: [] }),
      });
      const remarks = async () => (await app.events(s)).filter((e: Ev) => e.kind === "agent.remark");
      return { s, move, remarks };
    };
    const until = async (fn: () => Promise<boolean>, ms = 9000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await sleep(250); } return false; };

    console.log("a word between turns");
    await test("after a pause, the agent says one short thing about what they moved, as its own line in the thread", async () => {
      const { s, move, remarks } = await scene("moved");
      await move();
      assert.ok(await until(async () => (await remarks()).length > 0), "it spoke");
      const [r] = await remarks();
      assert.equal(r.payload.text, "Nice -- I'll leave the signature where you put it.");
      assert.equal(r.payload.surface, "pdf");
      assert.equal(r.actor, "agent");
      assert.equal((await remarks()).length, 1);
      void s;
    });

    await test("it can choose to say nothing, and a few actions in a row get one remark at most", async () => {
      reply = "SKIP";
      const quiet = await scene("quiet");
      await quiet.move();
      await sleep(4500);
      assert.equal((await quiet.remarks()).length, 0, "SKIP is silence");

      reply = "Good, that sits better there.";
      const busy = await scene("spaced");
      await busy.move();
      await sleep(300);
      await busy.move();
      assert.ok(await until(async () => (await busy.remarks()).length > 0));
      await sleep(4000);
      await busy.move();
      await sleep(4000);
      assert.equal((await busy.remarks()).length, 1, "the gap between remarks held");
    });

    await test("nobody looking, or the switch off, means nothing is said", async () => {
      reply = "You are being watched.";
      const away = await scene("away", false);
      await away.move();
      await sleep(4500);
      assert.equal((await away.remarks()).length, 0, "no page was open to say it to");

      assert.equal((await app.api("PATCH", "/api/collaboration", { remarks: false })).body.remarks, false);
      const off = await scene("off");
      await off.move();
      await sleep(4500);
      assert.equal((await off.remarks()).length, 0);
      assert.equal((await app.api("PATCH", "/api/collaboration", { remarks: true })).body.remarks, true);
    });

    await test("it is not said over a turn that is running, and the agent remembers having said it", async () => {
      reply = "Looks right to me.";
      const t = await scene("remembered");
      await t.move();
      assert.ok(await until(async () => (await t.remarks()).length > 0));
      app.seen.length = 0;
      app.decide = (req) => guard(req) ?? (/collaborator at the next desk/.test(req.system) ? { text: "SKIP" } : { text: "Noted." });
      await app.turn(t.s, "how does it look?", 30_000);
      const asked = JSON.stringify(app.seen.filter((r) => !/collaborator|You check/.test(r.system)).at(-1)!.messages);
      assert.match(asked, /Looks right to me\./, "its own earlier remark is in what it is shown");
    });

    await test("nothing is said over a turn that is running: the agent answers in its own words then", async () => {
      reply = "This should not be said.";
      const t = await scene("running");
      app.decide = (req) => guard(req) ?? (/collaborator at the next desk/.test(req.system) ? { text: reply } : { text: "word ".repeat(120), slow: true });
      await app.say(t.s, "tell me a long story");
      await app.until(t.s, (ev) => ev.some((e) => e.kind === "turn.agent.text" && e.seq > 5), "the reply to start");
      await t.move();
      await sleep(4500);
      assert.equal((await t.remarks()).length, 0, "the turn was still going");
      await app.api("POST", `/api/sessions/${t.s}/interrupt`);
      await app.until(t.s, (ev) => ev.filter((e) => e.kind === "turn.agent.done").length >= 2, "the turn to stop", 10_000);
    });

    await test("the switch is reported and kept", async () => {
      assert.equal((await app.api("GET", "/api/collaboration")).body.remarks, true);
    });
  } finally {
    for (const ws of sockets) ws.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
