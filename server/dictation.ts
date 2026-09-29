/**
 * Listening, from Deepgram's live speech-to-text service.
 *
 * Why the console no longer just uses the browser's recogniser. On Android the
 * Web Speech API is not a browser feature at all: it is a session handed to
 * Google's speech service, which plays its own microphone cue when that session
 * opens and again when it closes. A recogniser cannot be kept open -- it ends
 * on its own after every silence and after most phrases, and the only way to go
 * on listening is to start the next one. So every re-arm is another cue from
 * the phone, every few seconds, for as long as talk mode lasts. It was the
 * single most annoying thing about talking to this app, and nothing on the page
 * could stop it: the sound is not ours to make or to mute.
 *
 * The fix is to stop re-arming. With a Deepgram key the microphone is opened
 * once, when talk mode starts, and one stream of raw PCM runs to Deepgram for
 * as long as it lasts -- no session to end, no restart, no cue. The audio is
 * only ever what the local machine sends to Deepgram, the same service that
 * already speaks for the app; the key stays on this side, as it does for the
 * voice, and a page is never handed it.
 *
 * The browser's recogniser is still there for an install with no key, and is
 * what this falls back to: dictationAvailable() is what the page asks before
 * choosing, and everything here is optional and nothing throws at the caller.
 *
 * The environment:
 *
 *   AUTORA_DEEPGRAM_STT_MODEL  the model to listen with (nova-2)
 *   AUTORA_DEEPGRAM_STT_LANG   the language to assume (en-US)
 */
import { WebSocket as Upstream } from "ws";
import type { WebSocket } from "ws";
import { secretFor } from "./state";

const DEEPGRAM_LIVE = "wss://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-2";
const DEFAULT_LANG = "en-US";

/** A PCM rate we are willing to hand Deepgram: the page sends its own audio
    context's rate, and anything outside this is a client we do not believe. */
const MIN_RATE = 8000;
const MAX_RATE = 48000;
const DEFAULT_RATE = 16000;

/** One audio chunk. 128 KB is four seconds of 16 kHz mono PCM -- far past any
    honest frame, and a bound on what one message can cost. */
const MAX_FRAME_BYTES = 128 * 1024;

/** How long to wait for Deepgram to accept the socket before saying so. */
const OPEN_TIMEOUT_MS = 10_000;

/** What the page asks before it opens a microphone this way. */
export interface DictationStatus {
  available: boolean;
  provider: "deepgram" | null;
  reason: string | null;
}

export function deepgramKey(): string {
  return secretFor("DEEPGRAM_API_KEY");
}

export function dictationStatus(): DictationStatus {
  const key = deepgramKey();
  return {
    available: Boolean(key),
    provider: key ? "deepgram" : null,
    reason: key
      ? null
      : "No listening service: paste a Deepgram API key in Settings, or set DEEPGRAM_API_KEY, and the microphone is opened once for talk mode instead of the browser's own recogniser.",
  };
}

function model(): string {
  return (process.env.AUTORA_DEEPGRAM_STT_MODEL || "").trim() || DEFAULT_MODEL;
}

/** The language to transcribe, from the page where it gave one. Only a plain
    tag is passed on: this is a query parameter on somebody else's URL. */
function language(asked?: string): string {
  const wanted = (asked || "").trim() || (process.env.AUTORA_DEEPGRAM_STT_LANG || "").trim() || DEFAULT_LANG;
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(wanted) ? wanted : DEFAULT_LANG;
}

function rate(asked?: string): number {
  const value = Number(asked);
  if (!Number.isFinite(value)) return DEFAULT_RATE;
  const whole = Math.round(value);
  if (whole < MIN_RATE || whole > MAX_RATE) return DEFAULT_RATE;
  return whole;
}

/**
 * The URL to listen on, and the one thing in it worth arguing about: the name.
 *
 * The page has a whole list of spellings the recogniser produces for "Autora"
 * -- aurora, atora, a tora -- because the wake word is the entire way into a
 * spoken turn and it was being missed. Deepgram takes hints instead, so the
 * name is put to it up front and comes back spelled the one way that is asked
 * for here. The parameter has two names depending on the model, which is the
 * only reason this is a function rather than a constant.
 */
function liveUrl(asked: { rate?: string; lang?: string }): string {
  const chosen = model();
  const query = new URLSearchParams({
    model: chosen,
    language: language(asked.lang),
    encoding: "linear16",
    sample_rate: String(rate(asked.rate)),
    channels: "1",
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
    /* How much silence ends a phrase. Short enough that a caption keeps up,
       long enough not to cut a sentence in half at a breath. */
    endpointing: "500",
    /* Told when speech starts, so the bar can show it is hearing something
       without waiting for words. */
    vad_events: "true",
  });
  if (/^nova-3/.test(chosen)) query.set("keyterm", "Autora");
  else if (/^nova-[12]|^enhanced|^base|^general/.test(chosen)) query.set("keywords", "Autora:2");
  return `${DEEPGRAM_LIVE}?${query.toString()}`;
}

/** What Deepgram sends that is worth passing on, and nothing else. */
type Heard = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
};

/**
 * Listen through one page's socket, from the moment it connects to the moment
 * it closes.
 *
 * The page sends audio and nothing else; this sends words and nothing else. The
 * upstream socket is closed whenever either end goes, so a page that is closed
 * mid-sentence cannot leave a microphone being billed for.
 */
export function attachDictation(ws: WebSocket, asked: { rate?: string; lang?: string }): void {
  const key = deepgramKey();
  const tell = (message: Record<string, unknown>) => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    } catch {
      // A socket that has gone is not a reason to throw in a close handler.
    }
  };
  if (!key) {
    tell({ type: "error", detail: "No listening service: paste a Deepgram API key in Settings." });
    ws.close();
    return;
  }

  let upstream: Upstream;
  try {
    upstream = new Upstream(liveUrl(asked), { headers: { Authorization: `Token ${key}` } });
  } catch (err: any) {
    tell({ type: "error", detail: `Could not reach the listening service: ${String(err?.message ?? err)}` });
    ws.close();
    return;
  }

  let ready = false;
  let finished = false;
  const timer = setTimeout(() => {
    if (ready) return;
    tell({ type: "error", detail: "The listening service did not answer." });
    finish();
  }, OPEN_TIMEOUT_MS);

  function finish(): void {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try {
      upstream.close();
    } catch {
      // Already closed.
    }
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  upstream.on("open", () => {
    ready = true;
    clearTimeout(timer);
    tell({ type: "ready" });
  });

  upstream.on("message", (raw: Buffer | string) => {
    let said: Heard;
    try {
      said = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Heard;
    } catch {
      return;
    }
    if (said.type === "SpeechStarted") {
      tell({ type: "speaking" });
      return;
    }
    if (said.type !== "Results") return;
    const text = (said.channel?.alternatives?.[0]?.transcript ?? "").trim();
    /* An empty final is the silence between phrases being closed off. It is
       not a phrase, and sending it would end the caller's turn on a pause. */
    if (!text) return;
    tell({ type: "text", text, final: said.is_final === true });
  });

  upstream.on("error", (err: Error) => {
    tell({ type: "error", detail: `The listening service refused the connection: ${String(err?.message ?? err)}` });
    finish();
  });

  upstream.on("close", () => {
    // Said before the close so the page can tell a finished stream from a lost
    // one, and fall back to its own recogniser only when the key was refused.
    tell({ type: "closed" });
    finish();
  });

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      /* The one thing a page may say in words: it has stopped. Everything
         else is audio, and audio is the only thing Deepgram is sent. */
      if (data.toString("utf8").trim() === "close") finish();
      return;
    }
    if (!ready) return;
    if (!data || data.length > MAX_FRAME_BYTES) return;
    try {
      upstream.send(data, { binary: true });
    } catch {
      finish();
    }
  });

  ws.on("close", () => {
    /* Closing the stream politely lets Deepgram settle the phrase in hand, so
       the last thing said is not lost to the way the page was left. */
    try {
      if (ready && upstream.readyState === upstream.OPEN) upstream.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      // Going anyway.
    }
    setTimeout(finish, 250);
  });

  ws.on("error", () => finish());
}
