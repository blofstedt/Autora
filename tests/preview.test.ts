/**
 * The pieces of the app window that need no browser: which addresses count as
 * this machine, finding a dev server's address in what it prints, serving a
 * folder without letting anything outside it be read, the styles the editor
 * may try, and the review as the agent is told it.
 *
 *   npx tsx tests/preview.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { addressIn, answers, deviceFor, isDevice, isLocalUrl, localAddress, serveFolder, waitForServer, DEVICES } = await import("../server/preview");
const { EDITABLE_STYLES, describeElement, pickExpression, reviewMessage, safeStyle } = await import("../server/pick");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const get = (url: string) => new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
  http.get(url, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers["content-type"] ?? "") }));
  }).on("error", reject);
});

await test("only this machine is a preview", () => {
  for (const ok of ["http://localhost:5173", "http://127.0.0.1:3000/x", "https://localhost/", "http://0.0.0.0:8080", "http://app.localhost:3000", "http://[::1]:5173/"]) assert.equal(isLocalUrl(ok), true, ok);
  for (const bad of ["https://example.com", "http://192.168.1.4:3000", "http://localhost.evil.com/", "file:///etc/passwd", "javascript:alert(1)", "localhost:3000", "", "http://evil.com/?http://localhost"]) assert.equal(isLocalUrl(bad), false, bad);
});

await test("a dev server's address is found in whatever it printed", () => {
  assert.equal(addressIn("  VITE v5.0.0  ready in 300 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host"), "http://localhost:5173/");
  assert.equal(addressIn("\u001b[32m  ➜\u001b[0m  Local:   \u001b[36mhttp://localhost:\u001b[1m4321\u001b[22m/\u001b[0m"), "http://localhost:4321/");
  assert.equal(addressIn("ready - started server on 0.0.0.0:3000, url: http://localhost:3000"), "http://localhost:3000/");
  assert.equal(addressIn("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."), "http://localhost:8000/");
  assert.equal(addressIn("Available on:\n  http://127.0.0.1:8080\n  http://192.168.1.4:8080"), "http://localhost:8080/");
  assert.equal(addressIn("Server listening on port 9000"), "http://localhost:9000/");
  assert.equal(addressIn("compiling…\nwarning: something"), null);
  assert.equal(addressIn("listening on http://192.168.1.4:3000"), null, "a network address is not this machine");
});

await test("the address keeps the scheme and base path the server printed", () => {
  assert.equal(addressIn("  ➜  Local:   https://localhost:5173/"), "https://localhost:5173/", "an https dev server does not answer http");
  assert.equal(addressIn("  ➜  Local:   http://localhost:5173/app/"), "http://localhost:5173/app/");
  assert.equal(addressIn("Local: http://localhost:3000/, Network: http://10.0.0.2:3000/"), "http://localhost:3000/");
  assert.equal(addressIn("listening on http://localhost:99999"), null, "not a port");
  assert.equal(addressIn("Server listening on port 70000"), null, "not a port either");
  assert.equal(localAddress("http://0.0.0.0:8080/x"), "http://localhost:8080/x");
  assert.equal(localAddress("http://[::]:8080/"), "http://localhost:8080/");
  assert.equal(localAddress("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
});

await test("a dev server that only bound the IPv6 loopback still answers on localhost", async () => {
  const server = http.createServer((_q, r) => r.end("ok"));
  const port = await new Promise<number | null>((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "::1", () => resolve((server.address() as { port: number }).port));
  });
  if (port === null) { console.log("  skip  no IPv6 loopback here"); return; }
  try {
    assert.equal(await answers(`http://localhost:${port}/`), true);
    assert.equal(await answers(`http://[::1]:${port}/`), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test("devices are a phone, a tablet and a desktop, each with a real size", () => {
  assert.deepEqual(Object.keys(DEVICES), ["phone", "tablet", "desktop"]);
  assert.ok(DEVICES.phone.width < DEVICES.tablet.width && DEVICES.tablet.width < DEVICES.desktop.width);
  assert.equal(isDevice("tablet"), true);
  assert.equal(isDevice("watch"), false);
  assert.equal(deviceFor(390), "phone");
  assert.equal(deviceFor(820), "tablet");
  assert.equal(deviceFor(1280), "desktop");
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-site-"));
fs.mkdirSync(path.join(dir, "site", "about"), { recursive: true });
fs.writeFileSync(path.join(dir, "site", "index.html"), "<h1>home</h1>");
fs.writeFileSync(path.join(dir, "site", "about", "index.html"), "<h1>about</h1>");
fs.writeFileSync(path.join(dir, "site", "app.js"), "console.log(1)");
fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");

await test("a folder is served as it is on disk, with its index and its types", async () => {
  const server = await serveFolder(path.join(dir, "site"));
  try {
    assert.match(server.url, /^http:\/\/localhost:\d+\/$/);
    assert.equal((await get(server.url)).body, "<h1>home</h1>");
    assert.equal((await get(`${server.url}about/`)).body, "<h1>about</h1>");
    const js = await get(`${server.url}app.js`);
    assert.match(js.type, /javascript/);
    fs.writeFileSync(path.join(dir, "site", "app.js"), "console.log(2)");
    assert.equal((await get(`${server.url}app.js`)).body, "console.log(2)", "an edit shows on reload");
    assert.equal((await get(`${server.url}client/route`)).body, "<h1>home</h1>", "a single-page app's route gets the index");
    assert.equal((await get(`${server.url}missing.png`)).status, 404, "a file that is not there is not the index");
    assert.equal(await answers(server.url), true);
    assert.equal(await waitForServer(server.url, 1000), true);
  } finally {
    await server.close();
  }
  assert.equal(await answers(server.url, 400), false, "closed means closed");
});

await test("nothing above the folder can be read", async () => {
  const server = await serveFolder(path.join(dir, "site"));
  try {
    for (const evil of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/about/../../secret.txt"]) {
      const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.port, path: evil, method: "GET" }, (res) => {
          let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject); req.end();
      });
      assert.ok(!r.body.includes("do not serve"), `${evil} leaked`);
    }
  } finally {
    await server.close();
  }
});

await test("waiting for a server gives up, and can be told to stop", async () => {
  const t = Date.now();
  assert.equal(await waitForServer("http://127.0.0.1:1/", 700), false);
  assert.ok(Date.now() - t < 3000);
  assert.equal(await waitForServer("http://127.0.0.1:1/", 60_000, () => true), false);
});

await test("only plain values of the allowed styles can be tried on the page", () => {
  assert.equal(safeStyle("color", "#ff6a00"), "#ff6a00");
  assert.equal(safeStyle("font-size", "20px"), "20px");
  assert.equal(safeStyle("padding", "8px 12px"), "8px 12px");
  assert.equal(safeStyle("box-shadow", "0 2px 8px rgba(0,0,0,0.3)"), "0 2px 8px rgba(0,0,0,0.3)");
  assert.equal(safeStyle("opacity", 0.5), "0.5");
  assert.equal(safeStyle("background-image", "none"), null, "not an editable property");
  assert.equal(safeStyle("position", "fixed"), null);
  assert.equal(safeStyle("color", "red; } body { display:none"), null);
  assert.equal(safeStyle("color", "url(javascript:alert(1))"), null);
  assert.equal(safeStyle("width", "expression(alert(1))"), null);
  assert.equal(safeStyle("width", "x".repeat(200)), null);
  assert.ok(EDITABLE_STYLES.includes("border-radius"));
});

await test("an operation is one expression with its arguments as data", () => {
  const e = pickExpression({ op: "at", x: 4, y: 5, light: true });
  assert.match(e, /^\(\(req\) => \{/);
  assert.ok(e.endsWith(`)({"op":"at","x":4,"y":5,"light":true})`));
  const hostile = pickExpression({ op: "sel", selector: `"); alert(1); ("` });
  assert.ok(hostile.includes(`\\"); alert(1); (\\"`), "the selector is a string in JSON, not code");
  assert.doesNotThrow(() => new Function(`return ${pickExpression({ op: "rects", selectors: ["a"] })}`), "the script parses");
});

const element = (over: Record<string, unknown> = {}) => ({
  selector: "a.cta", tag: "a", id: "", classes: ["cta"], text: "Shop bikes", fullText: "Shop bikes", editableText: true,
  attrs: { href: "#" }, rect: { x: 24, y: 190, w: 122, h: 36 }, styles: { color: "rgb(255, 255, 255)", fontSize: "14px", padding: "10px 18px" },
  html: '<a class="cta" href="#">Shop bikes</a>', path: [{ tag: "section", id: "", classes: ["hero"], selector: "section.hero" }],
  children: 0, source: "src/Hero.tsx:12", component: "Hero", visible: true, ...over,
}) as any;

await test("an element is described the way the agent can act on it", () => {
  const text = describeElement(element());
  assert.match(text, /Element <a class="cta">, selector: a\.cta/);
  assert.match(text, /Text: "Shop bikes"/);
  assert.match(text, /Size: 122×36 at 24,190/);
  assert.match(text, /fontSize: 14px/);
  assert.match(text, /From: component Hero, src\/Hero\.tsx:12/);
  assert.match(text, /Inside: section\.hero/);
});

await test("a review is one message: each comment numbered, what changed, and the page's errors", () => {
  const scroll = { x: 0, y: 100 };
  const viewport = { width: 1280, height: 800 };
  const text = reviewMessage({
    url: "http://localhost:5173/", viewport, device: "Desktop", consoleErrors: ["Uncaught: x is not defined"],
    comments: [
      { id: "a", kind: "element", text: "Bigger and orange", elements: [element()], styleChanges: [{ property: "font-size", from: "14px", to: "20px" }], blob: "b1", scroll, viewport, ts: 1 },
      { id: "b", kind: "region", text: "", elements: [], region: { x: 20, y: 240, w: 420, h: 120 }, styleChanges: [], blob: "b2", scroll, viewport, ts: 2 },
      { id: "c", kind: "element", text: "", elements: [element({ selector: "h1", tag: "h1", classes: [] })], textEdit: { from: "Ride further.", to: "Ride far." }, styleChanges: [], blob: null, scroll, viewport, ts: 3 },
    ],
  });
  assert.match(text, /^\[Autora: the person reviewed the app preview \(http:\/\/localhost:5173\/, shown at 1280×800, Desktop\) and left 3 comments\./);
  assert.match(text, /1\. Bigger and orange\n[\s\S]*selector: a\.cta[\s\S]*Change the styles: font-size: 14px -> 20px/);
  assert.match(text, /2\. \(no words: look at the picture\)\n {3}Region: 420×120 at 20,240 \(page position 20,340\)/);
  assert.match(text, /3\. \(see the change below\)[\s\S]*Change the text: "Ride further\." -> "Ride far\."/);
  assert.match(text, /The page's console[\s\S]*x is not defined/);
  const one = reviewMessage({ url: "u", viewport, device: "Phone", consoleErrors: [], comments: [{ id: "a", kind: "element", text: "x", elements: [], styleChanges: [], blob: null, scroll, viewport, ts: 1 }] });
  assert.match(one, /left 1 comment\./);
  assert.ok(!one.includes("console"));
});

console.log(`\n${passed} passed`);
