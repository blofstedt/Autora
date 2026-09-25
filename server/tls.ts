/**
 * The https listener, for a microphone on a network with nothing in front.
 *
 * Browsers only open a microphone (and only install a home-screen app) on a
 * secure page, and `http://box.local:8817` is not one. The better answer is a
 * proxy with a real certificate in front of the plain port -- see the README
 * -- but where there is none, `AUTORA_TLS=1` puts an https copy of the app on
 * the next port up (8818 in the Umbrel app), and the page offers a link
 * across. Everything else about the app is unchanged.
 *
 * The certificate is Autora's own. A small authority (ca.crt / ca.key) is made
 * once and kept beside the settings, so it survives an update, and it is
 * offered at /autora-ca.crt: installed on a device, it makes every certificate
 * below an ordinary trusted one there. Leaves are issued from it per hostname
 * during the handshake, from the name the browser asks for, so the same
 * server reached as box.local, by tailnet name or as localhost all match. A
 * bare IP address sends no name; that falls back to a leaf naming every
 * address this machine knows it has.
 *
 * `AUTORA_TLS_CERT` / `AUTORA_TLS_KEY` use a real certificate instead, and
 * then no authority is made or offered.
 *
 * The X.509 encoding is written out here, in a hundred lines of DER, rather
 * than shelled out to openssl: the container image does not have it, and a
 * listener that silently fails to start because a binary is missing is the
 * failure this whole feature was already suffering from.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

// ------------------------------------------------------------------- DER --

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
const octets = (data: Buffer) => der(0x04, data);
const bits = (data: Buffer, unused = 0) => der(0x03, Buffer.from([unused]), data);
const bool = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0]));
const utf8 = (text: string) => der(0x0c, Buffer.from(text, "utf8"));
const explicit = (n: number, inner: Buffer) => der(0xa0 | n, inner);

/** A non-negative INTEGER from big-endian bytes. */
function integer(value: Buffer | number): Buffer {
  let data = typeof value === "number" ? Buffer.from([value]) : value;
  let start = 0;
  while (start < data.length - 1 && data[start] === 0) start += 1;
  data = data.subarray(start);
  if (data[0] & 0x80) data = Buffer.concat([Buffer.from([0]), data]);
  return der(0x02, data);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

/** UTCTime until 2050, GeneralizedTime after, as RFC 5280 asks. */
function time(date: Date): Buffer {
  const two = (n: number) => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const rest = `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}` +
    `${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return year < 2050
    ? der(0x17, Buffer.from(`${String(year).slice(2)}${rest}`, "ascii"))
    : der(0x18, Buffer.from(`${year}${rest}`, "ascii"));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function name(commonName: string): Buffer {
  return seq(
    set(seq(oid("2.5.4.10"), utf8("Autora"))),
    set(seq(oid("2.5.4.3"), utf8(commonName.slice(0, 64)))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/** The key identifier RFC 5280 suggests: SHA-1 of the public key's bits. */
function keyId(spki: Buffer): Buffer {
  // SubjectPublicKeyInfo is SEQUENCE { algorithm, BIT STRING }; the bits
  // are the last element, and a P-256 point is the last 65 bytes of it.
  return crypto.createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

/** The key id of a key pair (either half), as its certificate carries it. */
export function publicKeyId(key: crypto.KeyObject): Buffer {
  const publicKey = key.type === "public" ? key : crypto.createPublicKey(key);
  return keyId(publicKey.export({ type: "spki", format: "der" }));
}

/** An IP address as the 4 or 16 bytes a certificate names it by, or null. */
function ipBytes(address: string): Buffer | null {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const parts = bare.split(".").map(Number);
    return parts.every((p) => p <= 255) ? Buffer.from(parts) : null;
  }
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const words = (text: string) => (text ? text.split(":") : []);
  const head = words(halves[0]);
  const tail = halves.length === 2 ? words(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...tail];
  if (!all.every((w) => /^[0-9a-f]{1,4}$/i.test(w))) return null;
  const out = Buffer.alloc(16);
  all.forEach((w, i) => out.writeUInt16BE(parseInt(w, 16), i * 2));
  return out;
}

/** A name a certificate can carry as a DNS name. */
export function validHostname(host: string): boolean {
  return host.length > 0 && host.length <= 253 &&
    /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i.test(host);
}

export interface IssueOptions {
  /** What the certificate is called, and (for a leaf) its first name. */
  commonName: string;
  /** DNS names and IP addresses it is good for. Leaves only. */
  names?: string[];
  subjectKey: crypto.KeyObject;
  issuerKey: crypto.KeyObject;
  /** The issuer's certificate subject and key id; absent means self-signed. */
  issuer?: { commonName: string; keyId: Buffer };
  ca?: boolean;
  days: number;
  now?: Date;
}

/** One certificate, DER-encoded and signed. */
export function issueCertificate(opts: IssueOptions): Buffer {
  const now = opts.now ?? new Date();
  const spki = opts.subjectKey.export({ type: "spki", format: "der" });
  const ownId = keyId(spki);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;

  const extensions: Buffer[] = [];
  if (opts.ca) {
    extensions.push(extension("2.5.29.19", true, seq(bool(true), integer(0))));
    // keyCertSign and cRLSign.
    extensions.push(extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)));
  } else {
    extensions.push(extension("2.5.29.19", true, seq()));
    // digitalSignature, which is all an ECDHE handshake asks of the key.
    extensions.push(extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)));
    extensions.push(extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))));
    const general: Buffer[] = [];
    for (const entry of [...new Set(opts.names ?? [opts.commonName])]) {
      const ip = ipBytes(entry);
      if (ip) general.push(der(0x87, ip));
      else if (validHostname(entry)) general.push(der(0x82, Buffer.from(entry.toLowerCase(), "ascii")));
    }
    if (general.length) extensions.push(extension("2.5.29.17", false, seq(...general)));
  }
  extensions.push(extension("2.5.29.14", false, octets(ownId)));
  if (opts.issuer) extensions.push(extension("2.5.29.35", false, seq(der(0x80, opts.issuer.keyId))));

  // Valid from an hour ago, for a phone whose clock is a little behind.
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + opts.days * 24 * 60 * 60 * 1000);
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    ECDSA_SHA256,
    name(opts.issuer?.commonName ?? opts.commonName),
    seq(time(notBefore), time(notAfter)),
    name(opts.commonName),
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, opts.issuerKey);
  return seq(tbs, ECDSA_SHA256, bits(signature));
}

export function pem(derBytes: Buffer, label = "CERTIFICATE"): string {
  const body = derBytes.toString("base64").replace(/.{1,64}/g, "$&\n");
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

// ------------------------------------------------------------ the listener --

export interface TlsSettings {
  enabled: boolean;
  port: number;
  cert: string;
  key: string;
  /** Extra names for the fallback leaf (AUTORA_TLS_NAMES, comma separated). */
  names: string[];
}

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test((value ?? "").trim());

export function tlsSettings(httpPort: number, env: NodeJS.ProcessEnv = process.env): TlsSettings {
  const port = Number.parseInt((env.AUTORA_TLS_PORT || "").trim(), 10);
  return {
    enabled: truthy(env.AUTORA_TLS),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : httpPort + 1,
    cert: (env.AUTORA_TLS_CERT || "").trim(),
    key: (env.AUTORA_TLS_KEY || "").trim(),
    names: (env.AUTORA_TLS_NAMES || "").split(",").map((n) => n.trim()).filter(Boolean),
  };
}

/** Every name and address this machine answers to, as far as it knows. */
function localNames(extra: string[]): string[] {
  const names = new Set<string>(["localhost", "127.0.0.1", "::1", ...extra]);
  const host = os.hostname().toLowerCase();
  if (validHostname(host)) {
    names.add(host);
    if (!host.includes(".")) names.add(`${host}.local`);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) if (!nic.internal || nic.family === "IPv4") names.add(nic.address);
  }
  return [...names];
}

export interface CertificateSource {
  /** Options for https.createServer. */
  options: tls.SecureContextOptions & { SNICallback?: tls.TlsOptions["SNICallback"] };
  /** The authority to offer for download, when the certificates are ours. */
  caPem: string | null;
}

/** Leaves live a little over a year: Apple refuses anything past 825 days. */
const LEAF_DAYS = 397;
const CA_DAYS = 3650;
/** Per-name leaves kept in memory, so a handshake is only slow once per name. */
const MAX_CACHED = 64;

function loadOrMakeKey(file: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey(fs.readFileSync(file));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    return privateKey;
  }
}

/** The authority: made once, kept, and remade only when it is unreadable or
    within a month of running out. */
function authority(dir: string): { key: crypto.KeyObject; cert: string; id: Buffer } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "ca.key");
  const certFile = path.join(dir, "ca.crt");
  const key = loadOrMakeKey(keyFile);
  const id = publicKeyId(key);
  try {
    const cert = fs.readFileSync(certFile, "utf8");
    const parsed = new crypto.X509Certificate(cert);
    const fresh = Date.parse(parsed.validTo) - Date.now() > 30 * 24 * 60 * 60 * 1000;
    if (fresh && parsed.checkIssued(parsed) && parsed.verify(crypto.createPublicKey(key))) {
      return { key, cert, id };
    }
  } catch {
    // Missing or unreadable: made below.
  }
  const cn = `Autora local authority (${os.hostname().slice(0, 30)})`;
  const cert = pem(issueCertificate({ commonName: cn, subjectKey: crypto.createPublicKey(key), issuerKey: key, ca: true, days: CA_DAYS }));
  fs.writeFileSync(certFile, cert, { mode: 0o644 });
  return { key, cert, id };
}

/**
 * Where the listener's certificates come from: files named in the
 * environment, else Autora's own authority under `dir`.
 */
export function certificateSource(settings: TlsSettings, dir: string): CertificateSource {
  if (settings.cert || settings.key) {
    if (!settings.cert || !settings.key) {
      throw new Error("AUTORA_TLS_CERT and AUTORA_TLS_KEY go together; only one is set.");
    }
    return {
      options: { cert: fs.readFileSync(settings.cert), key: fs.readFileSync(settings.key) },
      caPem: null,
    };
  }

  const ca = authority(dir);
  const caSubject = new crypto.X509Certificate(ca.cert).subject.split("\n")
    .find((line) => line.startsWith("CN="))?.slice(3) ?? "Autora local authority";
  const leafKey = loadOrMakeKey(path.join(dir, "leaf.key"));
  const leafPublic = crypto.createPublicKey(leafKey);
  const leafKeyPem = leafKey.export({ type: "pkcs8", format: "pem" });

  const leaf = (commonName: string, names: string[]) => pem(issueCertificate({
    commonName, names, subjectKey: leafPublic, issuerKey: ca.key,
    issuer: { commonName: caSubject, keyId: ca.id }, days: LEAF_DAYS,
  }));

  const everything = localNames(settings.names);
  const fallback = { cert: leaf(everything[0], everything) + ca.cert, key: leafKeyPem };
  const cache = new Map<string, tls.SecureContext>();

  return {
    options: {
      ...fallback,
      SNICallback: (servername, done) => {
        const host = String(servername || "").toLowerCase().replace(/\.$/, "");
        if (!validHostname(host)) return done(null, undefined);
        let context = cache.get(host);
        if (!context) {
          try {
            context = tls.createSecureContext({ cert: leaf(host, [host]) + ca.cert, key: leafKeyPem });
          } catch (err) {
            return done(err as Error, undefined);
          }
          if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
          cache.set(host, context);
        }
        done(null, context);
      },
    },
    caPem: ca.cert,
  };
}
