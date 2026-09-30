import { useEffect, useState } from "react";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../lib/webpush";

/**
 * Where news reaches the person's phone: the installed app itself.
 *
 * Everything the console does by itself -- a schedule that ran, something it
 * noticed, a long task that finished, a question only the person can answer
 * -- used to wait for them to open the app. This is the card that lets it
 * reach them instead. The app is the phone interface, so it is also what
 * notifies: one switch per device, and which kinds of news to send. There is
 * no other service to sign in to. See server/push.ts and server/webpush.ts.
 */
type Push = {
  on: { jobs: boolean; notices: boolean; turns: boolean; asks: boolean };
  ready: string[];
  /** The key a device subscribes with, and the devices that have. */
  web: { publicKey: string; devices: { endpoint: string; label: string; added: number }[] };
};

async function load(): Promise<Push | null> {
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    return res.ok ? ((await res.json())?.push ?? null) : null;
  } catch {
    return null;
  }
}

async function save(patch: Record<string, unknown>): Promise<Push | null> {
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ push: patch }),
    });
    return res.ok ? ((await res.json())?.push ?? null) : null;
  } catch {
    return null;
  }
}

const NEWS: { key: keyof Push["on"]; label: string; hint: string }[] = [
  { key: "asks", label: "When it needs you", hint: "A code, a choice or a sign-in, while you are away." },
  { key: "jobs", label: "Schedules, watchers and triggers", hint: "When one finishes or fails." },
  { key: "notices", label: "Things it notices", hint: "A disk filling up, an app that keeps restarting." },
  { key: "turns", label: "A long task finishing", hint: "When it took a while and nobody was looking." },
];

export function NotifyCard() {
  const [push, setPush] = useState<Push | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether this browser is subscribed, and if it cannot be, why. */
  const [here, setHere] = useState<boolean | null>(null);
  const support = pushSupport();

  useEffect(() => {
    let alive = true;
    void load().then((found) => {
      if (!alive) return;
      if (found) setPush(found);
      setLoaded(true);
    });
    void currentSubscription().then((sub) => { if (alive) setHere(Boolean(sub)); });
    return () => { alive = false; };
  }, []);

  /** Turn notifications on or off for this device, then read the settings
      again so the list of devices and what is ready are the server's word. */
  const toggleHere = async (on: boolean) => {
    if (!push) return;
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        const done = await enablePush(push.web.publicKey);
        if (!done.ok) setNote(done.error);
      } else {
        await disablePush();
      }
      setHere(Boolean(await currentSubscription()));
      const next = await load();
      if (next) setPush(next);
    } finally {
      setBusy(false);
    }
  };

  const change = (patch: Record<string, unknown>) => {
    setNote(null);
    void save(patch).then((next) => (next ? setPush(next) : setNote("That could not be saved.")));
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNote(body?.error ?? "That did not work.");
      else {
        const results: { ok: boolean; error?: string }[] = body.results ?? [];
        setNote(results.map((r) => (r.ok ? "Sent." : r.error)).join(" "));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <section className="set-card">
        <h3>Phone notifications</h3>
        <p className="jf-hint">Reading the settings…</p>
      </section>
    );
  }
  if (!push) {
    return (
      <section className="set-card">
        <h3>Phone notifications</h3>
        <p className="set-warn">The settings could not be read.</p>
      </section>
    );
  }

  return (
    <section className="set-card notify-card">
      <h3>Phone notifications</h3>
      <p className="jf-hint">
        Autora can tell you when it needs you, when a schedule runs, when it notices something, and when a long task
        finishes while you are away. A line or two each; the chat has the rest, one tap away. Nothing is sent during
        your quiet hours: it is held, and arrives as one message when they end.
      </p>

      <label className="set-check">
        <input
          type="checkbox"
          checked={here === true}
          disabled={busy || here === null || !support.ok}
          onChange={(e) => void toggleHere(e.target.checked)}
        />
        <span>
          Notify this device
          <em>
            {support.ok
              ? "Straight from Autora to this phone or computer, with the app closed. Nothing else to install, and what is sent is readable only here."
              : support.reason}
          </em>
        </span>
      </label>
      {push.web.devices.length > 0 && (
        <p className="jf-hint">Notifying {push.web.devices.map((d) => d.label).join(", ")}.</p>
      )}

      {push.web.devices.length > 0 && (
        <>
          <div className="notify-news">
            <span className="notify-news-head">What to send</span>
            {NEWS.map((n) => (
              <label key={n.key} className="set-check">
                <input type="checkbox" checked={push.on[n.key]} onChange={(e) => change({ on: { [n.key]: e.target.checked } })} />
                <span>
                  {n.label}
                  <em>{n.hint}</em>
                </span>
              </label>
            ))}
          </div>
          <div className="row-actions">
            <button type="button" className="btn tiny" disabled={busy || push.ready.length === 0} onClick={() => void test()}>
              Send a test
            </button>
          </div>
        </>
      )}
      {note && <p className="jf-hint notify-note" role="status">{note}</p>}
    </section>
  );
}
