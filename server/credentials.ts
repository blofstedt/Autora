/**
 * The person's own details and sign-ins, for the agent to use without reading.
 *
 * Name, address and phone for forms; a username, password and authenticator
 * key for each site. The agent is told which exist, never what they are: it
 * writes a placeholder such as {{cred:first_name}} or
 * {{cred:github.com:password}} into browser_fill, and the value is put in
 * here, on the server, at the moment the field is typed. So a password never
 * goes to the model's vendor, into the transcript, or into a log.
 *
 * A sign-in is locked to its site: {{cred:github.com:password}} is only typed
 * into a page on github.com (or a subdomain of it), or on another site of the
 * same account (see ACCOUNT_FAMILIES: Google on gmail.com). A page that talks the
 * agent into "sign in here" cannot collect a password meant for somewhere
 * else. The "code" field is the current six-digit authenticator code, made
 * from the key the person pasted in, the same as an authenticator app would.
 *
 * Kept encrypted (AES-256-GCM) in credentials.enc beside the settings file,
 * with its key in credentials.key, both owner-only. The key sits on the same
 * disk, so this keeps the details out of backups of the settings file and out
 * of a casual `cat`, not away from someone who has the whole data directory.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state";

export const IDENTITY_FIELDS = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "birth_date", label: "Date of birth", hint: "YYYY-MM-DD" },
  { key: "address_line1", label: "Address line 1" },
  { key: "address_line2", label: "Address line 2" },
  { key: "city", label: "City" },
  { key: "region", label: "State / region" },
  { key: "postal_code", label: "Postal code" },
  { key: "country", label: "Country" },
] as const;

export type IdentityKey = (typeof IDENTITY_FIELDS)[number]["key"];

export interface Login {
  /** The site it belongs to, e.g. "github.com". Also its name in placeholders. */
  site: string;
  username: string;
  password: string;
  /** Base32 authenticator key, or "" when the site has no 2FA set up here. */
  totp: string;
  digits: number;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
}

interface Stored {
  identity: Partial<Record<IdentityKey, string>>;
  logins: Login[];
}

const IDENTITY_KEYS = new Set<string>(IDENTITY_FIELDS.map((f) => f.key));

const dataFile = () => path.join(stateDir(), "credentials.enc");
const keyFile = () => path.join(stateDir(), "credentials.key");

let cache: Stored | null = null;

function key(): Buffer {
  const file = keyFile();
  try {
    const raw = fs.readFileSync(file);
    if (raw.length === 32) return raw;
  } catch {
    // First use: made below.
  }
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

function load(): Stored {
  if (cache) return cache;
  const empty: Stored = { identity: {}, logins: [] };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(dataFile());
  } catch {
    return (cache = empty);
  }
  try {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    const raw = JSON.parse(text);
    const identity: Stored["identity"] = {};
    for (const [k, v] of Object.entries(raw?.identity ?? {})) {
      if (IDENTITY_KEYS.has(k) && typeof v === "string" && v) identity[k as IdentityKey] = v;
    }
    const logins = (Array.isArray(raw?.logins) ? raw.logins : [])
      .filter((l: any) => l && typeof l.site === "string")
      .map((l: any) => saneLogin(l));
    return (cache = { identity, logins });
  } catch (err: any) {
    // A key that no longer matches the file: say so, and do not overwrite
    // the file until the person saves something new.
    console.warn(`[credentials] could not read ${dataFile()}: ${err?.message ?? err}`);
    return (cache = empty);
  }
}

function persist() {
  const body = Buffer.from(JSON.stringify(load()), "utf8");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  const file = dataFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function saneLogin(l: any): Login {
  const algorithm = String(l.algorithm || "SHA1").toUpperCase();
  return {
    site: normaliseSite(String(l.site)),
    username: String(l.username ?? ""),
    password: String(l.password ?? ""),
    totp: String(l.totp ?? ""),
    digits: [6, 7, 8].includes(Number(l.digits)) ? Number(l.digits) : 6,
    period: Number(l.period) > 0 ? Math.min(Number(l.period), 300) : 30,
    algorithm: algorithm === "SHA256" || algorithm === "SHA512" ? algorithm : "SHA1",
  };
}

/** "https://www.GitHub.com/login" -> "github.com". */
export function normaliseSite(raw: string): string {
  let text = raw.trim().toLowerCase();
  if (!text) return "";
  try {
    if (!/^[a-z]+:\/\//.test(text)) text = `https://${text}`;
    text = new URL(text).hostname;
  } catch {
    return "";
  }
  return text.replace(/^www\./, "").replace(/\.$/, "");
}

// ------------------------------------------------------------ authenticator --

function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("The authenticator key has characters that are not in a base32 key.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code an authenticator app would show right now (RFC 6238). */
export function totpCode(login: Pick<Login, "totp" | "digits" | "period" | "algorithm">, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / login.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(login.algorithm.toLowerCase(), base32(login.totp)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** login.digits).padStart(login.digits, "0");
}

/**
 * The authenticator key from what a site gives out: the bare key ("JBSW Y3DP
 * ...") or the otpauth:// address inside its QR code, which also says how
 * many digits and how often the code changes.
 */
export function parseAuthenticator(raw: string): Pick<Login, "totp" | "digits" | "period" | "algorithm"> {
  const text = raw.trim();
  let out: Pick<Login, "totp" | "digits" | "period" | "algorithm">;
  if (/^otpauth:\/\//i.test(text)) {
    const url = new URL(text);
    if (url.hostname.toLowerCase() !== "totp") {
      throw new Error("Only time-based (TOTP) authenticator codes are supported.");
    }
    const q = url.searchParams;
    const { totp, digits, period, algorithm } = saneLogin({
      site: "",
      totp: q.get("secret") ?? "",
      digits: q.get("digits"),
      period: q.get("period"),
      algorithm: q.get("algorithm"),
    });
    out = { totp, digits, period, algorithm };
  } else {
    out = { totp: text, digits: 6, period: 30, algorithm: "SHA1" };
  }
  out.totp = out.totp.toUpperCase().replace(/[\s=-]/g, "");
  if (base32(out.totp).length < 10) throw new Error("That authenticator key is too short to be real.");
  return out;
}

// ------------------------------------------------------------------ editing --

export function setIdentity(patch: Record<string, unknown>) {
  const stored = load();
  for (const [k, v] of Object.entries(patch)) {
    if (!IDENTITY_KEYS.has(k) || typeof v !== "string") continue;
    const value = v.trim();
    if (value) stored.identity[k as IdentityKey] = value;
    else delete stored.identity[k as IdentityKey];
  }
  persist();
}

/**
 * Add or change a sign-in. A field left undefined keeps what is stored, so
 * the settings panel can change a password without the username being sent
 * back; an empty string clears it.
 */
export function saveLogin(input: {
  site: string;
  previous?: string;
  username?: string;
  password?: string;
  authenticator?: string;
}) {
  const site = normaliseSite(input.site);
  if (!site || !site.includes(".")) throw new Error("Give the site as its address, e.g. github.com.");
  const stored = load();
  const previous = input.previous ? normaliseSite(input.previous) : site;
  const existing = stored.logins.find((l) => l.site === previous);
  if (previous !== site && stored.logins.some((l) => l.site === site)) {
    throw new Error(`There is already a sign-in for ${site}.`);
  }
  const next: Login = existing
    ? { ...existing, site }
    : { site, username: "", password: "", totp: "", digits: 6, period: 30, algorithm: "SHA1" };
  if (input.username !== undefined) next.username = input.username.trim();
  if (input.password !== undefined) next.password = input.password;
  if (input.authenticator !== undefined) {
    if (input.authenticator.trim()) Object.assign(next, parseAuthenticator(input.authenticator));
    else Object.assign(next, { totp: "", digits: 6, period: 30, algorithm: "SHA1" });
  }
  stored.logins = stored.logins.filter((l) => l !== existing);
  stored.logins.push(next);
  stored.logins.sort((a, b) => a.site.localeCompare(b.site));
  persist();
}

export function deleteLogin(site: string) {
  const stored = load();
  const name = normaliseSite(site);
  stored.logins = stored.logins.filter((l) => l.site !== name);
  persist();
}

/** "jonathan@example.com" -> "jo•••••om". Never the whole value. */
function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  const shown = value.length >= 10 ? 2 : 1;
  return `${value.slice(0, shown)}${"•".repeat(Math.min(value.length - shown * 2, 8))}${value.slice(-shown)}`;
}

/** What the settings panel shows: which details are set, masked. There is
    deliberately no way to read a value back out over the API. */
export function describeCredentials() {
  const stored = load();
  return {
    identity: IDENTITY_FIELDS.map((f) => ({
      key: f.key,
      label: f.label,
      hint: "hint" in f ? f.hint : undefined,
      set: Boolean(stored.identity[f.key]),
      masked: mask(stored.identity[f.key] ?? ""),
    })),
    logins: stored.logins.map((l) => ({
      site: l.site,
      username: mask(l.username),
      has_username: Boolean(l.username),
      has_password: Boolean(l.password),
      has_authenticator: Boolean(l.totp),
    })),
    file: dataFile(),
  };
}

// ------------------------------------------------------------ for the agent --

/** Placeholders look like {{cred:first_name}} or {{cred:github.com:password}}. */
const PLACEHOLDER = /\{\{\s*cred:([^}]+?)\s*\}\}/g;

export function hasPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

/**
 * Sites that are one account under several addresses. A Google sign-in saved
 * as google.ca is the same account on accounts.google.com, gmail.com and
 * youtube.com, and Google signs you in on whichever of them it likes -- so
 * locking it to google.ca alone left it unusable for Gmail.
 *
 * `brands` also cover the company's country sites (google.ca, amazon.co.uk,
 * yahoo.co.jp): the name followed by .com or a country ending, never any
 * other ending, which anyone could register. Kept to companies known to run
 * one sign-in across all of them; anything not listed stays on its own site.
 */
const ACCOUNT_FAMILIES: { name: string; brands: string[]; sites: string[] }[] = [
  { name: "Google", brands: ["google"], sites: ["gmail.com", "googlemail.com", "youtube.com", "blogger.com"] },
  {
    name: "Microsoft",
    brands: ["microsoft"],
    sites: [
      "live.com", "outlook.com", "hotmail.com", "msn.com", "office.com", "office365.com",
      "microsoftonline.com", "onedrive.com", "xbox.com", "skype.com", "bing.com", "azure.com",
    ],
  },
  { name: "Apple", brands: ["apple"], sites: ["icloud.com"] },
  { name: "Amazon", brands: ["amazon"], sites: ["primevideo.com"] },
  { name: "Meta", brands: [], sites: ["facebook.com", "messenger.com", "fb.com"] },
  { name: "Yahoo", brands: ["yahoo"], sites: [] },
  { name: "PayPal", brands: ["paypal"], sites: [] },
  { name: "eBay", brands: ["ebay"], sites: [] },
  { name: "Atlassian", brands: [], sites: ["atlassian.com", "atlassian.net", "bitbucket.org", "trello.com"] },
  { name: "Proton", brands: [], sites: ["proton.me", "protonmail.com", "protonmail.ch"] },
];

/** "mail.google.co.uk" -> "google.co.uk". The name a company registers. */
function registrable(host: string): string {
  const parts = host.split(".").filter(Boolean);
  const keep = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** The account a site belongs to, if it is one that spans several sites. */
export function accountFamily(site: string) {
  const domain = registrable(normaliseSite(site));
  const dot = domain.indexOf(".");
  if (dot < 0) return null;
  const label = domain.slice(0, dot);
  const ending = domain.slice(dot + 1);
  const national = ending === "com" || /^[a-z]{2}$/.test(ending) || /^(co|com)\.[a-z]{2}$/.test(ending);
  return ACCOUNT_FAMILIES.find((f) => f.sites.includes(domain) || (national && f.brands.includes(label))) ?? null;
}

/** Where a family's sign-in works, for the agent and the person. */
function familyReach(family: NonNullable<ReturnType<typeof accountFamily>>): string {
  return [...family.brands.map((b) => `${b}.com and ${b}'s country sites`), ...family.sites].join(", ");
}

function siteMatches(host: string, site: string): boolean {
  if (host === site || host.endsWith(`.${site}`)) return true;
  const family = accountFamily(site);
  return family !== null && accountFamily(host) === family;
}

/** The saved sign-in a placeholder names: that site's, or failing that the
    one saved for another site of the same account. */
function loginFor(logins: Login[], site: string): Login | undefined {
  const exact = logins.find((l) => l.site === site);
  if (exact) return exact;
  const family = accountFamily(site);
  return family ? logins.find((l) => accountFamily(l.site) === family) : undefined;
}

/** Codes handed out lately, so they are blanked in what the agent reads back. */
const recentCodes = new Map<string, number>();

/**
 * Put the real values in for the placeholders in `text`, typed into a page at
 * `pageUrl`. Throws, with a message for the agent, for an unknown placeholder
 * or a sign-in used on a site it does not belong to.
 */
export function fillPlaceholders(text: string, pageUrl: string): string {
  if (!hasPlaceholder(text)) return text;
  const stored = load();
  let host = "";
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // No page: a sign-in will be refused below.
  }
  return text.replace(PLACEHOLDER, (_all, inner: string) => {
    const parts = inner.trim().split(":");
    if (parts.length === 1) {
      const name = parts[0].trim().toLowerCase();
      if (name === "full_name") {
        const full = [stored.identity.first_name, stored.identity.last_name].filter(Boolean).join(" ");
        if (!full) throw new Error("No name is saved in Credentials. Ask the person for it.");
        return full;
      }
      if (!IDENTITY_KEYS.has(name)) throw new Error(`There is no credential called "${name}".`);
      const value = stored.identity[name as IdentityKey];
      if (!value) throw new Error(`No ${name.replace(/_/g, " ")} is saved in Credentials. Ask the person for it.`);
      return value;
    }
    const field = parts.pop()!.trim().toLowerCase();
    const site = normaliseSite(parts.join(":"));
    const login = loginFor(stored.logins, site);
    if (!login) throw new Error(`There is no saved sign-in for ${site || inner}.`);
    if (!host || !siteMatches(host, login.site)) {
      const family = accountFamily(login.site);
      const where = family ? `${login.site} and the other ${family.name} sites (${familyReach(family)})` : login.site;
      throw new Error(
        `Refused: the sign-in for ${login.site} is only typed into pages on ${where}, and this page is on ${host || "no site"}.`,
      );
    }
    if (field === "username") {
      if (!login.username) throw new Error(`No username is saved for ${login.site}.`);
      return login.username;
    }
    if (field === "password") {
      if (!login.password) throw new Error(`No password is saved for ${login.site}.`);
      return login.password;
    }
    if (field === "code") {
      if (!login.totp) throw new Error(`No authenticator is set up for ${login.site}; hand the page to the person for the code.`);
      const code = totpCode(login);
      recentCodes.set(code, Date.now());
      return code;
    }
    throw new Error(`A sign-in has username, password and code, not "${field}".`);
  });
}

/**
 * Details distinctive enough to blank wherever they turn up. A first name,
 * a city or a country alone is left: blanking "Paris" or "John" in every
 * page read would garble ordinary reading far more than it protects.
 */
const BLANKED_IDENTITY: IdentityKey[] = ["email", "phone", "birth_date", "address_line1", "address_line2"];

/** Stored values, longest first, with the name to show in their place:
    sign-ins always, personal details only when `identity` is set. */
function credentialValues(identity: boolean): { name: string; value: string }[] {
  const stored = load();
  const out: { name: string; value: string }[] = [];
  if (identity) {
    for (const k of BLANKED_IDENTITY) {
      const v = stored.identity[k];
      if (v) out.push({ name: `cred:${k}`, value: v });
    }
    const full = [stored.identity.first_name, stored.identity.last_name].filter(Boolean).join(" ");
    if (stored.identity.first_name && stored.identity.last_name) out.push({ name: "cred:full_name", value: full });
  }
  for (const l of stored.logins) {
    if (l.username) out.push({ name: `cred:${l.site}:username`, value: l.username });
    if (l.password) out.push({ name: `cred:${l.site}:password`, value: l.password });
  }
  const cutoff = Date.now() - 5 * 60_000;
  for (const [code, ts] of recentCodes) {
    if (ts < cutoff) recentCodes.delete(code);
    else out.push({ name: "cred:code", value: code });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace stored values in `text` with their placeholders. What goes to the
 * model blanks personal details too; what goes to the person's own screen
 * blanks only sign-ins, since the details there are theirs.
 */
export function redactCredentials(text: string, opts: { identity?: boolean } = {}): string {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const { name, value } of credentialValues(opts.identity ?? true)) {
    if (value.length < 3) continue;
    out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}

/** The personal details as environment variables for the terminal, so a
    script filling a PDF can use them. Sign-ins are left out: in the terminal
    nothing could keep a password to its own site. */
export function identityEnv(): Record<string, string> {
  const stored = load();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(stored.identity)) if (v) env[`CRED_${k.toUpperCase()}`] = v;
  return env;
}

/** What the agent is told at the start of a conversation: names, no values. */
export function credentialsBriefing(): string {
  const stored = load();
  const identity = Object.keys(stored.identity);
  if (identity.length === 0 && stored.logins.length === 0) {
    return "- Credentials: none saved. The person can add their details and sign-ins in Config -> Credentials.";
  }
  const lines = [
    "- Credentials: the person's saved details. You never see the values; write a placeholder " +
      "and the real value is typed in for you. Use them in browser_fill only, as the whole text of a " +
      "field or part of it, e.g. {\"ref\": 4, \"text\": \"{{cred:first_name}}\"}. Sign-ins, email, phone, " +
      "date of birth and address come back blanked as their placeholder in what you read. Never ask the person " +
      "for a detail that is saved here.",
  ];
  if (identity.length > 0) {
    const names = identity.map((k) => `{{cred:${k}}}`);
    if (stored.identity.first_name && stored.identity.last_name) names.push("{{cred:full_name}}");
    lines.push(`  Personal: ${names.join(", ")}.`);
    lines.push(
      `  In the terminal (e.g. to fill a PDF) the same details are environment variables: ` +
        `${identity.map((k) => `$CRED_${k.toUpperCase()}`).join(", ")}. Use them by name in scripts; do not print them.`,
    );
  }
  for (const l of stored.logins) {
    const fields = [
      l.username && `{{cred:${l.site}:username}}`,
      l.password && `{{cred:${l.site}:password}}`,
      l.totp && `{{cred:${l.site}:code}} (the current 2FA code)`,
    ].filter(Boolean);
    if (!fields.length) continue;
    const family = accountFamily(l.site);
    lines.push(
      family
        ? `  Sign-in for ${l.site} (the person's ${family.name} account): ${fields.join(", ")}. The same account on ` +
            `every ${family.name} site, so use it on ${familyReach(family)} too, e.g. to sign in to ` +
            `${family.sites[0] ?? `${family.brands[0]}.com`}.`
        : `  Sign-in for ${l.site}: ${fields.join(", ")}. Only typed into pages on ${l.site}.`,
    );
  }
  if (stored.logins.length > 0) {
    lines.push(
      "  When a site you have a saved sign-in for asks you to sign in, sign in with it yourself rather " +
        "than handing the page over. Fill the 2FA code only when the site asks for it -- it changes every 30 seconds.",
    );
  }
  return lines.join("\n");
}
