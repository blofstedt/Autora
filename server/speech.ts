/**
 * The console's own voice, from Deepgram's hosted text-to-speech service rather
 * than from the browser.
 *
 * The app used to speak with `speechSynthesis`, which is whatever system voice
 * the platform happens to install -- a different one on every device, and on
 * most of them the worst one it has. Deepgram's Aura voices replace it whenever
 * there is a key for them (DEEPGRAM_API_KEY in the environment, or one pasted
 * into Settings). There is nothing to run: one HTTPS request a sentence, and
 * the same voice on the phone, the laptop and the desktop.
 *
 * The audio is fetched here rather than by the page, so that the key never has
 * to reach the browser, and so the audio arrives from the origin the page
 * already trusts. Everything is optional and nothing throws at the caller: with
 * no key, `/api/speech` says so and the page falls back to the browser's own
 * voice -- exactly what it had before. The environment:
 *
 *   AUTORA_DEEPGRAM_VOICE the Deepgram voice to start with (aura-2-thalia-en)
 */
import { secretFor } from "./state";

/** Where the hosted voices are, and where the key is sent. */
const DEEPGRAM_API = "https://api.deepgram.com";
/** Aura-2, the current generation: the ones that do not read like a machine.
    Aura-1 voices are still listed, and still work, if one is wanted. */
const DEFAULT_DEEPGRAM_VOICE = "aura-2-thalia-en";

/** Long enough that the voice list is not re-fetched per sentence, short enough
    that a key pasted into the panel is noticed while the person is still
    looking. */
const STATUS_TTL_MS = 30_000;
/** Deepgram's voice list is static and comes from a service we do not run, so
    it is held far longer than a status check is. */
const VOICES_TTL_MS = 10 * 60_000;
/** A sentence, not a document. The client sends spoken fragments; anything
    past this is a bug in the caller, and a 10,000-character request would
    occupy the service for minutes. */
const MAX_CHARS = 2_000;

export interface VoiceOption {
  id: string;
  /** What to show in a picker: the name a person reads, and where that voice
      is from ("Thalia — American"). */
  label: string;
}

export interface SpeechStatus {
  /** False when there is no key to speak with: the page then uses the browser's
      own voice. */
  available: boolean;
  /** The service that would speak, even when it cannot right now -- so that a
      settings panel can say "Deepgram, and its key was refused" rather than
      "no voice". Null only when nothing is configured at all. */
  provider: "deepgram" | null;
  /** The voice in use, whether it came from the environment, the settings
      file, or Deepgram's own default. */
  voice: string;
  voices: VoiceOption[];
  /** Why it is unavailable, in words a settings panel can show. */
  reason: string | null;
  /** The service behind it, for the panel to say out loud. */
  url: string | null;
}

export function defaultDeepgramVoice(): string {
  return (process.env.AUTORA_DEEPGRAM_VOICE || "").trim() || DEFAULT_DEEPGRAM_VOICE;
}

/** The key to speak through Deepgram with: the one pasted into the app first,
    then the environment, the way every other key here is found. */
function deepgramKey(): string {
  return secretFor("DEEPGRAM_API_KEY");
}

let cached: { at: number; value: SpeechStatus } | null = null;
let deepgramVoices: { at: number; value: VoiceOption[] } | null = null;

/** An answer from Deepgram that was not 200, carrying what it said. */
class DeepgramError extends Error {}

async function getJson(url: string, ms: number, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new DeepgramError(deepgramComplaint(res.status, await res.text().catch(() => "")));
  return res.json();
}

/**
 * Deepgram's voices, from its own model list.
 *
 * The list is the model catalogue, filtered to text-to-speech, and it is what
 * makes the picker usable: an id like `aura-2-thalia-en` reads as "Thalia —
 * American", and the current generation is put above the older one rather than
 * in the order the catalogue happens to hold.
 */
async function deepgramList(key: string): Promise<VoiceOption[]> {
  if (deepgramVoices && Date.now() - deepgramVoices.at < VOICES_TTL_MS) return deepgramVoices.value;
  const body = await getJson(`${DEEPGRAM_API}/v1/models`, 8_000, { Authorization: `Token ${key}` });
  const rows: any[] = Array.isArray(body?.tts) ? body.tts : [];
  const ranked = rows
    .map((row) => {
      const id = String(row?.canonical_name ?? row?.name ?? "").trim();
      if (!id) return null;
      const name = String(row?.metadata?.display_name ?? "").trim() || id;
      const where = String(row?.metadata?.accent ?? row?.languages?.[0] ?? "").trim();
      return {
        id,
        label: where ? `${name} — ${where}` : name,
        // Aura-2 first: the better voices should not be a scroll away.
        rank: String(row?.architecture ?? "") === "aura-2" ? 0 : 1,
      };
    })
    .filter(Boolean) as (VoiceOption & { rank: number })[];
  ranked.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const value = ranked.map(({ id, label }) => ({ id, label }));
  deepgramVoices = { at: Date.now(), value };
  return value;
}

/**
 * The voice to use, given what is wanted and what Deepgram offers.
 *
 * A voice the catalogue has never heard of is not passed through: the id saved
 * by the install this replaced (`af_heart`, from the local voice server that
 * used to be an option here) would come back as "Invalid 'model' value" on
 * every sentence. An unheard-of voice falls back to the default instead, which
 * keeps the console speaking.
 */
function voiceFor(wanted: string, voices: VoiceOption[]): string {
  const id = String(wanted ?? "").trim();
  if (id && (voices.some((v) => v.id === id) || (voices.length === 0 && id.startsWith("aura-")))) return id;
  return defaultDeepgramVoice();
}

/** What Deepgram says went wrong, in a sentence rather than a status code. */
function deepgramComplaint(status: number, raw: string): string {
  let detail = raw.slice(0, 200);
  try {
    const body = JSON.parse(raw);
    detail = String(body?.err_msg || body?.message || detail);
  } catch {
    // Not JSON: the text itself is the detail.
  }
  if (status === 401 || status === 403) {
    return `Deepgram refused the API key${detail ? ` (${detail})` : ""}.`;
  }
  return `Deepgram answered ${status}${detail ? `: ${detail}` : ""}.`;
}

async function deepgramStatus(prefer?: string): Promise<SpeechStatus> {
  const base: SpeechStatus = {
    available: false,
    provider: "deepgram",
    voice: voiceFor(prefer ?? "", []),
    voices: [],
    reason: null,
    url: DEEPGRAM_API,
  };
  const key = deepgramKey();
  if (!key) {
    return {
      ...base,
      provider: null,
      reason: "No voice service: paste a Deepgram API key in Settings, or set DEEPGRAM_API_KEY, and the hosted voices are used. Without one, the browser's own voice speaks.",
    };
  }
  try {
    const voices = await deepgramList(key);
    if (voices.length === 0) throw new Error("its voice list came back empty");
    return { ...base, available: true, voices, voice: voiceFor(prefer ?? "", voices) };
  } catch (err: any) {
    // A refused key or a rejected request is Deepgram answering, and says so;
    // only a throw that never got an answer is the service being unreachable.
    const why = err instanceof DeepgramError ? err.message : `Deepgram could not be reached: ${err?.message ?? err}`;
    return { ...base, reason: why };
  }
}

/**
 * Whether there is a voice service, which voice it will use, and what it can
 * do. The result is held for half a minute: the page asks on load and the
 * settings panel asks when it opens, and neither is worth two lookups.
 */
export async function speechStatus(refresh = false, prefer?: string): Promise<SpeechStatus> {
  if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    const held = cached.value;
    return prefer ? { ...held, voice: voiceFor(prefer, held.voices) } : held;
  }
  const value = await deepgramStatus(prefer);
  cached = { at: Date.now(), value };
  return value;
}

/** Forget what was cached -- after a settings change, or a key that changed. */
export function forgetSpeech(): void {
  cached = null;
  deepgramVoices = null;
}

export interface Utterance {
  audio: Uint8Array;
  contentType: string;
  /** What was rendered, for the log and the tests. */
  voice: string;
}

/**
 * One fragment of speech as an audio file.
 *
 * Throws with a sentence a person can read; the route turns it into a 503 and
 * the client falls back to the browser's voice. `speed` is passed through to
 * the service, only when it is sane.
 */
export async function speak(
  text: string,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" } = {},
): Promise<Utterance> {
  const input = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!input) throw new Error("Nothing to say.");
  if (input.length > MAX_CHARS) throw new Error(`Too long to speak (${input.length} characters).`);

  const status = await speechStatus();
  if (!status.available) throw new Error(status.reason ?? "No voice service is available.");

  return speakDeepgram(input, status, options);
}

/** One sentence through Deepgram's hosted voices. */
async function speakDeepgram(
  input: string,
  status: SpeechStatus,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" },
): Promise<Utterance> {
  const key = deepgramKey();
  if (!key) throw new Error("Deepgram needs an API key — set DEEPGRAM_API_KEY, or paste one in Settings.");
  // The id that arrives here can be one saved before this service replaced the
  // old local one (af_heart), or one from a panel left open across an upgrade.
  // Asking for a voice Deepgram has never heard of would fail the sentence;
  // the same fallback the status path uses keeps it speaking instead.
  const voice = voiceFor(
    String(options.voice ?? "").trim() || status.voice,
    deepgramVoices?.value ?? [],
  );
  const format = options.format ?? "mp3";

  const query = new URLSearchParams({ model: voice });
  if (format === "wav") {
    query.set("encoding", "linear16");
    query.set("container", "wav");
    query.set("sample_rate", "24000");
  }
  const speed = Number(options.speed);
  if (Number.isFinite(speed) && speed >= 0.7 && speed <= 1.5) query.set("speed", String(speed));

  const res = await fetch(`${DEEPGRAM_API}/v1/speak?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
      Accept: format === "wav" ? "audio/wav" : "audio/mpeg",
    },
    body: JSON.stringify({ text: input }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(deepgramComplaint(res.status, await res.text().catch(() => "")));
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength === 0) throw new Error("Deepgram returned an empty recording.");
  return {
    audio,
    contentType: res.headers.get("content-type") || (format === "wav" ? "audio/wav" : "audio/mpeg"),
    voice,
  };
}
