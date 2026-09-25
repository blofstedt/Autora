/**
 * The irrecoverable tier: what a call with no Jev key, no model and no
 * network still asks the person about, and -- just as importantly -- what it
 * lets through. A guard that cries wolf on ordinary work is worse than none,
 * so most of this file is cases that must NOT be held.
 *
 *   npx tsx tests/guard.test.ts
 */
import assert from "node:assert/strict";
import { guardWorthy, irreversible } from "../server/jev/guard";

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

const command = (text: string) => irreversible("terminal", { command: text });
const held = (text: string) => command(text) !== null;

console.log("the guard");

test("the commands nothing can undo are held", () => {
  for (const text of [
    "rm -rf /",
    "sudo rm -rf /*",
    "rm -fr ~",
    "rm --recursive --force --no-preserve-root /",
    "ls -la && rm -rf /",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "mkfs.ext4 /dev/sdb1",
    "wipefs -a /dev/nvme0n1",
    "docker compose down -v",
    "docker volume prune -f",
    "git push --force origin main",
    ":(){ :|:& };:",
  ]) {
    assert.ok(held(text), `should be held: ${text}`);
  }
});

test("ordinary work is not", () => {
  for (const text of [
    "rm -rf node_modules",
    "rm -f /tmp/scratch.txt",
    "rm -rf /tmp/build",
    "ls -la",
    "docker compose down",
    "docker volume ls",
    "git push origin main",
    "git push --force origin feature/cleanup",
    "git reset --hard HEAD~1",
    "npm test",
    "echo 'rm -rf /' >> notes.txt",
  ]) {
    assert.equal(command(text), null, `should not be held: ${text}`);
  }
});

test("only the terminal is judged this way", () => {
  assert.equal(irreversible("http_request", { url: "https://example.com", method: "DELETE" }), null);
  assert.equal(irreversible("browser_open", { url: "https://example.com" }), null);
  assert.equal(irreversible("terminal", {}), null);
});

test("what it says is what the card shows", () => {
  const danger = command("docker compose down -v");
  assert.ok(danger);
  assert.match(danger.what, /Docker volume/);
  assert.match(danger.match, /compose/);
});

test("the wider pre-filter is left alone", () => {
  // RISKY_COMMAND decides whether to spend a Jev call, never whether to ask
  // the person: it still matches things that are perfectly ordinary.
  assert.equal(guardWorthy("terminal", { command: "rm -rf node_modules" }), true);
  assert.equal(guardWorthy("terminal", { command: "ls" }), false);
  assert.equal(guardWorthy("http_request", { method: "POST" }), true);
});

console.log(`\nguard: ${passed} passed`);
