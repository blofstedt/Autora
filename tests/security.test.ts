/**
 * The protections around the app: requests from other websites refused,
 * secrets blanked wherever they turn up, the GitHub token sent only to
 * GitHub, the https listener's certificates, and settings that survive a
 * crash or a corrupt file.
 *
 *   npx tsx tests/security.test.ts
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sec-"));
process.env.AUTORA_STATE_DIR = dir;
// A settings file edited into nonsense, there before the app starts.
fs.writeFileSync(path.join(dir, "settings.json"), "{ this is not json");
// Provider keys that come only from the environment.
process.env.DEEPSEEK_API_KEY = "sk-deepseek-env-0123456789";
process.env.OPENROUTER_API_KEY = "sk-or-v1-abcdefabcdef";
process.env.DEEPGRAM_API_KEY = "dg-secret-key-99887766";

const stateMod = await import("../server/state");
const { allowSocket, fromAnotherSite, refuseRequest } = await import("../server/crosssite");
const { certificateSource, issueCertificate, pem, publicKeyId, tlsSettings } = await import("../server/tls");
const { isGitHubApi } = await import("../server/tools");
const { addressFor } = await import("../server/browser");
const logs = await import("../server/logs");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log("security");

await test("a request another website started cannot change anything", () => {
  assert.equal(refuseRequest("POST", { "sec-fetch-site": "same-origin" }), null);
  assert.equal(refuseRequest("POST", { "sec-fetch-site": "none" }), null);
  // The relay, curl and old browsers send no header at all.
  assert.equal(refuseRequest("POST", {}), null);
  assert.match(refuseRequest("POST", { "sec-fetch-site": "cross-site" }) ?? "", /another website/);
  // Another app on the same host is another site too.
  assert.ok(refuseRequest("DELETE", { "sec-fetch-site": "same-site" }));
  assert.ok(refuseRequest("PATCH", { "sec-fetch-site": "Cross-Site" }));
  // Reading is left alone: links from elsewhere, and the widget frame's script.
  assert.equal(refuseRequest("GET", { "sec-fetch-site": "cross-site" }), null);
  assert.equal(refuseRequest("HEAD", { "sec-fetch-site": "cross-site" }), null);
});

await test("a websocket from another website is refused, the relay is not", () => {
  assert.equal(allowSocket({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(allowSocket({}), true);
  assert.equal(allowSocket({ "sec-fetch-site": "cross-site" }), false);
  assert.equal(fromAnotherSite({ "sec-fetch-site": "same-site" }), true);
});

await test("an unreadable settings file is kept aside, not overwritten", () => {
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.unreadable-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), "{ this is not json");
  // And the app came up on defaults.
  assert.equal(stateMod.state.provider, "auto");
});

await test("a waiting save is written by flushState, not lost with the process", () => {
  stateMod.setKey("openai", "sk-saved-in-app-1234567890");
  // save() is debounced; nothing is on disk until the timer or a flush.
  stateMod.flushState();
  const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(written.keys.openai, "sk-saved-in-app-1234567890");
});

await test("provider keys from the environment are blanked, not only three of them", () => {
  const out = stateMod.redactSecrets(
    "DEEPSEEK_API_KEY=sk-deepseek-env-0123456789\nOPENROUTER_API_KEY=sk-or-v1-abcdefabcdef\n" +
    "DEEPGRAM_API_KEY=dg-secret-key-99887766\nOPENAI=sk-saved-in-app-1234567890",
  );
  assert.ok(!out.includes("sk-deepseek-env-0123456789"), out);
  assert.ok(!out.includes("sk-or-v1-abcdefabcdef"), out);
  assert.ok(!out.includes("dg-secret-key-99887766"), out);
  assert.ok(!out.includes("sk-saved-in-app-1234567890"), out);
  assert.match(out, /\[REDACTED_DEEPSEEK_API_KEY\]/);
  assert.match(out, /\[REDACTED_OPENAI_KEY\]/);
});

await test("a secret containing another is blanked whole, and changes apply at once", () => {
  stateMod.setSecret("SHORT_TOKEN", "abcd1234");
  stateMod.setSecret("LONG_TOKEN", "abcd1234-and-more");
  assert.equal(stateMod.redactSecrets("x abcd1234-and-more y"), "x [REDACTED_LONG_TOKEN] y");
  assert.equal(stateMod.redactSecrets("x abcd1234 y"), "x [REDACTED_SHORT_TOKEN] y");
  // Special characters in a secret are matched literally.
  stateMod.setSecret("ODD_TOKEN", "a.b*c(d)+e?");
  assert.equal(stateMod.redactSecrets("[a.b*c(d)+e?]"), "[[REDACTED_ODD_TOKEN]]");
  assert.equal(stateMod.redactSecrets("aXb*c(d)+e?"), "aXb*c(d)+e?");
  stateMod.deleteSecret("ODD_TOKEN");
  assert.equal(stateMod.redactSecrets("a.b*c(d)+e?"), "a.b*c(d)+e?");
});

await test("the Logs page blanks secrets too, and a redactor that logs cannot recurse", () => {
  logs.setLogRedactor((text) => {
    console.warn("[test] redacting");
    return stateMod.redactSecrets(text);
  });
  logs.log("info", "test", "token is sk-deepseek-env-0123456789");
  const lines = logs.readLogs({ component: "test" }).lines;
  const last = lines[lines.length - 1];
  assert.equal(last.message, "token is [REDACTED_DEEPSEEK_API_KEY]");
  logs.setLogRedactor(null);
});

await test("the GitHub token goes only to GitHub's API", () => {
  assert.equal(isGitHubApi("https://api.github.com/repos/a/b"), true);
  assert.equal(isGitHubApi("https://API.GitHub.com/user"), true);
  assert.equal(isGitHubApi("https://evil.example/?u=api.github.com"), false);
  assert.equal(isGitHubApi("https://api.github.com.evil.example/"), false);
  assert.equal(isGitHubApi("https://evil.example/api.github.com/"), false);
  assert.equal(isGitHubApi("http://api.github.com/"), false);
  assert.equal(isGitHubApi("not a url"), false);
});

await test("addresses without a scheme open, over http when they are local", () => {
  assert.equal(addressFor("localhost:3000"), "http://localhost:3000");
  assert.equal(addressFor("umbrel.local:8817/app"), "http://umbrel.local:8817/app");
  assert.equal(addressFor("192.168.1.5:8080"), "http://192.168.1.5:8080");
  assert.equal(addressFor("10.0.0.2"), "http://10.0.0.2");
  assert.equal(addressFor("[::1]:5173"), "http://[::1]:5173");
  assert.equal(addressFor("intranet/wiki"), "http://intranet/wiki");
  assert.equal(addressFor("example.com"), "https://example.com");
  assert.equal(addressFor("github.com:443/x"), "https://github.com:443/x");
  assert.equal(addressFor("https://example.com"), "https://example.com");
  assert.equal(addressFor("http://localhost"), "http://localhost");
  assert.equal(addressFor("about:blank"), "about:blank");
  assert.equal(addressFor("file:///tmp/x.html"), "file:///tmp/x.html");
});

await test("https is off unless asked, on the next port up by default", () => {
  assert.equal(tlsSettings(8817, {}).enabled, false);
  const on = tlsSettings(8817, { AUTORA_TLS: "1" });
  assert.equal(on.enabled, true);
  assert.equal(on.port, 8818);
  assert.equal(tlsSettings(3000, { AUTORA_TLS: "true", AUTORA_TLS_PORT: "4443" }).port, 4443);
  assert.equal(tlsSettings(3000, { AUTORA_TLS: "0" }).enabled, false);
  assert.deepEqual(tlsSettings(3000, { AUTORA_TLS_NAMES: "box.lan, 192.168.1.9" }).names, ["box.lan", "192.168.1.9"]);
});

await test("a certificate Autora issues is one Node's own X.509 parser accepts", () => {
  const ca = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caCert = new crypto.X509Certificate(pem(issueCertificate({
    commonName: "Test authority", subjectKey: ca.publicKey, issuerKey: ca.privateKey, ca: true, days: 30,
  })));
  assert.equal(caCert.ca, true);
  assert.ok(caCert.verify(ca.publicKey));

  const leafKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = new crypto.X509Certificate(pem(issueCertificate({
    commonName: "box.local", names: ["box.local", "127.0.0.1", "::1", "not a name!"],
    subjectKey: leafKey.publicKey, issuerKey: ca.privateKey,
    issuer: { commonName: "Test authority", keyId: publicKeyId(ca.publicKey) }, days: 397,
  })));
  assert.equal(leaf.ca, false);
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(leaf.checkIssued(caCert));
  assert.equal(leaf.checkHost("box.local"), "box.local");
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkIP("::1"), "::1");
  assert.equal(leaf.checkHost("other.local"), undefined);
  // Under Apple's 825-day ceiling.
  const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86_400_000;
  assert.ok(days < 825, `valid for ${days} days`);
});

await test("the https listener hands each name its own trusted certificate", async () => {
  const tlsDir = path.join(dir, "tls");
  const source = certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), tlsDir);
  assert.ok(source.caPem);
  // The authority is kept: a second start reuses it rather than making a new one.
  assert.equal(certificateSource(tlsSettings(3000, { AUTORA_TLS: "1" }), tlsDir).caPem, source.caPem);
  assert.equal((fs.statSync(path.join(tlsDir, "ca.key")).mode & 0o077), 0);

  const server = https.createServer(source.options, (_req, res) => res.end("secure"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const get = (servername: string | undefined) => new Promise<{ body: string; cert: crypto.X509Certificate }>((resolve, reject) => {
    const req = https.request({
      // A fresh connection each time, so the second handshake is its own.
      host: "127.0.0.1", port, path: "/", ca: source.caPem!, agent: false,
      ...(servername ? { servername, headers: { host: servername } } : {}),
    }, (res) => {
      const peer = (res.socket as import("node:tls").TLSSocket).getPeerX509Certificate();
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ body, cert: peer! }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    // By name: a leaf for exactly that name, verified against the authority.
    const named = await get("my-box.local");
    assert.equal(named.body, "secure");
    assert.equal(named.cert.checkHost("my-box.local"), "my-box.local");
    // By bare address: no name is sent, and the fallback names the address.
    const bare = await get(undefined);
    assert.equal(bare.body, "secure");
    assert.equal(bare.cert.checkIP("127.0.0.1"), "127.0.0.1");
  } finally {
    server.close();
  }
});

await test("a real certificate from files is used as given, with no authority offered", () => {
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const certFile = path.join(dir, "real.crt");
  const keyFile = path.join(dir, "real.key");
  fs.writeFileSync(certFile, pem(issueCertificate({
    commonName: "real.example", subjectKey: key.publicKey, issuerKey: key.privateKey, days: 30,
  })));
  fs.writeFileSync(keyFile, key.privateKey.export({ type: "pkcs8", format: "pem" }));
  const source = certificateSource(
    tlsSettings(3000, { AUTORA_TLS: "1", AUTORA_TLS_CERT: certFile, AUTORA_TLS_KEY: keyFile }),
    path.join(dir, "unused"),
  );
  assert.equal(source.caPem, null);
  assert.ok(source.options.cert);
  assert.throws(() => certificateSource(tlsSettings(3000, { AUTORA_TLS: "1", AUTORA_TLS_CERT: certFile }), dir));
});

console.log(`${passed} passed`);
