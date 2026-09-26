/**
 * The person's details in an API call: a placeholder in the address, a header
 * or the body is filled in before the request goes out, and a sign-in for one
 * site is refused on another.
 *
 * The requests go to a server started here, which answers with what it was
 * actually sent -- so a header that arrived is a placeholder that was filled.
 *
 *   npx tsx tests/httprequest.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-httpreq-"));
process.env.AUTORA_STATE_DIR = dir;

const cred = await import("../server/credentials");
const { findTool, runTool } = await import("../server/tools");

cred.setIdentity({ first_name: "Jonathan", last_name: "Quill", email: "jq@example.com" });
cred.saveLogin({ site: "github.com", username: "jquill", password: "hunter2-long" });

console.log("http_request placeholders");

/** What the server last received. */
const seen: { authorization?: string; url?: string; body?: string } = {};
const server = http.createServer((req, res) => {
  seen.authorization = req.headers.authorization as string | undefined;
  seen.url = req.url;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.body = body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ arrived: seen.url, body }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/`;

const ctx = {
  onOutput: () => undefined,
  putBlob: () => "blob",
  showImage: () => undefined,
  showWidget: () => undefined,
  showScreen: () => undefined,
  browser: () => {
    throw new Error("no browser in this test");
  },
  browserChanged: () => undefined,
  watchDesktop: () => undefined,
  cancelled: () => false,
  onCancel: () => undefined,
  memory: {
    write: () => ({ id: "m", action: "add" }),
    search: () => [],
    update: () => false,
    forget: () => false,
  },
  vault: () => null,
  session: "test",
  ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
} as unknown as import("../server/tools").ToolContext;

const http_request = findTool("http_request")!;

const header = await runTool(
  http_request,
  { url: base, headers: { Authorization: "Bearer {{cred:first_name}}" } },
  ctx,
);
assert.equal(header.ok, true, header.summary);
assert.equal(seen.authorization, "Bearer Jonathan");
console.log("  ok  a placeholder in a header goes out as the real value");

const inUrl = await runTool(http_request, { url: `${base}?who={{cred:email}}` }, ctx);
assert.equal(inUrl.ok, true, inUrl.summary);
assert.equal(seen.url, "/?who=jq@example.com", String(seen.url));
console.log("  ok  a placeholder in the address is filled too");

const inBody = await runTool(
  http_request,
  { url: base, method: "POST", body: JSON.stringify({ who: "{{cred:full_name}}" }) },
  ctx,
);
assert.equal(inBody.ok, true, inBody.summary);
assert.equal(seen.body, '{"who":"Jonathan Quill"}');
console.log("  ok  a placeholder in the body is filled too");

const elsewhere = await runTool(
  http_request,
  { url: base, headers: { Authorization: "token {{cred:github.com:password}}" } },
  ctx,
);
assert.equal(elsewhere.ok, false, "a github sign-in must not be sent to another site");
assert.match(elsewhere.summary, /Refused/i);
assert.ok(!elsewhere.summary.includes("hunter2-long"), "the password must not come back");
console.log("  ok  a sign-in saved for one site is refused for another");

const unknown = await runTool(http_request, { url: base, headers: { "X-Who": "{{cred:nonsense}}" } }, ctx);
assert.equal(unknown.ok, false);
assert.match(unknown.summary, /no credential called/i);
console.log("  ok  a placeholder with no credential says so instead of sending it");

server.close();
console.log("httprequest: all passed");
