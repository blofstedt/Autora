/**
 * Reaching the person's phone.
 *
 * Everything the console does on its own -- a schedule that ran, a watcher
 * that saw a change, something it noticed, a long task finishing, a question
 * only the person can answer -- used to wait for them to open the app. A
 * phone that buzzes when it matters is most of what makes an agent feel like
 * it is there when you are not.
 *
 * There is one way, and it is the app itself: the installed PWA is the phone
 * interface, so it is what notifies (server/webpush.ts). Nothing here sends
 * through another app or service -- no chat bot, no third-party topic -- so
 * there is no second place for a message to be read, and nothing else to set
 * up or keep signed in.
 *
 * Quiet hours hold, not drop: what arrives inside them is kept and sent as
 * one message when the window ends. What is sent is only a line or two -- the
 * thread has the rest, one tap away.
 */

export interface PushSettings {
  /** Which kinds of news are sent. */
  on: { jobs: boolean; notices: boolean; turns: boolean; asks: boolean };
}

export type PushKind = keyof PushSettings["on"];

export const DEFAULT_PUSH: PushSettings = {
  on: { jobs: true, notices: true, turns: true, asks: true },
};

export function defaultPush(): PushSettings {
  return { on: { ...DEFAULT_PUSH.on } };
}

/** Field by field, like every other settings merge: nonsense leaves the old
    value. Settings written by an older build -- which also named a chat bot
    and a topic -- are read for what is still here and the rest dropped. */
export function mergePush(current: PushSettings, patch: any): PushSettings {
  if (!patch || typeof patch !== "object") return current;
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

/** The installed app's own notifications (server/webpush.ts): there is no
    switch for them beyond a device having asked, so this is only asked how
    many have, and to send. */
export interface WebSender {
  count(): number;
  send(msg: { title: string; body: string; url?: string | null; urgent?: boolean }): Promise<{ ok: boolean; sent: number; failed: number; error?: string }>;
}

export type PushChannel = "web";

/** Which channels can send right now: this app, on any device that asked. */
export function readyChannels(web: Pick<WebSender, "count">): PushChannel[] {
  return web.count() > 0 ? ["web"] : [];
}

export interface Delivery {
  channel: PushChannel;
  ok: boolean;
  error?: string;
}

/** Shorter than any phone shows, and never a whole thread. */
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Send one message to every device that asked. Never throws: a phone that
 * could not be reached is a line in the result, not a failed turn.
 */
export async function deliver(msg: PushMessage, web: WebSender): Promise<Delivery[]> {
  if (readyChannels(web).length === 0) return [];
  const title = clip(msg.title.trim() || "Autora", 120);
  const body = clip(msg.body.trim() || " ", 900);
  const r = await web.send({ title, body, url: msg.url, urgent: msg.urgent }).catch((err): { ok: false; sent: number; failed: number; error: string } => ({
    ok: false, sent: 0, failed: 1, error: String(err?.message ?? err),
  }));
  return [r.ok ? { channel: "web", ok: true } : { channel: "web", ok: false, error: r.error ?? "no device could be reached" }];
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
