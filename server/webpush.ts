/**
 * Notifications for the installed app itself.
 *
 * Nothing else is needed on the phone: the installed app is the interface, so
 * it is also what notifies. The page asks the browser for a subscription, the
 * console keeps it, and a message goes to the browser's own push service (Google's for Chrome and
 * Android, Mozilla's for Firefox, Apple's for Safari) which wakes the app's
 * service worker to show it -- with the page closed and the phone locked.
 *
 * The push service carries the message and cannot read it: what is sent is
 * encrypted to a key only that browser holds (RFC 8291, aes128gcm), and the
 * request is signed with a key of this console's own (VAPID, RFC 8292), so
 * nobody else can send to a subscription it hands over. Both are a page of
 * `node:crypto` here rather than a dependency: the image has none to spare,
 * and the whole of it is checked against the RFC's own worked example.
 *
 * Browsers only offer push to a secure page, so on a tailnet it is the
 * `tailscale serve --https` address that can turn it on. The console makes an
 * outbound request to the push service on send -- the one thing here that
 * leaves the tailnet, and all it carries is ciphertext.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A browser's subscription, as its push manager hands it over. */
interface WebSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** What to call the device in a list. */
  label?: string;
  added?: number;
}

interface WebMessage {
  title: string;
  body: string;
  url?: string | null;
  urgent?: boolean;
}

interface WebDelivery {
  ok: boolean;
  /** Devices reached, and devices that could not be. */
  sent: number;
  failed: number;
  error?: string;
}

const b64u = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");
const unb64u = (text: string) => Buffer.from(text, "base64url");

const MAX_DEVICES = 10;
/** A day: a phone that is off overnight still gets the morning's news. */
const TTL_SECONDS = 86_400;
/** RFC 8291's record size. Every message here fits in one record. */
const RECORD_SIZE = 4096;
/** Leaves room in a record for the padding byte and the tag. */
const MAX_PAYLOAD = RECORD_SIZE - 17 - 1;

// ------------------------------------------------------------------ keys --

interface Vapid {
  /** The uncompressed public point, base64url: what the browser is given. */
  publicKey: string;
  privateJwk: crypto.JsonWebKey;
}

export function makeVapid(): Vapid {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
  return { publicKey: b64u(point), privateJwk: privateKey.export({ format: "jwk" }) };
}

/** The signed header a push service wants: who is sending, for how long. */
export function vapidHeader(
  endpoint: string,
  vapid: Vapid,
  subject: string,
  now = Date.now(),
): string {
  const audience = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${head}.${claims}`),
    { key: crypto.createPrivateKey({ key: vapid.privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
  );
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

// ------------------------------------------------------------ the message --

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) =>
  Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));

/**
 * One message, encrypted for one browser (RFC 8291, aes128gcm).
 *
 * `asKey` and `salt` exist so the RFC's own example can be reproduced byte
 * for byte; in use both are fresh for every message, which is what makes
 * sending the same words twice look like two different things on the wire.
 */
export function encryptPayload(
  payload: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  fixed?: { asPrivate: crypto.KeyObject; asPublic: Buffer; salt: Buffer },
): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error("message too long for one push");
  let asPrivate: crypto.KeyObject;
  let asPublic: Buffer;
  if (fixed) {
    ({ asPrivate, asPublic } = fixed);
  } else {
    const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    asPrivate = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    asPublic = Buffer.concat([Buffer.from([4]), unb64u(jwk.x!), unb64u(jwk.y!)]);
  }
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const uaKey = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(uaPublic.subarray(1, 33)), y: b64u(uaPublic.subarray(33, 65)) },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey: asPrivate, publicKey: uaKey });
  const prk = hkdf(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const key = hkdf(salt, prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, nonce);
  // 0x02 closes the last (here, only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);
  return Buffer.concat([header, sealed]);
}

// --------------------------------------------------------- what is trusted --

/** A push endpoint is always https, and never a host on this machine or its
    network: a subscription is input from the page, and this server would
    otherwise be a way to make requests to whatever the page names. */
export function cleanEndpoint(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A subscription as the browser gave it, or null if it is anything else. */
export function cleanSubscription(raw: any, label?: unknown): WebSubscription | null {
  const endpoint = cleanEndpoint(raw?.endpoint);
  const p256dh = String(raw?.keys?.p256dh ?? "");
  const auth = String(raw?.keys?.auth ?? "");
  if (!endpoint) return null;
  const point = unb64u(p256dh);
  if (point.length !== 65 || point[0] !== 4 || unb64u(auth).length !== 16) return null;
  const name = String(label ?? "").replace(/[^\w .,()/-]/g, "").trim().slice(0, 60);
  return { endpoint, keys: { p256dh, auth }, ...(name ? { label: name } : {}) };
}

// ------------------------------------------------------------------ store --

interface Doc {
  vapid: Vapid;
  subscriptions: WebSubscription[];
}

type Fetch = typeof fetch;

/**
 * The console's VAPID key and the devices that have asked to be told things,
 * kept in one private file beside the settings so both survive an update.
 */
export class WebPush {
  private doc: Doc | null = null;

  constructor(
    private file: string,
    private subject = process.env.AUTORA_PUSH_SUBJECT || "mailto:autora@localhost.invalid",
  ) {}

  private load(): Doc {
    if (this.doc) return this.doc;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Doc;
      if (parsed?.vapid?.publicKey && parsed.vapid.privateJwk) {
        parsed.subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
        this.doc = parsed;
        return parsed;
      }
    } catch {
      // Absent or unreadable: a new key, below.
    }
    this.doc = { vapid: makeVapid(), subscriptions: [] };
    this.save();
    return this.doc;
  }

  private save() {
    if (!this.doc) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.doc), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** What the page needs to ask the browser for a subscription. */
  publicKey(): string {
    return this.load().vapid.publicKey;
  }

  count(): number {
    return this.load().subscriptions.length;
  }

  list(): { endpoint: string; label: string; added: number }[] {
    return this.load().subscriptions.map((s) => ({
      // Enough to tell devices apart in a list, not enough to send to.
      endpoint: `${new URL(s.endpoint).host}/…${s.endpoint.slice(-8)}`,
      label: s.label ?? "A device",
      added: s.added ?? 0,
    }));
  }

  has(endpoint: string): boolean {
    return this.load().subscriptions.some((s) => s.endpoint === endpoint);
  }

  /** Add a device, or refresh one already here. The oldest goes when full. */
  add(sub: WebSubscription): void {
    const doc = this.load();
    doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    doc.subscriptions.push({ ...sub, added: Date.now() });
    while (doc.subscriptions.length > MAX_DEVICES) doc.subscriptions.shift();
    this.save();
  }

  remove(endpoint: string): boolean {
    const doc = this.load();
    const before = doc.subscriptions.length;
    doc.subscriptions = doc.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (doc.subscriptions.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Send one message to every device. Never throws. A device the push service
   * says is gone (404, 410: the app was uninstalled, or permission taken
   * back) is forgotten, so the list does not fill with dead ones.
   */
  async send(msg: WebMessage, fetchImpl: Fetch = fetch): Promise<WebDelivery> {
    const doc = this.load();
    const subs = [...doc.subscriptions];
    if (subs.length === 0) return { ok: false, sent: 0, failed: 0, error: "no device has asked for notifications" };
    const text = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const payload = Buffer.from(JSON.stringify({
      title: text(msg.title, 120),
      body: text(msg.body, 600),
      ...(msg.url ? { url: msg.url } : {}),
      ...(msg.urgent ? { urgent: true } : {}),
    }));
    let sent = 0;
    let failed = 0;
    let error: string | undefined;
    await Promise.all(subs.map(async (sub) => {
      try {
        const body = encryptPayload(payload, unb64u(sub.keys.p256dh), unb64u(sub.keys.auth));
        const res = await fetchImpl(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidHeader(sub.endpoint, doc.vapid, this.subject),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.length),
            TTL: String(TTL_SECONDS),
            Urgency: msg.urgent ? "high" : "normal",
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          sent += 1;
          return;
        }
        failed += 1;
        if (res.status === 404 || res.status === 410) this.remove(sub.endpoint);
        else error = `the push service answered ${res.status}`;
      } catch (err: any) {
        failed += 1;
        error = `could not reach the push service: ${err?.name === "TimeoutError" ? "timed out" : "no connection"}`;
      }
    }));
    return { ok: sent > 0, sent, failed, ...(sent === 0 && error ? { error } : {}) };
  }
}
