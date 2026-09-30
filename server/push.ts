/**
 * Reaching the person's phone.
 *
 * Everything the console does on its own -- a schedule that ran, a watcher
 * that saw a change, something it noticed, a long task finishing, a question
 * only the person can answer -- used to wait for them to open the app. A
 * phone that buzzes when it matters is most of what makes an agent feel like
 * it is there when you are not.
 *
 * Two ways, both a single HTTP request and neither needing the app to be on
 * https (which browser push would):
 *
 *  - ntfy: a topic on ntfy.sh or a server of their own (ntfy is in the
 *    Umbrel app store). The phone app subscribes to the topic. An access
 *    token is optional, for a protected topic.
 *  - Telegram: a bot of their own, which messages them.
 *
 * The tokens are secrets and live in the secret store (so every log, event
 * and prompt blanks them); only these settings are here. A token goes to its
 * own service and nowhere else: ntfy's to the server named here, the bot's to
 * api.telegram.org.
 *
 * Quiet hours hold, not drop: what arrives inside them is kept and sent as
 * one message when the window ends. What is sent is only a line or two --
 * the thread has the rest, one tap away.
 */

export interface PushSettings {
  ntfy: { enabled: boolean; server: string; topic: string };
  telegram: { enabled: boolean; chat: string };
  /** Which kinds of news are sent. */
  on: { jobs: boolean; notices: boolean; turns: boolean; asks: boolean };
}

export type PushKind = keyof PushSettings["on"];

export const DEFAULT_PUSH: PushSettings = {
  ntfy: { enabled: false, server: "https://ntfy.sh", topic: "" },
  telegram: { enabled: false, chat: "" },
  on: { jobs: true, notices: true, turns: true, asks: true },
};

/** The names the tokens are kept under in the secret store. */
export const NTFY_TOKEN = "NTFY_TOKEN";
export const TELEGRAM_TOKEN = "TELEGRAM_BOT_TOKEN";

export function defaultPush(): PushSettings {
  return {
    ntfy: { ...DEFAULT_PUSH.ntfy },
    telegram: { ...DEFAULT_PUSH.telegram },
    on: { ...DEFAULT_PUSH.on },
  };
}

/** An http(s) address with no path, query or credentials, or null. */
export function cleanServer(value: unknown): string | null {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Field by field, like every other settings merge: nonsense leaves the old value. */
export function mergePush(current: PushSettings, patch: any): PushSettings {
  if (!patch || typeof patch !== "object") return current;
  const n = patch.ntfy;
  if (n && typeof n === "object") {
    if (typeof n.enabled === "boolean") current.ntfy.enabled = n.enabled;
    if (n.server !== undefined) {
      const server = cleanServer(n.server);
      if (server) current.ntfy.server = server;
    }
    if (typeof n.topic === "string") {
      const topic = n.topic.trim();
      // ntfy's own rule for a topic name.
      if (topic === "" || /^[A-Za-z0-9_-]{1,64}$/.test(topic)) current.ntfy.topic = topic;
    }
  }
  const t = patch.telegram;
  if (t && typeof t === "object") {
    if (typeof t.enabled === "boolean") current.telegram.enabled = t.enabled;
    if (typeof t.chat === "string" || typeof t.chat === "number") {
      const chat = String(t.chat).trim();
      if (chat === "" || /^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(chat)) current.telegram.chat = chat;
    }
  }
  const on = patch.on;
  if (on && typeof on === "object") {
    for (const key of Object.keys(DEFAULT_PUSH.on) as PushKind[]) {
      if (typeof on[key] === "boolean") current.on[key] = on[key];
    }
  }
  return current;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where a tap goes: the thread it is about, or the app. */
  url?: string | null;
  /** Something that needs the person, not just news. */
  urgent?: boolean;
}

export interface PushTokens {
  ntfy: string;
  telegram: string;
}

/** Which channels can send right now. */
export function readyChannels(p: PushSettings, tokens: PushTokens): ("ntfy" | "telegram")[] {
  const out: ("ntfy" | "telegram")[] = [];
  if (p.ntfy.enabled && p.ntfy.topic && cleanServer(p.ntfy.server)) out.push("ntfy");
  if (p.telegram.enabled && p.telegram.chat && tokens.telegram) out.push("telegram");
  return out;
}

export interface Delivery {
  channel: "ntfy" | "telegram";
  ok: boolean;
  error?: string;
}

type Fetch = typeof fetch;

/** Shorter than any phone shows, and never a whole thread. */
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Send one message on every channel that is set up. Never throws: a phone
 * that could not be reached is a line in the result, not a failed turn.
 * Errors are built from the status and the service's own words, never from
 * the request -- a Telegram URL has the bot's token in it.
 */
export async function deliver(
  msg: PushMessage,
  p: PushSettings,
  tokens: PushTokens,
  fetchImpl: Fetch = fetch,
): Promise<Delivery[]> {
  const title = clip(msg.title.trim() || "Autora", 120);
  const body = clip(msg.body.trim() || " ", 900);
  const jobs: Promise<Delivery>[] = [];

  for (const channel of readyChannels(p, tokens)) {
    if (channel === "ntfy") {
      const server = cleanServer(p.ntfy.server)!;
      jobs.push((async (): Promise<Delivery> => {
        try {
          // JSON publishing: the one form that carries a UTF-8 title intact.
          const res = await fetchImpl(`${server}/`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(tokens.ntfy ? { Authorization: `Bearer ${tokens.ntfy}` } : {}),
            },
            body: JSON.stringify({
              topic: p.ntfy.topic,
              title,
              message: body,
              priority: msg.urgent ? 4 : 3,
              tags: [msg.urgent ? "bell" : "sparkles"],
              ...(msg.url ? { click: msg.url } : {}),
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) return { channel, ok: true };
          const said = await res.text().catch(() => "");
          return { channel, ok: false, error: `ntfy answered ${res.status}${said ? `: ${clip(said.trim(), 160)}` : ""}` };
        } catch (err: any) {
          return { channel, ok: false, error: `could not reach ${new URL(server).host}: ${err?.name === "TimeoutError" ? "timed out" : "no connection"}` };
        }
      })());
    } else {
      jobs.push((async (): Promise<Delivery> => {
        try {
          const res = await fetchImpl(`https://api.telegram.org/bot${tokens.telegram}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: p.telegram.chat,
              text: [`${msg.urgent ? "🔔" : "✦"} ${title}`, body, msg.url ?? ""].filter((l) => l.trim()).join("\n"),
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          const answer: any = await res.json().catch(() => null);
          if (res.ok && answer?.ok) return { channel, ok: true };
          return {
            channel, ok: false,
            error: `Telegram answered ${res.status}${answer?.description ? `: ${clip(String(answer.description), 160)}` : ""}`,
          };
        } catch (err: any) {
          return { channel, ok: false, error: `could not reach Telegram: ${err?.name === "TimeoutError" ? "timed out" : "no connection"}` };
        }
      })());
    }
  }
  return Promise.all(jobs);
}

/**
 * The chats that have written to the bot lately, newest first: how the person
 * finds their chat id without knowing what one is -- they message the bot,
 * then press a button. Reading updates this way does not consume them.
 */
export async function telegramChats(token: string, fetchImpl: Fetch = fetch): Promise<{ id: string; name: string }[]> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(10_000),
  });
  const answer: any = await res.json().catch(() => null);
  if (!res.ok || !answer?.ok) {
    throw new Error(answer?.description ? `Telegram said: ${clip(String(answer.description), 160)}` : `Telegram answered ${res.status}`);
  }
  const seen = new Map<string, string>();
  for (const update of [...(answer.result ?? [])].reverse()) {
    const chat = update?.message?.chat ?? update?.channel_post?.chat ?? update?.my_chat_member?.chat;
    if (!chat?.id) continue;
    const id = String(chat.id);
    if (seen.has(id)) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || id;
    seen.set(id, String(name));
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/**
 * What arrived inside quiet hours, kept until they end.
 *
 * Sent as one message rather than a burst of them at 07:00: a phone that
 * buzzes six times as the alarm goes off is the thing quiet hours are for.
 */
export class HeldMessages {
  private items: PushMessage[] = [];

  hold(msg: PushMessage, max = 20) {
    this.items.push(msg);
    if (this.items.length > max) this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  /** Everything held, as one message, and the store emptied. */
  take(appUrl: string | null): PushMessage | null {
    if (this.items.length === 0) return null;
    const items = this.items;
    this.items = [];
    if (items.length === 1) return items[0];
    return {
      title: `${items.length} things while your quiet hours were on`,
      // Each with the start of what it said: two "Autora needs you" lines say nothing.
      body: items.map((m) => {
        const said = m.body.trim().split("\n")[0];
        return `• ${m.title}${said ? `: ${clip(said, 90)}` : ""}`;
      }).join("\n"),
      url: appUrl,
      urgent: items.some((m) => m.urgent),
    };
  }
}
