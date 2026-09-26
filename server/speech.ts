/**
 * The console's own voice, from a text-to-speech service rather than from the
 * browser.
 *
 * Until now the app spoke with `speechSynthesis`, which is whatever system
 * voice the platform happens to install -- a different one on every device,
 * and on most of them the worst one it has. Two ways out, and the app picks
 * between them on its own:
 *
 *  - Deepgram's hosted Aura voices, used whenever there is a key for them
 *    (DEEPGRAM_API_KEY in the environment, or one pasted into Settings). There
 *    is nothing to run: one HTTPS request a sentence, and the same voice on
 *    the phone, the laptop and the desktop.
 *  - A Kokoro server (its FastAPI image speaks the OpenAI `/v1/audio/speech`
 *    shape) found on the private Docker network by name. Kept because someone
 *    is already running one, and it costs nothing to prefer it when asked for.
 *
 * The audio is fetched here rather than by the page, because the page cannot
 * reach a Kokoro container: it sits on the same private Docker network as this
 * one, with no published port, and a browser on the tailnet has no route to
 * it. Going through this origin also means the audio arrives from the one the
 * page already trusts. For Deepgram the same route is kept so that the key
 * never has to reach the browser.
 *
 * Everything is optional and nothing throws at the caller. If there is no key
 * and no server, `/api/speech` says so and the page falls back to the
 * browser's own voice -- exactly what it had before. The environment:
 *
 *   AUTORA_TTS_PROVIDER   "deepgram" or "kokoro" to force one (default: auto,
 *                         which means Deepgram when a key is set, Kokoro when
 *                         one is not)
 *   AUTORA_DEEPGRAM_VOICE the Deepgram voice to start with (aura-2-thalia-en)
 *   AUTORA_KOKORO_URL     the Kokoro server to use instead of the ones found
 *                         by name (http://kokoro_web_1:8880, then
 *                         http://kokoro:8880, then http://localhost:8880)
 *   AUTORA_KOKORO_VOICE   the Kokoro voice to start with (af_heart)
 */
import { secretFor } from "./state";

/** Where the hosted voices are, and where the key is sent. */
const DEEPGRAM_API = "https://api.deepgram.com";
/** Aura-2, the current generation: the ones that do not read like a machine.
    Aura-1 voices are still listed, and still work, if one is wanted. */
const DEFAULT_DEEPGRAM_VOICE = "aura-2-thalia-en";

/** Where a Kokoro server might be, most specific first. The first that answers
    /health is the one used for the rest of the process's life -- a container
    name is what an Umbrel app answers to, and the fallbacks cover a Kokoro
    installed by hand under its own name. */
const CANDIDATES = ["http://kokoro_web_1:8880", "http://kokoro:8880", "http://localhost:8880"];
const DEFAULT_VOICE = "af_heart";
/** Long enough that a health check is not run per sentence, short enough that
    starting the voice server is noticed while the person is still looking. */
const STATUS_TTL_MS = 30_000;
/** Deepgram's voice list is static and comes from a service we do not run, so
    it is held far longer than a health check is. */
const VOICES_TTL_MS = 10 * 60_000;
/** A sentence, not a document. The client sends spoken fragments; anything
    past this is a bug in the caller, and a 10,000-character request would
    occupy the TTS server for minutes. */
const MAX_CHARS = 2_000;

/** Which service speaks: Deepgram's hosted voices, or a server on the network. */
export type SpeechProvider = "deepgram" | "kokoro";

export interface VoiceOption {
  id: string;
  /** What to show in a picker: the name a person reads, and where that voice
      is from ("Thalia — American"). Kokoro states no such thing, so there it
      stays the id, with its quality grade when the server gives one. */
  label: string;
}

export interface SpeechStatus {
  /** False when there is no service to speak through: the page then uses the
      browser's own voice. */
  available: boolean;
  /** Which service would speak, even when it cannot right now -- so that a
      settings panel can say "Deepgram, and its key was refused" rather than
      "no voice". Null only when nothing is configured at all. */
  provider: SpeechProvider | null;
  /** The voice in use, whether it came from the environment, the settings
      file, or the service's own default. */
  voice: string;
  voices: VoiceOption[];
  /** Why it is unavailable, in words a settings panel can show. */
  reason: string | null;
  /** The service behind it, for the panel to say out loud. */
  url: string | null;
}

/** A service named from the settings panel wins over the environment, so the
    person can change their mind without editing a compose file. */
let providerOverride: "" | SpeechProvider = "";

/** An address set from the settings panel wins over the environment, so the
    person can move the voice server without editing a compose file. */
let override: string | null = null;

function parseProvider(name: unknown): "" | SpeechProvider {
  const wanted = String(name ?? "").trim().toLowerCase();
  return wanted === "deepgram" || wanted === "kokoro" ? wanted : "";
}

export function setSpeechProvider(name: string): void {
  const next = parseProvider(name);
  if (next === providerOverride) return;
  providerOverride = next;
  forgetSpeech();
}

/** The service chosen on purpose, if any: the panel first, then the
    environment, then nothing (which means "decide for me"). */
export function configuredProvider(): "" | SpeechProvider {
  return providerOverride || parseProvider(process.env.AUTORA_TTS_PROVIDER);
}

export function setSpeechUrl(url: string): void {
  const next = String(url ?? "").trim().replace(/\/+$/, "");
  if (next === (override ?? "")) return;
  override = next || null;
  forgetSpeech();
}

export function configuredUrl(): string {
  return override ?? (process.env.AUTORA_KOKORO_URL || "").trim().replace(/\/+$/, "");
}

export function defaultVoice(): string {
  return (process.env.AUTORA_KOKORO_VOICE || "").trim() || DEFAULT_VOICE;
}

export function defaultDeepgramVoice(): string {
  return (process.env.AUTORA_DEEPGRAM_VOICE || "").trim() || DEFAULT_DEEPGRAM_VOICE;
}

/** The key to speak through Deepgram with: the one pasted into the app first,
    then the environment, the way every other key here is found. */
function deepgramKey(): string {
  return secretFor("DEEPGRAM_API_KEY");
}

/** Which service to speak through. A choice made on purpose is honoured as
    given -- if its key is missing the reason says so, which is more use than
    silently speaking through something else. Left to itself: Deepgram when
    there is a key for it, a Kokoro server on the network when there is not. */
function chosenProvider(): SpeechProvider {
  return configuredProvider() || (deepgramKey() ? "deepgram" : "kokoro");
}

/** The address in use, once one has answered. */
let resolved: string | null = null;
let cached: { at: number; value: SpeechStatus } | null = null;
let deepgramVoices: { at: number; value: VoiceOption[] } | null = null;

async function getJson(url: string, ms: number, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

/** Which of the candidate addresses answers, if any. Cached once found. */
async function findServer(): Promise<string | null> {
  const explicit = configuredUrl();
  if (explicit) return explicit; // A configured address is used as given.
  if (resolved) return resolved;
  for (const candidate of CANDIDATES) {
    try {
      const health = await getJson(`${candidate}/health`, 2_500);
      if (health?.status === "healthy" || health?.status === "ok") {
        resolved = candidate;
        return candidate;
      }
    } catch {
      // Not this one. Try the next.
    }
  }
  return null;
}

/** The voice list, minus the bookkeeping the server keeps about each one. */
async function listVoices(base: string): Promise<VoiceOption[]> {
  const body = await getJson(`${base}/v1/audio/voices`, 5_000);
  const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.voices) ? body.voices : [];
  return rows
    .map((row) => {
      const id = String(row?.id ?? row?.name ?? "").trim();
      const grade = String(row?.overall_grade ?? "").trim();
      return id ? { id, label: grade ? `${id} — ${grade}` : id } : null;
    })
    .filter(Boolean) as VoiceOption[];
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
 * The voice to use, given what is wanted and what the service offers.
 *
 * Kokoro is taken at its word: a voice id it has never heard of is passed on
 * and refused there, which is a message the panel can show. Deepgram is not,
 * because the id saved by the install this replaced -- `af_heart` -- would
 * come back as "Invalid 'model' value" on every sentence; an unheard-of voice
 * there falls back to the default instead.
 */
function voiceFor(wanted: string, provider: SpeechProvider, voices: VoiceOption[]): string {
  const id = String(wanted ?? "").trim();
  if (provider === "deepgram") {
    if (id && (voices.some((v) => v.id === id) || (voices.length === 0 && id.startsWith("aura-")))) return id;
    return defaultDeepgramVoice();
  }
  return id || defaultVoice();
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
    voice: voiceFor(prefer ?? "", "deepgram", []),
    voices: [],
    reason: null,
    url: DEEPGRAM_API,
  };
  const key = deepgramKey();
  if (!key) {
    return { ...base, reason: "Deepgram is selected but has no API key — set DEEPGRAM_API_KEY, or paste one in Settings." };
  }
  try {
    const voices = await deepgramList(key);
    if (voices.length === 0) throw new Error("its voice list came back empty");
    return { ...base, available: true, voices, voice: voiceFor(prefer ?? "", "deepgram", voices) };
  } catch (err: any) {
    return { ...base, reason: `Deepgram could not be reached: ${err?.message ?? err}` };
  }
}

async function kokoroStatus(prefer?: string): Promise<SpeechStatus> {
  const chosen = configuredProvider();
  const base: SpeechStatus = {
    available: false,
    provider: chosen === "kokoro" ? "kokoro" : null,
    voice: prefer || defaultVoice(),
    voices: [],
    reason: configuredUrl()
      ? `No voice server answered at ${configuredUrl()}.`
      : chosen === "kokoro"
        ? "No voice server found — set AUTORA_KOKORO_URL to its address."
        : "No voice server found, and no Deepgram key: set AUTORA_KOKORO_URL to a voice server's address, or DEEPGRAM_API_KEY to use Deepgram's voices.",
    url: null,
  };
  const found = await findServer();
  if (!found) return base;
  try {
    const voices = await listVoices(found);
    return {
      available: true,
      provider: "kokoro",
      voice: prefer || defaultVoice(),
      voices,
      reason: null,
      url: found,
    };
  } catch (err: any) {
    return {
      ...base,
      reason: `The voice server at ${found} did not answer: ${err?.message ?? err}`,
      url: found,
    };
  }
}

/**
 * Whether there is a voice service, which one, which voice it will use, and
 * what it can do. The result is held for half a minute: the page asks on load
 * and the settings panel asks when it opens, and neither is worth two lookups.
 */
export async function speechStatus(refresh = false, prefer?: string): Promise<SpeechStatus> {
  if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    const held = cached.value;
    return prefer ? { ...held, voice: voiceFor(prefer, held.provider ?? "kokoro", held.voices) } : held;
  }
  const provider = chosenProvider();
  const value = provider === "deepgram" ? await deepgramStatus(prefer) : await kokoroStatus(prefer);
  cached = { at: Date.now(), value };
  return value;
}

/** Forget what was cached -- after a settings change, or a server that moved. */
export function forgetSpeech(): void {
  resolved = null;
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
 * whichever service is speaking, only when it is sane.
 */
export async function speak(
  text: string,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" } = {},
): Promise<Utterance> {
  const input = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!input) throw new Error("Nothing to say.");
  if (input.length > MAX_CHARS) throw new Error(`Too long to speak (${input.length} characters).`);

  const status = await speechStatus();
  if (!status.available || !status.provider) throw new Error(status.reason ?? "No voice service is available.");

  return status.provider === "deepgram"
    ? speakDeepgram(input, status, options)
    : speakKokoro(input, status, options);
}

/** One sentence through Deepgram's hosted voices. */
async function speakDeepgram(
  input: string,
  status: SpeechStatus,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" },
): Promise<Utterance> {
  const key = deepgramKey();
  if (!key) throw new Error("Deepgram needs an API key — set DEEPGRAM_API_KEY, or paste one in Settings.");
  // The id that arrives here can be one saved before this provider existed
  // (af_heart), or one from a panel left open across an upgrade. Asking for a
  // voice Deepgram has never heard of would fail the sentence; the same
  // fallback the status path uses keeps it speaking instead.
  const voice = voiceFor(
    String(options.voice ?? "").trim() || status.voice,
    "deepgram",
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

/** One sentence through a Kokoro server on the private network. */
async function speakKokoro(
  input: string,
  status: SpeechStatus,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" },
): Promise<Utterance> {
  const voice = String(options.voice ?? "").trim() || status.voice || defaultVoice();
  const format = options.format ?? "mp3";
  const speed = Number(options.speed);
  const body: Record<string, unknown> = {
    model: "kokoro",
    input,
    voice,
    response_format: format,
  };
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) body.speed = speed;

  const res = await fetch(`${status.url}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`The voice server answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength === 0) throw new Error("The voice server returned an empty recording.");
  return {
    audio,
    contentType: res.headers.get("content-type") || (format === "wav" ? "audio/wav" : "audio/mpeg"),
    voice,
  };
}
