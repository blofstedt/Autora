/**
 * Speaking to the app, and the app speaking back.
 *
 * All of this is the browser's own speech stack -- SpeechRecognition for words
 * in, speechSynthesis for words out. The voice loop that ships with the CLI
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
const EDGES = /^["'“”‘’(\[]+|[.,!?;:"'“”‘’)\]…]+$/g;
const bare = (word: string): string => word.toLowerCase().replace(EDGES, "");

/**
 * The part of `text` that `said` has not already given out.
 *
 * The plain case is a growing phrase, where the old text is a prefix of the
 * new one. The awkward case is a final that restates words already handed
 * over in a tidied-up form -- "this is just" becoming "This is just a test."
 * -- where a prefix test fails and handing over the whole final would say the
 * first three words twice. So the comparison falls back to matching word by
 * word, ignoring case and punctuation, and keeps only the tail past the last
 * word both versions agree on. A phrase the engine has walked backwards
 * contributes nothing.
 */
export function unsaid(said: string, text: string): string {
  if (!said) return text;
  if (text.startsWith(said)) return text.slice(said.length).trim();
  const before = words(said);
  const now = words(text);
  let same = 0;
  while (same < before.length && same < now.length
         && bare(before[same]) === bare(now[same])) same += 1;
  return now.slice(same).join(" ");
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

  /** What each engine result has already handed over, and the part that is new.
   *
   * Chromium's result list is indexed and append-only: a final arrives once,
   * complete. The Android system recogniser does something the spec does not
   * describe -- it returns the whole utterance so far as a single result and
   * re-fires it as final every time the hypothesis moves, and it sometimes
   * walks a word back. Appending every final then says everything again and
   * again: "testing 1 2 3" arrived as "testing" nine times, then "testing 1",
   * then the whole phrase.
   *
   * So each index keeps a watermark of what it has handed over, and only the
   * part past it is passed on. `heard` is the other half: the latest text for
   * each index whether or not the engine has settled on it, so that a caller
   * which acted on an unsettled phrase can mark it spent -- see `accept`. Both
   * are refs rather than state because they are read inside engine callbacks
   * that close over whatever render created them.
   */
  const handed = useRef<Map<number, string>>(new Map());
  const heard = useRef<Map<number, string>>(new Map());

  /**
   * The same watermark, kept across engine restarts rather than sessions.
   *
   * `handed` dies with the session that filled it, and that is the hole the
   * repeats came back through. Safari hangs up after every phrase and `onend`
   * restarts it; so does a stretch of silence, on every engine. A restart
   * that lands mid-utterance does not always begin a new utterance -- the
   * engine picks the old one up from the top and re-reports the whole
   * hypothesis so far, into a session whose marks were just cleared. Every
   * such restart then handed the caller the entire phrase over again, and a
   * caller that appends -- live chat does -- built a staircase out of it:
   * "this this is this is just this is just a test", one rung per restart.
   *
   * So this one outlives the session. Only the result a new session opens on
   * is compared against it, because that is where a replay lands; a later
   * result is genuinely new, and measuring it against the start of an earlier
   * phrase is how "Open the file" followed by "Open the folder" would come
   * out as "folder".
   */
  const spent = useRef("");

  /** The index the session in hand opened on, or null before its first
      result. */
  const resumed = useRef<number | null>(null);

  /** Move the watermark up, never down.
   *
   * A shorter text is the engine revising words already handed over, and
   * lowering the mark for it would hand over the words in between a second
   * time. Counted in words, because a final is often the same phrase
   * re-punctuated and a capital letter is not progress.
   */
  const mark = useCallback((index: number, text: string) => {
    const before = handed.current.get(index);
    if (before === undefined || words(text).length >= words(before).length) {
      handed.current.set(index, text);
    }
    if (words(text).length >= words(spent.current).length) spent.current = text;
  }, []);

  /**
   * Treat everything the engine has produced so far as already handed over.
   *
   * For callers that cannot wait for `isFinal`. Live chat is one: Chrome on
   * Android will stream a whole sentence as interim results and never settle
   * on any of it, so a pause has to be enough to send. Sending the interim
   * text is not the whole job though -- the engine keeps that same result
   * open, and its eventual final still holds the words that were sent, so
   * they came back and went out a second time. That is the "repeated words"
   * everyone hit: not the engine hearing you twice, us saying it twice.
   */
  const accept = useCallback(() => {
    heard.current.forEach((text, index) => mark(index, text));
    setInterim("");
  }, [mark]);

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
    spent.current = "";
    setError(null);

    const engine = new Impl();
    recognition.current = engine;
    engine.lang = lang ?? navigator.language ?? "en-US";
    engine.continuous = continuous;
    engine.interimResults = true;
    engine.maxAlternatives = 1;

    engine.onstart = () => {
      // A new session numbers its results from zero again, so the per-index
      // marks from the last one describe results that no longer exist.
      // `spent` is deliberately not cleared here -- see above.
      handed.current.clear();
      heard.current.clear();
      resumed.current = null;
      setListening(true);
    };

    engine.onresult = (event) => {
      if (resumed.current === null) resumed.current = event.resultIndex;
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const phrase = event.results[i];
        const text = (phrase[0]?.transcript ?? "").trim();
        heard.current.set(i, text);
        // Both kinds go through the watermark. An interim that repeats words
        // already sent is the same double as a final that does, and captioning
        // them back is how it looks from the outside.
        // A session that has marked this index is the authority on it. One
        // that has not just started, and if this is the result it started on,
        // the engine may be replaying what the last session already gave out.
        const known = handed.current.get(i)
          ?? (i === resumed.current ? spent.current : "");
        const fresh = unsaid(known, text);
        if (phrase.isFinal) {
          mark(i, text);
          if (fresh) phraseRef.current?.(fresh);
          // A phrase landing means the engine is healthy, whatever it had to
          // restart through to get here.
          restarts.current = 0;
        } else if (fresh) {
          live = live ? `${live} ${fresh}` : fresh;
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
  }, [bump, continuous, lang, mark, settle]);

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

export type Speech = {
  supported: boolean;
  speaking: boolean;
  /** Queue a fragment. Fragments play in order, so streamed text stays in order. */
  say: (text: string) => void;
  /** Stop now and drop whatever is queued -- for barge-in. */
  cancel: () => void;
  /** Unlock audio from inside a tap, which iOS requires before it will speak. */
  prime: () => void;
};

export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false);
  const voice = useRef<SpeechSynthesisVoice | null>(null);
  const queued = useRef(0);

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

  const cancel = useCallback(() => {
    if (!speechSupported) return;
    queued.current = 0;
    speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const say = useCallback((text: string) => {
    if (!speechSupported) return;
    const clean = text.trim();
    if (!clean) return;
    const utterance = new SpeechSynthesisUtterance(clean);
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

  const prime = useCallback(() => {
    if (!speechSupported) return;
    // iOS will not speak unless the first utterance comes from a gesture. A
    // space is inaudible and counts.
    const unlock = new SpeechSynthesisUtterance(" ");
    unlock.volume = 0;
    speechSynthesis.speak(unlock);
    voice.current = voice.current ?? pickVoice();
  }, []);

  return { supported: speechSupported, speaking, say, cancel, prime };
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
