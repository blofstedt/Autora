/**
 * Spend already on the books, put right once.
 *
 * A turn's cached input used to be priced from the vendor's catalogue without
 * the catalogue's cache-read price being read at all, so every token the
 * provider served from its prompt cache was charged as a fresh one. On Orca
 * Router that is $0.834/M charged where $0.042/M was due -- read off its own
 * /v1/models on 2026-10-06 -- and it turned $21.94 of real Orca spend into
 * $91.17 on the ledger, and a $20 month into $101.45. The reader is fixed; this
 * checks the correction applied to what was already written down.
 *
 * What matters, and what is checked here: only the cached part of a matching
 * row is rewritten (the fresh and output parts came from the published price
 * and were right); nothing is ever raised; a row already at the published rate
 * is left alone; and the correction is stamped, so a ledger cannot be brought
 * down twice by a second read.
 *
 *   npx tsx tests/price-repair.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-price-repair-"));

const { applyRepairs, PRICE_REPAIRS } = await import("../server/state");
type State = Parameters<typeof applyRepairs>[0];

/* Fresh $0.834/M, cache read $0.042/M, output $2.501/M: Orca Router's own
   figures for tencent/hy4-preview. One million cached tokens costs $0.042 at
   the cache rate and $0.834 at the fresh rate -- a factor of 19.86. */
const row = (over: Partial<Parameters<typeof applyRepairs>[0]["usage"][number]> = {}) => ({
  ts: 1_700_000_000,
  session: "s",
  provider: "orcarouter",
  model: "tencent/hy4-preview",
  input: 1_000_000,
  output: 100_000,
  cost: 0.834 + 0.042 + 0.2501,
  priced: true,
  estimated: false,
  cached: 1_000_000,
  /* Priced as though every cached token were new. */
  parts: { fresh: 0, cached: 0.834, output: 0.2501 },
  ...over,
});

const ledger = (rows: ReturnType<typeof row>[], repairs: Record<string, number> = {}) =>
  ({ usage: rows, repairs }) as unknown as State;

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

test("cached input is put at the vendor's cache-read price, not the fresh one", () => {
  const before = row();
  const after = applyRepairs(ledger([before]));
  const got = after.usage[0];
  assert.ok(Math.abs(got.parts!.cached - 0.042) < 1e-12, `cached ${got.parts!.cached}`);
  /* The whole row's cost follows the corrected part. */
  assert.ok(Math.abs(got.cost - (0 + 0.042 + 0.2501)) < 1e-12, `cost ${got.cost}`);
  /* And nothing else moved. */
  assert.equal(got.parts!.fresh, 0);
  assert.equal(got.parts!.output, 0.2501);
  assert.equal(got.priced, true);
});

test("the fresh and output halves are left exactly as they were", () => {
  const fresh = 0.5;
  const output = 1.25;
  const after = applyRepairs(
    ledger([row({ input: 2_000_000, cached: 1_000_000, parts: { fresh, cached: 0.834, output } })]),
  );
  assert.equal(after.usage[0].parts!.fresh, fresh);
  assert.equal(after.usage[0].parts!.output, output);
});

test("a correction is stamped, and a stamped ledger is not touched again", () => {
  const first = applyRepairs(ledger([row()]));
  assert.ok(first.repairs[PRICE_REPAIRS[0].name] > 0, "stamped");
  const again = row();
  const second = applyRepairs(ledger([again], { ...first.repairs }));
  assert.equal(second.usage[0].parts!.cached, 0.834, "left at the price it was charged");
});

test("a row already at the cache rate is left alone", () => {
  const right = row({ cost: 0.042 + 0.2501, parts: { fresh: 0, cached: 0.042, output: 0.2501 } });
  const after = applyRepairs(ledger([right]));
  assert.equal(after.usage[0].parts!.cached, 0.042);
  assert.equal(after.usage[0].cost, 0.042 + 0.2501);
});

test("nothing is ever raised: a row cheaper than the cache rate stays put", () => {
  const odd = row({ parts: { fresh: 0, cached: 0.001, output: 0.2501 } });
  const after = applyRepairs(ledger([odd]));
  assert.equal(after.usage[0].parts!.cached, 0.001);
});

test("another vendor, another model, or no split on the row is not our business", () => {
  const other = [
    row({ provider: "deepseek" }),
    row({ model: "tencent/hy4-preview-free" }),
    row({ parts: undefined }),
    row({ cached: undefined }),
  ];
  const after = applyRepairs(ledger(other));
  assert.equal(after.usage[0].parts!.cached, 0.834);
  assert.equal(after.usage[1].parts!.cached, 0.834);
  assert.equal(after.usage[2].parts, undefined);
  assert.equal(after.usage[3].parts!.cached, 0.834);
});

test("the repair names the model it was found on, and the rate it was found at", () => {
  assert.equal(PRICE_REPAIRS.length, 1);
  assert.equal(PRICE_REPAIRS[0].provider, "orcarouter");
  assert.equal(PRICE_REPAIRS[0].model, "tencent/hy4-preview");
  /* Orca Router's published input_cache_read for that model, $0.042 per
     million. A rate that drifted from this would silently stop correcting. */
  assert.equal(PRICE_REPAIRS[0].cachedPerMillion, 0.042);
});

console.log(`\n${passed} passed`);
