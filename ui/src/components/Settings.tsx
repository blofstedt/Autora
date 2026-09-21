import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconGear, IconX } from "./Icons";
import { VoiceCheck } from "./VoiceCheck";

type Credential = {
  name: string;
  label: string;
  note: string;
  role: "model" | "voice";
  set: boolean;
  hint: string;
};

type SettingsState = {
  provider: string;
  model: string;
  base_url: string;
  providers: string[];
  system_prompt: string;
  system_prompt_limit: number;
  credentials: Credential[];
  active: {
    model: string | null;
    endpoint: string | null;
    provider: string | null;
    hint: string | null;
  };
  restart_required_for?: string[];
};

const PROVIDER_LABEL: Record<string, string> = {
  auto: "Automatic",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  local: "Local server",
};

const PROVIDER_NOTE: Record<string, string> = {
  auto: "Use DeepSeek if its key is set, then Anthropic, then a local server.",
  anthropic: "Always use Claude.",
  deepseek: "Always use DeepSeek.",
  local: "Always use an OpenAI-compatible server — vLLM, Ollama, llama.cpp.",
};

/**
 * Keys and model choice, editable from the app.
 *
 * Keys arrive masked and are never sent back: an untouched field submits
 * nothing, so the server keeps what it has. Typing replaces, clearing removes.
 *
 * What is saved and what is running are shown separately. They can differ --
 * the file is editable by hand, and voice is wired up once at startup -- and
 * conflating them is how you end up certain a key is set while the agent is
 * still talking to something else entirely.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("auto");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((next: SettingsState) => {
    setState(next);
    setProvider(next.provider);
    setModel(next.model);
    setBaseUrl(next.base_url);
    setPrompt(next.system_prompt ?? "");
    setDrafts({});
  }, []);

  /**
   * Read the settings, and be honest about not managing to.
   *
   * This used to run once and report every possible failure as the same four
   * words. Two things were wrong with that. The message named no cause, so a
   * server that was simply still restarting looked identical to a corrupt
   * file. And there was no way to try again: one failed fetch -- which is
   * guaranteed for anyone who opens this while the container is coming back up
   * after an update -- left the panel dead until it was closed and reopened,
   * with nothing on screen suggesting that would help.
   *
   * It matters more here than it looks, because the page itself is served by a
   * service worker out of cache. A server that is down therefore does not
   * announce itself: the app appears, and only the parts that need the server
   * quietly fail.
   */
  const load = useCallback(() => {
    setError(null);
    void fetch("/api/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return response.json();
      })
      .then(adopt)
      .catch((cause: unknown) =>
        setError(
          cause instanceof TypeError
            ? "Could not reach the server. It may still be starting up after an update."
            : `Could not read settings: ${
                cause instanceof Error ? cause.message : String(cause)
              }.`,
        ),
      );
  }, [adopt]);

  useEffect(load, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Only fields actually edited travel, so a masked key is never echoed
        // back as if it were the real one.
        body: JSON.stringify({
          provider,
          model,
          base_url: baseUrl,
          system_prompt: prompt,
          credentials: drafts,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.detail ?? "Could not save settings.");
        return;
      }
      adopt(body);
      setSaved(true);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }, [provider, model, baseUrl, prompt, drafts, adopt]);

  if (!state) {
    return (
      <div className="sched">
        <div className="sched-top">
          <div className="brand">
            <span className="brand-mark"><IconGear size={13} /></span>
            <span className="brand-word">Settings</span>
          </div>
          <div className="spacer" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
            <IconX size={14} />
          </button>
        </div>
        <div className="sched-body">
          {error ? (
            <>
              <div className="sched-error">{error}</div>
              <button className="btn primary set-retry" onClick={load}>Try again</button>
            </>
          ) : (
            <p className="jf-hint">Loading…</p>
          )}
        </div>
      </div>
    );
  }

  const byRole = (role: string) => state.credentials.filter((c) => c.role === role);
  const dirty =
    Object.keys(drafts).length > 0 ||
    provider !== state.provider ||
    model !== state.model ||
    baseUrl !== state.base_url ||
    prompt !== (state.system_prompt ?? "");

  return (
    <div className="sched">
      <div className="sched-top">
        <div className="brand">
          <span className="brand-mark"><IconGear size={13} /></span>
          <span className="brand-word">Settings</span>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
          <IconX size={14} />
        </button>
      </div>

      {error && <div className="sched-error">{error}</div>}
      {saved && !error && (
        <div className="sched-note">
          <IconCheck size={13} /> Saved. The model switched immediately; voice keys
          apply the next time Autora starts.
        </div>
      )}

      <div className="sched-body">
        {/* What is actually running, which is the question people open this to
            answer -- and the one the error messages could not answer before. */}
        <section className="set-card set-active">
          <h3>Currently using</h3>
          <div className="set-active-row">
            <code>{state.active.model ?? "—"}</code>
            <span>{state.active.endpoint ?? "built-in"}</span>
          </div>
          {state.active.hint && <p className="set-warn">{state.active.hint}</p>}
        </section>

        <section className="set-card">
          <h3>Model</h3>
          <div className="set-choices">
            {state.providers.map((id) => (
              <button
                key={id}
                className={`set-choice ${provider === id ? "on" : ""}`}
                onClick={() => setProvider(id)}
                aria-pressed={provider === id}
              >
                <b>{PROVIDER_LABEL[id] ?? id}</b>
                <span>{PROVIDER_NOTE[id] ?? ""}</span>
              </button>
            ))}
          </div>

          <label className="jf-row">
            <span>Model name</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="leave blank for the default"
              spellCheck={false}
            />
          </label>

          {(provider === "local" || provider === "auto") && (
            <label className="jf-row">
              <span>Local server URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8000/v1"
                spellCheck={false}
                className="jf-cron"
              />
            </label>
          )}
        </section>

        <section className="set-card">
          <h3>Standing instructions</h3>
          <p className="jf-hint">
            Added to Autora's own instructions on every turn — house rules like
            "be concise" or "never guess; say you do not know". Applies to open
            sessions from their next turn.
          </p>
          <textarea
            className="set-prompt"
            value={prompt}
            rows={6}
            maxLength={state.system_prompt_limit ?? 4000}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"Be concise.\nDo not invent facts — say when you are unsure.\nAsk before anything destructive."}
            aria-label="Standing instructions"
          />
          <div className="set-count">
            {prompt.length} / {state.system_prompt_limit ?? 4000}
          </div>
        </section>

        <section className="set-card">
          <h3>Model keys</h3>
          {byRole("model").map((c) => (
            <KeyField key={c.name} cred={c} value={drafts[c.name]}
                      onChange={(v) => setDrafts((d) => ({ ...d, [c.name]: v }))}
                      onReset={() => setDrafts(({ [c.name]: _drop, ...rest }) => rest)} />
          ))}
        </section>

        <section className="set-card">
          <h3>Voice keys</h3>
          <p className="jf-hint">
            Speech in and out. These are read when Autora starts, so a change
            here takes effect after a restart.
          </p>
          {byRole("voice").map((c) => (
            <KeyField key={c.name} cred={c} value={drafts[c.name]}
                      onChange={(v) => setDrafts((d) => ({ ...d, [c.name]: v }))}
                      onReset={() => setDrafts(({ [c.name]: _drop, ...rest }) => rest)} />
          ))}
        </section>

        <VoiceCheck />

        <TrustThisServer />
      </div>
    </div>
  );
}

function KeyField({
  cred, value, onChange, onReset,
}: {
  cred: Credential;
  value: string | undefined;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const editing = value !== undefined;
  return (
    <div className="set-key">
      <div className="set-key-head">
        <b>{cred.label}</b>
        {cred.set && !editing && <em className="set-badge">{cred.hint}</em>}
        {!cred.set && !editing && <em className="set-badge is-unset">not set</em>}
      </div>
      <p className="set-note">{cred.note}</p>
      {editing ? (
        <div className="set-key-edit">
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={cred.set ? "new key, or blank to remove" : "paste the key"}
            spellCheck={false}
            aria-label={`${cred.label} key`}
          />
          <button className="btn ghost" onClick={onReset}>Cancel</button>
        </div>
      ) : (
        <button className="btn ghost" onClick={() => onChange("")}>
          {cred.set ? "Replace" : "Add key"}
        </button>
      )}
    </div>
  );
}


/**
 * The certificate, offered where someone would go looking for it.
 *
 * Three separate-looking complaints -- the browser warning, the missing
 * microphone, and "this app cannot be installed" -- are one fact: nothing on
 * this device vouches for the server. Installing what signed it answers all
 * three at once, so they are named together rather than left to be discovered
 * as three unrelated disappointments.
 *
 * Absent entirely where Autora is not running its own authority, because then
 * there is nothing to install and whoever set up the real certificate does not
 * need advice from here.
 */
function TrustThisServer() {
  const [offered, setOffered] = useState(false);

  useEffect(() => {
    fetch("/api/origin")
      .then((r) => r.json())
      .then((d) => setOffered(!!d?.certificate))
      .catch(() => undefined);
  }, []);

  if (!offered) return null;

  return (
    <section className="set-card">
      <h3>Trust this server</h3>
      <p className="jf-hint">
        Your devices do not know this server, so they warn about it, refuse it a
        microphone, and will not install it to a home screen. Install the
        certificate below on a device and all three stop: it becomes an ordinary
        trusted site there.
      </p>
      <a className="btn primary set-ca" href="/autora-ca.crt" download>
        Download certificate
      </a>
      <p className="jf-hint set-ca-how">
        <b>Android:</b> Settings → Security → More security settings → Encryption
        &amp; credentials → Install a certificate → CA certificate.{" "}
        <b>iPhone:</b> open the file, then Settings → General → VPN &amp; Device
        Management to install it, then Settings → General → About → Certificate
        Trust Settings to switch it on.
      </p>
      <p className="set-warn">
        Install it only on devices you own. A certificate you trust can vouch for
        any site to that device, so this one is worth exactly as much as the
        server holding its key.
      </p>
    </section>
  );
}
