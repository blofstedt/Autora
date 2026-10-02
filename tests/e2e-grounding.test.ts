/**
 * Know it before you do it, end to end: acting on a site nothing current is
 * stored about is held until the official documentation has been read and
 * written down; the mind's rules refuse a bad write and say what to change;
 * the old records can be tidied. A scripted model; what is checked is what the
 * agent is told and what the mind holds.
 *
 *   npx tsx tests/e2e-grounding.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
const told = (app: App) => app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
const post = (url: string) => ({ name: "http_request", args: { url, method: "POST", body: "{}" } });
const held = (ev: Ev[]) => ev.filter((e) => e.kind === "tool.error" && e.payload.grounding);

async function main() {
  const app: App = await startApp();
  try {
    console.log("ground first");
    await test("an action on a site with nothing stored is held until the docs are read and written down", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [post("https://api.zorblax.invalid/v1/refunds")] };
        if (step === 2) {
          return {
            tools: [{
              name: "memory_write",
              args: {
                kind: "reference", subject: "zorblax", facet: "api", title: "refunds endpoint",
                body: "POST /v1/refunds with {charge}; returns the refund id.",
                source: "https://docs.zorblax.invalid/api/refunds",
              },
            }],
          };
        }
        if (step === 3) return { tools: [post("https://api.zorblax.invalid/v1/refunds")] };
        return { text: "Tried it." };
      };
      const s = await app.newSession("ground", "build");
      const ev = await app.turn(s, "refund the last charge via https://api.zorblax.invalid/v1/refunds", 60_000);
      assert.equal(held(ev).length, 1, "held once, then let through");
      assert.match(told(app), /nothing is stored about how zorblax\.invalid works/);
      assert.match(told(app), /kind \\"reference\\", subject \\"zorblax\\"/);
      assert.match(told(app), /The request names sites you have nothing current on[\s\S]*zorblax\.invalid/, "named in the request, said up front");
      assert.ok(ev.some((e) => e.kind === "system.log" && /read its official documentation before acting/.test(String(e.payload.message))));
      const mind = (await app.api("GET", "/api/memory")).body.records as any[];
      const ref = mind.find((r) => r.kind === "reference");
      assert.ok(ref, "the reference was kept");
      assert.equal(ref.title, "Zorblax: refunds endpoint");
      assert.equal(ref.subject, "zorblax");
      assert.equal(ref.source, "https://docs.zorblax.invalid/api/refunds");
      assert.equal(ref.status, "confirmed");
      assert.ok(ref.fetched > 0);
      app.decide = null;
    });

    await test("with a fresh reference stored, the next chat is not held, and sees it with its source", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [post("https://api.zorblax.invalid/v1/refunds")] };
        return { text: "Done." };
      };
      const s = await app.newSession("ground2", "build");
      const ev = await app.turn(s, "refund again", 60_000);
      assert.equal(held(ev).length, 0);
      assert.match(told(app), /official source https:\/\/docs\.zorblax\.invalid\/api\/refunds, read \d{4}-\d{2}-\d{2}/);
      app.decide = null;
    });

    await test("it cannot wedge a turn: after three holds the action goes ahead", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step <= 4) return { tools: [{ name: "http_request", args: { url: "https://api.nodocs.invalid/x", method: "POST", body: String(step) } }] };
        return { text: "Gave up on the docs." };
      };
      const s = await app.newSession("wedge", "build");
      const ev = await app.turn(s, "post to https://api.nodocs.invalid/x", 60_000);
      assert.equal(held(ev).length, 3, "held three times, the fourth went through");
      assert.match(told(app), /repeat the action once more and it will go ahead/);
      app.decide = null;
    });

    await test("the setting turns it off", async () => {
      assert.equal((await app.api("PATCH", "/api/memory-settings", { groundFirst: false })).body.groundFirst, false);
      assert.equal((await app.api("GET", "/api/memory")).body.groundFirst, false);
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [post("https://api.other-unknown.invalid/x")] };
        return { text: "Done." };
      };
      const s = await app.newSession("off", "build");
      const ev = await app.turn(s, "post to https://api.other-unknown.invalid/x", 60_000);
      assert.equal(held(ev).length, 0);
      await app.api("PATCH", "/api/memory-settings", { groundFirst: true });
      app.decide = null;
    });

    console.log("the mind's rules");
    await test("a write that breaks the rules is refused with what to change", async () => {
      app.seen.length = 0;
      const calls = [
        { kind: "reference", subject: "acme", title: "menu", body: "Top left." },
        { kind: "reference", title: "menu", body: "Top left.", source: "https://docs.acme.com/x" },
        { kind: "fact", title: "Notes", body: "y".repeat(800) },
        { kind: "fact", title: "Now", body: "I am working on this right now" },
        { kind: "reference", subject: "acme", title: "Menu", body: "Top left.", source: "https://medium.com/@x/acme" },
      ];
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step <= calls.length) return { tools: [{ name: "memory_write", args: calls[step - 1] }] };
        return { text: "Done." };
      };
      const s = await app.newSession("rules", "build");
      await app.turn(s, "write some things down", 60_000);
      const t = told(app);
      assert.match(t, /needs its source/);
      assert.match(t, /needs a subject/);
      assert.match(t, /Too long for a fact \(800 characters; at most 600\)/);
      assert.match(t, /about this conversation or this moment/);
      assert.match(t, /does not read as acme's own site/);
      const mind = (await app.api("GET", "/api/memory")).body.records as any[];
      const unconfirmed = mind.find((r) => r.subject === "acme");
      assert.equal(unconfirmed.status, "provisional", "a reference from a blog waits to be looked at");
      app.decide = null;
    });

    await test("the old records are tidied on request, and what needs a rewrite is listed", async () => {
      await app.api("POST", "/api/memory", { title: "login needs 2fa", body: "Use the authenticator app.", kind: "fact", tags: ["github.com"] });
      await app.api("POST", "/api/memory", { title: "Big", body: "z".repeat(900), kind: "fact", tags: ["misc"] });
      const dry = (await app.api("POST", "/api/memory/tidy", { dry: true })).body;
      assert.equal(dry.dry, true);
      assert.ok(dry.fixed.length >= 1);
      const before = ((await app.api("GET", "/api/memory")).body.records as any[]).find((r) => r.title === "login needs 2fa");
      assert.ok(before, "a dry run changes nothing");
      const done = (await app.api("POST", "/api/memory/tidy", {})).body;
      assert.equal(done.dry, false);
      const after = ((await app.api("GET", "/api/memory")).body.records as any[]).find((r) => r.subject === "github");
      assert.equal(after.title, "Github: login needs 2fa");
      assert.ok(done.flagged.some((f: any) => f.problems.some((p: string) => /too long for a fact/.test(p))));
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
