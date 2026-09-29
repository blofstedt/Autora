import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { chooseTalk, fetchSpeechStatus, turnPause, useDictation } from "../lib/voice";
import { useLiveView } from "../lib/liveview";
import { AutoraMark } from "./AutoraMark";
import { IconX } from "./Icons";

/** Single stray syllables are usually the room, not a request. */
const MIN_CHARS = 2;

/** How long after you let go to wait for the engine to settle the last words
    before sending what it had. Chrome on Android may never settle them. */
const RELEASE_GRACE_MS = 1200;

/**
 * Live voice, in place of the composer.
 *
 * The screen above does not change: the same thread, the same stage, the same
 * steps scrolling past. Only the strip you would normally type into becomes
 * the conversation -- which is the whole point, because the reason to talk to
 * this thing is to watch it work while your hands are somewhere else.
 *
 * Two things about that strip are the person's to choose, and both are here
 * rather than buried in Settings, because they are the kind of thing that
 * depends on the room you are in:
 *
 *  - How the microphone works. Holding the mark is the default and is
 *    unambiguous: nothing is heard unless you are pressing, and pressing cuts
 *    the agent off mid-sentence. Hands-free keeps it open and sends what it
 *    hears after a pause -- for when the hands really are busy -- and closes
 *    itself while Autora is speaking, because the microphone would otherwise
 *    hear the answer and send it back as a question.
 *  - Whether the camera is on. Off by default. On, it is two things: a small
 *    live picture in the bar for the person, and a stream at about a frame a
 *    second for the agent, so "look at this" arrives with the thing being
 *    shown. Both are switched off together the moment talk mode ends.
 */
export function LiveChat({
  onUtterance,
  onInterrupt,
  sessionId,
  agentSpeaking,
  agentWorking,
  agentDoing,
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
  /** What it is on, in a few words, when it is working. */
  agentDoing?: string | null;
  disabled?: boolean;
  /** Back to typing: the X at the end of the bar. */
  onClose?: () => void;
}) {
  /** Phrases the engine has committed to. */
  const pending = useRef("");
  /** The phrase still forming, which may never be committed to at all. */
  const live = useRef("");
  /** Set between letting go and sending, while the last words settle. */
  const releasing = useRef(false);
  const graceTimer = useRef(0);
  const utteranceRef = useRef(onUtterance);
  utteranceRef.current = onUtterance;

  /** Set once the hook below exists; sending unsettled words is only half the
      job without it -- see `accept` in lib/voice. */
  const acceptRef = useRef<() => void>(() => {});
  /** What will go out when you let go, shown so you can see it forming. */
  const [heard, setHeard] = useState("");
  const [holding, setHolding] = useState(false);

  /** Hands-free: the microphone stays open, and what it hears goes after a
      pause rather than at the end of a press. Remembered between devices. */
  const [handsFree, setHandsFree] = useState(false);
  /** Live view: the camera, and the frames the agent is shown. Remembered
      the same way. */
  const [view, setView] = useState(false);
  /** A switch that could not be saved is said here rather than swallowed. */
  const [complaint, setComplaint] = useState<string | null>(null);
  /** The person chose something before the saved settings arrived. */
  const touched = useRef(false);
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;

  const camera = useLiveView(sessionId, view);

  /* What talk mode opened as last time. Applied only if nothing has been
     touched yet: the saved answer is not worth more than the switch somebody
     just flicked. */
  useEffect(() => {
    let alive = true;
    void fetchSpeechStatus().then((status) => {
      if (!alive || !status || touched.current) return;
      setView(status.liveView === true);
      setHandsFree(status.handsFree === true);
    });
    return () => { alive = false; };
  }, []);

  /** Send what we have, settled or not. */
  const flush = useCallback(() => {
    window.clearTimeout(graceTimer.current);
    releasing.current = false;
    const text = `${pending.current} ${live.current}`.trim();
    pending.current = "";
    live.current = "";
    setHeard("");
    // These words are spent, settled or not. Without this the engine's
    // eventual final still carries the ones just sent, and they go out again.
    acceptRef.current();
    if (text.length >= MIN_CHARS) {
      utteranceRef.current(text);
    }
  }, []);

  /** Hands-free sends after a pause, not at the end of a press: the wait is
      tuned in lib/voice, where a sentence that trails off mid-thought waits
      longer than one that has finished. */
  const arm = useCallback((settled: boolean) => {
    if (!handsFreeRef.current) return;
    window.clearTimeout(graceTimer.current);
    const text = `${pending.current} ${live.current}`.trim();
    if (text.length < MIN_CHARS) return;
    graceTimer.current = window.setTimeout(flush, turnPause(text, settled));
  }, [flush]);

  const onPhrase = useCallback((phrase: string) => {
    pending.current = `${pending.current} ${phrase}`.trim();
    // Settled, so it is no longer in flight -- keeping both would say it twice.
    live.current = "";
    setHeard(pending.current);
    arm(true);
  }, [arm]);

  const dictation = useDictation({ onPhrase, continuous: true });
  const { start, stop, interim, supported, listening, error } = dictation;
  acceptRef.current = dictation.accept;

  // Show the words forming as interim results stream in. In hands-free a
  // phrase still forming is not a phrase to send: it re-arms the longer wait
  // instead, so talking over the pause does not get cut in half.
  useEffect(() => {
    if (!interim) return;
    live.current = interim;
    setHeard(`${pending.current} ${interim}`.trim());
    arm(false);
  }, [interim, arm]);

  // Once the engine has closed after you let go, everything it was going to
  // settle has settled: send it now rather than waiting out the grace.
  useEffect(() => {
    if (!listening && releasing.current) flush();
  }, [listening, flush]);

  const press = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || !supported || event.button > 0) return;
    event.preventDefault();
    if (handsFree) {
      /* A tap, not a hold: this opens the microphone, and the next tap closes
         it and sends what was heard. It also cuts the agent off, which is what
         makes talking over it work. */
      if (holding) {
        setHolding(false);
        stop();
        flush();
        return;
      }
    } else {
      // Keep the release even if the finger slides off the mark.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    }
    // Still settling the last thing you said: send it before starting again.
    if (releasing.current) flush();
    onInterrupt?.();
    setHolding(true);
    start();
  }, [disabled, supported, handsFree, holding, stop, flush, onInterrupt, start]);

  const release = useCallback(() => {
    if (!holding) return;
    setHolding(false);
    releasing.current = true;
    stop();
    window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(flush, RELEASE_GRACE_MS);
  }, [holding, stop, flush]);

  /* Autora talking into an open microphone is a loop: it hears the answer and
     sends it back as a question. The microphone closes for the length of the
     reply, and the mark is still there to talk over it with. */
  useEffect(() => {
    if (!handsFree || !holding || !agentSpeaking) return;
    setHolding(false);
    stop();
    flush();
  }, [handsFree, holding, agentSpeaking, stop, flush]);

  // Hands-free switched off mid-sentence: close the microphone and send it.
  useEffect(() => {
    if (handsFree || !holding) return;
    setHolding(false);
    stop();
    flush();
  }, [handsFree, holding, stop, flush]);

  // Losing the page (or live mode going read-only) mid-hold is a release.
  useEffect(() => {
    if (disabled && holding) release();
  }, [disabled, holding, release]);

  useEffect(() => () => {
    window.clearTimeout(graceTimer.current);
  }, []);

  /** A switch, saved for the next time talk mode opens. */
  const pick = (next: { liveView?: boolean; handsFree?: boolean }) => {
    touched.current = true;
    setComplaint(null);
    if (next.liveView !== undefined) setView(next.liveView);
    if (next.handsFree !== undefined) setHandsFree(next.handsFree);
    void chooseTalk(next).then((result) => {
      if (!result.ok) setComplaint(result.detail ?? "That could not be saved.");
    });
  };

  const hint = handsFree ? "Tap the mark to talk." : "Hold the mark to talk.";
  const trouble = error || camera.error || complaint;
  const status = trouble
    ? trouble
    : heard
      ? heard
      : holding
        ? listening
          ? handsFree ? "Listening… it goes when you stop." : "Listening… let go to send."
          : "Starting the microphone…"
        : agentSpeaking
          ? `Autora is speaking. ${hint}`
          : agentWorking
            ? `${agentDoing || "Autora is working"}. ${hint}`
            : hint;

  const lit = holding || agentSpeaking;
  /* Your own voice works the mark too: while the microphone is carrying your
     words the star glows and morphs, instead of only breathing. */
  const talking = lit || Boolean(heard);
  /* What the bar is doing, for the light it carries: the same vocabulary the
     rest of live mode uses, so the strip moves with the room rather than
     only with the mark. */
  const barState = agentSpeaking ? "speaking" : agentWorking ? "thinking" : "listening";

  // The strip you would type into becomes the live bar: the mark, the words as
  // they form, the two switches, and the way back out -- and with live view on,
  // the picture the agent is being shown, running the whole width of it.
  return (
    <div className={`live-bar${view ? " has-view" : ""}`} data-state={barState} role="group" aria-label="Live voice chat">
      <button
        type="button"
        className={`mob-live-btn live-bar-orb is-${talking ? "working" : "live"} ${holding ? "is-holding" : ""}`}
        onPointerDown={press}
        onPointerUp={() => { if (!handsFree) release(); }}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
        disabled={disabled || !supported}
        title={handsFree ? "Tap to talk, tap again to send" : "Hold to talk"}
        aria-label={handsFree ? "Tap to talk, tap again to send" : "Hold to talk"}
        aria-pressed={holding}
      >
        <span className="mob-live-glow" aria-hidden="true" />
        {/* 54 was 46: at 46 the triangle inside the 60px disc was about 27px
            across and read as a detail of the disc rather than as the mark.
            The box can grow without touching the disc because a triangle only
            fills a little over half of its own box. */}
        <AutoraMark state={talking ? "working" : "live"} size={54} />
      </button>
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
        /* A wash over the picture: the same bar carries the preview, the words
           and the switches, so all of them need something to sit on. */
        <span className="live-bar-scrim" aria-hidden="true" />
      )}
      <div className="live-bar-text">
        <span className={`live-bar-status ${heard ? "is-heard" : ""} ${trouble ? "is-trouble" : ""}`} aria-live="polite">
          {status}
        </span>
      </div>
      {/* No Stop button here. It was a red badge parked in the bar while the
          agent worked -- the one thing on screen that looked like an error.
          To stop a spoken turn, say stop or close the chat; /stop still works
          when typing, and the composer's own Stop has not moved. */}
      <button
        type="button"
        className={`btn live-bar-switch ${handsFree ? "is-on" : ""}`}
        onClick={() => pick({ handsFree: !handsFree })}
        title={handsFree ? "The microphone stays open" : "The mark has to be held"}
        aria-pressed={handsFree}
      >
        {handsFree ? "Open" : "Hold"}
      </button>
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
          this strip worth looking at; the bar is the mark, the words and the
          Hold/Open switch now. The camera moves to Settings (liveView), and
          live mode ends the way it did anyway: close the chat, or press v. */}    </div>
  );
}
