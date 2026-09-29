import { useCallback, useEffect, useRef, useState } from "react";
import { afterName, fetchSpeechStatus, turnPause, useDictation, withoutName } from "../lib/voice";
import { useLiveView } from "../lib/liveview";
import { AutoraMark } from "./AutoraMark";
import { IconX } from "./Icons";

/** Single stray syllables are usually the room, not a request. */
const MIN_CHARS = 2;

/** What the bar carries while the microphone is open for its name alone. */
const WAKE_LINE = "Say 'Autora' to add to the conversation…";

/** Said the name and then nothing: how long the microphone waits before it
    gives the bar back. Long enough to think of the sentence, short enough that
    an open microphone is never a mystery. */
const NAME_ONLY_IDLE_MS = 6000;
/** How long to wait, after live mode opens, before believing the microphone
    did not open. Long enough to cover the engine warming up, short enough that
    a person who has said the name twice is told what is wrong. */
const MIC_CHECK_MS = 2500;

/**
 * Live voice, in place of the composer.
 *
 * The screen above does not change: the same thread, the same stage, the same
 * steps scrolling past. Only the strip you would normally type into becomes the
 * conversation -- which is the whole point, because the reason to talk to this
 * thing is to watch it work while your hands are somewhere else.
 *
 * There is one way in, and it is the name. The microphone opens with talk mode
 * and stays open for as long as it lasts: what it hears is the room, Autora's
 * own answer coming back through it, and -- every so often -- somebody saying
 * "Autora". Only the name at the start of what was heard is a request, and
 * everything else is dropped where it stands. Say it and the answer stops
 * mid-sentence and the words are yours; the bar says so in as many words,
 * because nothing else on screen does.
 *
 * What follows the name in the same breath -- "Autora, what's the weather" --
 * is the request, and so is whatever you say next if you said the name alone.
 * It goes out on a pause, the wait tuned in lib/voice: a sentence that trails
 * off mid-thought waits longer than one that has finished. The microphone is
 * never closed to send, which is what makes talking over an answer work.
 *
 * The other thing here is the camera. Off by default, and in Settings rather
 * than in this bar: on, it is two things -- a small live picture in the bar for
 * the person, and a stream at about a frame a second for the agent, so "look at
 * this" arrives with the thing being shown. Both are switched off together the
 * moment talk mode ends.
 */
export function LiveChat({
  onUtterance,
  onInterrupt,
  sessionId,
  agentSpeaking,
  agentWorking,
  disabled,
  onClose,
}: {
  onUtterance: (text: string) => void;
  /* `onExit` was here, for the End button at the end of the bar. That button
     is gone (see the note in the bar's markup) and live mode ends by closing
     the chat or pressing v, which is what App.tsx already does. It may still
     pass onExit and it is simply ignored. */
  /** Stop the agent talking, for barge-in. */
  onInterrupt?: () => void;
  /* `onStop` used to be here, for the Stop badge in the bar. The badge is
     gone (see the note in the bar's markup), so the bar no longer asks for
     it; App.tsx may still pass it and it is simply ignored. */
  /** The conversation this is happening in: where the frames go. */
  sessionId: string | null;
  agentSpeaking: boolean;
  agentWorking?: boolean;
  /* `agentDoing` was here, to say what the agent was on while it worked. The
     bar has one line now and it is the instruction to say the name: the thread
     above already says what is being done, and a second copy of it on the strip
     competed with the one thing the strip is for. */
  disabled?: boolean;
  /** Back to typing: the X at the end of the bar. */
  onClose?: () => void;
}) {
  /** Phrases the engine has committed to. */
  const pending = useRef("");
  /** The phrase still forming, which may never be committed to at all. */
  const live = useRef("");
  const graceTimer = useRef(0);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  /** Set once the hook below exists; sending unsettled words is only half the
      job without it -- see `accept` in lib/voice. */
  const acceptRef = useRef<() => void>(() => {});
  /** What will go out when you pause, shown so you can see it forming. */
  const [heard, setHeard] = useState("");
  /** Woken: the name was heard, and the microphone is the person's until what
      they said has gone out. */
  const [awake, setAwake] = useState(false);
  /** The microphone was asked for and did not open. See MIC_CHECK_MS. */
  const [stalled, setStalled] = useState(false);
  /** The same, for the engine's callbacks, which close over older renders. */
  const awakeRef = useRef(false);
  awakeRef.current = awake;
  /** See NAME_ONLY_IDLE_MS. */
  const wokeTimer = useRef(0);

  /** Live view: the camera, and the frames the agent is shown. Remembered
      between devices, and set in Settings -- this bar carries no switches at
      all now, so nothing here can be unsaved or half-chosen. */
  const [view, setView] = useState(false);

  const camera = useLiveView(sessionId, view);

  /* Whether talk mode opens with the camera on. */
  useEffect(() => {
    let alive = true;
    void fetchSpeechStatus().then((status) => {
      if (!alive || !status) return;
      setView(status.liveView === true);
    });
    return () => { alive = false; };
  }, []);

  /** Send what we have. */
  const flush = useCallback(() => {
    window.clearTimeout(graceTimer.current);
    window.clearTimeout(wokeTimer.current);
    const text = `${pending.current} ${live.current}`.trim();
    pending.current = "";
    live.current = "";
    setHeard("");
    // These words are spent. Without this the engine's eventual final still
    // carries the ones just sent, and they go out again.
    acceptRef.current();
    /* The microphone stays open and goes straight back to listening for the
       name: there is nothing to close and nothing to reopen. */
    setAwake(false);
    awakeRef.current = false;
    /* "Autora, what's the weather" is a question about the weather; a bare
       "Autora" is not a question at all, it is somebody taking the microphone,
       which they already have. */
    const said = withoutName(text);
    if (said !== null && said.length >= MIN_CHARS) {
      utteranceRef.current(said);
    }
  }, []);

  /** It goes out on a pause, not on a press: the wait is tuned in lib/voice,
      where a sentence that trails off mid-thought waits longer than one that
      has finished. */
  const arm = useCallback((settled: boolean) => {
    window.clearTimeout(graceTimer.current);
    const text = `${pending.current} ${live.current}`.trim();
    if (text.length < MIN_CHARS) return;
    graceTimer.current = window.setTimeout(flush, turnPause(text, settled));
  }, [flush]);

  /** The name was heard: stop the answer, and take what followed it. */
  const wakeUp = useCallback((tail: string, settled: boolean) => {
    awakeRef.current = true;
    setAwake(true);
    // First, before anything else: the microphone is the person's now.
    onInterrupt?.();
    pending.current = tail;
    live.current = "";
    setHeard(tail);
    /* Everything heard up to here is spent, so the engine's eventual final --
       which still carries the name -- does not hand it over twice. */
    acceptRef.current();
    arm(settled);
    /* Named and then nothing: the microphone does not stay open on a hope. This
       is the one way out of being awake, and it is the same flush that sends. */
    window.clearTimeout(wokeTimer.current);
    wokeTimer.current = window.setTimeout(() => {
      if (!pending.current && !live.current) flush();
    }, NAME_ONLY_IDLE_MS);
  }, [arm, onInterrupt, flush]);

  const onPhrase = useCallback((phrase: string) => {
    /* Nothing is awake yet, so what the engine heard is the room, or Autora's
       own answer coming back through the microphone. Only the name is meant as
       a request, and only at the start of what was heard. */
    if (!awakeRef.current) {
      const tail = afterName(phrase);
      if (tail === null) return;
      wakeUp(tail, true);
      return;
    }
    // Talking again, so the wait for a word that never came is off.
    window.clearTimeout(wokeTimer.current);
    pending.current = `${pending.current} ${phrase}`.trim();
    // Settled, so it is no longer in flight -- keeping both would say it twice.
    live.current = "";
    setHeard(pending.current);
    arm(true);
  }, [arm, wakeUp]);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, interim, supported, listening, error } = dictation;
  acceptRef.current = dictation.accept;
  /* Whether the engine actually opened is checked rather than assumed. A
     microphone that never started looks exactly like a quiet room -- the bar
     says the same words either way -- and a phone will refuse one without
     saying why. Tap-to-open then starts a fresh one, which is also the gesture
     the browser was waiting for. */
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  /* Words count as opened whatever the engine says about itself: on Android
     start-up is sometimes never announced, and a bar that admitted a dead
     microphone over words that plainly arrived would be worse than the wait. */
  const heardRef = useRef("");
  heardRef.current = heard;
  useEffect(() => {
    if (!supported || disabled) return;
    let timer = 0;
    const look = () => {
      if (listeningRef.current || heardRef.current) { setStalled(false); return; }
      setStalled(true);
      timer = window.setTimeout(look, MIC_CHECK_MS);
    };
    timer = window.setTimeout(look, MIC_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, [supported, disabled]);

  /* Stop then start: the hook ignores a start while one is already wanted, and
     a tap has to mean "open a new one" rather than "keep trying". */
  const openAgain = useCallback(() => {
    setStalled(false);
    stop();
    start();
  }, [start, stop]);


  /* The microphone opens with talk mode and closes with it -- nothing else in
     here starts or stops it. It used to follow the mark, held or tapped, and
     that is gone: the name is what decides whether what is heard is a request,
     so there is nothing left for a press to mean. */
  useEffect(() => {
    if (!supported || disabled) return;
    start();
    return () => stop();
  }, [supported, disabled, start, stop]);

  // Show the words forming as interim results stream in. What is heard before
  // the name is not shown and not kept: captioning the room, or Autora's own
  // answer, as if it were the person speaking is worse than silence.
  useEffect(() => {
    if (!interim) return;
    if (!awakeRef.current) {
      /* The name is the one thing in it worth acting on -- and on a phone it is
         often the one word the engine never settles on. */
      const tail = afterName(interim);
      if (tail !== null) wakeUp(tail, false);
      return;
    }
    live.current = interim;
    setHeard(`${pending.current} ${interim}`.trim());
    arm(false);
  }, [interim, arm, wakeUp]);

  useEffect(() => () => {
    window.clearTimeout(graceTimer.current);
    window.clearTimeout(wokeTimer.current);
  }, []);

  const trouble = error || camera.error;
  const status = trouble
    // The microphone has the floor: what was said is the bar.
    ? trouble
    : heard
      ? heard
      /* Nothing has been heard because nothing is listening. The instruction
         to say the name is not one the person can carry out, so the line says
         what is wrong instead of what to say. */
      : stalled
        ? "The microphone has not opened — tap here to try."
        : awake
        ? listening ? "Listening… it goes when you pause." : "Starting the microphone…"
        /* The whole instruction, and the same one while Autora speaks or works:
           the way to add to the conversation is to say the name, so the bar
           says that rather than reporting what the agent is doing -- which the
           thread above is already showing. */
        : WAKE_LINE;

  const lit = awake || agentSpeaking;
  /* Your own voice works the mark too: while the microphone is carrying your
     words the star glows and morphs, instead of only breathing. */
  const talking = lit || Boolean(heard);
  /* What the bar is doing, for the light it carries: the same vocabulary the
     rest of live mode uses, so the strip moves with the room rather than
     only with the mark. */
  const barState = agentSpeaking ? "speaking" : agentWorking ? "thinking" : "listening";

  // The strip you would type into becomes the live bar: the mark, the words as
  // they form, and the way back out -- and with live view on, the picture the
  // agent is being shown, running the whole width of it.
  return (
    <div className={`live-bar${view ? " has-view" : ""}`} data-state={barState} role="group" aria-label="Live voice chat">
      {/* A lamp, not a button. There is nothing to press any more -- the name
          is the whole of it -- and a control that does nothing is worse than a
          light that says something. The status line beside it carries the
          words for anyone not reading the light. */}
      <span
        className={`mob-live-btn live-bar-orb is-${talking ? "working" : "live"} ${awake ? "is-awake" : ""}`}
        aria-hidden="true"
      >
        <span className="mob-live-glow" aria-hidden="true" />
        {/* 54 was 46: at 46 the triangle inside the 60px disc was about 27px
            across and read as a detail of the disc rather than as the mark.
            The box can grow without touching the disc because a triangle only
            fills a little over half of its own box. */}
        <AutoraMark state={talking ? "working" : "live"} size={54} />
      </span>
      {view && (
        /* The person's own half of live view: what the camera has, filling the
           bar, drawn here and sent nowhere. Tap it to turn the camera around. */
        <button
          type="button"
          className={`live-bar-peek ${camera.facing === "user" ? "is-mirror" : ""}`}
          onClick={camera.flip}
          title="Turn the camera around"
          aria-label="Turn the camera around"
        >
          <video ref={camera.attach} muted playsInline />
        </button>
      )}
      {view && (
        /* A wash over the picture: the same bar carries the preview and the
           words, so both need something to sit on. */
        <span className="live-bar-scrim" aria-hidden="true" />
      )}
      <div className="live-bar-text">
        {stalled && !trouble ? (
          /* A button where the words are, for the one thing that helps: the
             microphone is not open and the person is the only one who can
             open it. */
          <button type="button" className="live-bar-status is-trouble is-tap" onClick={openAgain}>
            {status}
          </button>
        ) : (
          <span className={`live-bar-status ${heard ? "is-heard" : ""} ${trouble ? "is-trouble" : ""}`} aria-live="polite">
            {status}
          </span>
        )}
      </div>
      {/* No Stop button here. It was a red badge parked in the bar while the
          agent worked -- the one thing on screen that looked like an error.
          To stop a spoken turn, say stop -- which is to say it after the name,
          or say the name and then stop -- or close the chat; /stop still works
          when typing, and the composer's own Stop has not moved. */}
      {/* And no Hold/Open switch. Whether the microphone was open was a mode
          the person had to hold in their head and set before speaking; it is
          open now, and the name is what it listens for. */}
      {/* The way back out, at the top right of the bar: an X where the eye
          expects one. Closing the chat or pressing v both still work, but
          neither is something you can see, and in talk mode there is no
          composer to look at -- the X is the one visible way back to typing. */}
      {onClose && (
        <button
          type="button"
          className="btn live-bar-exit"
          onClick={onClose}
          title="Back to typing"
          aria-label="Leave live voice and go back to typing"
        >
          <IconX size={15} />
        </button>
      )}
      {/* No icons along the bar. The camera switch and the way out were two
          pictures sitting next to the mark, which is itself the one thing on
          this strip worth looking at; the bar is the mark and the words now.
          The camera moves to Settings (liveView), and live mode ends the way
          it did anyway: close the chat, or press v. */}
    </div>
  );
}
