/**
 * The Threads list excerpt: the one line a post or a comment gets in the list.
 *
 * It is easy to get wrong in a way nobody reports, because a wrong excerpt
 * looks like a post with nothing in it rather than like a bug -- which is how
 * a post whose visible part is empty (it opens straight into a ```detail
 * block) came to show a blank line where its label was meant to stand in.
 *
 *   npx tsx tests/excerpt.test.ts
 */
import assert from "node:assert/strict";
import { plain } from "../src/lib/excerpt";

let failures = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message.split("\n")[0]}`);
  }
};

const body = ["Short and plain.", "", "```detail", "What I checked", "- numbers 41% -> 78%", "- /data/work/a2/server/threadlife.ts:265", "```"].join("\n");

await test("the excerpt is the visible part, and the folded material stays folded", () => {
  assert.equal(plain(body), "Short and plain.");
});

await test("the material behind the toggle never reaches the list", () => {
  const out = plain(body);
  for (const hidden of ["41%", "78%", "threadlife", "What I checked", "```", "detail"]) {
    assert.ok(!out.includes(hidden), `"${hidden}" leaked into the excerpt`);
  }
});

await test("a post that opens straight into a detail shows its label, not a blank line", () => {
  const out = plain("```detail\nWhat I checked\n- 41%\n```");
  assert.equal(out, "What I checked");
});

await test("the label fallback works with the fence indented, and with ~~~", () => {
  assert.equal(plain("   ```detail\nFiles touched\n- a\n```"), "Files touched");
  assert.equal(plain("~~~detail\nFiles touched\n- a\n~~~"), "Files touched");
});

await test("marks come off the label and the visible part alike", () => {
  assert.equal(plain("**Bold opening** and `code`"), "Bold opening and code");
  assert.equal(plain("```detail\n## The numbers\n- a\n```"), "The numbers");
});

await test("an unclosed fence still leaves its label, not nothing", () => {
  assert.equal(plain("```detail\nStill writing\n- one"), "Still writing");
});

await test("a post with no detail at all is unchanged", () => {
  assert.equal(plain("Just a short post."), "Just a short post.");
});

await test("a long excerpt is clipped to 240 characters", () => {
  const out = plain("x".repeat(500));
  assert.equal(out.length, 240);
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
