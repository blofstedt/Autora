/**
 * The Terminal window's server side (server/termdesk.ts): a real shell on a pseudo-terminal behind a websocket.
 * Input reaches it and its output comes back, it is a terminal (a tty, the size the page gives, Ctrl+C), the folder it
 * is in is where the agent starts, what the agent runs is printed into it, what the person ran is told to the agent,
 * a page that comes later gets the scrollback, and putting the window away ends the shell. A page on another site is
 * refused.
 *
 *   npx tsx tests/termdesk.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import WebSocket from "ws";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-termdesk-test-"));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autora-term-work-")));
process.env.AUTORA_WORKDIR = work;
fs.mkdirSync(path.join(work, "alpha"));

const term = await import("../server/termdesk");
const { allowSocket } = await import("../server/crosssite");

const S = "session-test-1";
const app = express();
app.use(express.json());
term.termRoutes(app, { exists: (id) => id === S });
const server = http.createServer(app);
server.on("upgrade", (req, socket, head) => {
  if (!term.termUpgrade(req, socket, head, allowSocket)) socket.destroy();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A page: what the shell has said so far, and a way to type. */
function page(extraHeaders: Record<string, string> = {}, cols = 100, rows = 30) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/term/ws?session=${S}&cols=${cols}&rows=${rows}`, { headers: extraHeaders });
  let seen = "";
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { t: string; d?: string };
    if (msg.t === "out") seen += msg.d ?? "";
  });
  const until = async (re: RegExp, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(seen)) return seen;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`never saw ${re} in ${JSON.stringify(seen.slice(-400))}`);
  };
  return {
    ws, until, text: () => seen,
    open: new Promise<void>((res, rej) => { ws.on("open", res); ws.on("error", rej); ws.on("close", () => rej(new Error("closed"))); }),
    type: (d: string) => ws.send(JSON.stringify({ t: "in", d })),
    size: (cols: number, rows: number) => ws.send(JSON.stringify({ t: "size", cols, rows })),
  };
}

await fetch(`${base}/api/term/${S}/open`, { method: "POST" });

await test("what is typed reaches a real shell and its output comes back", async () => {
  const p = page();
  await p.open;
  p.type("echo hello-$((20+22))\r");
  await p.until(/hello-42/);
  p.type("tty\r");
  await p.until(/\/dev\/(pts|tty)/);
  p.ws.close();
});

await test("the shell is the size the page says, and a new size reaches it", async () => {
  const p = page({}, 91, 27);
  await p.open;
  p.type("stty size\r");
  await p.until(/27 91/);
  p.size(120, 40);
  await new Promise((r) => setTimeout(r, 200));
  p.type("stty size\r");
  await p.until(/40 120/);
  p.ws.close();
});

await test("Ctrl+C stops what is running", async () => {
  const p = page();
  await p.open;
  p.type("sleep 30\r");
  await new Promise((r) => setTimeout(r, 300));
  p.type("\x03");
  p.type("echo back-$((1+1))\r");
  await p.until(/back-2/);
  p.ws.close();
});

await test("the folder the shell is in is where the agent starts", async function () {
  const p = page();
  await p.open;
  p.type(`cd ${path.join(work, "alpha")}\r`);
  const end = Date.now() + 5000;
  while (Date.now() < end && term.termCwd(S) !== path.join(work, "alpha")) await new Promise((r) => setTimeout(r, 50));
  if (!fs.existsSync("/proc/self/cwd")) return; // no /proc here: the last known folder is all there is
  assert.equal(term.termCwd(S), path.join(work, "alpha"));
  p.ws.close();
});

await test("what the agent runs is printed into the terminal, marked as its own", async () => {
  const p = page();
  await p.open;
  const id = term.termAgentBegin(S, "ls -la", work);
  term.termAgentChunk(S, id, "one\ntwo\n");
  term.termAgentEnd(S, id, 0);
  const seen = await p.until(/\[Autora\] done/);
  assert.match(seen, /\[Autora\] \$ ls -la/);
  assert.match(seen, /one\r\ntwo/);
  p.ws.close();
});

await test("what the person ran is told to the agent once", async () => {
  term.termNews(S); // whatever came before
  const p = page();
  await p.open;
  p.type("echo from-the-person\r");
  await p.until(/from-the-person/);
  const news = term.termNews(S);
  assert.match(news, /echo from-the-person/);
  assert.equal(term.termNews(S), "", "told once");
  p.ws.close();
});

await test("a page that comes later gets the scrollback of the same shell", async () => {
  const first = page();
  await first.open;
  first.type("echo remembered-$((6*7))\r");
  await first.until(/remembered-42/);
  first.ws.close();
  const later = page();
  await later.open;
  await later.until(/remembered-42/);
  later.ws.close();
});

await test("a page on another site is refused, and so is a session that does not exist", async () => {
  const other = page({ "sec-fetch-site": "cross-site" });
  await assert.rejects(other.open);
  const nobody = new WebSocket(`ws://127.0.0.1:${port}/api/term/ws?session=nope`);
  await assert.rejects(new Promise<void>((res, rej) => { nobody.on("open", res); nobody.on("error", rej); nobody.on("close", () => rej(new Error("closed"))); }));
});

await test("putting the window away ends the shell", async () => {
  const p = page();
  await p.open;
  p.type("echo up\r");
  await p.until(/up/);
  assert.equal(term.termState(S).running, true);
  await fetch(`${base}/api/term/${S}/close`, { method: "POST" });
  assert.equal(term.termState(S).open, false);
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(p.ws.readyState, WebSocket.OPEN, "the page's socket was closed with it");
});

term.dropTerm(S);
server.close();
console.log(`\n${passed} passed`);
process.exit(0);
