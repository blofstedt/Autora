/**
 * Pinning one model to one endpoint of a vendor that routes.
 *
 * One endpoint of the chosen model, since OpenRouter serves the same model
 * from several and will otherwise pick a different one -- another machine, at
 * another price -- from call to call. A pin names one and refuses the rest, which is a routing
 * block in the request body. This file is about that block: that it is there
 * when a pin is set, that it is absent when none is (nobody who never chose
 * one gets a different request than before), that it never travels to a
 * vendor that does not route, and that setting, changing and clearing one
 * behaves.
 *
 * The body is read off a real HTTP server rather than a stubbed fetch: what
 * the vendor receives is the thing in question, and an assertion against our
 * own variable would pass however the body were assembled.
 *
 *   npx tsx tests/endpoint-pin.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-endpoint-pin-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const { streamChat } = await import("../server/llm");
const { endpointPinFor, endpointPinSaved, flushState, setEndpointPin, state } = await import("../server/state");
const { settingsRoutes } = await import("../server/routes/settings");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/* A vendor that answers in OpenRouter's streaming shape and remembers what it
   was asked. Nothing else about the reply matters here: the request is the
   subject, so a one-word answer is enough to finish the call. */
const bodies: any[] = [];
const vendor = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    try { bodies.push(JSON.parse(raw)); } catch { bodies.push(raw); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
vendor.listen(0);
await new Promise((r) => vendor.once("listening", r));
const base = `http://127.0.0.1:${(vendor.address() as { port: number }).port}/api/v1`;

const MODEL = "z-ai/glm-5.3-flash";

/** Ask once, and hand back the body the vendor was sent. */
async function ask(provider: string, endpoint: string | undefined, model = MODEL) {
  bodies.length = 0;
  await streamChat({
    provider, model, key: "k", baseUrl: base,
    system: "", messages: [{ role: "user", text: "hi" }], endpoint,
  }, () => undefined);
  assert.equal(bodies.length, 1, "the vendor should have been asked exactly once");
  return bodies[0];
}

console.log("endpoint pin");

await test("a pinned turn names that endpoint and refuses the others", async () => {
  const body = await ask("openrouter", "deepinfra");
  assert.equal(body.model, "z-ai/glm-5.3-flash");
  assert.deepEqual(body.provider, { only: ["deepinfra"], allow_fallbacks: false },
    "the routing block should name one endpoint and allow no fallback");
});

await test("no pin means no routing block at all", async () => {
  for (const endpoint of [undefined, "", "   "]) {
    const body = await ask("openrouter", endpoint);
    assert.equal("provider" in body, false,
      `an unpinned turn (${JSON.stringify(endpoint)}) should send the body it always did`);
    assert.deepEqual(Object.keys(body).filter((k) => k === "provider"), []);
  }
});

await test("a pin is not sent to a vendor that does not route", async () => {
  /* OpenAI and most gateways refuse a field they do not know, so a stray pin
     must not turn every call into a 400. */
  const body = await ask("openai", "deepinfra");
  assert.equal("provider" in body, false, "only a vendor that routes should be told about an endpoint");
});

await test("the pin is whitespace-trimmed on the way out", async () => {
  const body = await ask("openrouter", "  chutes\n");
  assert.deepEqual(body.provider, { only: ["chutes"], allow_fallbacks: false });
});

// ------------------------------------------------------------- the state --

await test("a pin is stored with its model, read back, and cleared", async () => {
  assert.equal(endpointPinFor("openrouter", MODEL), "", "nothing is pinned on a fresh install");
  setEndpointPin("openrouter", " deepinfra ", MODEL);
  assert.equal(endpointPinFor("openrouter", MODEL), "deepinfra");
  assert.deepEqual(endpointPinSaved("openrouter"), { model: MODEL, endpoint: "deepinfra" });
  setEndpointPin("openrouter", "   ", MODEL);
  assert.equal(endpointPinFor("openrouter", MODEL), "", "an empty value clears the pin");
  assert.equal(endpointPinSaved("openrouter"), null);
  assert.equal("openrouter" in state.endpointPins, false,
    "cleared means gone from the file, not stored as a blank");
});

await test("a pin holds the model it was made for and no other", async () => {
  /* The one that matters: talk mode answers with a faster model of the same
     vendor. A pin that travelled to it would have OpenRouter refuse every
     spoken turn, because that endpoint serves the model the pin was made for
     and not this one. */
  setEndpointPin("openrouter", "deepinfra", MODEL);
  assert.equal(endpointPinFor("openrouter", MODEL), "deepinfra");
  assert.equal(endpointPinFor("openrouter", "openai/gpt-4o-mini"), "");
  const other = await ask("openrouter", endpointPinFor("openrouter", "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal("provider" in other, false, "another model is asked for without a routing block");
  assert.equal(other.model, "openai/gpt-4o-mini");
  setEndpointPin("openrouter", "", MODEL);
});

await test("a pin reaches the disk", async () => {
  setEndpointPin("openrouter", "deepinfra", MODEL);
  flushState();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.deepEqual(saved.endpointPins.openrouter, { model: MODEL, endpoint: "deepinfra" });
  setEndpointPin("openrouter", "", MODEL);
  flushState();
  const after = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.deepEqual(after.endpointPins, {}, "a cleared pin is written as nothing at all");
});

// ------------------------------------------------------------ the route --

/* Mounted as the app mounts it, so the field name and its validation are the
   ones the Settings page actually talks to. */
const app = express();
app.use(express.json());
settingsRoutes(app, {
  captchaVisionLabel: () => null,
  webPush: { count: () => 0, publicKey: () => "", list: () => [] } as never,
  flushHeldPushes: () => undefined,
  replanJobs: () => undefined,
  stopPreviews: async () => undefined,
});
const ui = app.listen(0);
await new Promise((r) => ui.once("listening", r));
const api = `http://127.0.0.1:${(ui.address() as { port: number }).port}/api/settings`;

const patch = (body: unknown) => fetch(api, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

await test("the Settings page sets and clears a pin, and reads it back", async () => {
  /* The model the pin is made for is the one saved at that moment, so the
     model goes in the same request the way the page sends it. */
  const set = await patch({ models: { openrouter: MODEL }, endpoint_pins: { openrouter: "deepinfra" } });
  assert.equal(set.ok, true, `PATCH answered ${set.status}`);
  assert.deepEqual(endpointPinSaved("openrouter"), { model: MODEL, endpoint: "deepinfra" });

  const read = await fetch(api).then((r) => r.json());
  const card = read.catalog.find((c: any) => c.id === "openrouter");
  assert.equal(card.endpoint_pin, "deepinfra", "the row shows the pin that is set");
  assert.equal(card.endpoint_pin_model, MODEL, "and the model it is holding");
  assert.equal(card.pinnable, true, "and offers the field only where the vendor routes");
  assert.equal(read.catalog.find((c: any) => c.id === "openai").pinnable, false);

  /* Changing the model leaves the pin where it is: it still holds the model it
     was made for, and is not in force for the new one. */
  await patch({ models: { openrouter: "meta-llama/llama-3.3-70b-instruct" } });
  assert.deepEqual(endpointPinSaved("openrouter"), { model: MODEL, endpoint: "deepinfra" });
  assert.equal(endpointPinFor("openrouter", "meta-llama/llama-3.3-70b-instruct"), "");

  const cleared = await patch({ endpoint_pins: { openrouter: "" } });
  assert.equal(cleared.ok, true);
  assert.equal(endpointPinSaved("openrouter"), null, "an empty string clears it");
});

await test("a pin for a vendor that does not exist is ignored, not stored", async () => {
  const res = await patch({ endpoint_pins: { "not-a-vendor": "deepinfra", openrouter: 42 } });
  assert.equal(res.ok, true, "the request is still fine");
  assert.equal("not-a-vendor" in state.endpointPins, false);
  assert.equal(endpointPinSaved("openrouter"), null, "and a number is not an endpoint");
});

ui.close();
vendor.close();
console.log(`\n${passed} passed`);
