/**
 * The python tool: a kernel that keeps its variables between runs.
 *
 *   npx tsx tests/pykernel.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kernelRunning, pythonPath, runPython, stopAllKernels } from "../server/pykernel";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

if (!pythonPath()) {
  console.log("  skip  no python on this host");
  process.exit(0);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "autora-pykernel-"));
const run = (code: string, extra: Record<string, any> = {}, session = "s1") =>
  runPython({ session, cwd, args: { code, ...extra } });

try {
  await test("a value comes back like a notebook cell, and a print comes back too", async () => {
    const r = await run("x = 41\nprint('hello')\nx + 1");
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /hello/);
    assert.match(r.summary, /=> 42/);
    assert.match(r.summary, /new kernel started/);
  });

  await test("variables and imports survive from one run to the next", async () => {
    await run("import json\ndata = {'a': [1, 2, 3]}");
    const r = await run("json.dumps(data)");
    assert.match(r.summary, /\{"a": \[1, 2, 3\]\}/);
    assert.doesNotMatch(r.summary, /new kernel/);
  });

  await test("an error is a traceback, the run is not ok, and the kernel carries on", async () => {
    const r = await run("1 / 0");
    assert.equal(r.ok, false);
    assert.match(r.summary, /ZeroDivisionError/);
    assert.match((await run("data['a'][0]")).summary, /=> 1/);
  });

  await test("vars lists what is defined, with shapes", async () => {
    const r = await runPython({ session: "s1", cwd, args: { action: "vars" } });
    assert.equal(r.ok, true);
    assert.match(r.summary, /data: dict \(1\)/);
    assert.match(r.summary, /x: int = 41/);
  });

  await test("stderr and files in the working folder work; a program's own output cannot confuse the answer", async () => {
    const r = await run("import sys, os, subprocess\nsys.stderr.write('warn\\n')\nsubprocess.run(['echo', 'from a child'])\nopen('out.txt','w').write('ok')\nos.path.exists('out.txt')");
    assert.match(r.summary, /stderr:\nwarn/);
    assert.match(r.summary, /=> True/);
    assert.ok(fs.existsSync(path.join(cwd, "out.txt")));
  });

  await test("a run past its time limit kills the kernel and says the namespace is gone", async () => {
    const r = await run("import time\ntime.sleep(30)", { timeout: 5 });
    assert.equal(r.ok, false);
    assert.match(r.summary, /kernel was reset/);
    assert.equal(kernelRunning("s1"), false);
    const again = await run("'x' in globals()");
    assert.match(again.summary, /=> False/);
  });

  await test("a cancelled run stops the kernel", async () => {
    let stop: () => void = () => undefined;
    const pending = runPython({ session: "s2", cwd, args: { code: "import time\ntime.sleep(30)" }, onCancel: (s) => { stop = s; } });
    await new Promise((r) => setTimeout(r, 800));
    stop();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.match(r.summary, /Stopped/);
    assert.equal(kernelRunning("s2"), false);
  });

  await test("chats do not share a namespace, and reset starts over", async () => {
    await run("secret = 1", {}, "a");
    assert.match((await run("'secret' in globals()", {}, "b")).summary, /=> False/);
    await runPython({ session: "a", cwd, args: { action: "reset" } });
    assert.match((await run("'secret' in globals()", {}, "a")).summary, /=> False/);
  });

  await test("nothing, or the wrong action, is a plain message", async () => {
    assert.match((await run("  ")).summary, /No code/);
    assert.match((await runPython({ session: "s1", cwd, args: { action: "nope" } })).summary, /action is/);
  });

  const hasMpl = (await run("import matplotlib\nTrue")).ok;
  if (hasMpl) {
    await test("an open matplotlib figure comes back as a picture", async () => {
      const r = await run("import matplotlib.pyplot as plt\nplt.plot([1,2,3])");
      assert.equal(r.figures.length, 1);
      assert.equal(r.figures[0].png.subarray(1, 4).toString(), "PNG");
    });
  } else console.log("  --  figures: matplotlib is not installed here");
} finally {
  stopAllKernels();
}
console.log(`\n${passed} python cases passed.`);
