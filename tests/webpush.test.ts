/**
 * Web Push: the encryption is checked against the RFC's own worked example,
 * because a message a browser cannot decrypt fails silently -- nothing on the
 * phone, nothing in the log -- and there is nothing else to compare it to.
 *
 *   npx tsx tests/webpush.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliver, readyChannels } from "../server/push";
import {
  WebPush, cleanEndpoint, cleanSubscription, encryptPayload, makeVapid, vapidHeader,
} from "../server/webpush";

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

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

/** A browser, for the tests: a subscription key pair and an auth secret. */
function browser() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
  const auth = crypto.randomBytes(16);
  return { pair, point, auth, subscription: { endpoint: "https://push.example.com/send/abc12345", keys: { p256dh: b64u(point), auth: b64u(auth) } } };
}

/** What a browser does with the body: written from the RFC, apart from the sender. */
function decrypt(body: Buffer, ua: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const asKey = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(asPublic.subarray(1, 33)), y: b64u(asPublic.subarray(33, 65)) },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey: ua.pair.privateKey, publicKey: asKey });
  const h = (s: Buffer, ikm: Buffer, info: string, n: number) =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, s, Buffer.from(info), n));
  const prk = Buffer.from(crypto.hkdfSync("sha256", shared, ua.auth,
    Buffer.concat([Buffer.from("WebPush: info\0"), ua.point, asPublic]), 32));
  const key = h(salt, prk, "Content-Encoding: aes128gcm\0", 16);
  const nonce = h(salt, prk, "Content-Encoding: nonce\0", 12);
  const sealed = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv("aes-128-gcm", key, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "the record is closed with 0x02");
  return plain.subarray(0, plain.length - 1).toString();
}

async function main() {
  console.log("the message");
  await test("reproduces the RFC 8291 worked example exactly", () => {
    const asPublic = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const asPrivate = crypto.createPrivateKey({
      key: {
        kty: "EC", crv: "P-256",
        d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        x: b64u(asPublic.subarray(1, 33)), y: b64u(asPublic.subarray(33, 65)),
      },
      format: "jwk",
    });
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      unb64u("BTBZMqHH6r4Tts7J_aSIgg"),
      { asPrivate, asPublic, salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    assert.equal(
      b64u(body),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });
  await test("a message decrypts with the subscription's own key, and is new each time", () => {
    const ua = browser();
    const text = JSON.stringify({ title: "Autora needs you", body: "A code — “123456”" });
    const one = encryptPayload(Buffer.from(text), ua.point, ua.auth);
    const two = encryptPayload(Buffer.from(text), ua.point, ua.auth);
    assert.equal(decrypt(one, ua), text);
    assert.equal(decrypt(two, ua), text);
    assert.notEqual(b64u(one), b64u(two));
  });
  await test("another browser's key cannot read it", () => {
    const ua = browser();
    const other = browser();
    const body = encryptPayload(Buffer.from("private"), ua.point, ua.auth);
    assert.throws(() => decrypt(body, other));
  });
  await test("a message too long for one record is refused, not truncated", () => {
    const ua = browser();
    assert.throws(() => encryptPayload(Buffer.alloc(5000), ua.point, ua.auth), /too long/);
  });

  console.log("who is sending");
  await test("the VAPID header is signed with the console's key and names the push service", () => {
    const vapid = makeVapid();
    const header = vapidHeader("https://fcm.googleapis.com/fcm/send/xyz", vapid, "mailto:me@example.com", 1_800_000_000_000);
    const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    assert.equal(key, vapid.publicKey);
    const [h, c, sig] = jwt.split(".");
    assert.deepEqual(JSON.parse(unb64u(h).toString()), { typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(unb64u(c).toString());
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "mailto:me@example.com");
    assert.equal(claims.exp, 1_800_000_000 + 12 * 3600);
    const point = unb64u(vapid.publicKey);
    const pub = crypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
      format: "jwk",
    });
    assert.equal(unb64u(sig).length, 64);
    assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, unb64u(sig)));
  });

  console.log("what is accepted");
  await test("only real https push services, never this machine or its network", () => {
    assert.ok(cleanEndpoint("https://fcm.googleapis.com/fcm/send/abc"));
    assert.ok(cleanEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"));
    for (const bad of [
      "http://fcm.googleapis.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
      "https://[::1]/x", "https://box.local/x", "https://user:pw@fcm.googleapis.com/x", "ftp://x.com", "", "nonsense",
    ]) assert.equal(cleanEndpoint(bad), null, bad);
  });
  await test("a subscription needs a real P-256 point and a 16-byte secret", () => {
    const ua = browser();
    assert.ok(cleanSubscription(ua.subscription, "My phone"));
    assert.equal(cleanSubscription({ ...ua.subscription, keys: { ...ua.subscription.keys, auth: "short" } }), null);
    assert.equal(cleanSubscription({ ...ua.subscription, keys: { ...ua.subscription.keys, p256dh: b64u(Buffer.alloc(65, 7)) } }), null);
    assert.equal(cleanSubscription(null), null);
    assert.doesNotMatch(cleanSubscription(ua.subscription, "<script>x</script>")?.label ?? "", /[<>]/);
  });

  console.log("the devices");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-webpush-"));
  const file = path.join(home, "webpush.json");
  await test("the key is made once and kept, and the file is private", () => {
    const one = new WebPush(file);
    const key = one.publicKey();
    assert.equal(unb64u(key).length, 65);
    assert.equal(new WebPush(file).publicKey(), key);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
  await test("devices are kept across a restart; adding one again replaces it", () => {
    const wp = new WebPush(file);
    const ua = browser();
    wp.add(cleanSubscription(ua.subscription, "Pixel")!);
    wp.add(cleanSubscription(ua.subscription, "Pixel")!);
    assert.equal(wp.count(), 1);
    assert.equal(new WebPush(file).count(), 1);
    assert.equal(wp.list()[0].label, "Pixel");
    assert.ok(!JSON.stringify(wp.list()).includes(ua.subscription.keys.auth), "the list carries no keys");
    assert.equal(wp.remove(ua.subscription.endpoint), true);
    assert.equal(wp.remove(ua.subscription.endpoint), false);
  });
  await test("only ten devices are kept; the oldest goes", () => {
    const wp = new WebPush(path.join(home, "many.json"));
    for (let i = 0; i < 12; i++) {
      const ua = browser();
      wp.add(cleanSubscription({ ...ua.subscription, endpoint: `https://push.example.com/send/dev${i}xxxx` })!);
    }
    assert.equal(wp.count(), 10);
    assert.equal(wp.has("https://push.example.com/send/dev0xxxx"), false);
    assert.equal(wp.has("https://push.example.com/send/dev11xxxx"), true);
  });

  console.log("sending");
  await test("a message reaches the device encrypted, signed, and readable only there", async () => {
    const wp = new WebPush(path.join(home, "send.json"));
    const ua = browser();
    wp.add(cleanSubscription(ua.subscription)!);
    let seen: { url: string; init: any } | null = null;
    const fake = (async (url: string, init: any) => { seen = { url, init }; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const out = await wp.send({ title: "Autora can reach you here", body: "Hello", url: "https://box.ts.net/", urgent: true }, fake);
    assert.deepEqual(out, { ok: true, sent: 1, failed: 0 });
    assert.equal(seen!.url, ua.subscription.endpoint);
    const h = seen!.init.headers;
    assert.equal(h["Content-Encoding"], "aes128gcm");
    assert.equal(h.Urgency, "high");
    assert.match(h.Authorization, /^vapid t=.+, k=.+$/);
    const said = JSON.parse(decrypt(Buffer.from(seen!.init.body), ua));
    assert.deepEqual(said, { title: "Autora can reach you here", body: "Hello", url: "https://box.ts.net/", urgent: true });
    assert.ok(!Buffer.from(seen!.init.body).toString("latin1").includes("Hello"), "the words are not in the clear");
  });
  await test("a device the push service says is gone is forgotten", async () => {
    const wp = new WebPush(path.join(home, "gone.json"));
    const ua = browser();
    wp.add(cleanSubscription(ua.subscription)!);
    const gone = (async () => new Response(null, { status: 410 })) as unknown as typeof fetch;
    const out = await wp.send({ title: "x", body: "y" }, gone);
    assert.equal(out.ok, false);
    assert.equal(wp.count(), 0);
  });
  await test("a service that is down is a result, not a throw, and the device is kept", async () => {
    const wp = new WebPush(path.join(home, "down.json"));
    wp.add(cleanSubscription(browser().subscription)!);
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const out = await wp.send({ title: "x", body: "y" }, down);
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /could not reach the push service/);
    assert.equal(wp.count(), 1);
  });
  await test("with no device it says so and sends nothing", async () => {
    const wp = new WebPush(path.join(home, "none.json"));
    let called = false;
    const out = await wp.send({ title: "x", body: "y" }, (async () => { called = true; return new Response(null); }) as unknown as typeof fetch);
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });

  console.log("as a channel");
  await test("a device makes web the ready channel; none means nothing is ready", () => {
    assert.deepEqual(readyChannels({ count: () => 0 }), []);
    assert.deepEqual(readyChannels({ count: () => 2 }), ["web"]);
  });
  await test("deliver sends to the devices, with the title and body cut for a phone", async () => {
    let got: any = null;
    const web = { count: () => 1, send: async (m: any) => { got = m; return { ok: true, sent: 1, failed: 0 }; } };
    const out = await deliver({ title: "  Autora needs you ", body: "A code", url: "https://x/", urgent: true }, web);
    assert.deepEqual(out, [{ channel: "web", ok: true }]);
    assert.deepEqual(got, { title: "Autora needs you", body: "A code", url: "https://x/", urgent: true });
  });
  await test("a device that could not be reached is a line in the result, not a throw", async () => {
    const web = { count: () => 1, send: async () => ({ ok: false, sent: 0, failed: 1, error: "the push service answered 500" }) };
    const out = await deliver({ title: "x", body: "y" }, web);
    assert.deepEqual(out, [{ channel: "web", ok: false, error: "the push service answered 500" }]);
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
