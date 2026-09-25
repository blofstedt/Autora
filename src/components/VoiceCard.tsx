import { useEffect, useRef, useState } from "react";
import { chooseSpeechUrl, chooseVoice, fetchSpeechStatus, type SpeechStatus } from "../lib/voice";

/**
 * The console's voice: which voice server it speaks through (Kokoro, found on
 * its own or at an address given here), and which of that server's voices.
 *
 * Config rather than the Themes menu: this is a connection to another service
 * with an address, a status and an error to read, not a matter of taste, and
 * it sat beside the colours only because the voice picker came first.
 */
export function VoiceCard() {
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [address, setAddress] = useState("");
  const [complaint, setComplaint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const sample = useRef<HTMLAudioElement | null>(null);

  const refresh = async () => {
    const status = await fetchSpeechStatus();
    setSpeech(status);
    setAddress(status?.configured ?? "");
    setLoaded(true);
  };

  useEffect(() => {
    let alive = true;
    void fetchSpeechStatus().then((status) => {
      if (!alive) return;
      setSpeech(status);
      setAddress(status?.configured ?? "");
      setLoaded(true);
    });
    return () => {
      alive = false;
      sample.current?.pause();
    };
  }, []);

  const pickVoice = (voice: string) => {
    if (!speech) return;
    setSpeech({ ...speech, voice });
    setComplaint(null);
    void chooseVoice(voice).then((result) => {
      if (!result.ok) setComplaint(result.detail ?? "That voice could not be saved.");
    });
  };

  const saveAddress = async () => {
    if (address.trim() === (speech?.configured ?? "")) return;
    setBusy(true);
    setComplaint(null);
    const result = await chooseSpeechUrl(address.trim());
    if (!result.ok) setComplaint(result.detail ?? "That address could not be saved.");
    await refresh();
    setBusy(false);
  };

  /** One sentence in the chosen voice, played here, so a choice can be heard
      before it is the voice of every reply. */
  const playSample = async () => {
    setComplaint(null);
    setPlaying(true);
    try {
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hello. This is how I sound.", voice: speech?.voice }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `The voice server answered ${res.status}.`);
      }
      const url = URL.createObjectURL(await res.blob());
      sample.current?.pause();
      const audio = new Audio(url);
      sample.current = audio;
      const done = () => { URL.revokeObjectURL(url); setPlaying(false); };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
    } catch (err: any) {
      setComplaint(String(err?.message ?? err));
      setPlaying(false);
    }
  };

  return (
    <section className="set-card">
      <h3>Voice</h3>
      <p className="jf-hint">
        Replies read aloud, and anything Autora is asked to say, play straight
        from here in this voice on every device. Kokoro is found on its own
        when it runs on the same Umbrel; with no voice server, the browser's
        own voice is used.
      </p>

      <label className="voice-field">
        <span className="tool-label">Voice server</span>
        <input
          type="url"
          value={address}
          placeholder={speech?.url ?? "Found automatically (e.g. http://kokoro_web_1:8880)"}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => void saveAddress()}
          onKeyDown={(e) => { if (e.key === "Enter") void saveAddress(); }}
          disabled={busy}
          aria-label="Voice server address"
        />
      </label>

      {!loaded ? (
        <p className="set-note">Asking for the voice server…</p>
      ) : speech?.available ? (
        <>
          <div className="voice-row">
            <select
              className="sm-voice"
              aria-label="The voice Autora speaks in"
              value={speech.voice}
              onChange={(e) => pickVoice(e.target.value)}
            >
              {!speech.voices.some((v) => v.id === speech.voice) && (
                <option value={speech.voice}>{speech.voice}</option>
              )}
              {speech.voices.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => void playSample()} disabled={playing}>
              {playing ? "Playing…" : "Play a sample"}
            </button>
          </div>
          <p className="set-note">Speaking through {speech.url}.</p>
        </>
      ) : (
        <p className="set-note">
          {speech?.reason ?? "The console could not be asked about its voice."}
        </p>
      )}
      {complaint && <p className="set-warn">{complaint}</p>}
    </section>
  );
}
