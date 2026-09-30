/**
 * The app window, end to end: the agent starts a preview of a site it made,
 * the person points at parts of it (an element, several, a region), tries a
 * change on the page, and sends the comments as one review that the agent
 * receives with a picture of each. The real server, a real browser and a
 * scripted model.
 *
 *   npx tsx tests/e2e-preview.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Spoke &amp; Co</title><style>
body{margin:0;font-family:Georgia,serif;background:#fff;color:#111}
nav{display:flex;gap:16px;padding:12px 20px;border-bottom:1px solid #eee}
.hero{padding:40px 24px}
h1{font-size:40px;margin:0 0 8px}
p.lead{font:16px system-ui;color:#555;max-width:420px}
a.cta{display:inline-block;background:#6e5bff;color:#fff;padding:10px 18px;border-radius:8px;font:600 14px system-ui;text-decoration:none}
.cards{display:flex;gap:12px;padding:0 24px}.card{flex:1;height:90px;background:#f3f1ff;border-radius:8px}
@media (max-width:500px){ nav{flex-direction:column} }
</style></head><body>
<nav><b id="brand">Spoke &amp; Co</b><a href="#">Bikes</a><a href="#">Repairs</a></nav>
<section class="hero"><h1>Ride further.</h1><p class="lead">Hand-built city bikes, serviced for life.</p><a class="cta" href="#">Shop bikes</a></section>
<div class="cards"><div class="card"></div><div class="card"></div><div class="card"></div></div>
<script>console.error("boom from the page")</script>
</body></html>`;

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, SITE);
    const s = await app.newSession("Bikes", "build");
    const api = (method: string, url: string, body?: unknown) => app.api(method, `/api/sessions/${s}/preview${url}`, body);

    console.log("starting it");
    await test("the agent starts a preview of a folder; it opens, is told what is on it, and the thread says so", async () => {
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "It is open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] };
      const ev = await app.turn(s, "show me the site", 60_000);
      assert.ok(ev.some((e) => e.kind === "preview.open"), "an open event");
      const state = (await api("GET", "")).body;
      assert.equal(state.open, true);
      assert.match(state.url, /^http:\/\/localhost:\d+\/$/);
      assert.equal(state.device, "desktop");
      assert.deepEqual(state.viewport, { width: 1280, height: 800 });
      assert.match(JSON.stringify(app.seen.at(-1)!.messages), /open in the preview window/);
      app.decide = null;
    });
    await test("a served folder reloads by itself when its files change", async () => {
      fs.writeFileSync(`${app.home}/site/index.html`, SITE.replace("Ride further.", "Ride even further."));
      let text = "";
      for (let i = 0; i < 20 && text !== "Ride even further."; i += 1) {
        await new Promise((r) => setTimeout(r, 300));
        text = (await api("POST", "/inspect", { selector: "h1" })).body.info?.text ?? "";
      }
      assert.equal(text, "Ride even further.");
      fs.writeFileSync(`${app.home}/site/index.html`, SITE);
      for (let i = 0; i < 20 && text !== "Ride further."; i += 1) {
        await new Promise((r) => setTimeout(r, 300));
        text = (await api("POST", "/inspect", { selector: "h1" })).body.info?.text ?? "";
      }
      assert.equal(text, "Ride further.", "and back");
    });
    await test("look returns a picture and the page's console", async () => {
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "Saw it." } : { tools: [{ name: "app_preview", args: { action: "look" } }] };
      const from = app.seen.length;
      await app.turn(s, "how does it look", 30_000);
      const back = JSON.stringify(app.seen.slice(from).map((v) => v.messages));
      assert.match(back, /boom from the page/);
      assert.match(back, /data:image\/png|image_url|"image"/);
      app.decide = null;
    });
    await test("only this machine can be previewed", async () => {
      const r = await app.api("POST", `/api/sessions/${s}/preview/open`, { url: "https://example.com/" });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /localhost/);
      assert.equal((await api("GET", "")).body.open, true, "the one already open is left alone... or closed, not broken");
    });

    console.log("pointing at things");
    await test("a point on the page says what is there: a unique selector, its words and styles", async () => {
      const r = (await api("POST", "/inspect", { x: 60, y: 160 })).body.info;
      assert.ok(r, "something is there");
      const all = (await api("POST", "/inspect", { x: 40, y: 140 })).body.info;
      assert.ok(all);
      const h1 = (await api("POST", "/inspect", { selector: "h1" })).body.info;
      assert.equal(h1.tag, "h1");
      assert.equal(h1.text, "Ride further.");
      assert.equal(h1.editableText, true);
      assert.equal(h1.styles.fontSize, "40px");
      assert.equal(h1.selector, "h1");
    });
    await test("hover is the light version; parent, child and sibling steps move the selection", async () => {
      const light = (await api("POST", "/inspect", { selector: "a.cta", light: true })).body.info;
      assert.equal(light.tag, "a");
      assert.ok(light.label.startsWith("a.cta"), light.label);
      assert.equal(light.styles, undefined);
      const parent = (await api("POST", "/inspect", { selector: "a.cta", nav: "parent" })).body.info;
      assert.equal(parent.tag, "section");
      const child = (await api("POST", "/inspect", { selector: "section.hero", nav: "child" })).body.info;
      assert.ok(["h1", "p", "a"].includes(child.tag));
      const next = (await api("POST", "/inspect", { selector: "h1", nav: "next" })).body.info;
      assert.equal(next.tag, "p");
    });
    await test("selectors are unique even with look-alike siblings", async () => {
      const card = (await api("POST", "/inspect", { selector: ".card:nth-of-type(2)" })).body.info;
      assert.ok(card.selector.includes("nth-of-type(2)"), card.selector);
      const again = (await api("POST", "/inspect", { selector: card.selector })).body.info;
      assert.equal(again.selector, card.selector);
    });
    await test("rects follow the element", async () => {
      const r = (await api("POST", "/rects", { selectors: ["h1", "#nope"] })).body;
      assert.equal(r.rects[1], null);
      assert.ok(r.rects[0].w > 100);
    });

    console.log("trying a change");
    await test("a style is tried on the page, and only plain values of the allowed properties", async () => {
      const ok = await api("POST", "/style", { selector: "a.cta", css: { "background-color": "#ff6a00", "font-size": "20px" } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.info.styles.fontSize, "20px");
      assert.match(ok.body.info.styles.backgroundColor, /255, 106, 0/);
      assert.equal((await api("POST", "/style", { selector: "a.cta", css: { "background-image": "url(x)" } })).status, 400);
      assert.equal((await api("POST", "/style", { selector: "a.cta", css: { color: "red; } body { display:none" } })).status, 400);
      assert.equal((await api("POST", "/style", { selector: "a.cta", css: { color: "url(javascript:1)" } })).status, 400);
      const back = await api("POST", "/reset", { selector: "a.cta" });
      assert.equal(back.body.info.styles.fontSize, "14px");
    });
    await test("text is tried on the page; an element with children is refused", async () => {
      const ok = await api("POST", "/text", { selector: "h1", text: "Ride much further." });
      assert.equal(ok.body.info.text, "Ride much further.");
      assert.equal((await api("POST", "/text", { selector: "section.hero", text: "x" })).status, 400);
      await api("POST", "/reset", { selector: "h1" });
      assert.equal((await api("POST", "/inspect", { selector: "h1" })).body.info.text, "Ride further.");
    });

    console.log("the review");
    let first = "";
    await test("an element comment keeps what it is about and a picture of it", async () => {
      const r = await api("POST", "/comments", {
        kind: "element", selectors: ["a.cta"], text: "Bigger, and the brand orange",
        styleChanges: [{ property: "font-size", from: "14px", to: "20px" }],
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      first = r.body.comment.id;
      assert.equal(r.body.comment.elements[0].text, "Shop bikes");
      assert.ok(r.body.comment.blob, "a picture was taken");
      const b = await app.api("GET", `/api/sessions/${s}/blobs/${r.body.comment.blob}`);
      assert.equal(b.status, 200);
    });
    await test("several elements together, a region, and a text edit are comments too", async () => {
      const multi = await api("POST", "/comments", { kind: "element", selectors: [".card:nth-of-type(1)", ".card:nth-of-type(2)"], text: "More space between these" });
      assert.equal(multi.body.comment.elements.length, 2);
      const region = await api("POST", "/comments", { kind: "region", region: { x: 20, y: 240, w: 420, h: 120 }, text: "Cramped" });
      assert.equal(region.status, 200);
      assert.deepEqual(region.body.comment.region, { x: 20, y: 240, w: 420, h: 120 });
      assert.ok(region.body.comment.elements.length >= 1, "the element at its centre");
      const edit = await api("POST", "/comments", { kind: "element", selectors: ["h1"], text: "", textEdit: { from: "Ride further.", to: "Ride far." } });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
      assert.deepEqual(edit.body.comment.textEdit, { from: "Ride further.", to: "Ride far." });
      assert.equal((await api("GET", "")).body.comments.length, 4);
    });
    await test("a comment with nothing to say, nothing selected, or a gone element is refused", async () => {
      assert.equal((await api("POST", "/comments", { kind: "element", selectors: ["h1"], text: "" })).status, 400);
      assert.equal((await api("POST", "/comments", { kind: "element", selectors: [], text: "x" })).status, 400);
      assert.equal((await api("POST", "/comments", { kind: "element", selectors: ["#gone"], text: "x" })).status, 400);
      assert.equal((await api("POST", "/comments", { kind: "region", region: { x: 1, y: 1, w: 1, h: 1 }, text: "x" })).status, 400);
    });
    await test("a comment can be reworded and removed", async () => {
      assert.equal((await api("POST", `/comments/${first}`, { text: "Bigger, brand orange" })).body.comment.text, "Bigger, brand orange");
      const extra = (await api("POST", "/comments", { kind: "element", selectors: ["nav"], text: "Drop this" })).body.comment.id;
      assert.equal((await api("DELETE", `/comments/${extra}`)).status, 200);
      assert.equal((await api("DELETE", `/comments/${extra}`)).status, 404);
      assert.equal((await api("GET", "")).body.comments.length, 4);
    });
    await test("the phone size re-lays the page out, and the window says so", async () => {
      const r = await api("POST", "/device", { device: "phone" });
      assert.deepEqual(r.body.viewport, { width: 390, height: 844 });
      assert.equal((await api("GET", "")).body.device, "phone");
      const nav = (await api("POST", "/inspect", { selector: "nav" })).body.info;
      assert.ok(nav.rect.w <= 390, "the page fits the phone");
      assert.equal((await api("POST", "/device", { device: "watch" })).status, 400);
      await api("POST", "/device", { device: "desktop" });
    });
    await test("sending the review is one message to the agent with a picture of each comment", async () => {
      const from = app.seen.length;
      app.decide = () => ({ text: "On it." });
      const sent = await api("POST", "/send", { text: "Mostly good." });
      assert.equal(sent.status, 200);
      await app.until(s, (e) => e.filter((x) => x.kind === "turn.agent.done").length >= 3, "the turn to end", 30_000);
      const asked = app.seen.slice(from).find((v) => /reviewed the app preview/.test(v.last))!;
      assert.ok(asked, "the model was given the review");
      assert.match(asked.last, /Mostly good\./);
      assert.match(asked.last, /4 comments/);
      assert.match(asked.last, /1\. Bigger, brand orange[\s\S]*selector: a\.cta[\s\S]*Change the styles: font-size: 14px -> 20px/);
      assert.match(asked.last, /Region: 420×120 at 20,240/);
      assert.match(asked.last, /Change the text: "Ride further\." -> "Ride far\."/);
      assert.match(asked.last, /boom from the page/);
      const ev = await app.events(s);
      const user = ev.filter((e) => e.kind === "turn.user").at(-1)!;
      assert.equal(user.payload.shown, "Reviewed the app: 4 comments -- Mostly good.");
      assert.equal(user.payload.attachments.length, 4);
      assert.ok(ev.some((e) => e.kind === "preview.review" && e.payload.count === 4));
      assert.equal((await api("GET", "")).body.comments.length, 0, "the review starts over");
      app.decide = null;
    });
    await test("sending with nothing in it is refused", async () => {
      assert.equal((await api("POST", "/send", {})).status, 400);
    });

    console.log("starting it from a command, and closing it");
    await test("a command is run, its address is found in what it prints, and closing stops it", async () => {
      fs.writeFileSync(`${app.home}/serve.mjs`, `import http from "node:http"; const s = http.createServer((q, r) => { r.setHeader("content-type","text/html"); r.end("<h1 id=x>from a command</h1>"); }); s.listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + s.address().port + "/"));\n`);
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "Up." } : { tools: [{ name: "app_preview", args: { action: "start", command: "node serve.mjs" } }] };
      await app.turn(s, "run it", 90_000);
      const state = (await api("GET", "")).body;
      assert.equal(state.open, true);
      assert.equal((await api("POST", "/inspect", { selector: "#x" })).body.info.text, "from a command");
      const jobs = (await app.api("GET", "/api/jobs")).body;
      app.decide = null;
      const closed = await api("POST", "/close");
      assert.equal(closed.status, 200);
      assert.equal((await api("GET", "")).body.open, false);
      assert.equal((await api("POST", "/inspect", { x: 1, y: 1 })).status, 400, "nothing to point at");
      void jobs;
    });
    await test("a command that says nothing useful fails with what it said", async () => {
      app.decide = (req) => req.messages.some((m) => m.role === "tool") ? { text: "Hm." }
        : { tools: [{ name: "app_preview", args: { action: "start", command: "echo nothing to see; exit 1" } }] };
      const from = app.seen.length;
      await app.turn(s, "run it", 60_000);
      assert.match(JSON.stringify(app.seen.slice(from).map((v) => v.messages)), /did not say which address[\s\S]*nothing to see/);
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
