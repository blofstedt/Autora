/**
 * The bytes behind a picture: kept in memory, per session, oldest out first.
 *
 *   npx tsx tests/blobs.test.ts
 */
import assert from "node:assert/strict";
import { dropSession, fromDataUrl, getBlob, putBlob } from "../server/blobs";

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

const MB = 1024 * 1024;

test("a picture comes back as it went in, under an id that is never reused", () => {
  const data = Buffer.from("png-bytes");
  const a = putBlob("s1", data, "image/png");
  const b = putBlob("s1", data, "image/png");
  assert.notEqual(a, b);
  assert.deepEqual(getBlob(a)?.data, data);
  assert.equal(getBlob(a)?.mime, "image/png");
  assert.equal(getBlob("nope"), null);
});

test("a type the browser should not run is served as plain bytes", () => {
  for (const mime of ["text/html", "application/javascript", "image/svg+xml; charset=x", ""]) {
    assert.equal(getBlob(putBlob("s2", Buffer.from("x"), mime))?.mime, mime === "" ? "application/octet-stream" : "application/octet-stream", mime);
  }
  assert.equal(getBlob(putBlob("s2", Buffer.from("x"), "image/svg+xml"))?.mime, "image/svg+xml");
});

test("a session over its ceiling loses its oldest pictures, and only its own", () => {
  const other = putBlob("keep", Buffer.alloc(MB), "image/png");
  const first = putBlob("big", Buffer.alloc(30 * MB), "image/jpeg");
  const second = putBlob("big", Buffer.alloc(30 * MB), "image/jpeg");
  assert.ok(getBlob(first) && getBlob(second), "60 MB is under the 64 MB ceiling");
  const third = putBlob("big", Buffer.alloc(30 * MB), "image/jpeg");
  assert.equal(getBlob(first), null, "the oldest went");
  assert.ok(getBlob(second) && getBlob(third));
  assert.ok(getBlob(other), "another session is untouched");
});

test("the newest picture is kept even when it alone is over the ceiling", () => {
  const huge = putBlob("huge", Buffer.alloc(70 * MB), "image/png");
  assert.ok(getBlob(huge));
});

test("dropping a session releases everything it showed", () => {
  const ids = [putBlob("gone", Buffer.from("a"), "image/png"), putBlob("gone", Buffer.from("b"), "image/png")];
  dropSession("gone");
  for (const id of ids) assert.equal(getBlob(id), null);
  dropSession("never-existed");
});

test("a data: URL is decoded, and anything else is not one", () => {
  const url = `data:image/PNG;base64,${Buffer.from("hello").toString("base64")}`;
  const parsed = fromDataUrl(`  ${url}\n`);
  assert.equal(parsed?.mime, "image/png");
  assert.equal(parsed?.data.toString(), "hello");
  for (const bad of ["https://x/y.png", "data:image/png,plain", "data:;base64,AAAA", "", "hello"]) assert.equal(fromDataUrl(bad), null, bad);
});
console.log(`\n${passed} blob cases passed.`);
