/**
 * The console's own voice, from a TTS server on the network rather than from
 * the browser.
 *
 * Until now the app spoke with `speechSynthesis`, which is whatever system
 * voice the platform happens to install -- a different one on every device,
 * and on most of them the worst one it has. Anyone already running a voice
 * server (Kokoro, whose FastAPI image speaks the OpenAI `/v1/audio/speech`
 * shape) should hear that voice instead: the same one on the phone, the
 * laptop and the desktop.
 *
 * The audio is fetched here rather than by the page, because the page cannot
 * reach it: the voice server sits on the same private Docker network as this
 * container, with no published port, and a browser on the tailnet has no
 * route to it. So the client asks this server for a sentence and gets an
 * audio file back, from the origin it already trusts.
 *
 * Everything is optional and nothing throws at the caller. If the address is
 * wrong or the server is down, `/api/speech` says so and the page falls back
 * to the browser's own voice -- exactly what it had before. Two environment
 * variables configure it, and neither is required:
 *
 *   AUTORA_KOKORO_URL    e.g. http://kokoro_web_1:8880 (the default, and the
 *                        name Kokoro's own Umbrel app answers to here)
 *   AUTORA_KOKORO_VOICE  the voice id, e.g. af_heart (the default)
 */

/** Where a voice server might be, most specific first. The first that answers
    /health is the one used for the rest of the process's life -- a container
    name is what an Umbrel app answers to, and the fallbacks cover a Kokoro
    installed by hand under its own name. */
const CANDIDATES = ["http://kokoro_web_1:8880", "http://kokoro:8880", "http://localhost:8880"];
const DEFAULT_VOICE = "af_heart";
/** Long enough that a health check is not run per sentence, short enough that
    starting the voice server is noticed while the person is still looking. */
const STATUS_TTL_MS = 30_000;
/** A sentence, not a document. The client sends spoken fragments; anything
    past this is a bug in the caller, and a 10,000-character request would
    occupy the TTS server for minutes. */
const MAX_CHARS = 2_000;

export interface VoiceOption {
  id: string;
  /** What to show in a picker: the id, and the voice's own quality grade when
      the server states one ("af_heart — A"). */
  label: string;
}

export interface SpeechStatus {
  /** False when no voice server answered: the page then uses the browser's. */
  available: boolean;
  /** The voice in use, whether it came from the environment, the settings
      file, or the server's own default. */
  voice: string;
  voices: VoiceOption[];
  /** Why it is unavailable, in words a settings panel can show. */
  reason: string | null;
  /** The address that answered, for the panel to say out loud. */
  url: string | null;
}

/** An address set from the settings panel wins over the environment, so the
    person can move the voice server without editing a compose file. */
let override: string | null = null;

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

/** The address in use, once one has answered. */
let resolved: string | null = null;
let cached: { at: number; value: SpeechStatus } | null = null;

async function getJson(url: string, ms: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
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
 * Whether there is a voice server, which voice it will use, and what it can
 * do. The result is held for half a minute: the page asks on load and the
 * settings panel asks when it opens, and neither is worth two health checks.
 */
export async function speechStatus(refresh = false, prefer?: string): Promise<SpeechStatus> {
  if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return prefer ? { ...cached.value, voice: prefer } : cached.value;
  }
  const base = await findServer();
  if (!base) {
    const value: SpeechStatus = {
      available: false,
      voice: prefer || defaultVoice(),
      voices: [],
      reason: configuredUrl()
        ? `No voice server answered at ${configuredUrl()}.`
        : "No voice server found — set AUTORA_KOKORO_URL to its address.",
      url: null,
    };
    cached = { at: Date.now(), value };
    return value;
  }
  try {
    const voices = await listVoices(base);
    const voice = prefer || defaultVoice();
    const value: SpeechStatus = {
      available: true,
      voice,
      voices,
      reason: null,
      url: base,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch (err: any) {
    const value: SpeechStatus = {
      available: false,
      voice: prefer || defaultVoice(),
      voices: [],
      reason: `The voice server at ${base} did not answer: ${err?.message ?? err}`,
      url: base,
    };
    cached = { at: Date.now(), value };
    return value;
  }
}

/** Forget what was cached -- after a settings change, or a server that moved. */
export function forgetSpeech(): void {
  resolved = null;
  cached = null;
}

export interface Utterance {
  audio: Uint8Array;
  contentType: string;
  /** What the server says it rendered, for the log and the tests. */
  voice: string;
}

/**
 * One fragment of speech as an audio file.
 *
 * Throws with a sentence a person can read; the route turns it into a 503 and
 * the client falls back to the browser's voice. `speed` is Kokoro's own
 * multiplier, passed through only when it is sane.
 */
export async function speak(
  text: string,
  options: { voice?: string; speed?: number; format?: "mp3" | "wav" } = {},
): Promise<Utterance> {
  const input = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!input) throw new Error("Nothing to say.");
  if (input.length > MAX_CHARS) throw new Error(`Too long to speak (${input.length} characters).`);

  const status = await speechStatus();
  if (!status.available || !status.url) throw new Error(status.reason ?? "No voice server is available.");

  const voice = (options.voice || "").trim() || status.voice || defaultVoice();
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
