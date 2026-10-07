/**
 * This device, asking to be told things.
 *
 * The browser's half of server/webpush.ts: whether push can work here at all
 * (it only offers it to a secure page, and on an iPhone only to an app added
 * to the Home Screen), the permission, and the subscription that is handed to
 * the console. Each refusal has a sentence of its own, because "not
 * supported" gives a person nothing to do about it.
 */

/** The key the console signs with, as the bytes a push manager wants. */
function keyToBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** What to call this device in the list. */
function deviceName(ua: string): string {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "Mac";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "This device";
}

type PushSupport = { ok: true } | { ok: false; reason: string };

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { ok: false, reason: "Not available here." };
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: "Browsers only offer notifications to a secure page. Open Autora at its https address (your Tailscale one) and try again.",
    };
  }
  const iphone = /iPhone|iPad/i.test(navigator.userAgent);
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  if (iphone && !installed) {
    return { ok: false, reason: "On an iPhone, add Autora to the Home Screen first (Share, then Add to Home Screen), then open it from there." };
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: "This browser does not offer notifications to web apps." };
  }
  return { ok: true };
}

/** The subscription this device already has, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Ask permission, subscribe, and hand the subscription to the console. */
export async function enablePush(publicKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const support = pushSupport();
  if (!support.ok) return { ok: false, error: support.reason };
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false,
      error: permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again."
        : "Permission was not given.",
    };
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const sub = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(publicKey) as BufferSource,
    });
    const res = await fetch("/api/push/web/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), label: deviceName(navigator.userAgent) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.error ?? "Autora could not keep that subscription." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `The browser could not subscribe: ${err instanceof Error ? err.message : "unknown error"}.` };
  }
}

/** Stop telling this device: the browser's subscription and the console's copy. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch("/api/push/web/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}
