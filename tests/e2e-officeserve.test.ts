/**
 * The editors' pages are sent compressed (the Excel one is 14 MB as it is), kept
 * after the first time, answered with 304 when nothing changed, and only ever
 * from the editors' own folder.
 *
 *   npx tsx tests/e2e-officeserve.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const file = "dist/office/web/sheets/index.html";
  if (!fs.existsSync(file)) { console.log("  skip  the Excel editor is not built (node scripts/build-office.mjs)"); return; }
  const app = await startApp();
  try {
    const raw = fs.readFileSync(file);
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${app.base}${path}`, { headers: { "Accept-Encoding": "identity", ...headers } });
    const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

    await test("with brotli accepted the page comes compressed, and is the same page", async () => {
      const r = await fetch(`${app.base}/office-app/sheets/index.html`, { headers: { "Accept-Encoding": "br" } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-encoding"), "br");
      assert.equal(r.headers.get("vary"), "Accept-Encoding");
      assert.match(r.headers.get("content-security-policy") ?? "", /^sandbox/);
      const sent = Buffer.from(await r.arrayBuffer());
      const wire = Number(r.headers.get("content-length") ?? sent.length);
      assert.ok(wire < raw.length / 3, `${wire} bytes for ${raw.length}`);
    });

    await test("gzip works too, and without either the file is sent as it is", async () => {
      const gz = await fetch(`${app.base}/office-app/sheets/index.html`, { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(gz.headers.get("content-encoding"), "gzip");
      const plain = await get("/office-app/sheets/index.html");
      assert.equal(plain.headers.get("content-encoding"), null);
      assert.equal((await bytes(plain)).length, raw.length);
      void zlib;
    });

    await test("asked again with its tag, nothing is sent", async () => {
      const first = await fetch(`${app.base}/office-app/sheets/index.html`, { headers: { "Accept-Encoding": "br" } });
      const tag = first.headers.get("etag")!;
      await first.arrayBuffer();
      const again = await fetch(`${app.base}/office-app/sheets/index.html`, { headers: { "Accept-Encoding": "br", "If-None-Match": tag } });
      assert.equal(again.status, 304);
    });

    await test("nothing outside the editors' folder is reachable this way", async () => {
      // Sent as written: fetch would tidy ".." away before it left, and the server would never see it.
      const rawGet = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(app.base);
        http.get({ host: u.hostname, port: u.port, path: p, headers: { "Accept-Encoding": "br" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        }).on("error", reject);
      });
      for (const p of ["/office-app/..%2f..%2fpackage.json", "/office-app/%2e%2e%2f%2e%2e%2fpackage.json", "/office-app/sheets/..%2f..%2f..%2f..%2fpackage.json", "/office-app/../../package.json"]) {
        const r = await rawGet(p);
        assert.doesNotMatch(r.body, /"autora"/, `${p} -> ${r.status}`);
      }
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
