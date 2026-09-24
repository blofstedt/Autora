import { useCallback, useEffect, useState } from "react";

/**
 * The person's details and sign-ins, for the agent to type without reading.
 *
 * Values go in and never come back out: the server only answers with masked
 * forms, so a field here shows what is saved as "jo•••••om" and typing
 * replaces it. See server/credentials.ts.
 */

interface IdentityField {
  key: string;
  label: string;
  hint?: string;
  set: boolean;
  masked: string;
}

interface LoginRow {
  site: string;
  username: string;
  has_username: boolean;
  has_password: boolean;
  has_authenticator: boolean;
}

interface Described {
  identity: IdentityField[];
  logins: LoginRow[];
  file: string;
}

interface LoginDraft {
  /** The site being edited, or null for a new sign-in. */
  previous: string | null;
  site: string;
  username: string;
  password: string;
  authenticator: string;
  /** Editing only: take the authenticator off. */
  dropAuthenticator: boolean;
}

const blankDraft = (): LoginDraft => ({
  previous: null, site: "", username: "", password: "", authenticator: "", dropAuthenticator: false,
});

/** The otpauth:// address in a QR code picture, where the browser can read one. */
async function readQr(file: File): Promise<string> {
  const Detector = (window as any).BarcodeDetector;
  if (!Detector) {
    throw new Error("This browser cannot read QR pictures. Paste the key the site shows under \"Can't scan it?\" instead.");
  }
  const detector = new Detector({ formats: ["qr_code"] });
  const found = await detector.detect(await createImageBitmap(file));
  const text = found?.[0]?.rawValue;
  if (!text) throw new Error("No QR code found in that picture.");
  return String(text);
}

export function Credentials() {
  const [data, setData] = useState<Described | null>(null);
  const [identity, setIdentity] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<LoginDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/credentials");
      if (res.ok) setData(await res.json());
    } catch {
      setError("Could not load credentials from the server.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const send = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "The server refused that.");
        return false;
      }
      setData(json);
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveIdentity = async () => {
    if (await send("/api/credentials/identity", "PUT", identity)) {
      setIdentity({});
      setNote("Details saved.");
    }
  };

  const clearIdentity = async (key: string, label: string) => {
    if (!confirm(`Remove your saved ${label.toLowerCase()}?`)) return;
    await send("/api/credentials/identity", "PUT", { [key]: "" });
  };

  const saveLogin = async () => {
    if (!draft) return;
    const editing = draft.previous !== null;
    const body: Record<string, string> = { site: draft.site };
    if (editing) body.previous = draft.previous!;
    // Editing, a blank box keeps what is saved.
    if (!editing || draft.username) body.username = draft.username;
    if (!editing || draft.password) body.password = draft.password;
    if (draft.authenticator) body.authenticator = draft.authenticator;
    else if (editing && draft.dropAuthenticator) body.authenticator = "";
    if (await send("/api/credentials/logins", "POST", body)) {
      setDraft(null);
      setNote(`Sign-in for ${draft.site} saved.`);
    }
  };

  const removeLogin = async (site: string) => {
    if (!confirm(`Remove the saved sign-in for ${site}?`)) return;
    await send(`/api/credentials/logins/${encodeURIComponent(site)}`, "DELETE");
  };

  const scan = async (file: File | undefined) => {
    if (!file || !draft) return;
    try {
      const text = await readQr(file);
      let site = draft.site;
      if (!site) {
        // otpauth://totp/GitHub:me?issuer=GitHub -- the issuer is a name, not
        // an address, so it is only a starting guess for the site box.
        const issuer = new URL(text).searchParams.get("issuer");
        if (issuer && /\./.test(issuer)) site = issuer.toLowerCase();
      }
      setDraft({ ...draft, site, authenticator: text, dropAuthenticator: false });
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    }
  };

  const changed = Object.values(identity).some((v) => v.trim());

  return (
    <section className="set-card" id="credentials-panel">
      <h3>Credentials</h3>
      <p className="jf-hint">
        Your details and sign-ins, for Autora to type into forms and sign-in pages. It is told
        which ones exist, never what they are: it asks for {"{{cred:first_name}}"} and the server
        types the real value into the page. A sign-in is only ever typed into pages on its own
        site, or on the other sites of the same account: one saved for google.ca also signs in
        on accounts.google.com, gmail.com and youtube.com. Nothing saved here can be read back
        out, including from this screen.
      </p>

      {error && <p className="set-warn">{error}</p>}
      {note && <p className="set-note cred-ok">{note}</p>}

      <div className="set-key">
        <div className="set-key-head"><b>Personal details</b></div>
        <p className="set-note">
          For forms, and as $CRED_FIRST_NAME and so on in the terminal for filling PDFs. Type to
          replace what is saved.
        </p>
        <div className="cred-grid">
          {(data?.identity ?? []).map((f) => (
            <label key={f.key} className="cred-field">
              <span>
                {f.label}
                {f.set && (
                  <button type="button" className="cred-clear" onClick={() => clearIdentity(f.key, f.label)}
                          disabled={busy} aria-label={`Remove ${f.label}`} title="Remove">×</button>
                )}
              </span>
              <input
                value={identity[f.key] ?? ""}
                onChange={(e) => setIdentity((d) => ({ ...d, [f.key]: e.target.value }))}
                placeholder={f.set ? f.masked : f.hint || "not set"}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ))}
        </div>
        <div className="cred-actions">
          <button className="btn" onClick={saveIdentity} disabled={busy || !changed}>Save details</button>
          {changed && <button className="btn ghost" onClick={() => setIdentity({})}>Cancel</button>}
        </div>
      </div>

      <div className="set-key">
        <div className="set-key-head">
          <b>Sign-ins</b>
          <em className={`set-badge ${data?.logins.length ? "" : "is-unset"}`}>{data?.logins.length ?? 0} saved</em>
        </div>
        <p className="set-note">
          A username and password per site, and optionally its authenticator key so Autora can
          fill the 2FA code itself, the way an authenticator app would. Keeping that key here means
          this server alone can pass both steps of the sign-in, so add it only for sites where that
          is worth it.
        </p>

        {(data?.logins ?? []).map((l) => (
          <div key={l.site} className="cred-login">
            <div>
              <b>{l.site}</b>
              <span>{l.has_username ? l.username : "no username"}</span>
            </div>
            <div className="cred-badges">
              <em className={`set-badge ${l.has_password ? "" : "is-unset"}`}>password</em>
              <em className={`set-badge ${l.has_authenticator ? "" : "is-unset"}`}>2FA</em>
            </div>
            <div className="cred-actions">
              <button className="btn ghost" disabled={busy}
                      onClick={() => setDraft({ ...blankDraft(), previous: l.site, site: l.site })}>Edit</button>
              <button className="btn ghost" disabled={busy} onClick={() => removeLogin(l.site)}>Remove</button>
            </div>
          </div>
        ))}

        {draft ? (
          <div className="cred-form">
            <div className="cred-grid">
              <label className="cred-field">
                <span>Site</span>
                <input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })}
                       placeholder="github.com" autoComplete="off" spellCheck={false} autoFocus />
              </label>
              <label className="cred-field">
                <span>Username or email</span>
                <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                       placeholder={draft.previous ? "unchanged" : ""} autoComplete="off" spellCheck={false} />
              </label>
              <label className="cred-field">
                <span>Password</span>
                <input type="password" value={draft.password}
                       onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                       placeholder={draft.previous ? "unchanged" : ""} autoComplete="new-password" />
              </label>
              <label className="cred-field">
                <span>Authenticator key (optional)</span>
                <input type="password" value={draft.authenticator}
                       onChange={(e) => setDraft({ ...draft, authenticator: e.target.value, dropAuthenticator: false })}
                       placeholder={draft.previous ? "unchanged" : "key or otpauth:// address"}
                       autoComplete="off" spellCheck={false} />
              </label>
            </div>
            <p className="set-note">
              When a site offers an authenticator app, it shows a QR code and usually a text key under
              "Can't scan it?". Paste that key, or upload a screenshot of the QR code.
            </p>
            <div className="cred-actions">
              <button className="btn" onClick={saveLogin} disabled={busy || !draft.site.trim()}>Save sign-in</button>
              <label className="btn ghost cred-upload">
                Scan QR picture
                <input type="file" accept="image/*" onChange={(e) => { void scan(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {draft.previous && data?.logins.find((l) => l.site === draft.previous)?.has_authenticator && (
                <label className="cred-check">
                  <input type="checkbox" checked={draft.dropAuthenticator}
                         onChange={(e) => setDraft({ ...draft, dropAuthenticator: e.target.checked, authenticator: "" })} />
                  Remove authenticator
                </label>
              )}
              <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn ghost" onClick={() => setDraft(blankDraft())} disabled={busy}>Add sign-in</button>
        )}
      </div>

      {data && (
        <p className="set-note set-where">
          Saved encrypted in <code>{data.file}</code>, with its key beside it, both readable only by
          the account Autora runs as.
        </p>
      )}
    </section>
  );
}
