/**
 * The real total: what has been paid in, less what the vendor says is left.
 *
 * The number this replaces is counted from token counts, and counting cannot
 * see a call that was charged without reporting what it used -- an answer
 * stopped mid-sentence, an attempt retried after a dropped connection. So the
 * counted figure is always the lower of the two and the gap is invisible,
 * which is the whole reason the balance is used instead.
 *
 * What is checked here is that arithmetic, and the rule it is built on: it
 * invents nothing. No balance read, nothing known to have been paid in, or a
 * balance sitting above what was paid in all mean "not known", and every
 * caller then falls back to counting.
 *
 *   npx tsx tests/vendor-money.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-vendor-money-"));

const { realSpend, vendorMoneyFor, vendorMoneyAll, readBalance, forgetVendorMoney } =
  await import("../server/vendor-money");
const { recordUsage, clearUsage, state } = await import("../server/state");
const { billingSummary } = await import("../server/billing");
const { providerSpec } = await import("../server/providers");

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

/** Null never equals a number: it fails rather than being read as zero. */
const near = (got: number | null | undefined, want: number) =>
  assert.ok(
    typeof got === "number" && Math.abs(got - want) < 1e-9,
    `${got} != ${want}`,
  );

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

/** What one vendor is holding, and what has been paid in, as state holds it.
    Every other vendor is cleared first: these tests each say what is known for
    one or two accounts, and a balance left behind by the previous case would
    quietly become a second line in somebody else's answer. */
function vendor(balance: number | null, toppedUp: number | null, id = "deepseek") {
  clearVendors();
  addVendor(balance, toppedUp, id);
}

/** Forget every vendor's figures, so one case cannot inherit another's money. */
function clearVendors() {
  for (const key of Object.keys(state.balances)) delete state.balances[key];
  for (const key of Object.keys(state.topUps)) delete state.topUps[key];
  for (const key of Object.keys(state.balanceAts)) delete state.balanceAts[key];
}

/** Set one vendor's figures without disturbing the others. A key goes in with
    them: an account nobody has a key for publishes nothing, and gets no line. */
function addVendor(balance: number | null, toppedUp: number | null, id: string) {
  state.keys[id] = `test-key-${id}`;
  if (balance === null) delete state.balances[id];
  else state.balances[id] = balance;
  if (toppedUp === null) delete state.topUps[id];
  else state.topUps[id] = toppedUp;
  state.balanceAts[id] = now;
}

function call(ts: number, cost: number) {
  recordUsage({
    ts, session: "t", provider: "deepseek", model: "deepseek-flash",
    input: 1000, output: 100, cost, priced: true, estimated: false,
  });
}

test("spend is what was paid in, less what is left", () => {
  near(realSpend(20.3, 30) ?? -1, 9.7);
  near(realSpend(0, 25) ?? -1, 25);
  /* Nothing paid in is nothing to spend from: a real figure of zero here
     would print "$0.00 spent" over an account that cannot have spent. */
  assert.equal(realSpend(20.3, 0), null);
});

test("an unreadable pair is not a guess", () => {
  assert.equal(realSpend(null, 30), null);
  assert.equal(realSpend(20.3, null), null);
  assert.equal(realSpend(Number.NaN, 30), null);
  /* A balance above what was paid in means one of the two is stale. */
  assert.equal(realSpend(35, 30), null);
});

test("vendorMoney says nothing until there is a balance to speak of", () => {
  vendor(null, null);
  assert.equal(vendorMoneyFor("deepseek"), null);

  /* A balance nobody has said a paid-in figure for is still that account's
     money, so it is reported as a balance -- what it is not is a spend, and
     there is deliberately no arithmetic invented to make it one. */
  vendor(20.3, null);
  const balanceOnly = vendorMoneyFor("deepseek");
  assert.ok(balanceOnly);
  near(balanceOnly.balance_usd, 20.3);
  assert.equal(balanceOnly.topped_up_usd, null);
  assert.equal(balanceOnly.lifetime_usd, null);

  vendor(20.3, 30);
  const money = vendorMoneyFor("deepseek");
  assert.ok(money);
  near(money.lifetime_usd ?? -1, 9.7);
  near(money.balance_usd, 20.3);
  near(money.topped_up_usd, 30);
  assert.equal(money.label, "DeepSeek");
});

/* The bug this whole file grew around: the balance was read from DeepSeek's
   endpoint and then reported as whichever provider's money was on screen. A
   balance belongs to one account, so each vendor keeps its own and nobody's is
   borrowed. */
test("one vendor's money is never another vendor's", () => {
  clearVendors();
  addVendor(20.3, 30, "deepseek");
  addVendor(4.5, 5, "orcarouter");

  const deep = vendorMoneyFor("deepseek");
  const orca = vendorMoneyFor("orcarouter");
  assert.ok(deep && orca);
  near(deep.lifetime_usd, 9.7);
  near(orca.lifetime_usd, 0.5);
  /* Orca Router's own figures, not DeepSeek's read through another name. */
  near(orca.balance_usd, 4.5);
  near(orca.topped_up_usd, 5);
  assert.equal(orca.provider, "orcarouter");

  /* A provider that publishes no balance at all gets no figure rather than a
     borrowed one -- OpenAI has no balance endpoint here. */
  assert.equal(vendorMoneyFor("openai"), null);
});

test("each vendor's reply is read in its own shape", () => {
  near(readBalance("deepseek", { balance_infos: [{ currency: "USD", total_balance: "9.24" }] }) ?? -1, 9.24);
  /* Promotional credit is scoped to a model and expires, so it is not money
     that was paid in and must not be counted as such. */
  near(readBalance("orcarouter", { unit: "USD", paid_balance: 19.99, promo_credits: [{ balance: 20 }] }) ?? -1, 19.99);
  near(readBalance("openrouter", { data: { total_credits: 10, total_usage: 3.5 } }) ?? -1, 10);
  assert.equal(readBalance("orcarouter", {}), null);
});

test("the all-time total is the vendor's, not the count", () => {
  clearUsage();
  vendor(20.3, 30);
  state.provider = "deepseek";
  call(now, 0.1);

  const b = billingSummary();
  assert.equal(b.vendors.length, 1);
  const real = b.vendors[0];
  assert.equal(real.headline, true);
  near(real.lifetime_usd ?? -1, 9.7);
  near(real.counted_usd, 0.1);
  near(real.unaccounted_usd, 9.6);
  near(b.lifetime.cost, 9.7);
  /* Every turn on the ledger is in this month, so the month is the same money
     and carries the part counting cannot see. */
  near(b.month.cost, 9.7);
});

test("a ledger reaching into another month keeps the month counted", () => {
  clearUsage();
  /* Well outside this month, so the month figure and the lifetime are no
     longer the same money and the difference must not be pushed into it. */
  const longAgo = now - 60 * DAY;
  vendor(20.3, 30);
  state.provider = "deepseek";
  call(longAgo, 0.1);

  const b = billingSummary();
  near(b.lifetime.cost, 9.7);
  near(b.month.cost, 0);
});

test("with no balance to read, the total goes back to counting", () => {
  clearUsage();
  vendor(null, null);
  state.provider = "deepseek";
  call(now, 0.25);

  const b = billingSummary();
  assert.deepEqual(b.vendors, []);
  near(b.lifetime.cost, 0.25);
  near(b.month.cost, 0.25);
});

/* A ledger holding two vendors' turns cannot have one vendor's balance stand in
   for the total: the balance is one account's money and the total is everybody's.
   It is still reported, named, for whoever wants to compare the two. */
test("a mixed ledger reports the vendor's figure beside the counted total", () => {
  clearUsage();
  vendor(20.3, 30, "deepseek");
  state.provider = "deepseek";
  call(now, 0.1);
  recordUsage({
    ts: now, session: "t", provider: "orcarouter", model: "orca-auto",
    input: 1000, output: 100, cost: 0.4, priced: true, estimated: false,
  });

  const b = billingSummary();
  assert.equal(b.vendors.length, 1);
  const real = b.vendors[0];
  assert.equal(real.headline, false);
  assert.equal(real.provider, "deepseek");
  near(real.lifetime_usd ?? -1, 9.7);
  /* Counted, because the total is not DeepSeek's alone. */
  near(b.lifetime.cost, 0.5);
  near(b.month.cost, 0.5);
});

/* Two vendors with money in them get two lines, each its own arithmetic, and
   neither may stand in for the all-time total: a balance is one account's money
   and the total is everybody's. This is what asking for "a line for each API"
   means -- not one figure chosen by whoever is selected. */
test("every vendor with money gets its own line, and none of them is the total", () => {
  clearUsage();
  clearVendors();
  addVendor(20.3, 30, "deepseek");
  addVendor(4.5, 5, "orcarouter");
  state.provider = "orcarouter";
  recordUsage({
    ts: now, session: "t", provider: "orcarouter", model: "orca-auto",
    input: 1000, output: 100, cost: 0.4, priced: true, estimated: false,
  });
  recordUsage({
    ts: now, session: "t", provider: "deepseek", model: "deepseek-flash",
    input: 1000, output: 100, cost: 0.1, priced: true, estimated: false,
  });

  const b = billingSummary();
  assert.equal(b.vendors.length, 2);
  const byId = Object.fromEntries(b.vendors.map((v) => [v.provider, v]));
  /* Each line is that vendor's own figures: paid in, less what is left. */
  near(byId.deepseek.topped_up_usd ?? -1, 30);
  near(byId.deepseek.balance_usd, 20.3);
  near(byId.deepseek.lifetime_usd ?? -1, 9.7);
  near(byId.orcarouter.topped_up_usd ?? -1, 5);
  near(byId.orcarouter.balance_usd, 4.5);
  near(byId.orcarouter.lifetime_usd ?? -1, 0.5);
  /* Neither is the headline: the ledger holds both vendors' turns. */
  assert.equal(b.vendors.every((v) => v.headline === false), true);
  /* So the total stays counted rather than taken from either account. */
  near(b.lifetime.cost, 0.5);
  near(b.month.cost, 0.5);

  /* The list itself is per vendor, whichever one happens to be selected. */
  const ids = vendorMoneyAll().map((v) => v.provider).sort();
  assert.deepEqual(ids, ["deepseek", "orcarouter"]);
});

/* A vendor nobody has paid into, or whose key is not set, gets no line at all:
   an absent line means "not known", never "nothing". */
test("a vendor with no money recorded gets no line", () => {
  clearUsage();
  clearVendors();
  addVendor(20.3, 30, "deepseek");
  addVendor(null, null, "orcarouter");

  const ids = vendorMoneyAll().map((v) => v.provider);
  assert.deepEqual(ids, ["deepseek"]);
});

/* A balance nobody has typed a paid-in figure for is still its own line: what is
   left with that vendor is a fact, and leaving the account out altogether is how
   a page ends up looking like only one API was ever paid for. It just carries no
   spend, and it must never stand in for the total. */
test("a balance with nothing recorded as paid in is still its own line", () => {
  clearUsage();
  clearVendors();
  addVendor(20.3, 30, "deepseek");
  addVendor(19.9998, null, "orcarouter");
  state.provider = "orcarouter";
  recordUsage({
    ts: now, session: "t", provider: "orcarouter", model: "orca-auto",
    input: 1000, output: 100, cost: 0.4, priced: true, estimated: false,
  });

  const b = billingSummary();
  assert.equal(b.vendors.length, 2);
  const orca = b.vendors.find((v) => v.provider === "orcarouter")!;
  near(orca.balance_usd, 19.9998);
  assert.equal(orca.topped_up_usd, null);
  assert.equal(orca.lifetime_usd, null);
  assert.equal(orca.spent_known, false);
  /* No spend to take the total from, so neither line is the headline. */
  assert.equal(b.vendors.every((v) => v.headline === false), true);
  near(b.lifetime.cost, 0.4);
});

/* Each line is compared with that vendor's own tokens, and nobody else's.
   Counting every API's turns against one account makes the line say the vendor
   owes money it was never charged: here both vendors were paid into, and each
   one's rows are a fraction of what the whole ledger counted. */
test("each vendor's line counts that vendor's own turns, not the whole ledger's", () => {
  clearUsage();
  clearVendors();
  addVendor(20.3, 30, "deepseek");
  addVendor(4.5, 5, "orcarouter");
  state.provider = "orcarouter";
  recordUsage({
    ts: now, session: "t", provider: "orcarouter", model: "orca-auto",
    input: 1000, output: 100, cost: 0.4, priced: true, estimated: false,
  });
  recordUsage({
    ts: now, session: "t", provider: "deepseek", model: "deepseek-flash",
    input: 1000, output: 100, cost: 0.1, priced: true, estimated: false,
  });

  const b = billingSummary();
  const byId = Object.fromEntries(b.vendors.map((v) => [v.provider, v]));
  /* Orca's own rows are 0.40 of the 0.50 the ledger counted, not the 0.50. */
  near(byId.orcarouter.counted_usd, 0.4);
  near(byId.deepseek.counted_usd, 0.1);
  /* Each is short against its own till by what that vendor cannot account for:
     5.00 paid in, 4.50 left is 0.50 spent, of which 0.40 was counted here. */
  near(byId.orcarouter.unaccounted_usd, 0.1);
  /* DeepSeek's 9.70 of spend against a 0.10 row is history before this ledger. */
  near(byId.deepseek.unaccounted_usd, 9.6);
});

/* A key taken out of Settings is the end of that connection: the last reading was
   that account's money, and with nothing to ask there is no way to refresh it, so
   it stops being reported rather than being drawn from a figure read hours ago. */
test("a key taken away takes its balance reading with it", () => {
  clearUsage();
  clearVendors();
  addVendor(4.5, 5, "orcarouter");
  state.provider = "orcarouter";
  assert.equal(billingSummary().vendors.length, 1);

  /* What the settings route does when an empty string arrives for a key. */
  delete state.keys.orcarouter;
  forgetVendorMoney("orcarouter");

  assert.equal(state.balances.orcarouter, undefined);
  assert.equal(state.balanceAts.orcarouter, undefined);
  assert.deepEqual(billingSummary().vendors, []);
  /* What has been paid in stays: it is a fact of the account, not a reading, so
     putting a key back picks the arithmetic up where it left off. */
  near(state.topUps.orcarouter ?? -1, 5);
});

/* The route calls this for every credential name it is given, and most of them
   are not balance vendors at all. */
test("a name with no balance endpoint is left alone", () => {
  clearVendors();
  addVendor(4.5, 5, "orcarouter");
  forgetVendorMoney("openai");
  forgetVendorMoney("some-login");
  near(state.balances.orcarouter ?? -1, 4.5);
  near(state.balanceAts.orcarouter ?? -1, now);
});

/* Where each vendor is asked. DeepSeek keeps /user/balance off the host while
   Orca Router keeps /balance under its /v1 prefix, so stripping the version
   from every base would aim one of them at nothing. */
test("each balance endpoint is built from that vendor's own base", () => {
  const spec = (id: string) => providerSpec(id)!;
  const build = (id: string) => {
    const base = spec(id).baseUrl.replace(/\/+$/, "");
    const root = spec(id).balance!.root === "host" ? base.replace(/\/v1$/, "") : base;
    return `${root}${spec(id).balance!.path}`;
  };
  assert.equal(build("deepseek"), "https://api.deepseek.com/user/balance");
  assert.equal(build("orcarouter"), "https://api.orcarouter.ai/v1/balance");
  assert.equal(build("openrouter"), "https://openrouter.ai/api/v1/credits");
  /* A vendor with no balance endpoint is not asked anywhere. */
  assert.equal(spec("openai").balance, undefined);
});

console.log(`\n${passed} passed`);
