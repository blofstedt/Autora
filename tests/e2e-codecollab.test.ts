/**
 * Sharing the code: edits the person makes in their own editor are noticed
 * between the agent's steps, told to it, and never written over. The real
 * server and a scripted model; the person is a write to the file made while the
 * agent is "thinking" (inside the model's reply).
 *
 *   npx tsx tests/e2e-codecollab.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SRC = "const title = 'Hello';\nconst price = 10;\nconst tax = 2;\nconst total = price + tax;\nconst shop = 'Spoke';\nexport { title, total, shop };\n";

async function main() {
  const app = await startApp();
  try {
    const file = path.join(app.home, "app.js");
    const reset = () => fs.writeFileSync(file, SRC);
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
    const unesc = (t: string) => t.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const toolSaid = () => unesc(app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n"));

    /** A turn: read the file, then (while the agent is "thinking") the person edits it, then the agent edits. */
    const scene = async (mode: string, person: () => void, edit: Record<string, unknown>) => {
      reset();
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "cat app.js" } }] };
        if (step === 2) { person(); return { tools: [{ name: "edit_file", args: edit }] }; }
        return { text: "Done." };
      };
      const s = await app.newSession("code", mode);
      return app.turn(s, "update the price", 60_000);
    };

    console.log("the code, side by side");
    await test("what the person saved while the agent was working is noticed, shown as theirs, told to the agent, and kept", async () => {
      const ev = await scene("build",
        () => fs.writeFileSync(file, SRC.replace("const shop = 'Spoke';", "const shop = 'Spoke & Co';")),
        { path: "app.js", edits: [{ old: "const price = 10;", new: "const price = 12;" }] });
      const now = fs.readFileSync(file, "utf8");
      assert.match(now, /const price = 12;/, "the agent's edit is there");
      assert.match(now, /const shop = 'Spoke & Co';/, "and the person's");
      const theirs = ev.filter((e) => e.kind === "file.edit" && e.payload.by === "person");
      assert.equal(theirs.length, 1);
      assert.equal(theirs[0].payload.path, "app.js");
      assert.match(theirs[0].payload.diff, /-const shop = 'Spoke';\n\+const shop = 'Spoke & Co';/);
      assert.equal(theirs[0].actor, "user");
      const mine = ev.filter((e) => e.kind === "file.edit" && e.payload.by !== "person");
      assert.equal(mine.length, 1);
      assert.match(mine[0].payload.diff, /\+const price = 12;/);
      assert.doesNotMatch(mine[0].payload.diff, /Spoke/, "their change is not shown as the agent's");
      assert.match(toolSaid(), /The person, working alongside you/);
      assert.match(toolSaid(), /edited app\.js \(\+1 -1\)/);
    });

    await test("when they changed the very lines the agent meant to change, nothing is written over theirs and it is told where the file is now", async () => {
      await scene("build",
        () => fs.writeFileSync(file, SRC.replace("const price = 10;", "const price = 99; // person")),
        { path: "app.js", edits: [{ old: "const price = 10;", new: "const price = 12;" }] });
      assert.match(toolSaid(), /that text is not in the file/i);
      assert.match(toolSaid(), /Near it the file has:/);
      assert.match(toolSaid(), /const price = 99; \/\/ person/);
      assert.match(fs.readFileSync(file, "utf8"), /const price = 99; \/\/ person/, "theirs stands");
    });

    await test("edits made between turns are the first thing the next turn hears", async () => {
      reset();
      const s = await app.newSession("idle", "build");
      app.seen.length = 0;
      app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Read." } : { tools: [{ name: "terminal", args: { command: "cat app.js" } }] });
      await app.turn(s, "look at app.js", 60_000);
      // The person edits while no turn is running.
      fs.writeFileSync(file, SRC.replace("const tax = 2;", "const tax = 3;"));
      app.seen.length = 0;
      app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Seen." } : { tools: [{ name: "terminal", args: { command: "cat app.js" } }] });
      const ev = await app.turn(s, "carry on", 60_000);
      const all = unesc(app.seen.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n"));
      assert.match(all, /edited app\.js \(\+1 -1\)/);
      assert.ok(ev.some((e) => e.kind === "file.edit" && e.payload.by === "person" && /tax = 3/.test(e.payload.diff)));
    });

    await test("Autora's own data, and files while planning, are not edited this way", async () => {
      reset();
      const s = await app.newSession("guard", "build");
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        return step++ === 0 ? { tools: [{ name: "edit_file", args: { path: "settings/inventory.json", edits: [{ old: "{", new: "{ " }] } }] } : { text: "No." };
      };
      await app.turn(s, "edit the data", 60_000);
      assert.match(toolSaid(), /Autora's own data/);

      const p = await app.newSession("plan", "plan");
      app.seen.length = 0;
      step = 0;
      app.decide = (req) => guard(req) ?? (step++ === 0 ? { tools: [{ name: "edit_file", args: { path: "app.js", edits: [{ old: "10", new: "11" }] } }] } : { text: "Planned." });
      await app.turn(p, "change it", 60_000);
      assert.match(toolSaid(), /Plan mode/);
      assert.match(fs.readFileSync(file, "utf8"), /price = 10/);
    });

    await test("a call with edits that cannot be located is refused before anything is written", async () => {
      await scene("build", () => undefined, { path: "app.js", edits: [{ old: "this is not in the file", new: "x" }] });
      assert.match(toolSaid(), /not in the file/);
      assert.equal(fs.readFileSync(file, "utf8"), SRC);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
