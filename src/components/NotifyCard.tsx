import { useEffect, useState } from "react";

/**
 * Where news reaches the person's phone: ntfy, Telegram, and which news.
 *
 * Everything the console does by itself -- a schedule that ran, something it
 * noticed, a long task that finished, a question only the person can answer
 * -- used to wait for them to open the app. This is the card that lets it
 * reach them instead. The two tokens are write-only here, like every key in
 * Settings: typed in, saved to the secret store, never shown again beyond a
 * masked tail. See server/push.ts.
 */
type TokenState = { set: boolean; source: "app" | "env" | null; masked: string };
type Push = {
  ntfy: { enabled: boolean; server: string; topic: string };
  telegram: { enabled: boolean; chat: string };
  on: { jobs: boolean; notices: boolean; turns: boolean; asks: boolean };
  tokens: { ntfy: TokenState; telegram: TokenState };
  ready: string[];
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

/** A topic nobody will guess: on ntfy.sh the name is the only lock. */
function randomTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `autora-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12)}`;
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
  const [server, setServer] = useState("");
  const [topic, setTopic] = useState("");
  const [chat, setChat] = useState("");
  const [ntfyToken, setNtfyToken] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [chats, setChats] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const take = (next: Push | null) => {
    if (!next) {
      setNote("That could not be saved.");
      return;
    }
    setPush(next);
    setServer(next.ntfy.server);
    setTopic(next.ntfy.topic);
    setChat(next.telegram.chat);
  };

  useEffect(() => {
    let alive = true;
    void load().then((found) => {
      if (!alive) return;
      if (found) take(found);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const change = (patch: Record<string, unknown>) => {
    setNote(null);
    void save(patch).then(take);
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNote(body?.error ?? "That did not work.");
      else {
        const results: { channel: string; ok: boolean; error?: string }[] = body.results ?? [];
        setNote(results.map((r) => (r.ok ? `Sent to ${r.channel}.` : `${r.channel}: ${r.error}`)).join(" "));
      }
    } finally {
      setBusy(false);
    }
  };

  const findChat = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/push/telegram/chats", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setNote(body?.error ?? "That did not work.");
      const found: { id: string; name: string }[] = body.chats ?? [];
      if (found.length === 0) return setNote("Nobody has written to the bot yet. Send it any message, then try again.");
      if (found.length === 1) {
        setChat(found[0].id);
        change({ telegram: { chat: found[0].id } });
        return setNote(`Found ${found[0].name}.`);
      }
      setChats(found);
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

  const tokenHint = (t: TokenState, fallback: string) =>
    t.set ? (t.source === "env" ? `From the server's environment (${t.masked})` : `Saved (${t.masked}) — type to replace`) : fallback;

  return (
    <section className="set-card notify-card">
      <h3>Phone notifications</h3>
      <p className="jf-hint">
        Autora can tell your phone when it needs you, when a schedule runs, when it notices something, and when a long
        task finishes while you are away. A line or two each; the chat has the rest, one tap away. Nothing is sent during
        your quiet hours: it is held, and arrives as one message when they end.
      </p>

      <label className="set-check">
        <input type="checkbox" checked={push.ntfy.enabled} onChange={(e) => change({ ntfy: { enabled: e.target.checked } })} />
        <span>
          Send to ntfy
          <em>A free app for your phone. Subscribe to a topic and messages arrive there.</em>
        </span>
      </label>
      {push.ntfy.enabled && (
        <div className="notify-fields">
          <label className="jf-row">
            <span>Server</span>
            <input
              value={server}
              placeholder="https://ntfy.sh"
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => server !== push.ntfy.server && change({ ntfy: { server } })}
            />
          </label>
          <label className="jf-row">
            <span>Topic</span>
            <span className="notify-inline">
              <input
                value={topic}
                placeholder="autora-…"
                onChange={(e) => setTopic(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
                onBlur={() => topic !== push.ntfy.topic && change({ ntfy: { topic } })}
              />
              <button
                type="button"
                className="btn tiny"
                onClick={() => { const t = randomTopic(); setTopic(t); change({ ntfy: { topic: t } }); }}
              >
                Pick one for me
              </button>
            </span>
          </label>
          <p className="jf-hint">
            In the ntfy app, subscribe to this topic{push.ntfy.server !== "https://ntfy.sh" ? ` on ${push.ntfy.server}` : ""}.
            On ntfy.sh anyone who knows a topic's name can read it, so keep it one nobody would guess — or run ntfy on
            your own server (it is in the Umbrel app store).
          </p>
          <label className="jf-row">
            <span>Access token (only for a protected topic)</span>
            <input
              type="password"
              autoComplete="off"
              value={ntfyToken}
              placeholder={tokenHint(push.tokens.ntfy, "Leave empty for a public topic")}
              onChange={(e) => setNtfyToken(e.target.value)}
              onBlur={() => { if (ntfyToken.trim()) { change({ ntfy_token: ntfyToken.trim() }); setNtfyToken(""); } }}
            />
          </label>
        </div>
      )}

      <label className="set-check">
        <input type="checkbox" checked={push.telegram.enabled} onChange={(e) => change({ telegram: { enabled: e.target.checked } })} />
        <span>
          Send to Telegram
          <em>Through a bot of your own, which messages you.</em>
        </span>
      </label>
      {push.telegram.enabled && (
        <div className="notify-fields">
          <label className="jf-row">
            <span>Bot token</span>
            <input
              type="password"
              autoComplete="off"
              value={tgToken}
              placeholder={tokenHint(push.tokens.telegram, "From @BotFather: 123456:ABC…")}
              onChange={(e) => setTgToken(e.target.value)}
              onBlur={() => { if (tgToken.trim()) { change({ telegram_token: tgToken.trim() }); setTgToken(""); } }}
            />
          </label>
          <p className="jf-hint">
            Make a bot by messaging @BotFather in Telegram and sending /newbot; it gives you the token. Then send your
            new bot any message, and press Find my chat.
          </p>
          <label className="jf-row">
            <span>Your chat</span>
            <span className="notify-inline">
              <input
                value={chat}
                placeholder="Found for you, or a chat id"
                onChange={(e) => setChat(e.target.value.trim())}
                onBlur={() => chat !== push.telegram.chat && change({ telegram: { chat } })}
              />
              <button type="button" className="btn tiny" disabled={busy || !push.tokens.telegram.set} onClick={() => void findChat()}>
                Find my chat
              </button>
            </span>
          </label>
          {chats && (
            <div className="notify-chats">
              {chats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`btn tiny ${chat === c.id ? "primary" : ""}`}
                  onClick={() => { setChat(c.id); setChats(null); change({ telegram: { chat: c.id } }); }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {(push.ntfy.enabled || push.telegram.enabled) && (
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
            <span className="set-note">
              {push.ready.length === 0
                ? "Fill in the fields above to start sending."
                : `Ready: ${push.ready.join(" and ")}.`}
            </span>
          </div>
        </>
      )}
      {note && <p className="jf-hint notify-note" role="status">{note}</p>}
    </section>
  );
}
