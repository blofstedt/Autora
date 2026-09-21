import { useCallback, useRef, useState } from "react";
import { recognitionAvailable, secureOrigin, speechEngine } from "../lib/voice";

/**
 * What the speech engine is actually doing, in words.
 *
 * Dictation fails silently: the engine starts, reports no error, and never
 * returns a phrase. From the outside that is indistinguishable from the
 * feature not existing, and three plausible causes -- a second microphone
 * stream, a permission Chrome remembers as denied, a speech service that is
 * not installed -- produce exactly the same nothing.
 *
 * So this drives the browser's recognition directly, around `useDictation`,
 * and prints every event it emits. The order tells you where the chain breaks:
 * `onstart` alone means the engine never got audio; `audiostart` without
 * `speechstart` means it got audio with no voice in it; `speechstart` without
 * a result means it heard you and could not transcribe. Those want completely
 * different fixes, and guessing between them has cost enough already.
 */
export function VoiceCheck() {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const engine = useRef<InstanceType<NonNullable<ReturnType<typeof speechEngine>>> | null>(null);

  const log = useCallback((text: string) => {
    const at = new Date().toISOString().slice(14, 23);
    setLines((all) => [...all.slice(-60), `${at}  ${text}`]);
  }, []);

  const run = useCallback(async () => {
    setLines([]);
    log(`secure page        ${secureOrigin}`);
    log(`engine present     ${recognitionAvailable}`);
    log(`language           ${navigator.language || "?"}`);
    log(`getUserMedia       ${!!navigator.mediaDevices?.getUserMedia}`);
    try {
      const status = await (navigator as unknown as {
        permissions?: { query: (d: { name: string }) => Promise<{ state: string }> };
      }).permissions?.query({ name: "microphone" });
      log(`mic permission     ${status?.state ?? "not reported"}`);
    } catch (err) {
      log(`mic permission     could not ask (${String(err).slice(0, 60)})`);
    }

    const Engine = speechEngine();
    if (!Engine) {
      log("no recognition engine in this browser — nothing to test");
      return;
    }

    const recogniser = new Engine();
    engine.current = recogniser;
    recogniser.lang = navigator.language || "en-US";
    recogniser.continuous = false;
    recogniser.interimResults = true;
    recogniser.maxAlternatives = 1;

    recogniser.onstart = () => log("EVENT start        engine accepted the request");
    recogniser.onaudiostart = () => log("EVENT audiostart   audio is reaching it");
    recogniser.onsoundstart = () => log("EVENT soundstart   there is sound in the audio");
    recogniser.onspeechstart = () => log("EVENT speechstart  it thinks that sound is speech");
    recogniser.onspeechend = () => log("EVENT speechend");
    recogniser.onaudioend = () => log("EVENT audioend");
    recogniser.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const phrase = event.results[i];
        const text = phrase[0]?.transcript ?? "";
        log(`EVENT result       ${phrase.isFinal ? "final" : "interim"}: "${text}"`);
      }
    };
    recogniser.onerror = (event) => log(`EVENT error        ${event.error}`);
    recogniser.onend = () => {
      log("EVENT end          session over");
      setRunning(false);
    };

    try {
      recogniser.start();
      setRunning(true);
      log("start() returned   now say something for a few seconds");
    } catch (err) {
      log(`start() threw      ${String(err).slice(0, 120)}`);
    }
  }, [log]);

  const halt = useCallback(() => {
    try {
      engine.current?.stop();
    } catch {
      // Nothing running.
    }
    setRunning(false);
  }, []);

  // Deliberately still rendered when there is no engine. Hiding the
  // controls that depend on speech is defensible; hiding the panel whose
  // entire job is to explain why they do not work is the same instinct one
  // level up, and it turns a useful answer into "there is nothing in
  // Settings".
  return (
    <section className="set-card">
      <h3>Microphone check</h3>
      <p className="jf-hint">
        Runs the browser's own speech recognition and prints every step. Tap
        below, then say a sentence out loud.
      </p>
      {!recognitionAvailable && (
        <p className="set-warn">
          This browser has no speech recognition, so dictation and live chat
          cannot work in it whatever else is configured. Reading replies aloud
          is a different feature and is unaffected.
        </p>
      )}
      <div className="set-choices">
        <button className="btn primary" onClick={() => void run()} disabled={running}>
          {running ? "Listening…" : "Run check"}
        </button>
        {running && <button className="btn ghost" onClick={halt}>Stop</button>}
      </div>
      {lines.length > 0 && (
        <pre className="voice-check-log">{lines.join("\n")}</pre>
      )}
    </section>
  );
}
