/**
 * The toolbox's way in: a new blank file opened in its window, asked for by
 * the page rather than by the agent.
 *
 * The file itself (a real PDF, one blank A4 page), what it is called when
 * there is already an Untitled, and the route with its refusals -- no such
 * chat, a kind that is not a file, an incognito chat, an app switched off.
 *
 *   npx tsx tests/newfile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-newfile-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const { PDFDocument } = await import("@cantoo/pdf-lib");
const { A4, APP_OF, blankPdf, freeName, isNewKind, newFileRoutes } = await import("../server/newfile");
const { listArtifacts, readArtifact } = await import("../server/artifacts");
const { deskState } = await import("../server/pdfdesk");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

// -------------------------------------------------------------- the file --

await test("a blank PDF is a real PDF: one empty A4 page", async () => {
  const bytes = await blankPdf();
  assert.ok(bytes.length > 400, `too small to be a PDF: ${bytes.length} bytes`);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 1);
  const [w, h] = A4;
  assert.equal(doc.getPage(0).getWidth(), w);
  assert.equal(doc.getPage(0).getHeight(), h);
});

await test("the blank page is kept, and handed out as a copy each time", async () => {
  const a = await blankPdf();
  const b = await blankPdf();
  assert.deepEqual([...a], [...b], "the same blank page");
  a[0] = 0;
  const c = await blankPdf();
  assert.ok(c[0] !== 0, "one caller scribbling on its copy must not spoil the next");
});

// -------------------------------------------------------------- the name --

await test("a new file is Untitled, and finds a free number beside the others", () => {
  assert.equal(freeName("pdf", []), "Untitled.pdf");
  assert.equal(freeName("pdf", ["Untitled.pdf"]), "Untitled 2.pdf");
  assert.equal(freeName("docx", ["Untitled.docx", "Untitled 2.docx", "Untitled 4.docx"]), "Untitled 3.docx");
  assert.equal(freeName("pdf", ["untitled.PDF"]), "Untitled 2.pdf", "names are compared the way a person reads them");
});

await test("only a file kind is a kind", () => {
  assert.ok(isNewKind("pdf") && isNewKind("docx") && isNewKind("xlsx") && isNewKind("pptx"));
  assert.ok(!isNewKind("html") && !isNewKind("") && !isNewKind(7) && !isNewKind(null));
  assert.equal(APP_OF.docx, "Autora Pages");
});

// ------------------------------------------------------------- the route --

/** The route on a real port, with only the chats and switches this test says. */
async function withServer(opts: { exists?: (id: string) => boolean; incognito?: (id: string) => boolean; off?: (k: string) => boolean }, run: (post: (body: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  newFileRoutes(app as never, {
    exists: opts.exists ?? ((id) => id === "s1"),
    incognito: opts.incognito ?? (() => false),
    off: (opts.off ?? (() => false)) as never,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  try {
    await run(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/s1/new`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

await test("an unknown chat is refused", async () => {
  await withServer({ exists: () => false }, async (post) => {
    const res = await post({ kind: "pdf" });
    assert.equal(res.status, 404);
  });
});

await test("a kind that is not a file is refused", async () => {
  await withServer({}, async (post) => {
    assert.equal((await post({ kind: "html" })).status, 400);
    assert.equal((await post({ kind: 42 })).status, 400);
    assert.equal((await post({})).status, 400);
  });
});

await test("an incognito chat has no window, so it is refused", async () => {
  await withServer({ incognito: () => true }, async (post) => {
    const res = await post({ kind: "pdf" });
    assert.equal(res.status, 403);
    assert.match(String(res.body.error), /incognito/);
  });
});

await test("an app switched off on the Tools page is refused, and says which", async () => {
  await withServer({ off: (k) => k === "xlsx" }, async (post) => {
    const res = await post({ kind: "xlsx" });
    assert.equal(res.status, 403);
    assert.match(String(res.body.error), /Autora Sheets/);
    assert.equal((await post({ kind: "pdf" })).status, 200, "the others still open");
  });
});

await test("a PDF is made, saved as an artifact, and put in the window", async () => {
  await withServer({}, async (post) => {
    const res = await post({ kind: "pdf" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(String(res.body.name), /^Untitled.*\.pdf$/);
    const art = listArtifacts().find((a) => a.id === res.body.id);
    assert.ok(art, "the file is in the artifacts, so it is kept and the chat can show it");
    assert.equal(art!.origin, "agent");
    const file = readArtifact(res.body.id);
    assert.ok(file && file.length > 400);
    const doc = await PDFDocument.load(file!);
    assert.equal(doc.getPageCount(), 1);
    // The window beside the chat is showing it, so typing has somewhere to go.
    assert.equal(deskState("s1")?.working, res.body.id);
    assert.equal(deskState("s1")?.name, res.body.name);
  });
});

await test("the next new file is numbered, not a second Untitled", async () => {
  await withServer({}, async (post) => {
    const first = await post({ kind: "pdf" });
    const second = await post({ kind: "pdf" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(second.body.name, first.body.name);
    assert.notEqual(second.body.id, first.body.id);
  });
});

console.log(`\n${passed} passed`);
