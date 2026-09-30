/**
 * The desktop relay: one machine somewhere, dialled in, answering one action
 * at a time. The failure that costs a person half an hour is a relay that
 * stops working for no visible reason, so the cases are the ways it can go
 * quiet -- displaced, disconnected, wedged, refused -- and that each one is
 * said in words and never leaves a turn waiting.
 *
 *   npx tsx tests/desktop.test.ts
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

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

/** The relay's end of a websocket, as far as the server can tell. */
class FakeSocket extends EventEmitter {
  sent: any[] = [];
  closed = false;
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.emit("close"); }
  say(message: unknown) { this.emit("message", Buffer.from(JSON.stringify(message))); }
  actions() { return this.sent.filter((m) => m.type === "action"); }
}
const asWs = (s: FakeSocket) => s as never;

async function main() {
  const desktop = await import("../server/desktop");
  const { attachRelay, cleanHost, relayAction, relayClientSource, relayConnected, relayStatus, watchDesktop, RELAY_URL } = desktop;
  let changes = 0;
  const changed = () => { changes += 1; };

  /** A relay that has said hello. */
  const relay = (hello: Record<string, unknown> = {}) => {
    const s = new FakeSocket();
    attachRelay(asWs(s), changed);
    s.say({ type: "hello", platform: "Darwin-14.2", screen: { w: 2560, h: 1440 }, ...hello });
    return s;
  };

  console.log("connecting");
  await test("with no relay, an action says how to get one instead of hanging", async () => {
    const out = await relayAction("click", { x: 1, y: 2 });
    assert.equal(out.ok, false);
    assert.match(out.error!, /No desktop relay is connected/);
    assert.equal(relayConnected(), false);
  });
  await test("connected but not yet hello'd is not usable, and says it is connecting", async () => {
    const s = new FakeSocket();
    attachRelay(asWs(s), changed);
    assert.equal(relayConnected(), false);
    assert.match(relayStatus().detail!, /connecting/);
    assert.match((await relayAction("click")).error!, /No desktop relay/);
    s.close();
  });
  await test("hello sets the machine, the screen and whether it may click", () => {
    const s = relay();
    assert.deepEqual([relayStatus().connected, relayStatus().platform, relayStatus().screen, relayStatus().canControl],
      [true, "Darwin-14.2", { w: 2560, h: 1440 }, true]);
    s.close();
  });
  await test("a relay that does not say can_control is assumed able; only false means no", () => {
    let s = relay();
    assert.equal(relayStatus().canControl, true);
    s.close();
    s = relay({ can_control: false });
    assert.equal(relayStatus().canControl, false);
    s.close();
  });
  await test("nonsense from the relay is ignored, not thrown", () => {
    const s = relay();
    s.emit("message", Buffer.from("{not json"));
    s.say({ type: "hello", platform: 42, screen: { w: "wide", h: null } });
    assert.equal(relayStatus().platform, null);
    assert.deepEqual(relayStatus().screen, { w: null, h: null });
    s.say({ type: "frame" });
    s.say({ type: "unknown" });
    s.close();
  });

  console.log("doing things");
  await test("an action goes out with an id and resolves with exactly its own answer", async () => {
    const s = relay();
    const first = relayAction("click", { x: 400, y: 300, button: "left" });
    const second = relayAction("screenshot");
    const [a, b] = s.actions();
    assert.notEqual(a.id, b.id);
    assert.deepEqual([a.action, a.x, a.y, a.button], ["click", 400, 300, "left"]);
    // Answered out of order: a slow screenshot must not be taken for the click.
    s.say({ type: "result", id: b.id, ok: true, data: { png: "abc" } });
    s.say({ type: "result", id: a.id, ok: false, error: "no permission" });
    assert.deepEqual(await second, { ok: true, data: { png: "abc" }, error: undefined });
    assert.deepEqual(await first, { ok: false, data: undefined, error: "no permission" });
    s.close();
  });
  await test("an answer nobody is waiting for is dropped", () => {
    const s = relay();
    s.say({ type: "result", id: "a99999", ok: true });
    s.close();
  });
  await test("a relay that cannot control the machine may still take pictures", async () => {
    const s = relay({ can_control: false });
    const refused = await relayAction("click", { x: 1, y: 1 });
    assert.match(refused.error!, /can capture the screen but is not permitted to control it/);
    assert.match(refused.error!, /Accessibility/);
    assert.equal(s.actions().length, 0, "nothing was sent");
    const shot = relayAction("screenshot");
    s.say({ type: "result", id: s.actions()[0].id, ok: true });
    assert.equal((await shot).ok, true);
    s.close();
  });
  await test("a wedged relay is given up on after ten seconds, and its late answer is ignored", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const s = relay();
      const waiting = relayAction("click", { x: 1, y: 1 });
      mock.timers.tick(10_000);
      const out = await waiting;
      assert.match(out.error!, /did not answer within 10s/);
      s.say({ type: "result", id: s.actions()[0].id, ok: true });
      s.close();
    } finally {
      mock.timers.reset();
    }
  });

  console.log("going quiet");
  await test("a relay that disconnects answers everything still waiting, in words", async () => {
    const s = relay();
    const waiting = [relayAction("click"), relayAction("type")];
    s.close();
    for (const w of waiting) assert.match((await w).error!, /disconnected/);
    assert.equal(relayConnected(), false);
    assert.equal(relayStatus().detail, "The relay disconnected.");
  });
  await test("a connection error says what failed", () => {
    const s = relay();
    s.emit("error", new Error("ECONNRESET"));
    assert.match(relayStatus().detail!, /connection failed: ECONNRESET/);
  });
  await test("a second relay displaces the first, tells it why, and the first closing changes nothing", () => {
    const first = relay();
    const second = new FakeSocket();
    attachRelay(asWs(second), changed);
    assert.equal(first.closed, true);
    assert.match(first.sent.find((m) => m.type === "bye").reason, /Another relay connected/);
    second.say({ type: "hello", platform: "Linux", screen: { w: 1, h: 2 } });
    // The old socket's close event arrives after the new one is in charge.
    first.emit("close");
    assert.equal(relayStatus().connected, true);
    assert.equal(relayStatus().platform, "Linux");
    second.close();
  });

  console.log("what is on the screen");
  await test("frames go to whoever is watching, and capture is only asked for while someone is", () => {
    const s = relay();
    const got: [string, string][] = [];
    watchDesktop((data, mime) => got.push([data, mime]));
    assert.deepEqual(s.sent.filter((m) => m.type === "stream").pop(), { type: "stream", on: true, fps: 2 });
    s.say({ type: "frame", data: "AAAA" });
    s.say({ type: "frame", data: "BBBB", mime: "image/png" });
    s.say({ type: "frame", data: 7 });
    assert.deepEqual(got, [["AAAA", "image/jpeg"], ["BBBB", "image/png"]]);
    watchDesktop(null);
    assert.equal(s.sent.filter((m) => m.type === "stream").pop().on, false);
    s.say({ type: "frame", data: "CCCC" });
    assert.equal(got.length, 2, "nothing is delivered once nobody watches");
    s.close();
  });
  await test("a watcher waiting from before the relay existed is served when it says hello", () => {
    watchDesktop(() => undefined);
    const s = new FakeSocket();
    attachRelay(asWs(s), changed);
    s.say({ type: "hello", platform: "Windows" });
    assert.equal(s.sent.filter((m) => m.type === "stream").pop().on, true);
    watchDesktop(null);
    s.close();
  });
  await test("a screen that changes under a running relay is reported, and a bad size keeps the old one", () => {
    const s = relay();
    const before = changes;
    s.say({ type: "screen", w: 1920, h: 1080 });
    assert.deepEqual(relayStatus().screen, { w: 1920, h: 1080 });
    s.say({ type: "screen", w: "x", h: 0 });
    assert.deepEqual(relayStatus().screen, { w: 1920, h: 1080 });
    assert.ok(changes > before);
    s.close();
  });

  console.log("the script it hands out");
  await test("only a plain host and port may be written into it", () => {
    for (const ok of ["box.ts.net", "192.168.1.5:8817", "[fd7a::1]:8817", "localhost:3000"]) assert.equal(cleanHost(ok), ok, ok);
    for (const bad of ['x";import os;os.system("id");"', "a b", "a\nb", "", undefined, "x'y", "a/b", "x".repeat(300)]) {
      assert.equal(cleanHost(bad), null, String(bad));
    }
    assert.ok(RELAY_URL.test("wss://box.ts.net/ws/desktop-relay"));
    assert.ok(!RELAY_URL.test('ws://x"/ws/desktop-relay'));
    assert.throws(() => relayClientSource('ws://evil";import os;#/ws/desktop-relay'), /not an address/);
    assert.throws(() => relayClientSource("http://box/ws/desktop-relay"), /not an address/);
  });
  await test("the script carries the address it was given, and is valid Python", () => {
    const url = "wss://box.tailnet.ts.net/ws/desktop-relay";
    const source = relayClientSource(url);
    assert.ok(source.includes(`WS_URL = "${url}"`));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autora-relay-")), "relay.py");
    fs.writeFileSync(file, source);
    const py = spawnSync("python3", ["-m", "py_compile", file], { encoding: "utf8" });
    if (py.error) console.log("    (python3 not available here; syntax not checked)");
    else assert.equal(py.status, 0, py.stderr);
  });
  console.log(`\n${passed} desktop cases passed.`);
}
main().catch((err) => { console.error(err); process.exit(1); });
