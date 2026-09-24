/**
 * Credentials: authenticator codes match the RFC, placeholders fill, a
 * sign-in is only typed on its own site, and values are blanked on the way
 * back to the model.
 *
 *   npx tsx tests/credentials.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-cred-"));
process.env.AUTORA_STATE_DIR = dir;

const cred = await import("../server/credentials");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log("credentials");

test("authenticator codes match RFC 6238", () => {
  // The RFC's SHA-1 key, "12345678901234567890", in base32.
  const login = { totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", digits: 8, period: 30, algorithm: "SHA1" as const };
  assert.equal(cred.totpCode(login, 59_000), "94287082");
  assert.equal(cred.totpCode(login, 1111111109_000), "07081804");
  assert.equal(cred.totpCode(login, 20000000000_000), "65353130");
});

test("an otpauth address is read for its key and settings", () => {
  const got = cred.parseAuthenticator("otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60");
  assert.deepEqual(got, { totp: "JBSWY3DPEHPK3PXP", digits: 8, period: 60, algorithm: "SHA1" });
  assert.equal(cred.parseAuthenticator("jbsw y3dp ehpk 3pxp").totp, "JBSWY3DPEHPK3PXP");
  assert.throws(() => cred.parseAuthenticator("not a key!"));
});

test("placeholders are filled, and sign-ins only on their own site", () => {
  cred.setIdentity({ first_name: "Jonathan", last_name: "Quill", email: "jq@example.com" });
  cred.saveLogin({ site: "https://www.GitHub.com/login", username: "jquill", password: "hunter2-long", authenticator: "JBSWY3DPEHPK3PXP" });
  assert.equal(cred.fillPlaceholders("{{cred:first_name}}", "https://anything.test/"), "Jonathan");
  assert.equal(cred.fillPlaceholders("{{cred:full_name}}", ""), "Jonathan Quill");
  assert.equal(cred.fillPlaceholders("{{ cred:github.com:password }}", "https://github.com/login"), "hunter2-long");
  assert.equal(cred.fillPlaceholders("{{cred:github.com:username}}", "https://gist.github.com/"), "jquill");
  assert.match(cred.fillPlaceholders("{{cred:github.com:code}}", "https://github.com/sessions/two-factor"), /^\d{6}$/);
  assert.throws(() => cred.fillPlaceholders("{{cred:github.com:password}}", "https://github.com.evil.test/"), /Refused/);
  assert.throws(() => cred.fillPlaceholders("{{cred:github.com:password}}", "https://notgithub.com/"), /Refused/);
  assert.throws(() => cred.fillPlaceholders("{{cred:phone}}", "https://x.test/"), /No phone/);
  assert.equal(cred.fillPlaceholders("plain text", "https://x.test/"), "plain text");
});

test("values are blanked on the way back", () => {
  const page = "Signed in as jquill (jq@example.com). Hello Jonathan Quill. Password: hunter2-long";
  assert.equal(
    cred.redactCredentials(page),
    "Signed in as {{cred:github.com:username}} ({{cred:email}}). Hello {{cred:full_name}}. Password: {{cred:github.com:password}}",
  );
  assert.equal(
    cred.redactCredentials(page, { identity: false }),
    "Signed in as {{cred:github.com:username}} (jq@example.com). Hello Jonathan Quill. Password: {{cred:github.com:password}}",
  );
});

test("the file is encrypted and survives a reload", () => {
  const raw = fs.readFileSync(path.join(dir, "credentials.enc"));
  assert.ok(!raw.includes(Buffer.from("hunter2-long")));
  assert.ok(!raw.includes(Buffer.from("Jonathan")));
  const shown = cred.describeCredentials();
  assert.equal(shown.logins[0].site, "github.com");
  assert.ok(shown.logins[0].has_authenticator);
  assert.ok(!JSON.stringify(shown).includes("hunter2-long"));
});

test("the briefing names placeholders, never values", () => {
  const text = cred.credentialsBriefing();
  assert.match(text, /\{\{cred:github\.com:password\}\}/);
  assert.match(text, /\$CRED_FIRST_NAME/);
  assert.ok(!text.includes("hunter2-long") && !text.includes("Jonathan"));
});

test("a sign-in works across the sites of one account, and no further", () => {
  cred.saveLogin({ site: "google.ca", username: "jq@gmail.com", password: "g00gle-long" });
  for (const url of [
    "https://accounts.google.ca/", "https://accounts.google.com/v3/signin", "https://mail.google.com/",
    "https://www.gmail.com/", "https://www.youtube.com/", "https://accounts.google.co.uk/",
  ]) {
    assert.equal(cred.fillPlaceholders("{{cred:google.ca:password}}", url), "g00gle-long", url);
  }
  // Named by another site of the same account, it finds the one saved.
  assert.equal(cred.fillPlaceholders("{{cred:gmail.com:username}}", "https://accounts.google.com/"), "jq@gmail.com");
  for (const url of ["https://google.xyz/", "https://google.com.evil.test/", "https://gmail.co/", "https://github.com/"]) {
    assert.throws(() => cred.fillPlaceholders("{{cred:google.ca:password}}", url), /Refused/, url);
  }
  // A site in no family stays on its own.
  assert.throws(() => cred.fillPlaceholders("{{cred:github.com:password}}", "https://github.co.uk/"), /Refused/);
  assert.match(cred.credentialsBriefing(), /google\.ca \(the person's Google account\).*gmail\.com/);
  cred.deleteLogin("google.ca");
});

test("sign-ins stay out of the terminal", () => {
  const env = cred.identityEnv();
  assert.equal(env.CRED_FIRST_NAME, "Jonathan");
  assert.ok(!Object.values(env).includes("hunter2-long"));
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed`);
