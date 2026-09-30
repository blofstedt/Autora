/**
 * The page's side of server/suggest.ts and server/noticer.ts: what this
 * install could do for the person, the one schedule worth offering, and what
 * it has noticed.
 */

export type Suggestion = { key: string; title: string; why: string; prompt: string };

export type Offer = {
  key: string;
  text: string;
  why: string;
  job: { name: string; cron: string; prompt: string };
};

export type Noticed = {
  key: string;
  tone: "warn" | "bad";
  title: string;
  detail: string;
  prompt: string;
  since: number;
};

export type Proactive = {
  starters: Suggestion[];
  discover: Suggestion;
  offer: Offer | null;
  notices: Noticed[];
};

export async function fetchProactive(): Promise<Proactive | null> {
  try {
    const res = await fetch("/api/proactive");
    return res.ok ? ((await res.json()) as Proactive) : null;
  } catch {
    return null;
  }
}

/** Yes sets the schedule up; either answer means it is not asked again. */
export async function answerOffer(key: string, answer: "yes" | "no"): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const res = await fetch(`/api/proactive/offers/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, name: body?.name } : { ok: false, error: body?.error ?? "That did not work." };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** Quiet about it until it clears. */
export async function dismissNotice(key: string): Promise<void> {
  await fetch(`/api/proactive/notices/${encodeURIComponent(key)}/dismiss`, { method: "POST" }).catch(() => undefined);
}
