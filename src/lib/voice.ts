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
/** A run this long was a working microphone, not a failing one. */
const HEALTHY_MS = 3000;

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

    let opened = 0;
    engine.onstart = () => {
      /* A run that lasted a while is a healthy engine, whatever number of
         them came before it. Without this a quietly open microphone -- live
         mode with nobody talking, which is now most of a spoken turn --
         reaches the restart cap after forty silences and reports a failure
         that is not one. An engine that ends the moment it starts still
         counts, which is what the cap is for. */
      if (opened && Date.now() - opened > HEALTHY_MS) restarts.current = 0;
      opened = Date.now();
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

// -- the word that takes the microphone back ---------------------------------

/**
 * What you call Autora by, at the start of what the engine hears.
 *
 * A wake word is how live mode keeps the microphone open while Autora is
 * talking without the answer coming straight back as a question: in that time
 * nothing is a request unless it begins with the name. The engine writes the
 * name several ways on a phone -- "aurora" is what it settles on most often,
 * and "a tora" is not rare -- and the greeting in front of it ("hey Autora,")
 * is how a request usually starts.
 *
 * Anchored, deliberately. Matching the name anywhere in the phrase would let
 * Autora interrupt itself: it says its own name out loud, and the microphone
 * is listening to that.
 */
const CALL = /^(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?(autora|aurora|a\s+tora)(?:['\u2019]s)?\b[\s,.:;!?\u2013\u2014-]*/i;

/** Every spelling of the name a phone has actually written, including the
    short ones that are too short for drift to be trusted with. */
const NAME_FORMS = new Set([
  "autora", "aurora", "atora", "otora", "atura", "autura", "outora",
  "autara", "tora", "taura", "torah", "tura",
]);

/** The noise people make before a name, the greeting among it. A name is only
    a name at the start of a phrase -- Autora says its own name out loud and
    the microphone hears that -- so this is what "the start" is read through. */
const LEAD_IN = /^(?:(?:hey|hi|hello|ok|okay|yo|um|uh|erm|ah|so|well|and)[\s,]+)+/i;

/** The name heard as two words: "a tora", "o tora". */
const SPLIT_NAME = /^(?:a|o)[\s,]+(tora|taura|tura|torah)\b/i;

/** What a phrase may continue with once the name is off it. */
const GAP = /^[\s,.:;!?\u2013\u2014-]*/;

/** How far the engine's spelling may drift from "autora" and still be the
    name. Two edits covers aurora, atora, otora, autura, outora and autara in
    one go -- every spelling of it seen on a phone so far. Words shorter than
    the name are left to the list above: "auto" and "aura" are two edits away
    as well, and hearing one of those is not a call. */
const DRIFT = 2;
const MIN_NAME = 5;

/** Edit distance, plain and short: the words here are eight characters. */
function drift(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_: unknown, i: number) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row.push(Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/** Whether one word on its own is the name. */
function isName(word: string): boolean {
  const one = bare(word).replace(/['\u2019]s$/, "");
  if (!one) return false;
  return NAME_FORMS.has(one) || (one.length >= MIN_NAME && drift(one, "autora") <= DRIFT);
}

/** What followed the name at the start of `text`, or null when `text` did not
    start with it. An empty string is the name and nothing else. */
export function afterName(text: string): string | null {
  const said = text.trim().replace(/^[\s,.!?]+/, "");
  if (!said) return null;
  if (CALL.test(said)) return said.replace(CALL, "").trim();
  // The same name, written some other way. A phone settles on "aurora" most
  // often, but it will not be told which words to use, so the name is matched
  // by how it sounds rather than against a list -- and a greeting, or a "um",
  // dropped in front of it is still the start of the phrase.
  const rest = said.replace(LEAD_IN, "");
  if (!rest) return null;
  const split = rest.match(SPLIT_NAME);
  if (split) return rest.slice(split[0].length).replace(GAP, "").trim();
  const spoken = rest.split(/\s+/);
  const first = spoken[0];
  if (first === undefined || !isName(first)) return null;
  return spoken.slice(1).join(" ").replace(GAP, "").trim();
}

/** What to send, with the name taken off the front. Null when the whole
    utterance was the name -- called, not asked. */
export function withoutName(text: string): string | null {
  const said = text.trim().replace(/^[\s,.!?]+/, "");
  if (!said) return null;
  const rest = afterName(said);
  return (rest ?? said).trim() || null;
}

export type SpeechSource = "server" | "browser";

/** What the console says about its own voice, from GET /api/speech. */
export type SpeechStatus = {
  /** False when there is no voice service: the browser's voice is used. */
  available: boolean;
  /** The service that speaks, or null when nothing is configured. */
  provider?: "deepgram" | null;
  voice: string;
  voices: { id: string; label: string }[];
  reason: string | null;
  /** Whether a turn spoken to the console may think before answering. Off
      by default: the thinking is most of the wait in live voice. */
  liveThinking: boolean;
  /** Whether talk mode opens with live view on -- the camera, which the agent
      is then shown frames from. */
  liveView: boolean;
  /** The service behind it, for the panel to name. */
  url: string | null;
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

/** Whether spoken turns are allowed to think first, so it follows you
    between devices. Off means the answer starts sooner. */
export async function chooseLiveThinking(liveThinking: boolean): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speech: { liveThinking } }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, detail: body?.error ?? `The console answered ${res.status}.` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/** How talk mode is set up when it opens: the camera, and the microphone.
    Saved the way the voice is, so it follows the person between devices --
    the switches in the live bar are the quick ones, this is the remembered
    one. */
export async function chooseTalk(next: { liveView?: boolean }): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speech: next }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null);
    return { ok: false, detail: body?.error ?? `The console answered ${res.status}.` };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err) };
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

/** Raw PCM from the console is mono 24 kHz (see server/speech.ts). */
const SPEECH_RATE = 24000;

/** Characters in one streaming request. The console refuses more than 2000,
    and a reply longer than this is split on sentence ends: a few renderings
    for a very long answer, one for all the rest. */
const STREAM_CHARS = 1200;

/** How long a turn may sit unclosed before it is said anyway. Live chat
    closes each turn the moment the agent stops talking; this is only for a
    turn that never lands -- a dropped connection, a run that died. */
const IDLE_FLUSH_MS = 12_000;

/** Sentences rendered ahead of the one playing. Enough to cover a short
    sentence followed by a long one, few enough that a barge-in does not throw
    away a queue of requests nobody will hear. */
const LOOKAHEAD = 2;

export type Speech = {
  supported: boolean;
  speaking: boolean;
  /** Where the last words out actually came from, for the panel to say. */
  source: SpeechSource;
  /** Queue a fragment. Fragments play in order, so streamed text stays in order. */
  say: (text: string) => void;
  /**
   * The turn is over: render everything said since the last flush and play it.
   *
   * One request is one rendering, and Deepgram draws the voice fresh for each
   * rendering -- the same words come back at a different pitch and pace every
   * time. Asking for a sentence at a time is what made the voice change with
   * every sentence, so a turn is asked for whole.
   */
  flush: () => void;
  /** Stop now and drop whatever is queued -- for barge-in. */
  cancel: () => void;
  /** Unlock audio from inside a tap, which iOS requires before it will speak. */
  prime: () => void;
};

/**
 * The words out.
 *
 * Two voices behind one interface. Deepgram's hosted voices come first (see
 * server/speech.ts): the audio is fetched from this origin and played as a
 * file, so it sounds the same on the phone, the laptop and the desktop, and it
 * is a voice somebody chose. The browser's speechSynthesis is the fallback --
 * and is still what an install with no Deepgram key uses, unchanged.
 *
 * Which one is being used is not the caller's business: `say` queues a
 * fragment and fragments come out in order, spoken once each, whichever voice
 * is saying them. If the server stops answering mid-sentence the queue is
 * finished with the browser's voice rather than going silent, so a long reply
 * is never cut off because something else was restarted.
 */
/**
 * The line one voice speaks in.
 *
 * Renderings join it and come out one at a time, in the order they joined: a
 * sentence still being heard is never talked over by the next thing the page
 * has to say. Every way this file makes a sound -- a streamed rendering from
 * the console, a clip, the browser's own voice -- goes through the same line,
 * because two of them playing at once is heard as two people talking.
 *
 * It is a function rather than a ref inside the hook so the rule can be tested
 * without a browser.
 */
export type SpeechLine = {
  /** Add a rendering. `run` is called when everything before it has finished;
      the returned promise settles with it, so a failure reaches its caller --
      without wedging the line, which the next rendering still gets its turn
      in. */
  join: (run: () => void | Promise<void>) => Promise<void>;
  /** Renderings in the line, the one in flight included. */
  waiting: () => number;
  /** Everyone gives up their place, for a barge-in: what was waiting is
      dropped, and what is in flight is left to notice the cancellation. */
  reset: () => void;
  /** The line's generation: the same number while it is the same line, a new
      one after a reset. A caller part way through a rendering compares it to
      see whether it is still its turn. */
  stamp: () => number;
};

export function newSpeechLine(): SpeechLine {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let generation = 0;
  return {
    join(run) {
      const mine = generation;
      queued += 1;
      const call = () => { if (mine === generation) return run(); };
      const step = tail.then(call, call).then(() => undefined);
      /* The line itself never rejects: one rendering that threw must not stop
         the ones behind it. */
      tail = step.then(() => undefined, () => undefined);
      void tail.then(() => { if (mine === generation) queued -= 1; });
      return step;
    },
    waiting: () => queued,
    stamp: () => generation,
    reset() {
      generation += 1;
      queued = 0;
      tail = Promise.resolve();
    },
  };
}

export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false);
  const [source, setSource] = useState<SpeechSource>("browser");
  const voice = useRef<SpeechSynthesisVoice | null>(null);
  /** The line every rendering joins, so only one voice is ever in the air. */
  const line = useRef<SpeechLine>(newSpeechLine());
  /** Renderings on the line now, so the page says it is speaking while any of
      them is left, rather than each voice keeping its own tally. */
  const inLine = useRef(0);
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
  /** The voice id the last answer from the console named, so a change to it
      is noticed as well as a change of service. */
  const spokenAs = useRef<string | null>(null);
  /** Bumped when the voice changes, so a clip rendered for the old one is
      played if it is already on its way, but never kept for next time. */
  const clipGen = useRef(0);
  /* The turn so far: what has been said but not yet asked for. */
  const pending = useRef("");
  /** The context raw PCM plays through, and where in it the next chunk goes.
      Built (and resumed) inside the tap that starts live chat, which is the
      gesture iOS wants before a page may make a sound. */
  const output = useRef<AudioContext | null>(null);
  const playhead = useRef(0);
  const playing = useRef(new Set<AudioBufferSourceNode>());
  /** The rendering in flight, so a barge-in stops paying for the rest of it. */
  const pouring = useRef<AbortController | null>(null);
  /** A console too old to know the streaming route says so once, and every
      turn after it is spoken a sentence at a time as before. */
  const canStream = useRef(true);
  const idle = useRef<number | null>(null);

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
        spokenAs.current = status?.voice ?? null;
        setSource(status?.available ? "server" : "browser");
      })
      .catch(() => {
        if (alive) serverVoice.current = false;
      });
    return () => { alive = false; };
  }, []);

  /* The answer this page got at load is not the answer forever: the key gets
     pasted, the app is updated, the machine restarts, the voice is changed in
     Settings. A page left open kept whichever voice it started with until it
     was reloaded, so ask again each time the window is brought back and switch
     over where the conversation stands, with no reload and nothing said
     twice. */
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      void fetchSpeechStatus()
        .then((status) => {
          const can = Boolean(status?.available);
          const voice = status?.voice ?? null;
          if (can === serverVoice.current && voice === spokenAs.current) return;
          /* Anything already made was made in the old voice, or by the other
             service, and must not be heard after this one. */
          clipGen.current += 1;
          clips.current.clear();
          fetching.current.clear();
          serverVoice.current = can;
          spokenAs.current = voice;
          setSource(can ? "server" : "browser");
        })
        .catch(() => {
          /* Unreachable is not the same as gone: keep the last answer rather
             than dropping to the browser's voice for a blip. */
        });
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  /** The browser's own voice, resolvable when it has finished -- or when the
      browser has plainly stopped reporting, so one missing event cannot hold
      the line shut for the rest of the session. */
  const speakBrowser = useCallback((text: string): Promise<void> => {
    if (!speechSupported) return Promise.resolve();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice.current) {
      utterance.voice = voice.current;
      utterance.lang = voice.current.lang;
    }
    utterance.rate = 1.03;
    utterance.pitch = 1;
    return new Promise<void>((resolve) => {
      let done = false;
      let guard = 0;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(guard);
        resolve();
      };
      /* About the time this many characters take to say, and only ever a
         backstop for a browser that never reports the end. */
      guard = window.setTimeout(finish, Math.max(6000, text.length * 110));
      utterance.onend = finish;
      utterance.onerror = finish;
      speechSynthesis.speak(utterance);
    });
  }, []);

  /** Wait until what the streamed voice has already handed to the audio thread
      has been heard. A rendering that cannot share that timeline -- a clip
      through the element, or the browser's own voice -- waits here first, so
      it never starts on top of audio that is still playing. */
  const heardOut = useCallback(async (): Promise<void> => {
    const gen = generation.current;
    for (let i = 0; i < 600; i += 1) {
      const ac = output.current;
      /* Nothing scheduled, or nothing that would play if it were: a context
         that is not running does not advance its clock, and waiting on one
         would wait for ever. */
      if (!ac || ac.state !== "running") return;
      const left = playhead.current - ac.currentTime;
      if (left <= 0.03) return;
      if (gen !== generation.current) return;
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, Math.min(250, Math.max(30, left * 1000)));
      });
    }
  }, []);

  /** Take a turn on the line: the rendering runs once everything before it has
      finished, and the page is said to be speaking while any of them is left. */
  const speakInTurn = useCallback((run: () => Promise<void>): Promise<void> => {
    const stamp = line.current.stamp();
    inLine.current += 1;
    setSpeaking(true);
    return line.current.join(run).finally(() => {
      // Cancelled while this one was in flight: it belongs to the old line and
      // has no say in whether the new one is speaking.
      if (stamp !== line.current.stamp()) return;
      inLine.current = Math.max(0, inLine.current - 1);
      if (inLine.current === 0) setSpeaking(false);
    });
  }, []);

  /** The browser's voice, in its turn on the line. */
  const sayBrowser = useCallback((text: string) => {
    void speakInTurn(async () => {
      await heardOut();
      await speakBrowser(text);
    }).catch(() => undefined);
  }, [heardOut, speakBrowser, speakInTurn]);

  const clearIdle = useCallback(() => {
    if (idle.current === null) return;
    window.clearTimeout(idle.current);
    idle.current = null;
  }, []);

  /** The context to play raw PCM through, made on first use. */
  const context = useCallback((): AudioContext | null => {
    if (output.current) return output.current;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    try {
      /* Asked for at the rate it arrives at: nothing has to be resampled, and
         a device that insists otherwise still plays it correctly. */
      output.current = new Ctor({ sampleRate: SPEECH_RATE });
    } catch {
      try { output.current = new Ctor(); } catch { output.current = null; }
    }
    return output.current;
  }, []);

  /** One chunk of raw PCM onto the end of what is already due to play. */
  const schedule = useCallback((samples: Int16Array) => {
    const ac = context();
    if (!ac) return false;
    const buffer = ac.createBuffer(1, samples.length, SPEECH_RATE);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 0x8000;
    const node = ac.createBufferSource();
    node.buffer = buffer;
    node.connect(ac.destination);
    /* A short lead -- enough that the first chunk is not already late when
       the audio thread gets it, short enough not to be heard as a gap. What
       follows is queued end to end, so the rendering is heard as one
       utterance however many times it was chunked on the wire. */
    const at = Math.max(ac.currentTime + 0.04, playhead.current);
    node.start(at);
    playhead.current = at + buffer.duration;
    playing.current.add(node);
    node.onended = () => {
      playing.current.delete(node);
    };
    return true;
  }, [context]);

  /** One rendering, played as it arrives. Resolves when the last of it has
      been handed to the audio thread, not when it has been heard. */
  const pour = useCallback(async (text: string): Promise<void> => {
    const control = new AbortController();
    pouring.current = control;
    try {
      const res = await fetch("/api/speech/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: control.signal,
      });
      if (!res.ok || !res.body) throw new Error(`speech stream ${res.status}`);
      const reader = res.body.getReader();
      let carry: Uint8Array | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let bytes = value;
        if (carry) {
          const joined = new Uint8Array(carry.length + bytes.length);
          joined.set(carry);
          joined.set(bytes, carry.length);
          bytes = joined;
          carry = null;
        }
        /* Sixteen-bit samples: an odd byte at the end of a chunk belongs with
           the first byte of the next one. */
        const even = bytes.length - (bytes.length % 2);
        if (even !== bytes.length) carry = bytes.slice(even);
        if (even === 0) continue;
        const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
        if (!schedule(samples)) throw new Error("no audio to play it through");
      }
    } finally {
      if (pouring.current === control) pouring.current = null;
      control.abort();
    }
  }, [schedule]);

  /** One fragment as an audio file, from the console or from last time. */
  const clip = useCallback((text: string): Promise<Blob> => {
    const gen = clipGen.current;
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
      /* Already on its way when the voice changed: let it play if it is next,
         but do not keep it for the one after. */
      if (clipGen.current !== gen) return blob;
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
    try {
      /* The streamed voice may have audio scheduled that is still being
         heard, and the element cannot be put on that timeline: wait for it
         rather than playing over the top of it. */
      await heardOut();
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
             which voice says it matters far less than it being said. This
             rendering already has the line, so the browser's voice is awaited
             here directly: joining the line from inside it would wait on a turn
             that only begins when this one ends. */
          serverVoice.current = false;
          setSource("browser");
          const rest = queue.current.splice(0, queue.current.length);
          for (const sentence of rest) {
            if (gen !== generation.current) break;
            await speakBrowser(sentence);
          }
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
    } finally {
      draining.current = false;
    }
  }, [clip, heardOut, play, renderAhead, speakBrowser]);

  /** Sentences for the fallback path: the clip queue speaks fragments. */
  const fallback = useCallback((text: string) => {
    queue.current.push(...sentences(text));
    setSpeaking(true);
    void speakInTurn(() => drain()).catch(() => undefined);
  }, [drain, speakInTurn]);

  /**
   * Everything said since the last flush, as one rendering.
   *
   * This is the whole point of the change: a request per sentence was a
   * request per draw of the voice, and the drawing is what shifted -- same
   * text, same voice, and the pitch came back anywhere between 120 and 190 Hz.
   * One request for the turn is rendered in one pass and holds one voice.
   */
  const flush = useCallback(() => {
    clearIdle();
    const text = pending.current.trim();
    pending.current = "";
    if (!text) return;
    if (serverVoice.current !== true) { sayBrowser(text); return; }
    if (!canStream.current) { fallback(text); return; }
    const gen = generation.current;
    void (async () => {
      /* Each part takes a turn on the line, so one is only asked for once the
         part before it has finished being made. Two parts on the wire at once
         used to hand their chunks to the audio timeline in whatever order they
         came back, which is what made the voice chop and double over itself. */
      for (const part of streamParts(text)) {
        if (gen !== generation.current) return;
        try {
          await speakInTurn(() => pour(part));
        } catch {
          if (gen !== generation.current) return;
          /* No streaming here: an install older than this route, or a service
             that has stopped answering. The words are said a sentence at a
             time instead, which costs a voice that shifts -- silence and a
             reply nobody hears costs more. */
          canStream.current = false;
          fallback(part);
          return;
        }
      }
    })();
  }, [clearIdle, fallback, pour, sayBrowser, speakInTurn]);

  /** Keep a fragment until the turn is done. */
  const hold = useCallback((clean: string) => {
    pending.current = pending.current ? `${pending.current} ${clean}` : clean;
    setSpeaking(true);
    clearIdle();
    /* A turn the page never closes (a dropped connection, a run that died
       mid-answer) is still said rather than held for ever. */
    idle.current = window.setTimeout(() => { idle.current = null; flush(); }, IDLE_FLUSH_MS);
  }, [clearIdle, flush]);

  const say = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (serverVoice.current === true) {
      hold(clean);
      return;
    }
    /* The console has not said yet whether it has a voice of its own. One
       fragment, held for the answer, so the first sentence of the session is
       not the one that sounds like a different person. */
    if (serverVoice.current === null && ready.current) {
      setSpeaking(true);
      void ready.current.then(() => {
        if (serverVoice.current === true) hold(clean);
        else sayBrowser(clean);
      });
      return;
    }
    sayBrowser(clean);
  }, [hold, sayBrowser]);

  const cancel = useCallback(() => {
    queue.current = [];
    pending.current = "";
    clearIdle();
    generation.current += 1;
    /* Stop the rendering itself, not just the sound: a barge-in should not
       keep paying for a reply nobody is listening to. */
    pouring.current?.abort();
    pouring.current = null;
    for (const node of playing.current) {
      try { node.stop(); } catch { /* already finished */ }
    }
    playing.current.clear();
    playhead.current = 0;
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
    /* Everyone on the line gives up their place: what was waiting is dropped
       rather than said over the interruption. */
    line.current.reset();
    inLine.current = 0;
    setSpeaking(false);
  }, [clearIdle]);

  /* Settings plays a sample in the voice being chosen, and a sample that
     played over a reply being read out is two voices at once -- the same
     fault this file is arranged to avoid. It asks the page to stop first,
     the way the theme asks the page to repaint. */
  useEffect(() => {
    const hush = () => cancel();
    window.addEventListener("autora-hush", hush);
    return () => window.removeEventListener("autora-hush", hush);
  }, [cancel]);

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
    /* The same gesture unlocks the context the streamed rendering plays
       through: iOS refuses to start one that no tap has started. */
    const ac = context();
    if (ac && ac.state === "suspended") void ac.resume().catch(() => undefined);
    if (!speechSupported) return;
    const unlock = new SpeechSynthesisUtterance(" ");
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
    voice.current = voice.current ?? pickVoice();
  }, [context]);

  return {
    // Sound out is available from either voice; the browser's is only the one
    // that is always there.
    supported: speechSupported || source === "server",
    speaking,
    source,
    say,
    flush,
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
 * Break text into the pieces the service renders one at a time.
 *
 * A sentence is the smallest unit that still sounds like speech: the voice
 * sets its intonation across the whole sentence, so a word at a time would
 * come out as a list of words, each said as if it ended a thought. A sentence
 * that runs on is broken at a comma or dash once it is long enough that
 * waiting for its end would be a noticeable pause before anything is heard.
 */
/**
 * A reply split into requests the console will take.
 *
 * Nothing is split for its own sake here: every piece is a rendering of its
 * own and so a draw of the voice of its own, which is the thing being fixed.
 * Only what one request cannot carry -- a reply past the console's limit --
 * is split, and on sentence ends, so the join falls where a listener is least
 * likely to hear it.
 */
export function streamParts(text: string, limit = STREAM_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let at = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    if (at < limit / 2) at = window.lastIndexOf("; ");
    if (at < limit / 2) at = window.lastIndexOf(", ");
    if (at < limit / 2) at = window.lastIndexOf(" ");
    if (at <= 0) at = limit - 1;
    const piece = rest.slice(0, at + 1).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(at + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

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
