/**
 * Listening through Deepgram: one page's microphone, one stream upstream, for
 * as long as talk mode lasts. Run against a stand-in for Deepgram on a local
 * port, with the real `ws` library on both ends, because the failures here are
 * about sockets: what is asked for in the URL, what is passed on, and that a
 * page closed mid-sentence never leaves a microphone open upstream.
 *
 *   npx tsx tests/dictation.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-dictation-"));
process.env.DEEPGRAM_API_KEY = "dg-test-key";

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

const until = async (cond: () => boolean, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface Upstream { url: string; headers: http.IncomingHttpHeaders; sock: WebSocket; got: { data: Buffer; binary: boolean }[]; closed: boolean }

async function main() {
  const { attachDictation, dictationStatus } = await import("../server/dictation");

  /* Stand-in for Deepgram. */
  const upstreams: Upstream[] = [];
  const deepgram = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  deepgram.on("connection", (sock, req) => {
    const up: Upstream = { url: req.url ?? "", headers: req.headers, sock, got: [], closed: false };
    sock.on("message", (data, binary) => up.got.push({ data: data as Buffer, binary }));
    sock.on("close", () => { up.closed = true; });
    upstreams.push(up);
  });
  await new Promise((r) => deepgram.on("listening", r));
  process.env.AUTORA_DEEPGRAM_STT_URL = `ws://127.0.0.1:${(deepgram.address() as { port: number }).port}/v1/listen`;

  /* The console's side: a socket per page, handed to attachDictation. */
  let asked: { rate?: string; lang?: string } = {};
  const consoleSide = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  consoleSide.on("connection", (ws) => attachDictation(ws as never, asked));
  await new Promise((r) => consoleSide.on("listening", r));
  const pageUrl = `ws://127.0.0.1:${(consoleSide.address() as { port: number }).port}`;

  /** A page: connects, and records everything the console says to it. */
  const page = async (ask: { rate?: string; lang?: string } = {}) => {
    asked = ask;
    const before = upstreams.length;
    const ws = new WebSocket(pageUrl);
    const heard: any[] = [];
    let closed = false;
    ws.on("message", (d) => heard.push(JSON.parse(String(d))));
    ws.on("close", () => { closed = true; });
    await new Promise((r) => ws.on("open", r));
    return { ws, heard, isClosed: () => closed, before };
  };
  const upstreamOf = async (p: { before: number }) => {
    await until(() => upstreams.length > p.before, "the upstream connection");
    return upstreams[upstreams.length - 1];
  };
  const params = (u: Upstream) => new URL(`http://x${u.url}`).searchParams;

  console.log("is it available");
  await test("with a key it is available through Deepgram; the reason is only given without one", () => {
    assert.deepEqual(dictationStatus(), { available: true, provider: "deepgram", reason: null });
  });

  console.log("what is asked for");
  await test("the key goes in a header, never the URL, and the name is hinted", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    assert.equal(up.headers.authorization, "Token dg-test-key");
    assert.ok(!up.url.includes("dg-test-key"));
    const q = params(up);
    assert.deepEqual([q.get("model"), q.get("encoding"), q.get("channels"), q.get("interim_results")],
      ["nova-2", "linear16", "1", "true"]);
    assert.equal(q.get("keywords"), "Autora:2");
    p.ws.close();
    await until(() => up.closed, "the upstream to close");
  });
  await test("the page's rate and language are used when they are sane, and not otherwise", async () => {
    const good = await page({ rate: "44100", lang: "sv-SE" });
    const gu = await upstreamOf(good);
    assert.deepEqual([params(gu).get("sample_rate"), params(gu).get("language")], ["44100", "sv-SE"]);
    good.ws.close();
    for (const [rate, lang] of [["96000", "en&punctuate=false"], ["5", "en-US;drop=1"], ["abc", "../../x"], ["", ""]]) {
      const p = await page({ rate, lang });
      const u = await upstreamOf(p);
      assert.deepEqual([params(u).get("sample_rate"), params(u).get("language")], ["16000", "en-US"], `${rate} ${lang}`);
      assert.equal(params(u).get("punctuate"), "true", "a page cannot add or change parameters");
      p.ws.close();
    }
  });
  await test("a newer model is asked for the name the newer way", async () => {
    process.env.AUTORA_DEEPGRAM_STT_MODEL = "nova-3";
    try {
      const p = await page();
      const u = await upstreamOf(p);
      assert.equal(params(u).get("keyterm"), "Autora");
      assert.equal(params(u).get("keywords"), null);
      p.ws.close();
    } finally {
      delete process.env.AUTORA_DEEPGRAM_STT_MODEL;
    }
  });

  console.log("what is passed on");
  await test("the page hears ready, then words as they form, and nothing empty", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    await until(() => p.heard.some((m) => m.type === "ready"), "ready");
    const say = (o: unknown) => up.sock.send(JSON.stringify(o));
    say({ type: "SpeechStarted" });
    say({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hello wor" }] } });
    say({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "  hello world " }] } });
    say({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "" }] } });
    say({ type: "Results", is_final: true, channel: { alternatives: [] } });
    say({ type: "Metadata", request_id: "x" });
    up.sock.send("{not json");
    await until(() => p.heard.filter((m) => m.type === "text").length === 2, "the two phrases");
    assert.deepEqual(p.heard.filter((m) => m.type !== "ready"), [
      { type: "speaking" },
      { type: "text", text: "hello wor", final: false },
      { type: "text", text: "hello world", final: true },
    ]);
    p.ws.close();
  });
  await test("audio goes upstream as it is; words, and anything over 128 KB, do not", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    await until(() => p.heard.some((m) => m.type === "ready"), "ready");
    const chunk = Buffer.alloc(2048, 7);
    p.ws.send(chunk);
    p.ws.send("please send this text upstream");
    p.ws.send(Buffer.alloc(128 * 1024 + 1));
    p.ws.send(chunk);
    await until(() => up.got.length >= 2, "the audio");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(up.got.length, 2);
    assert.ok(up.got.every((g) => g.binary && g.data.length === 2048));
    p.ws.close();
  });

  console.log("when it ends");
  await test("the page saying close ends it on both sides", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    await until(() => p.heard.some((m) => m.type === "ready"), "ready");
    p.ws.send("close");
    await until(() => up.closed && p.isClosed(), "both sockets to close");
  });
  await test("a page closed mid-sentence lets Deepgram settle the phrase, then leaves no stream open", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    await until(() => p.heard.some((m) => m.type === "ready"), "ready");
    p.ws.close();
    await until(() => up.closed, "the upstream to close");
    assert.ok(up.got.some((g) => !g.binary && JSON.parse(g.data.toString()).type === "CloseStream"));
  });
  await test("Deepgram going away is said to the page, then the page's socket closes too", async () => {
    const p = await page();
    const up = await upstreamOf(p);
    await until(() => p.heard.some((m) => m.type === "ready"), "ready");
    up.sock.close();
    await until(() => p.isClosed(), "the page's socket to close");
    assert.ok(p.heard.some((m) => m.type === "closed"));
  });
  await test("a refused connection is said in words, not left hanging", async () => {
    const dead = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => dead.on("listening", r));
    dead.close();
    const saved = process.env.AUTORA_DEEPGRAM_STT_URL;
    process.env.AUTORA_DEEPGRAM_STT_URL = `ws://127.0.0.1:${(dead.address() as { port: number } | null)?.port ?? 1}/v1/listen`;
    try {
      const p = await page();
      await until(() => p.isClosed(), "the page's socket to close");
      assert.ok(p.heard.some((m) => m.type === "error" && /refused the connection/.test(m.detail)), JSON.stringify(p.heard));
    } finally {
      process.env.AUTORA_DEEPGRAM_STT_URL = saved;
    }
  });
  await test("with no key it says so and closes, and never dials", async () => {
    const key = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    try {
      assert.equal(dictationStatus().available, false);
      assert.match(dictationStatus().reason!, /Deepgram API key/);
      const p = await page();
      await until(() => p.isClosed(), "the page's socket to close");
      assert.match(p.heard[0].detail, /No listening service/);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(upstreams.length > p.before, false);
    } finally {
      process.env.DEEPGRAM_API_KEY = key;
    }
  });

  deepgram.close();
  consoleSide.close();
  console.log(`\n${passed} dictation cases passed.`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
