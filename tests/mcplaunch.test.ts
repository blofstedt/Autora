/**
 * Starting an MCP server whose launcher would pick the wrong build for this
 * machine, and the keys a server can do without.
 *
 *   npx tsx tests/mcplaunch.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mcplaunch-"));
process.env.AUTORA_MCP_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mcpbin-"));

const { untarEntry, prepareStdioEnv, isMusl } = await import("../server/mcplaunch");
const { connect, disconnect, statusOf } = await import("../server/mcp");
const { CATALOG } = await import("../server/mcpcatalog");
const { secretRefs } = await import("../server/mcpcatalog");

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

/** A tar (ustar) holding what it is given, gzipped, as a release is. */
function tarGz(entries: { name: string; body: Buffer; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const { name, body, type } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000755\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type ?? "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(header);
    if (body.length) {                              // a directory has no data block
      const padded = Buffer.alloc(512 * Math.ceil(body.length / 512));
      body.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

console.log("mcp launchers");

await test("the build for this machine comes out of the release archive", () => {
  const wanted = Buffer.from("#!/bin/sh\necho webclaw\n");
  const gz = tarGz([
    { name: "webclaw-v0.6.23-x86_64-unknown-linux-musl/", body: Buffer.alloc(0), type: "5" },
    { name: "webclaw-v0.6.23-x86_64-unknown-linux-musl/README.md", body: Buffer.from("docs\n") },
    { name: "webclaw-v0.6.23-x86_64-unknown-linux-musl/webclaw-mcp", body: wanted },
  ]);
  const found = untarEntry(zlib.gunzipSync(gz), "webclaw-mcp");
  assert.ok(found, "the binary is in the archive");
  assert.deepEqual(found, wanted, "and comes out whole");
  assert.equal(untarEntry(zlib.gunzipSync(gz), "webclaw"), null, "nothing else is taken");
});

await test("only a launcher that cannot look after itself is prepared", async () => {
  const plain = { id: "a", name: "echo", transport: "stdio" as const, command: process.execPath, args: ["-e", "0"], enabled: true };
  assert.deepEqual(await prepareStdioEnv(plain), {}, "an ordinary server is left alone");
  assert.deepEqual(
    await prepareStdioEnv({ ...plain, command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
    {}, "so is one that runs through npx but ships JavaScript");
});

await test("a binary already named is not fetched again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-fakebin-"));
  const file = path.join(dir, "webclaw-mcp");
  fs.writeFileSync(file, Buffer.alloc(2_000_000), { mode: 0o755 });
  const cfg = {
    id: "w", name: "webclaw", transport: "stdio" as const,
    command: "npx", args: ["-y", "@webclaw/mcp"], env: { WEBCLAW_MCP_BIN: file }, enabled: true,
  };
  assert.deepEqual(await prepareStdioEnv(cfg), {}, "the person's own build wins");
});

await test("a key a server can do without does not stop the connection", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
  const base = { name: "Echo", transport: "stdio" as const, command: process.execPath, args: [fixture], enabled: true };

  await connect({ ...base, id: "opt", env: { OPTIONAL_KEY: "${secret:NOT_SAVED?}" } });
  assert.equal(statusOf("opt").status, "connected", "an unsaved optional key goes in empty");
  await disconnect("opt");

  await connect({ ...base, id: "req", env: { NEEDED_KEY: "${secret:NEEDED_KEY}" } });
  const status = statusOf("req");
  assert.equal(status.status, "error");
  assert.match(String(status.error), /Missing secret NEEDED_KEY/, "a needed one still says which");
  await disconnect("req");
});

await test("the webclaw catalog entry offers its key without demanding it", () => {
  const entry = CATALOG.find((e) => e.id === "webclaw");
  assert.ok(entry, "webclaw is in the catalog");
  assert.deepEqual(entry!.args, ["-y", "@webclaw/mcp"]);
  assert.equal(entry!.needs?.[0].env, "SERPER_API_KEY");
  assert.equal(entry!.needs?.[0].optional, true, "the card installs without the search key");
  assert.match(entry!.env!.SERPER_API_KEY, /\?}/, "and a missing secret is not fatal at connect time");
  assert.deepEqual(secretRefs(Object.values(entry!.env!)), [], "so it is never reported as missing");
  assert.equal(typeof isMusl(), "boolean", "and the machine's libc is worked out without throwing");
});

console.log(`\n${passed} passed`);
