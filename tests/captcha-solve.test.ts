/**
 * The loop that answers a picture challenge, run against a scripted page.
 *
 * Everything that goes wrong here is a click on a real page, so the cases are
 * the ways the loop has been able to click wrongly or give up needlessly:
 * trying another backend on a challenge that has since been redrawn, a model
 * that could not be asked once and was never asked again, a model that never
 * answers, "nothing matches" being unsayable, and reCAPTCHA's replace-and-go-on
 * grids being verified after one round.
 *
 *   npx tsx tests/captcha-solve.test.ts
 */
import assert from "node:assert/strict";
import { encodePng, type Bitmap } from "../server/captcha-images";
import {
  DEFAULT_CAPTCHA, solveChallenge, type Challenge, type CaptchaSettings, type SolverDeps, type Tile,
} from "../server/captcha";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A picture with something in it: a model is not asked about a blank one. */
function busy(): Buffer {
  const w = 60, h = 60;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (i * 37) % 251;
    rgba.set([v, 255 - v, (v * 7) % 255, 255], i * 4);
  }
  return encodePng({ w, h, rgba } as Bitmap);
}

/** Nine squares in a 3x3 grid, each 100 wide, in a 300 box at 0,0. */
function grid(prompt: string, over: Partial<Challenge> = {}, labels?: string[]): Challenge {
  const tiles: Tile[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    tiles.push({ index: r * 3 + c + 1, box: { x: c * 100, y: r * 100, w: 100, h: 100 }, ...(labels ? { label: labels[r * 3 + c] } : {}) });
  }
  return {
    kind: "grid", widget: "reCAPTCHA", box: { x: 0, y: 0, w: 300, h: 380 }, prompt, tiles,
    verify: { x: 200, y: 320, w: 80, h: 40 }, handle: null, track: null, ...over,
  };
}
const centre = (i: number) => ({ x: ((i - 1) % 3) * 100 + 50, y: Math.floor((i - 1) / 3) * 100 + 50 });
const VERIFY = { x: 240, y: 340 };
const is = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;

let modelName = 0;
/**
 * A scripted page. `looks` is what the widget shows each time it is looked at
 * (the last one repeats; null is "gone"); `said` is what the model answers to
 * a real question, in order (the sight test is answered by itself).
 */
function page(looks: (Challenge | null)[], said: (string | Error | "hang")[], over: Partial<SolverDeps> & { settings?: Partial<CaptchaSettings> } = {}) {
  const clicks: { x: number; y: number }[] = [];
  const questions: string[] = [];
  let look = 0;
  let passedNow = false;
  const name = `test-model-${++modelName}`;
  const { settings: settingsOver, ...rest } = over;
  const deps: SolverDeps = {
    page: null,
    settings: { ...DEFAULT_CAPTCHA, backends: ["vision"], attempts: 3, ...settingsOver },
    shot: async () => busy(),
    vision: async (prompt) => {
      const probe = /nine numbered squares/.test(prompt);
      if (probe) return `{"tile":${/N from 1 to 9/.test(prompt) ? probeAnswer : 0}}`;
      questions.push(prompt);
      const next = said.shift();
      if (next === undefined) return '{"tiles":[]}';
      if (next === "hang") return new Promise<string>(() => undefined);
      if (next instanceof Error) throw next;
      return next;
    },
    visionName: () => name,
    click: async (at) => { clicks.push(at); },
    drag: async () => undefined,
    passed: async () => passedNow,
    log: () => undefined,
    sleep: async () => undefined,
    find: async () => {
      const shown = looks[Math.min(look, looks.length - 1)];
      look += 1;
      return shown;
    },
    ...rest,
  };
  return { deps, clicks, questions, pass: () => { passedNow = true; }, looked: () => look, name };
}
/** The sight test asks for the one inked square; a model that sees answers it. */
let probeAnswer = 0;
const seeing = (p: ReturnType<typeof page>) => {
  const original = p.deps.vision!;
  p.deps.vision = async (prompt, pngs) => {
    if (/nine numbered squares/.test(prompt)) {
      // The probe is drawn with the inked square's number in the prompt's picture, which a fake cannot read:
      // answer from the probe's own bytes by trying both squares the loop uses (4 then 9).
      probeAnswer = probeAnswer === 4 ? 9 : 4;
      return `{"tile":${probeAnswer}}`;
    }
    return original(prompt, pngs);
  };
  return p;
};

async function main() {
  console.log("a widget that redraws");
  await test("after a wrong answer the next backend is asked about what is showing now, not what was", async () => {
    const before = grid("Select all images with buses");
    const after = grid("Select all images with bicycles");
    const p = seeing(page([before, after], ['{"tiles":[2]}', '{"tiles":[5]}'], { settings: { backends: ["vision", "vision"], attempts: 2 } as never }));
    p.deps.passed = async () => p.clicks.some((c) => is(c, centre(5)));
    const report = await solveChallenge(p.deps);
    assert.ok(p.questions.length >= 2, `asked ${p.questions.length} times`);
    assert.match(p.questions[0], /buses/);
    assert.match(p.questions[1], /bicycles/, "the second question was about the challenge that was on screen");
    assert.doesNotMatch(p.questions[1], /buses/);
    assert.equal(report.outcome, "solved");
  });
  await test("a backend that answered wrongly is not the first asked next time", async () => {
    const labels = ["tomato", "carrot", "onion", "banana", "grape", "corn", "avocado", "potato", "eggplant"];
    const challenge = grid("Select all the squares with a Vegetable", {}, labels.map((v) => `${v}.webp`));
    const p = seeing(page([challenge], ['{"tiles":[2,3,6,8,9]}', '{"tiles":[2,3,6,8,9]}', '{"tiles":[2,3,6,8,9]}'], {
      settings: { backends: ["local", "vision"], attempts: 3 } as never,
    }));
    const used: string[] = [];
    p.deps.log = (what) => { const m = /answered by (\w+)/.exec(what); if (m) used.push(m[1]); };
    await solveChallenge(p.deps);
    assert.deepEqual(used.slice(0, 2), ["local", "vision"], `order was ${used.join(", ")}`);
  });

  console.log("a page that cannot be read");
  await test("a look that throws is not a pass: nothing is clicked and it says why", async () => {
    const p = seeing(page([grid("Select all images with buses")], ['{"tiles":[1]}']));
    p.deps.find = async () => { throw new Error("Execution context was destroyed"); };
    const report = await solveChallenge(p.deps);
    assert.equal(report.outcome, "giveup");
    assert.match(report.detail, /could not be read for a challenge \(Execution context was destroyed\)/);
    assert.equal(p.clicks.length, 0);
  });
  await test("a look that throws after the click is not taken for the challenge having gone", async () => {
    const challenge = grid("Select all images with buses");
    const p = seeing(page([challenge], ['{"tiles":[2]}']));
    let looks = 0;
    p.deps.find = async () => { looks += 1; if (looks === 1) return challenge; throw new Error("frame detached"); };
    const report = await solveChallenge(p.deps);
    assert.notEqual(report.outcome, "solved", report.detail);
  });

  console.log("a model that cannot be asked");
  await test("one failed sight test is not remembered forever", async () => {
    const p1 = seeing(page([grid("Select all images with buses")], []));
    const flaky = p1.deps.vision!;
    let first = true;
    p1.deps.vision = async (prompt, pngs) => {
      if (first) { first = false; throw new Error("ECONNRESET"); }
      return flaky(prompt, pngs);
    };
    const one = await solveChallenge(p1.deps);
    assert.equal(one.outcome, "giveup");
    assert.match(one.detail, /could not be asked|ECONNRESET/);
    // Same model, next challenge, network back: it is asked again and can see.
    const p2 = seeing(page([grid("Select all images with buses")], ['{"tiles":[1]}']));
    p2.deps.visionName = p1.deps.visionName;
    p2.deps.passed = async () => p2.clicks.length > 0;
    const two = await solveChallenge(p2.deps);
    assert.equal(two.outcome, "solved", two.detail);
  });
  await test("a model that never answers is given up on, and the turn is not left hanging", async () => {
    const p = seeing(page([grid("Select all images with buses")], ["hang", "hang", "hang"], { answerTimeoutMs: 30 } as never));
    const started = Date.now();
    const report = await solveChallenge(p.deps);
    assert.equal(report.outcome, "giveup");
    assert.match(report.detail, /did not answer in time/);
    assert.ok(Date.now() - started < 3000);
    assert.equal(p.clicks.length, 0, "nothing was clicked on a guess");
  });

  console.log("nothing matches");
  await test("when the widget allows skipping and the model finds nothing, Verify is pressed with nothing chosen", async () => {
    const challenge = grid("Select all squares with crosswalks. If there are none, click skip");
    const p = seeing(page([challenge, null, null], ['{"tiles":[]}']));
    const report = await solveChallenge(p.deps);
    assert.deepEqual(p.clicks, [VERIFY]);
    assert.equal(report.outcome, "solved");
  });
  await test("with no way to skip, an empty answer is not pressed through on a guess", async () => {
    const p = seeing(page([grid("Select all images with buses")], ['{"tiles":[]}', '{"tiles":[]}', '{"tiles":[]}']));
    const report = await solveChallenge(p.deps);
    assert.equal(p.clicks.length, 0);
    assert.equal(report.outcome, "giveup");
  });

  console.log("squares that are replaced");
  await test("clicked squares are re-read, and Verify comes once, after the last", async () => {
    const challenge = grid("Select all images with buses. Click verify once there are none left.");
    const p = seeing(page([challenge], ['{"tiles":[1,2]}', '{"tiles":[2]}', '{"tiles":[]}']));
    p.deps.find = (async () => (p.clicks.some((c) => is(c, VERIFY)) ? null : challenge));
    const report = await solveChallenge(p.deps);
    assert.deepEqual(p.clicks, [centre(1), centre(2), centre(2), VERIFY]);
    assert.equal(p.clicks.filter((c) => is(c, VERIFY)).length, 1);
    assert.equal(report.outcome, "solved");
  });
  await test("a replace-and-go-on grid is not read forever", async () => {
    const challenge = grid("Select all images with buses. Click verify once there are none left.");
    const p = seeing(page([challenge], Array.from({ length: 30 }, () => '{"tiles":[3]}')));
    await solveChallenge(p.deps);
    assert.ok(p.clicks.filter((c) => is(c, centre(3))).length <= 12, `${p.clicks.length} clicks`);
    assert.ok(p.clicks.some((c) => is(c, VERIFY)), "it stops and presses Verify");
  });
  await test("a static grid is unchanged: click the squares, press Check, once", async () => {
    const challenge = grid("Select all images with buses");
    const p = seeing(page([challenge, null, null], ['{"tiles":[4,6]}']));
    const report = await solveChallenge(p.deps);
    assert.deepEqual(p.clicks, [centre(4), centre(6), VERIFY]);
    assert.equal(report.outcome, "solved");
  });

  console.log(`\n${passed} passed`);
}
main().catch((err) => { console.error(err); process.exit(1); });
