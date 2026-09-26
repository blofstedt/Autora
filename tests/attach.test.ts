/**
 * Files attached to a message.
 *
 * Two things can go wrong quietly here, and both are worse than a visible
 * error. A file that the model is never told about looks attached in the
 * thread and is invisible to the agent, which then answers as if the person
 * had said nothing. A photograph that is uploaded again on every turn of the
 * session costs money on every turn and is nobody's idea of what was asked.
 * So: the note names what came, the pictures travel once, and a reference
 * that has gone missing loses its file and not the message.
 *
 *   npx tsx tests/attach.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../src/lib/derive";
import { Kind, type AutoraEvent } from "../src/lib/types";
import { isPicture, sizeLabel } from "../src/lib/attachments";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-attach-"));
process.env.AUTORA_STATE_DIR = dir;

const { attachmentNote, attachmentRefs, picturesFor, MAX_PICTURE_BYTES } = await import("../server/attach");
const { saveArtifact } = await import("../server/artifacts");

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

const photo = saveArtifact({
  origin: "user",
  name: "tram.jpg",
  data: Buffer.from([0xff, 0xd8, 0xff, 0x1f]),
  mime: "image/jpeg",
});
const notes = saveArtifact({
  origin: "user",
  name: "notes.md",
  data: Buffer.from("# Tuesday\n\nCall the plumber.\n"),
  mime: "text/markdown",
});
const drawing = saveArtifact({
  origin: "user",
  name: "plan.svg",
  data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
  mime: "image/svg+xml",
});
const huge = saveArtifact({
  origin: "user",
  name: "panorama.jpg",
  data: Buffer.alloc(MAX_PICTURE_BYTES + 1, 1),
  mime: "image/jpeg",
});

test("a reference is resolved against the artifact it names", () => {
  const files = attachmentRefs([photo.id, notes.id]);
  assert.deepEqual(
    files.map((f) => [f.id, f.name, f.mime]),
    [
      [photo.id, "tram.jpg", "image/jpeg"],
      [notes.id, "notes.md", "text/markdown"],
    ],
  );
  assert.equal(files[0].size, 4);
});

test("an id that is not an artifact is dropped, and the rest kept in order", () => {
  const files = attachmentRefs([notes.id, "file_ffffffffffffffff", "", null, photo.id]);
  assert.deepEqual(files.map((f) => f.id), [notes.id, photo.id]);
  assert.deepEqual(attachmentRefs("not a list"), []);
  assert.deepEqual(attachmentRefs([photo.id, photo.id]).map((f) => f.id), [photo.id]);
});

test("a message with no files has nothing added to it", () => {
  assert.equal(attachmentNote([]), "");
  assert.equal(attachmentNote(undefined), "");
});

test("the note names the file, how big it is and how to read it", () => {
  const note = attachmentNote(attachmentRefs([notes.id]));
  assert.match(note, /^\[Autora: a file is attached to this message/);
  assert.match(note, /notes\.md \(text\/markdown, 29 B, read it with artifact_read file_/);
});

test("a picture is said to be shown, and a document to be read", () => {
  const note = attachmentNote(attachmentRefs([photo.id, notes.id]));
  assert.match(note, /2 files are attached/);
  assert.match(note, /tram\.jpg \(image\/jpeg, 4 B, shown to you as a picture\)/);
  assert.match(note, /notes\.md \(text\/markdown, .*, read it with artifact_read/);
});

test("a picture too large to send is named, and named as something to read", () => {
  const note = attachmentNote(attachmentRefs([huge.id]));
  assert.match(note, /panorama\.jpg \(image\/jpeg, 4\.0 MB, read it with artifact_read/);
  assert.equal(picturesFor(attachmentRefs([huge.id])).length, 0);
});

test("only pictures travel as pictures, and they travel as base64", () => {
  const sent = picturesFor(attachmentRefs([photo.id, notes.id, drawing.id]));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mime, "image/jpeg");
  assert.equal(sent[0].data, Buffer.from([0xff, 0xd8, 0xff, 0x1f]).toString("base64"));
});

test("the thread shows what came with the message, and nothing for a plain one", () => {
  const events: AutoraEvent[] = [
    { seq: 1, ts: 1, kind: Kind.SessionStarted, actor: "system", span: null, payload: {}, blob: null },
    {
      seq: 2, ts: 2, kind: Kind.UserMessage, actor: "user", span: null,
      payload: { text: "What is wrong here?", attachments: [{ ...photo, size: 4 }] },
      blob: null,
    },
    {
      seq: 3, ts: 3, kind: Kind.UserMessage, actor: "user", span: null,
      payload: { text: "And this?", attachments: [{ id: "gone", name: "vanished.png" }, "nonsense"] },
      blob: null,
    },
  ];
  const folded = derive(events);
  const buckets = folded.buckets.filter((b) => b.prompt);
  assert.equal(buckets[0].attachments.length, 1);
  assert.equal(buckets[0].attachments[0].name, "tram.jpg");
  assert.equal(folded.transcript[0].attachments?.[0].id, photo.id);
  // A name and an id are enough to draw the row, so a file that has since
  // been pruned still shows; only a malformed entry is dropped.
  assert.deepEqual(buckets[1].attachments.map((a) => a.name), ["vanished.png"]);

  const old: AutoraEvent[] = [
    { seq: 1, ts: 1, kind: Kind.SessionStarted, actor: "system", span: null, payload: {}, blob: null },
    { seq: 2, ts: 2, kind: Kind.UserMessage, actor: "user", span: null, payload: { text: "No files here." }, blob: null },
  ];
  // A log an older build wrote has no attachments at all.
  const plain = derive(old);
  assert.deepEqual(plain.buckets.at(-1)!.attachments, []);
  assert.deepEqual(plain.transcript[0].attachments, []);
});

test("the client agrees with the server about what a picture is", () => {
  assert.equal(isPicture("image/jpeg"), true);
  assert.equal(isPicture("image/svg+xml"), false, "an svg is a document, not a photograph");
  assert.equal(isPicture("text/markdown"), false);
  assert.equal(sizeLabel(4), "4 B");
  assert.equal(sizeLabel(2048), "2.0 KB");
  assert.equal(sizeLabel(3 * 1024 * 1024), "3.0 MB");
});

console.log(`\n${passed} passed`);
