/**
 * The console's own voice: one key, one service, offered, spoken, refused.
 *
 * Nothing here reaches the network -- fetch is replaced with a fake Deepgram,
 * and the key is read from a state directory of this file's own, so a machine
 * with a real key set (the one this was written on) still tests both paths.
 *
 *   npx tsx tests/speech.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Before the app is imported: its own settings file, never the machine's. */
process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-speech-"));
process.env.DEEPGRAM_API_KEY = "";
delete process.env.AUTORA_DEEPGRAM_VOICE;

const { defaultDeepgramVoice, forgetSpeech, speak, speechStatus } = await import("../server/speech");

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

const realFetch = globalThis.fetch;
const realKey = process.env.DEEPGRAM_API_KEY;

type Call = { url: string; body: any; headers?: any };

/** Deepgram's model catalogue, as much of it as this file looks at. */
const MODELS = { tts: [
  { name: "asteria", canonical_name: "aura-asteria-en", architecture: "aura", languages: ["en-US"], metadata: { display_name: "Asteria", accent: "American" } },
  { name: "thalia", canonical_name: "aura-2-thalia-en", architecture: "aura-2", languages: ["en-US"], metadata: { display_name: "Thalia", accent: "American" } },
  { name: "agathe", canonical_name: "aura-2-agathe-fr", architecture: "aura-2", languages: ["fr-FR"], metadata: { display_name: "Agathe", accent: "French" } },
] };

/** Deepgram, answering the two endpoints this file uses. */
function deepgram(options: { speak?: number; models?: unknown; modelsStatus?: number; audio?: Uint8Array } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers });
    if (url.includes("/v1/models")) {
      if (options.modelsStatus && options.modelsStatus !== 200) {
        return new Response(JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }), { status: options.modelsStatus });
      }
      if (options.models === undefined) return new Response("something else entirely", { status: 200 });
      return new Response(JSON.stringify(options.models), { status: 200 });
    }
    if (url.includes("/v1/speak")) {
      const status = options.speak ?? 200;
      const audio = options.audio ?? new Uint8Array([9, 8, 7]);
      return status === 200
        ? new Response(audio.buffer as ArrayBuffer, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
        : new Response(JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }), { status });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

/** A key in the environment, and nothing remembered from the last test. */
function useKey(key = "dg-test-key") {
  process.env.DEEPGRAM_API_KEY = key;
  forgetSpeech();
}

async function main() {
  await test("with no key there is no voice service, and it says how to get one", async () => {
    process.env.DEEPGRAM_API_KEY = "";
    forgetSpeech();
    let asked = false;
    globalThis.fetch = (async () => { asked = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const status = await speechStatus(true);
    assert.equal(status.available, false);
    assert.equal(status.provider, null);
    assert.equal(status.voices.length, 0);
    assert.match(String(status.reason), /paste a Deepgram API key/);
    assert.equal(asked, false);
  });

  await test("a key makes Deepgram the voice, and its voices are the list", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    const status = await speechStatus(true);
    assert.equal(status.available, true);
    assert.equal(status.provider, "deepgram");
    assert.equal(status.url, "https://api.deepgram.com");
    assert.equal(status.voice, defaultDeepgramVoice());
    // The current generation is offered before the older one, by name.
    assert.deepEqual(status.voices, [
      { id: "aura-2-agathe-fr", label: "Agathe — French" },
      { id: "aura-2-thalia-en", label: "Thalia — American" },
      { id: "aura-asteria-en", label: "Asteria — American" },
    ]);
    assert.ok(calls.every((c) => String(c.headers?.Authorization ?? "").startsWith("Token ")));
  });

  await test("the answer is held for a moment, so the page and the panel cost one look", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    await speechStatus(true);
    await speechStatus();
    await speechStatus(false, "aura-2-agathe-fr");
    assert.equal(calls.filter((c) => c.url.includes("/v1/models")).length, 1);
    forgetSpeech();
  });

  await test("a chosen voice is the one asked for, and the status uses it", async () => {
    useKey();
    deepgram({ models: MODELS });
    const status = await speechStatus(true, "aura-2-agathe-fr");
    assert.equal(status.voice, "aura-2-agathe-fr");
  });

  await test("speaking asks Deepgram for the voice and returns the audio", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    const utterance = await speak("  Say   this.\n", { voice: "aura-2-thalia-en" });
    assert.deepEqual(Array.from(utterance.audio), [9, 8, 7]);
    assert.equal(utterance.contentType, "audio/mpeg");
    assert.equal(utterance.voice, "aura-2-thalia-en");
    const sent = calls.find((c) => c.url.includes("/v1/speak"));
    assert.match(String(sent?.url), /model=aura-2-thalia-en/);
    // Whitespace is collapsed: a fragment arrives as it was typed.
    assert.deepEqual(sent?.body, { text: "Say this." });
    assert.equal(sent?.headers?.Authorization, "Token dg-test-key");
  });

  await test("a voice saved for the replaced service is remapped, not sent to Deepgram", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    const status = await speechStatus(true, "af_heart");
    assert.equal(status.voice, defaultDeepgramVoice());
    await speak("Read this.", { voice: "af_heart" });
    // Asked for by name it would be a 400 and a failed sentence, so it is
    // carried over the same way the status path carries it.
    assert.match(String(calls.at(-1)?.url), new RegExp(`model=${defaultDeepgramVoice()}`));
    assert.ok(!calls.some((c) => String(c.url).includes("model=af_heart")));
  });

  await test("a speed that is not a speed is left out, a sane one is passed on", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    await speak("Faster.", { speed: 40 });
    assert.ok(!String(calls.at(-1)?.url).includes("speed="));
    await speak("Slower.", { speed: 0.9 });
    assert.match(String(calls.at(-1)?.url), /speed=0\.9/);
  });

  await test("a wav is asked for as a wav", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    await speak("Say it as a wav.", { format: "wav" });
    const url = String(calls.at(-1)?.url);
    assert.match(url, /encoding=linear16/);
    assert.match(url, /container=wav/);
  });

  await test("nothing to say, or far too much, is refused before the service is asked", async () => {
    useKey();
    const calls = deepgram({ models: MODELS });
    await assert.rejects(() => speak("   \n  "), /Nothing to say/);
    await assert.rejects(() => speak("x".repeat(2_001)), /Too long to speak/);
    assert.equal(calls.length, 0);
  });

  await test("with no key, speaking falls back with a reason rather than falling silent", async () => {
    process.env.DEEPGRAM_API_KEY = "";
    forgetSpeech();
    await assert.rejects(() => speak("Say it."), /paste a Deepgram API key/);
  });

  await test("a key Deepgram refuses is reported in words, not as silence", async () => {
    useKey();
    deepgram({ models: MODELS, speak: 401 });
    await assert.rejects(() => speak("Say it."), /refused the API key/);
  });

  await test("a service that answers 500 on the way out is reported in words", async () => {
    useKey();
    deepgram({ models: MODELS, speak: 500 });
    await assert.rejects(() => speak("Say it."), /Deepgram answered 500/);
  });

  await test("an empty recording is a failure rather than a silent success", async () => {
    useKey();
    deepgram({ models: MODELS, audio: new Uint8Array() });
    await assert.rejects(() => speak("Say it."), /empty recording/);
  });

  await test("a key refused at the model list is the reason, not a dead server", async () => {
    useKey();
    deepgram({ models: MODELS, modelsStatus: 401 });
    const status = await speechStatus(true);
    assert.equal(status.available, false);
    assert.equal(status.provider, "deepgram");
    assert.match(String(status.reason), /refused the API key/);
  });

  await test("a voice list with nothing in it is unavailable, with the reason in words", async () => {
    useKey();
    deepgram({ models: { tts: [] } });
    const broken = await speechStatus(true);
    assert.equal(broken.available, false);
    assert.match(String(broken.reason), /came back empty/);
  });

  await test("an answer that is not JSON at all is a complaint, not a stack trace", async () => {
    useKey();
    deepgram({ models: undefined });
    const broken = await speechStatus(true);
    assert.equal(broken.available, false);
    assert.match(String(broken.reason), /could not be reached/);
  });

  await test("a service nobody can reach is unavailable, and says so", async () => {
    useKey();
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const status = await speechStatus(true);
    assert.equal(status.available, false);
    assert.match(String(status.reason), /could not be reached/);
  });

  await test("a voice named in the environment is the default", async () => {
    process.env.AUTORA_DEEPGRAM_VOICE = "aura-2-orion-en";
    assert.equal(defaultDeepgramVoice(), "aura-2-orion-en");
    useKey();
    deepgram({ models: MODELS });
    const status = await speechStatus(true);
    assert.equal(status.voice, "aura-2-orion-en");
    delete process.env.AUTORA_DEEPGRAM_VOICE;
    assert.equal(defaultDeepgramVoice(), "aura-2-thalia-en");
  });

  console.log(`speech: ${passed} passed`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    globalThis.fetch = realFetch;
    process.env.DEEPGRAM_API_KEY = realKey;
  });
