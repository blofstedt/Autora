/**
 * The console's own voice: found by name, offered, spoken, and refused.
 *
 * Nothing here reaches the network -- fetch is replaced with a fake voice
 * server, so these run on a machine that has never heard of Kokoro.
 *
 *   npx tsx tests/speech.test.ts
 */
import assert from "node:assert/strict";
import { defaultVoice, forgetSpeech, setSpeechUrl, speak, speechStatus } from "../server/speech";

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

type Call = { url: string; body: any };

/** A voice server that answers /health, /v1/audio/voices and speech. */
function voiceServer(options: { health?: number; voices?: unknown; speech?: number; audio?: Uint8Array } = {}) {
  const calls: Call[] = [];
  const audio = options.audio ?? new Uint8Array([1, 2, 3, 4, 5]);
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/health")) {
      const status = options.health ?? 200;
      return status === 200
        ? new Response(JSON.stringify({ status: "healthy" }), { status: 200 })
        : new Response("nope", { status });
    }
    if (url.endsWith("/v1/audio/voices")) {
      if (options.voices === undefined) return new Response("no list", { status: 500 });
      return new Response(JSON.stringify(options.voices), { status: 200 });
    }
    if (url.endsWith("/v1/audio/speech")) {
      const status = options.speech ?? 200;
      return status === 200
        ? new Response(audio.buffer as ArrayBuffer, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
        : new Response("bad voice", { status });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const LIST = { voices: [
  { id: "af_heart", name: "af_heart", overall_grade: "A" },
  { id: "am_michael", name: "am_michael" },
] };

async function main() {
  await test("a voice server on the network is found and its voices listed", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    const status = await speechStatus(true);
    assert.equal(status.available, true);
    assert.equal(status.url, "http://kokoro_web_1:8880");
    assert.deepEqual(status.voices, [
      { id: "af_heart", label: "af_heart — A" },
      { id: "am_michael", label: "am_michael" },
    ]);
    assert.equal(status.voice, defaultVoice());
    assert.equal(calls.filter((c) => c.url.endsWith("/health")).length, 1);
  });

  await test("no voice server anywhere: unavailable, and it says so", async () => {
    forgetSpeech();
    setSpeechUrl("");
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const status = await speechStatus(true);
    assert.equal(status.available, false);
    assert.equal(status.voices.length, 0);
    assert.match(String(status.reason), /No voice server/);
  });

  await test("a server that answers health but not the voice list is unavailable", async () => {
    forgetSpeech();
    setSpeechUrl("");
    voiceServer({ voices: undefined });
    const status = await speechStatus(true);
    assert.equal(status.available, false);
    assert.equal(status.url, "http://kokoro_web_1:8880");
    assert.match(String(status.reason), /did not answer/);
  });

  await test("a configured address is used as given, without discovery", async () => {
    forgetSpeech();
    setSpeechUrl("http://10.21.0.13:8880/");
    const calls = voiceServer({ voices: LIST });
    const status = await speechStatus(true);
    assert.equal(status.url, "http://10.21.0.13:8880");
    assert.ok(calls.every((c) => c.url.startsWith("http://10.21.0.13:8880")));
    setSpeechUrl("");
  });

  await test("speaking asks for the OpenAI shape and returns the audio", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    const utterance = await speak("  Hello   there.\n");
    assert.deepEqual(Array.from(utterance.audio), [1, 2, 3, 4, 5]);
    assert.equal(utterance.contentType, "audio/mpeg");
    assert.equal(utterance.voice, defaultVoice());
    const sent = calls.find((c) => c.url.endsWith("/v1/audio/speech"))?.body;
    // Whitespace is collapsed: a fragment arrives as it was typed.
    assert.deepEqual(sent, {
      model: "kokoro", input: "Hello there.", voice: defaultVoice(), response_format: "mp3",
    });
  });

  await test("a chosen voice is the one asked for, and the status uses it", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    const status = await speechStatus(true, "am_michael");
    assert.equal(status.voice, "am_michael");
    await speak("Read this.", { voice: "am_michael" });
    assert.equal(calls.at(-1)?.body.voice, "am_michael");
  });

  await test("a speed that is not a speed is left out rather than passed on", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    await speak("Faster.", { speed: 40 });
    assert.equal("speed" in (calls.at(-1)?.body ?? {}), false);
    await speak("Slower.", { speed: 0.9 });
    assert.equal(calls.at(-1)?.body.speed, 0.9);
  });

  await test("nothing to say, or far too much, is refused before the server is asked", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    await assert.rejects(() => speak("   \n  "), /Nothing to say/);
    await assert.rejects(() => speak("x".repeat(2_001)), /Too long to speak/);
    assert.equal(calls.length, 0);
  });

  await test("a voice the server rejects is reported in words, not as silence", async () => {
    forgetSpeech();
    setSpeechUrl("");
    voiceServer({ voices: LIST, speech: 400 });
    await assert.rejects(() => speak("Say it.", { voice: "not_a_voice" }), /answered 400/);
  });

  await test("an empty recording is a failure rather than a silent success", async () => {
    forgetSpeech();
    setSpeechUrl("");
    voiceServer({ voices: LIST, audio: new Uint8Array() });
    await assert.rejects(() => speak("Say it."), /empty recording/);
  });

  await test("the answer is held for a moment, so the page and the panel cost one look", async () => {
    forgetSpeech();
    setSpeechUrl("");
    const calls = voiceServer({ voices: LIST });
    await speechStatus(true);
    await speechStatus();
    await speechStatus(false, "am_michael");
    assert.equal(calls.filter((c) => c.url.endsWith("/health")).length, 1);
  });

  console.log(`speech: ${passed} passed`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { globalThis.fetch = realFetch; });
