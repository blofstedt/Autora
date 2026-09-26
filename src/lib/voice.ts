/**
 * Speaking to the app, and the app speaking back.
 *
 * Words in are the browser's own speech stack: SpeechRecognition, with all
 * its unevenness. Words out are the console's own voice when it has one --
 * a TTS server on the network, fetched as audio from this origin (see
 * server/speech.ts) -- and speechSynthesis when it has not. The voice loop
 * that ships with the CLI
 * (`src/autora/voice/`) opens the *host* machine's microphone through
 * sounddevice: the right thing on the desktop you are sitting at, and no use
 * at all from a phone on the other side of the house, which is the case this
 * file exists for. Nothing here talks to the server.
 *
 * Support is uneven and that is designed for rather than papered over: Chrome
 * and Safari have recognition (Safari behind the webkit prefix, and it hangs
 * up after every phrase, so the loop restarts itself); Firefox has none, and
 * the buttons that depend on it simply do not render.
 */
import { useCallback, useEffect, useRef, useState } from "react";

// -- the shape of the API, which is not in lib.dom ---------------------------

type Alternative = { transcript: string; confidence: number };
type Phrase = { isFinal: boolean; length: number; [index: number]: Alternative };
type PhraseList = { length: number; [index: number]: Phrase };
type ResultEvent = { resultIndex: number; results: PhraseList };
type ErrorEvent_ = { error: string };

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: ErrorEvent_) => void) | null;
  onend: (() => void) | null;
  /* The chain between "started" and "heard a word", which is where this goes
     wrong silently. Each one that fires narrows the fault: audio reaching the
     engine, sound in that audio, speech in that sound. */
  onaudiostart: (() => void) | null;
  onsoundstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onaudioend: (() => void) | null;
}

const Impl: (new () => Recognition) | undefined =
  typeof window === "undefined"
    ? undefined
    : (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

/**
 * Whether the page is allowed to touch a microphone at all.
 *
 * Capture is a "powerful feature", so browsers gate it on a secure context:
 * https, or localhost. Reaching a machine over a LAN or a tailnet by name on
 * plain http is *not* one, however private the network is -- and the failure is
 * worth naming, because the constructor still exists there. Starting it fails
 * with `not-allowed`, which reads as a permission the user refused and sends
 * them to site settings, where there is nothing to fix.
 */
export const secureOrigin =
  typeof window === "undefined" ? true : window.isSecureContext;

/** Whether the browser has a recognition engine at all, secure page or not.
 *
 * Kept apart from `dictationSupported` because the two failures want opposite
 * treatment. Firefox has no engine, so there is nothing to offer and nothing
 * the reader could do about it -- those buttons stay hidden. An http page in
 * Chrome or Safari has the engine and lacks only a secure origin, which *is*
 * fixable, and hiding the button there is what made voice look unimplemented
 * rather than unreachable. */
export const recognitionAvailable = !!Impl;

/** The raw constructor, for the diagnostic to drive without this hook in the
    way. Whether the fault is the browser or this file is the first thing worth
    knowing, and it cannot be answered through an abstraction that might be
    causing it. */
export function speechEngine(): (new () => Recognition) | undefined {
  return Impl;
}

export const dictationSupported = recognitionAvailable && secureOrigin;
export const speechSupported =
  typeof window !== "undefined" && "speechSynthesis" in window;

/** Safari ends the session after each phrase; restarting is how you get
    continuous listening. A cap keeps a permanently failing engine from
    becoming a restart loop that pins a phone's battery. */
const MAX_RESTARTS = 40;
const RESTART_MS = 220;

const BLOCKED = secureOrigin
  ? "Microphone blocked. Allow it in your browser's site settings."
  : "Voice needs an https page — site settings cannot unblock this.";

const MESSAGES: Record<string, string> = {
  "not-allowed": BLOCKED,
  "service-not-allowed": BLOCKED,
  "audio-capture": "No microphone found.",
  network: "Speech service unreachable.",
};

// -- words in ----------------------------------------------------------------

const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** A word with the punctuation an engine sprinkles on a final taken off, so
    that "test" and "test." compare as the same word. */
const EDGES = /^["'“”‘’([]+|[.,!?;:"'“”‘’)\]…]+$/g;
const bare = (word: string): string => word.toLowerCase().replace(EDGES, "");

/**
 * What has already been handed over in one run of the microphone.
 *
 * `last` is the longest hypothesis handed over for the utterance in hand, in
 * bare words; `at` is when it was committed. Kept per run rather than per
 * engine result index, and that is the whole fix for the repeats.
 *
 * The earlier version kept a watermark per result index, on the reading that
 * each index is one phrase. The Android recogniser does not keep to that: it
 * opens a *new* index for every step of the same utterance, each one holding
 * the whole utterance so far and each one final -- "this", "this is",
 * "this is a", "this is a test". A fresh index had no watermark, so every step
 * went out whole and the composer filled with a staircase: "this this is this
 * is a this is a test". Comparing against the last thing handed over, whatever
 * index it came from, catches that and the restart replays alike.
 */
export type Ledger = { last: string[]; at: number };

export const newLedger = (): Ledger => ({ last: [], at: 0 });

/** How long after a commit a result that restates it is taken as the engine
    repeating itself rather than you saying the same words again. Android's
    steps arrive a few hundred milliseconds apart, a restart replay within a
    second or two; saying "yes" twice takes longer than this to matter. */
const REPLAY_MS = 4000;

/** How long after a commit a result that agrees on all but the last word is
    taken as the engine changing its mind about that word. Short, because
    "Open the file" followed by "Open the folder" is two requests, and saying
    the second one takes longer than this. */
const REVISE_MS = 1500;

/**
 * The part of `text` not already handed over, given what the ledger holds.
 *
 * - A restatement of what went out, or a shorter version of it (the engine
 *   walking a word back), contributes nothing.
 * - A longer version of what went out contributes only the new tail.
 * - A version that agrees on everything but the last word, arriving right
 *   away, is a revision: only what follows the agreement goes out.
 * - Anything else is a new phrase and goes out whole.
 */
export function unsaid(ledger: Ledger, text: string, now: number): string {
  const said = words(text);
  const heard = said.map(bare);
  const last = ledger.last;
  const since = now - ledger.at;
  let same = 0;
  while (same < last.length && same < heard.length && last[same] === heard[same]) same += 1;
  if (last.length > 0 && since < REPLAY_MS) {
    if (same === heard.length) return "";
    if (same === last.length) return said.slice(same).join(" ");
  }
  if (same >= 2 && same >= last.length - 1 && since < REVISE_MS) {
    return said.slice(same).join(" ");
  }
  return said.join(" ");
}

/** Hand `text` over: returns the part that is new and moves the ledger up.
    A shorter restatement never lowers it, or the words in between would go
    out a second time. */
export function commit(ledger: Ledger, text: string, now: number): string {
  const fresh = unsaid(ledger, text, now);
  const heard = words(text).map(bare);
  const shorter = fresh === "" && heard.length <= ledger.last.length;
  if (!shorter) ledger.last = heard;
  ledger.at = now;
  return fresh;
}

/** Words that leave a sentence hanging: a pause after one of these is you
    thinking, not you finishing. */
const HANGING = new Set([
  "and", "or", "but", "so", "because", "cause", "then", "if", "when", "while",
  "that", "which", "who", "the", "a", "an", "to", "of", "for", "with", "in",
  "on", "at", "from", "into", "about", "my", "your", "our", "their", "this",
  "is", "are", "was", "be", "can", "could", "should", "would", "will", "please",
  "um", "uh", "er", "erm", "hmm", "like", "maybe", "also", "just",
]);

/**
 * How long live chat waits in silence before it sends what you said.
 *
 * It used to be about a second, which is shorter than the breath people take
 * mid-sentence, so live mode kept answering half a thought. A settled phrase
 * (the engine decided you stopped) waits two seconds; an unsettled one, which
 * is all Chrome for Android ever gives, waits longer; and a phrase that ends on
 * "and", "the", "um" or a comma waits longer still, because nobody ends there.
 */
export function turnPause(text: string, settled: boolean): number {
  const base = settled ? 2000 : 2800;
  const trimmed = text.trim();
  if (!trimmed) return base;
  if (/,$/.test(trimmed)) return base + 1500;
  const last = trimmed.split(/\s+/).pop()!.toLowerCase().replace(/[^a-z']/g, "");
  return HANGING.has(last) ? base + 1500 : base;
}

export type Dictation = {
  supported: boolean;
  listening: boolean;
  /** The phrase in flight, before the engine settles on it. */
  interim: string;
  error: string | null;
  /** Microphone loudness, 0..1, for anything that wants to move with a voice. */
  level: number;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  /** Mark everything heard so far as handed over, for a caller that acted on
      an unsettled phrase rather than waiting for the engine to settle it. */
  accept: () => void;
};

export function useDictation({
  onPhrase,
  continuous = false,
  lang,
}: {
  /** A settled phrase. Called once per utterance the engine commits to. */
  onPhrase?: (text: string) => void;
  /** Keep listening across phrases, rather than stopping after the first. */
  continuous?: boolean;
  lang?: string;
} = {}): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const recognition = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const restarts = useRef(0);
  const phraseRef = useRef(onPhrase);
  phraseRef.current = onPhrase;

  /** What this run has handed over -- see `Ledger`. A ref, because it is
      read inside engine callbacks that close over whatever render created
      them, and it deliberately outlives engine restarts: Safari hangs up after
      every phrase, every engine does after a silence, and a restart that lands
      mid-utterance re-reports the whole of it. */
  const ledger = useRef<Ledger>(newLedger());

  /** The latest text for each result in the session in hand, settled or not,
      so a caller that acted on an unsettled phrase can mark it spent. */
  const heard = useRef<Map<number, string>>(new Map());

  /**
   * Treat everything the engine has produced so far as already handed over.
   *
   * For callers that cannot wait for `isFinal`. Live chat is one: Chrome on
   * Android will stream a whole sentence as interim results and never settle
   * on any of it, so a pause has to be enough to send. The engine keeps that
   * result open though, and its eventual final still holds the words that
   * were sent -- without this they would go out a second time.
   */
  const accept = useCallback(() => {
    const now = Date.now();
    [...heard.current.keys()].sort((x, y) => x - y)
      .forEach((index) => commit(ledger.current, heard.current.get(index) ?? "", now));
    setInterim("");
  }, []);

  /** Decays on a timer, bumped whenever the engine reports hearing something.
   *
   * This used to be a real analyser: a second `getUserMedia` stream, an
   * AudioContext, an honest RMS of your actual voice. It had to go, and the
   * reason is worth writing down because the meter is the more attractive
   * design and it does not work.
   *
   * On Android the speech engine is a separate system service with its own
   * claim on the microphone. Holding a second capture stream open beside it
   * does not fail -- it starves it. Recognition starts, reports no error,
   * fires `onstart`, and then simply never returns a phrase. Meanwhile the
   * analyser has the audio and the ring moves beautifully, so the interface
   * says "listening" with total confidence while the thing that transcribes is
   * deaf. That failure is indistinguishable from dictation not being
   * implemented, and it cost a long evening to find.
   *
   * So the level follows the engine rather than the microphone. It rises when
   * a phrase lands and falls when nothing is arriving, which is what it was
   * being read for anyway.
   */
  const decay = useRef(0);

  const bump = useCallback(() => {
    setLevel(0.8);
    window.clearInterval(decay.current);
    decay.current = window.setInterval(() => {
      setLevel((current) => {
        const next = current - 0.08;
        if (next <= 0.05) {
          window.clearInterval(decay.current);
          return 0.05;
        }
        return next;
      });
    }, 90);
  }, []);

  const settle = useCallback(() => {
    window.clearInterval(decay.current);
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    wanted.current = false;
    restarts.current = 0;
    setInterim("");
    settle();
    try {
      recognition.current?.stop();
    } catch {
      // Stopping something that never started is not an error worth surfacing.
    }
  }, [settle]);

  const start = useCallback(() => {
    if (!Impl || wanted.current) return;
    wanted.current = true;
    restarts.current = 0;
    // A run the reader asked for, rather than a restart: nothing said before
    // it has any claim on what gets handed over now.
    ledger.current = newLedger();
    setError(null);

    const engine = new Impl();
    recognition.current = engine;
    engine.lang = lang ?? navigator.language ?? "en-US";
    engine.continuous = continuous;
    engine.interimResults = true;
    engine.maxAlternatives = 1;

    engine.onstart = () => {
      // A new session numbers its results from zero again. The ledger is
      // deliberately kept -- see above.
      heard.current.clear();
      setListening(true);
    };

    engine.onresult = (event) => {
      const now = Date.now();
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const phrase = event.results[i];
        const text = (phrase[0]?.transcript ?? "").trim();
        heard.current.set(i, text);
        if (phrase.isFinal) {
          const fresh = commit(ledger.current, text, now);
          if (fresh) phraseRef.current?.(fresh);
          // A phrase landing means the engine is healthy, whatever it had to
          // restart through to get here.
          restarts.current = 0;
        } else {
          // An interim that repeats words already sent is the same double as
          // a final that does, and captioning it back is how it looks.
          const fresh = unsaid(ledger.current, text, now);
          if (fresh) live = live ? `${live} ${fresh}` : fresh;
        }
      }
      setInterim(live.trim());
      // Anything at all coming back means the engine is hearing you, which is
      // the one thing the ring is there to say.
      bump();
    };

    engine.onerror = (event) => {
      if (event.error === "aborted") return;
      // Silence between phrases is not a failure; the restart in onend covers
      // it and saying so would flash an error every time someone pauses.
      if (event.error === "no-speech") return;
      setError(MESSAGES[event.error] ?? `Speech input failed (${event.error}).`);
      wanted.current = false;
    };

    engine.onend = () => {
      // An engine stopped and replaced by a fresh start -- hold-to-talk pressed
      // again before the last one closed -- must not restart itself beside it.
      if (recognition.current !== engine) return;
      setInterim("");
      if (wanted.current && restarts.current < MAX_RESTARTS) {
        restarts.current += 1;
        window.setTimeout(() => {
          if (!wanted.current) return;
          try {
            engine.start();
          } catch {
            // Already running: the end we were told about had a start behind it.
          }
        }, RESTART_MS);
        return;
      }
      if (wanted.current) setError("Speech input keeps dropping out.");
      wanted.current = false;
      setListening(false);
      settle();
    };

    try {
      engine.start();
    } catch {
      wanted.current = false;
      setError("Could not start the microphone.");
    }
  }, [bump, continuous, lang, settle]);

  const toggle = useCallback(() => {
    if (wanted.current) stop();
    else start();
  }, [start, stop]);

  // A page that navigates away mid-phrase leaves the microphone light on.
  useEffect(() => () => {
    wanted.current = false;
    try {
      recognition.current?.abort();
    } catch {
      // Nothing to abort.
    }
    window.clearInterval(decay.current);
  }, []);

  return {
    supported: dictationSupported,
    listening,
    interim,
    error,
    level,
    start,
    stop,
    toggle,
    accept,
  };
}

// -- words out ---------------------------------------------------------------

/** Voices load asynchronously in Chrome, and the good ones are not first. */
function pickVoice(): SpeechSynthesisVoice | null {
  if (!speechSupported) return null;
  const voices = speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  const language = (navigator.language || "en-US").toLowerCase();
  const base = language.split("-")[0];
  const spoken = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = spoken.length > 0 ? spoken : voices;
  // Apple's Siri voices and Google's network voices are markedly better than
  // the default each platform hands out.
  const preferred = pool.find((v) => /siri|natural|neural|google/i.test(v.name));
  return preferred ?? pool.find((v) => v.lang.toLowerCase() === language) ?? pool[0];
}

export type SpeechSource = "server" | "browser";

/** What the console says about its own voice, from GET /api/speech. */
export type SpeechStatus = {
  /** False when there is no voice service: the browser's voice is used. */
  available: boolean;
  /** Which service speaks: Deepgram's hosted voices, or a Kokoro server. */
  provider?: "deepgram" | "kokoro" | null;
  /** What was chosen in Config: "", "deepgram" or "kokoro". "" is automatic. */
  choice?: string;
  voice: string;
  voices: { id: string; label: string }[];
  reason: string | null;
  url: string | null;
  /** The address set in Config, "" when the server is found by name. */
  configured?: string;
};

/** Ask the console which voice it has, if any. Null when it cannot be asked. */
export async function fetchSpeechStatus(): Promise<SpeechStatus | null> {
  try {
    const res = await fetch("/api/speech");
    if (!res.ok) return null;
    return (await res.json()) as SpeechStatus;
  } catch {
    return null;
  }
}

/** Save a chosen voice, so it follows you between devices. */
export async function chooseVoice(voice: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speech: { voice } }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, detail: body?.detail ?? `The console refused that voice (${res.status}).` };
  } catch {
    return { ok: false, detail: "The console could not be reached." };
  }
}

/** Choose the voice service: "deepgram", "kokoro", or "" to let the console
    decide (Deepgram when there is a key for it, Kokoro otherwise). */
export async function chooseProvider(provider: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speech: { provider } }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, detail: body?.detail ?? `The console refused that service (${res.status}).` };
  } catch {
    return { ok: false, detail: "The console could not be reached." };
  }
}

/** Point the console at a voice server by address, or clear it ("") to go
    back to finding one by name. */
export async function chooseSpeechUrl(url: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speech: { url } }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, detail: body?.detail ?? `The console refused that address (${res.status}).` };
  } catch {
    return { ok: false, detail: "The console could not be reached." };
  }
}

/** How long a clip of silence to unlock audio with: long enough that iOS sees
    it as playback, short enough that nobody hears anything. */
const UNLOCK_MS = 60;

/** A very short 8 kHz WAV of silence, built here rather than carried as a
    blob of base64 in the source. iOS only unlocks audio for a page that has
    started some from a gesture: playing this inside the tap that begins live
    chat unlocks the element every later utterance reuses. */
function silence(): Blob {
  const samples = (8000 * UNLOCK_MS) / 1000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return new Blob([bytes], { type: "audio/wav" });
}

/** Sentences rendered ahead of the one playing. Enough to cover a short
    sentence followed by a long one, few enough not to swamp a voice server
    running on a CPU with work that a barge-in throws away. */
const LOOKAHEAD = 2;

export type Speech = {
  supported: boolean;
  speaking: boolean;
  /** Where the last words out actually came from, for the panel to say. */
  source: SpeechSource;
  /** Queue a fragment. Fragments play in order, so streamed text stays in order. */
  say: (text: string) => void;
  /** Stop now and drop whatever is queued -- for barge-in. */
  cancel: () => void;
  /** Unlock audio from inside a tap, which iOS requires before it will speak. */
  prime: () => void;
};

/**
 * The words out.
 *
 * Two voices behind one interface. The console's own voice server comes first
 * (see server/speech.ts): the audio is fetched from this origin and played as
 * a file, so it sounds the same on the phone, the laptop and the desktop, and
 * it is a voice somebody chose. The browser's speechSynthesis is the fallback
 * -- and is still what an install with no voice server uses, unchanged.
 *
 * Which one is being used is not the caller's business: `say` queues a
 * fragment and fragments come out in order, spoken once each, whichever voice
 * is saying them. If the server stops answering mid-sentence the queue is
 * finished with the browser's voice rather than going silent, so a long reply
 * is never cut off because something else was restarted.
 */
export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false);
  const [source, setSource] = useState<SpeechSource>("browser");
  const voice = useRef<SpeechSynthesisVoice | null>(null);
  const queued = useRef(0);
  /** null until the console has been asked. */
  const serverVoice = useRef<boolean | null>(null);
  const ready = useRef<Promise<void> | null>(null);
  const queue = useRef<string[]>([]);
  const element = useRef<HTMLAudioElement | null>(null);
  /** Clips being synthesised, so the one playing next is never asked for
      twice -- once ahead of time and again when its turn comes. */
  const fetching = useRef(new Map<string, { promise: Promise<Blob>; control: AbortController }>());
  /** Bumped by cancel(), so a drain waking from an await knows the queue it
      was working on is gone. */
  const generation = useRef(0);
  const draining = useRef(false);
  /** A clip's playback, resolvable from outside it so cancel() cannot leave
      the drain loop waiting on an `ended` that will never come. */
  const settled = useRef<(() => void) | null>(null);
  /** Sentences the model repeats -- "Done.", a status line -- cost a round
      trip each otherwise, and a round trip is seconds of synthesis. */
  const clips = useRef(new Map<string, Blob>());

  useEffect(() => {
    if (!speechSupported) return;
    const load = () => { voice.current = pickVoice(); };
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      speechSynthesis.removeEventListener("voiceschanged", load);
      speechSynthesis.cancel();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    ready.current = fetchSpeechStatus()
      .then((status) => {
        if (!alive) return;
        serverVoice.current = Boolean(status?.available);
        setSource(status?.available ? "server" : "browser");
      })
      .catch(() => {
        if (alive) serverVoice.current = false;
      });
    return () => { alive = false; };
  }, []);

  const sayBrowser = useCallback((text: string) => {
    if (!speechSupported) return;
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice.current) {
      utterance.voice = voice.current;
      utterance.lang = voice.current.lang;
    }
    utterance.rate = 1.03;
    utterance.pitch = 1;
    const done = () => {
      queued.current = Math.max(0, queued.current - 1);
      if (queued.current === 0) setSpeaking(false);
    };
    utterance.onend = done;
    utterance.onerror = done;
    queued.current += 1;
    setSpeaking(true);
    speechSynthesis.speak(utterance);
  }, []);

  /** One fragment as an audio file, from the console or from last time. */
  const clip = useCallback((text: string): Promise<Blob> => {
    const held = clips.current.get(text);
    if (held) return Promise.resolve(held);
    const going = fetching.current.get(text);
    if (going) return going.promise;
    const control = new AbortController();
    const promise = (async () => {
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: control.signal,
      });
      if (!res.ok) throw new Error(`speech ${res.status}`);
      const blob = await res.blob();
      if (blob.size === 0) throw new Error("speech: empty recording");
      // Small and cleared whole: a handful of sentences is all this ever
      // holds, and a stale voice after changing it is worse than
      // re-synthesising.
      if (clips.current.size >= 24) clips.current.clear();
      clips.current.set(text, blob);
      return blob;
    })();
    fetching.current.set(text, { promise, control });
    const done = () => {
      if (fetching.current.get(text)?.promise === promise) fetching.current.delete(text);
    };
    promise.then(done, done);
    return promise;
  }, []);

  const play = useCallback((blob: Blob) => {
    const el = element.current ?? new Audio();
    el.preload = "auto";
    element.current = el;
    const url = window.URL.createObjectURL(blob);
    el.src = url;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        settled.current = null;
        window.URL.revokeObjectURL(url);
        resolve();
      };
      settled.current = finish;
      el.onended = finish;
      el.onerror = finish;
      // Autoplay may be refused (no gesture yet, or a page opened in the
      // background): there is nothing to say about it, and the queue has to
      // keep moving or the next sentence never arrives.
      el.play().then(undefined, finish);
    });
  }, []);

  /** Start rendering the next sentences, without waiting on them. Also run
      when a streamed sentence is queued mid-clip, so it is ready by the time
      the one playing ends. Failures surface when drain asks for the clip. */
  const renderAhead = useCallback(() => {
    for (const ahead of queue.current.slice(0, LOOKAHEAD)) {
      void clip(ahead).catch(() => undefined);
    }
  }, [clip]);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    while (queue.current.length > 0) {
      const text = queue.current[0];
      const gen = generation.current;
      let blob: Blob;
      try {
        blob = await clip(text);
      } catch {
        // Cut off while it was being made: start again on whatever has been
        // queued since, if anything.
        if (gen !== generation.current) continue;
        /* The server has stopped answering -- restarted, moved, or the
           network changed. Everything still queued is said with the
           browser's voice: the person asked for this turn to be spoken, and
           which voice says it matters far less than it being said. */
        serverVoice.current = false;
        setSource("browser");
        for (const line of queue.current.splice(0, queue.current.length)) sayBrowser(line);
        break;
      }
      // Cancelled while this one was on its way: it belongs to the old queue,
      // and the front of the queue now is something said since.
      if (gen !== generation.current) continue;
      queue.current.shift();
      // The next sentences render while this one plays. Synthesis runs faster
      // than speech, so by the time a sentence ends the one after it is
      // usually waiting -- no gap between them, and the first starts as soon
      // as it alone is ready rather than when the whole reply is.
      renderAhead();
      await play(blob);
    }
    draining.current = false;
    if (queue.current.length === 0) setSpeaking(false);
  }, [clip, play, renderAhead, sayBrowser]);

  const say = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (serverVoice.current === true) {
      queue.current.push(...sentences(clean));
      setSpeaking(true);
      // Already playing: get the new sentences rendering behind it now.
      if (draining.current) renderAhead();
      void drain();
      return;
    }
    /* The console has not said yet whether it has a voice of its own. One
       fragment, held for the answer, so the first sentence of the session is
       not the one that sounds like a different person. */
    if (serverVoice.current === null && ready.current) {
      setSpeaking(true);
      void ready.current.then(() => {
        if (serverVoice.current === true) {
          queue.current.push(...sentences(clean));
          void drain();
        } else {
          sayBrowser(clean);
        }
      });
      return;
    }
    sayBrowser(clean);
  }, [drain, renderAhead, sayBrowser]);

  const cancel = useCallback(() => {
    queue.current = [];
    generation.current += 1;
    for (const { control } of fetching.current.values()) control.abort();
    fetching.current.clear();
    settled.current?.();
    const el = element.current;
    if (el) {
      el.onended = null;
      el.onerror = null;
      el.pause();
    }
    if (speechSupported) speechSynthesis.cancel();
    queued.current = 0;
    setSpeaking(false);
  }, []);

  const prime = useCallback(() => {
    // iOS will not speak unless the first sound comes from a gesture, and it
    // unlocks the element rather than the page: play a silence through the
    // same element every clip will use.
    const el = element.current ?? new Audio();
    element.current = el;
    const url = window.URL.createObjectURL(silence());
    el.src = url;
    el.play().then(
      () => { el.pause(); window.URL.revokeObjectURL(url); },
      () => window.URL.revokeObjectURL(url),
    );
    if (!speechSupported) return;
    const unlock = new SpeechSynthesisUtterance(" ");
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
    voice.current = voice.current ?? pickVoice();
  }, []);

  return {
    // Sound out is available from either voice; the browser's is only the one
    // that is always there.
    supported: speechSupported || source === "server",
    speaking,
    source,
    say,
    cancel,
    prime,
  };
}

// -- reading the agent's replies out loud ------------------------------------

/* The rules here are a port of `voice/narration.py`, and deliberately so: the
   same reply read by the CLI and by a phone should sound the same, and both
   failure modes that file documents are easy to walk straight back into.

   No lookbehind in any of these. It is supported in current Safari and not in
   the iOS versions this has to keep working on, and an unsupported group is a
   SyntaxError at parse time -- which takes the whole app down, not just the
   voice. */
const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`]+`/g;
const JSON_BLOB = /\{[^{}]*[:,][^{}]*\}/g;
const URL = /https?:\/\/\S+/g;
const PATH = /(^|\s)((?:~|\.{0,2})\/[\w./-]{2,})/g;
const HASH = /\b[0-9a-f]{7,64}\b/g;
const MARKDOWN = /[*_#>]+/g;

/** Ends in a period without ending a sentence. */
const ABBREVIATIONS = new Set([
  "e.g.", "i.e.", "etc.", "vs.", "approx.", "dr.", "mr.", "mrs.", "ms.",
  "st.", "fig.", "no.", "cf.", "al.",
]);

/**
 * Strip what should never be read aloud, leaving prose.
 *
 * Substitutions rather than deletions wherever a listener would still want to
 * know something was there: "the file" beats a silent gap that leaves the
 * sentence ungrammatical.
 */
export function speakable(text: string): string {
  return text
    .replace(FENCE, " the code below ")
    .replace(INLINE_CODE, " that ")
    .replace(JSON_BLOB, " the payload ")
    .replace(URL, " the link ")
    .replace(HASH, " that hash ")
    // The basename only: the directory chain is never the useful part, and it
    // is most of the syllables.
    .replace(PATH, (_all, lead: string, path: string) =>
      `${lead}${path.replace(/\/+$/, "").split("/").pop() ?? path} `)
    .replace(MARKDOWN, "")
    .replace(/\s{2,}/g, " ")
    // The substitutions above pad what they insert, which can leave a space
    // sitting in front of a comma -- an audible hitch in some engines.
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

/** Whether a fragment ends on a sentence rather than mid-number or mid-title. */
function endsSentence(fragment: string): boolean {
  const stripped = fragment.trimEnd();
  if (!stripped || !".!?".includes(stripped[stripped.length - 1])) return false;
  const words = stripped.split(/\s+/);
  const last = (words[words.length - 1] ?? "").toLowerCase();
  if (ABBREVIATIONS.has(last)) return false;
  // "3." in "3.5" is a decimal point, and splitting there is the stutter the
  // architecture notes single out.
  if (/\d\.$/.test(stripped)) return false;
  // A single initial, as in "J. Smith".
  if (/(^|\s)[A-Za-z]\.$/.test(stripped)) return false;
  return true;
}

/** Past this, waiting for a full stop is more noticeable than splitting early. */
const SOFT_AFTER = 220;
const SOFT_BOUNDARY = /[,;:—–-]\s/g;

/**
 * Split off everything safe to speak now, leaving the rest to grow.
 *
 * Speaking each token as it lands gives a stutter; waiting for the whole reply
 * gives a silence as long as the answer. A sentence is the unit that sounds
 * like speech and still starts before the model has finished -- with a soft
 * boundary as the escape hatch for a sentence that never ends.
 *
 * Returns raw slices, not scrubbed text: the caller tracks how much of the
 * original it has consumed, and `speakable` changes the length.
 */
export function splitSpeakable(pending: string): [ready: string, rest: string] {
  let cut = -1;
  const hard = /[.!?](?=\s|$)|\n/g;
  for (let m = hard.exec(pending); m; m = hard.exec(pending)) {
    const end = m.index + m[0].length;
    if (m[0] === "\n" || endsSentence(pending.slice(0, end))) cut = end;
  }
  if (cut < 0 && pending.length > SOFT_AFTER) {
    SOFT_BOUNDARY.lastIndex = 0;
    for (let m = SOFT_BOUNDARY.exec(pending); m; m = SOFT_BOUNDARY.exec(pending)) {
      if (m.index + m[0].length <= SOFT_AFTER) cut = m.index + m[0].length;
    }
  }
  if (cut < 0) return ["", pending];
  return [pending.slice(0, cut), pending.slice(cut)];
}

/** Shorter than this, a piece rides along with the next one: "Done." alone
    costs a round trip and a seam for a word. */
const MERGE_UNDER = 12;

/**
 * Break text into the pieces the voice server renders one at a time.
 *
 * A sentence is the smallest unit that still sounds like speech: the voice
 * sets its intonation across the whole sentence, so a word at a time would
 * come out as a list of words, each said as if it ended a thought. A sentence
 * that runs on is broken at a comma or dash once it is long enough that
 * waiting for its end would be a noticeable pause before anything is heard.
 */
export function sentences(text: string): string[] {
  const pieces: string[] = [];
  const add = (piece: string) => {
    let rest = piece.trim();
    while (rest.length > SOFT_AFTER) {
      let cut = -1;
      SOFT_BOUNDARY.lastIndex = 0;
      for (let m = SOFT_BOUNDARY.exec(rest); m; m = SOFT_BOUNDARY.exec(rest)) {
        const end = m.index + m[0].length;
        if (end > SOFT_AFTER) break;
        if (end >= MERGE_UNDER) cut = end;
      }
      if (cut < 0) break;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  };
  const hard = /[.!?](?=\s|$)|\n/g;
  let from = 0;
  for (let m = hard.exec(text); m; m = hard.exec(text)) {
    const end = m.index + m[0].length;
    if (m[0] !== "\n" && !endsSentence(text.slice(from, end))) continue;
    add(text.slice(from, end));
    from = end;
  }
  add(text.slice(from));
  const merged: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    const joined = carry ? `${carry} ${piece}` : piece;
    if (joined.length < MERGE_UNDER) carry = joined;
    else { merged.push(joined); carry = ""; }
  }
  if (carry) {
    if (merged.length > 0) merged[merged.length - 1] += ` ${carry}`;
    else merged.push(carry);
  }
  return merged;
}
