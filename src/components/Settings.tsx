import { useCallback, useEffect, useState } from "react";
import { IconCheck, IconChevron, IconGear, IconRepeat, IconX } from "./Icons";
import { VoiceCheck } from "./VoiceCheck";
import { RelaySetup } from "./RelaySetup";
import { Billing } from "./Billing";
import { useServerVersion, versions } from "./UpdateNotice";

type Credential = {
  name: string;
  label: string;
  note: string;
  role: "model" | "voice";
  set: boolean;
  hint: string;
};

type ModelOption = {
  id: string;
  label: string;
  input: number;
  output: number;
  note?: string;
  /** False for a model the vendor listed without publishing a price. */
  priced?: boolean;
};

type ProviderCard = {
  id: string;
  label: string;
  note: string;
  kind: string;
  key_hint: string;
  keys_url: string;
  base_url: string;
  default_base_url: string;
  default_model: string;
  listable: boolean;
  open_ended: boolean;
  needs_key: boolean;
  key: {
    set: boolean;
    source: "app" | "env" | null;
    masked: string;
    env_names: string[];
  };
  model: string;
  models: ModelOption[];
};

type SettingsState = {
  provider: string;
  model: string;
  base_url: string;
  providers: string[];
  auto_order: string[];
  system_prompt: string;
  system_prompt_limit: number;
  catalog: ProviderCard[];
  prices_checked: string;
  budget_usd: number | null;
  state_file: string;
  credentials: Credential[];
  active: {
    model: string | null;
    endpoint: string | null;
    provider: string | null;
    hint: string | null;
  };
};

/** Per million tokens, which is how every vendor quotes it. */
function price(model: ModelOption): string {
  if (model.priced === false) return "price not published";
  return `$${model.input} in / $${model.output} out per 1M tokens`;
}

/**
 * Keys, models, and money, editable from the app.
 *
 * Any of the major vendors can be connected here -- OpenAI, Google, Anthropic,
 * DeepSeek, OpenRouter, or a local server -- each with its own key and its own
 * chosen model, so switching between them does not mean retyping anything.
 * Models come from a list the server supplies, priced, because "which model
 * shall I use" and "what will it cost me" are one question and answering them
 * in two different places is how a surprise bill happens.
 *
 * Keys arrive masked and are never sent back: an untouched field submits
 * nothing, so the server keeps what it has. Typing replaces, clearing removes.
 *
 * What is saved and what is running are shown separately. They can differ --
 * keys can also come from the environment, and voice is wired up once at
 * startup -- and conflating them is how you end up certain a key is set while
 * the agent is still talking to something else entirely.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const serverVersion = useServerVersion();
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((next: SettingsState) => {
    setState(next);
    setProvider(next.provider);
    setPrompt(next.system_prompt ?? "");
    setBudget(next.budget_usd === null ? "" : String(next.budget_usd));
    setKeyDrafts({});
    setModelDrafts({});
    setUrlDrafts({});
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
          models: modelDrafts,
          base_urls: urlDrafts,
          system_prompt: prompt,
          credentials: keyDrafts,
          budget_usd: budget.trim() === "" ? null : Number(budget),
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
  }, [provider, modelDrafts, urlDrafts, prompt, keyDrafts, budget, adopt]);

  /** Models discovered by asking a vendor, folded back into the open panel so
      the picker fills without losing everything else being edited. */
  const replaceModels = useCallback((providerId: string, models: ModelOption[]) => {
    setState((current) =>
      current
        ? {
            ...current,
            catalog: current.catalog.map((p) =>
              p.id === providerId ? { ...p, models } : p,
            ),
          }
        : current,
    );
  }, []);

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

  const voiceKeys = state.credentials.filter((c) => c.role === "voice");
  const savedBudget = state.budget_usd === null ? "" : String(state.budget_usd);
  const dirty =
    Object.keys(keyDrafts).length > 0 ||
    Object.keys(modelDrafts).length > 0 ||
    Object.keys(urlDrafts).length > 0 ||
    provider !== state.provider ||
    prompt !== (state.system_prompt ?? "") ||
    budget.trim() !== savedBudget;

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
        {/* First thing in the panel, because "did my update arrive" is the
            question people open this to answer, and it used to be answerable
            only from a line buried in the microphone check. */}
        <VersionCard server={serverVersion} />

        <section className="set-card set-active">
          <h3>Currently using</h3>
          <div className="set-active-row">
            <code>{state.active.model ?? "—"}</code>
            <span>{state.active.provider ?? "nothing connected"}</span>
          </div>
          {state.active.hint && (
            <p className={state.active.model ? "jf-hint" : "set-warn"}>{state.active.hint}</p>
          )}
        </section>

        <section className="set-card">
          <h3>Which provider answers</h3>
          <div className="set-choices">
            <button
              className={`set-choice ${provider === "auto" ? "on" : ""}`}
              onClick={() => setProvider("auto")}
              aria-pressed={provider === "auto"}
            >
              <b>Automatic</b>
              <span>
                Use the first connected provider, in this order:{" "}
                {state.auto_order
                  .map((id) => state.catalog.find((p) => p.id === id)?.label ?? id)
                  .join(", ")}
                .
              </span>
            </button>
            {state.catalog.map((card) => (
              <button
                key={card.id}
                className={`set-choice ${provider === card.id ? "on" : ""}`}
                onClick={() => setProvider(card.id)}
                aria-pressed={provider === card.id}
              >
                <b>
                  {card.label}
                  {card.key.set ? (
                    <em className="set-badge">key set</em>
                  ) : card.needs_key ? (
                    <em className="set-badge is-unset">no key</em>
                  ) : null}
                </b>
                <span>{card.note}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="set-card">
          <h3>Providers and models</h3>
          <p className="jf-hint set-providers-hint">
            Add a key for any vendor and pick its model. Each provider keeps its
            own choice, so switching back and forth costs nothing. Prices are the
            vendors' published rates as of {state.prices_checked} and are what the
            billing card counts with.
          </p>
          {state.catalog.map((card) => (
            <ProviderRow
              key={card.id}
              card={card}
              selected={provider === card.id || provider === "auto"}
              inUse={state.active.provider === card.label}
              keyDraft={keyDrafts[card.id]}
              modelDraft={modelDrafts[card.id]}
              urlDraft={urlDrafts[card.id]}
              onKey={(v) => setKeyDrafts((d) => ({ ...d, [card.id]: v }))}
              onKeyCancel={() => setKeyDrafts(({ [card.id]: _drop, ...rest }) => rest)}
              onModel={(v) => setModelDrafts((d) => ({ ...d, [card.id]: v }))}
              onUrl={(v) => setUrlDrafts((d) => ({ ...d, [card.id]: v }))}
              onModels={(models) => replaceModels(card.id, models)}
              onUse={() => setProvider(card.id)}
            />
          ))}
          <p className="set-note set-where">
            Keys saved here are written to <code>{state.state_file}</code> on the
            server, readable only by the account Autora runs as. Keys set in the
            environment stay there and are used when the app has none of its own.
          </p>
        </section>

        <Billing budget={budget} onBudget={setBudget} />

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

        {voiceKeys.length > 0 && (
          <section className="set-card">
            <h3>Voice keys</h3>
            <p className="jf-hint">
              Speech in and out. These are read when Autora starts, so a change
              here takes effect after a restart.
            </p>
            {voiceKeys.map((c) => (
              <KeyField
                key={c.name}
                label={c.label}
                note={c.note}
                hint={c.hint}
                set={c.set}
                value={keyDrafts[c.name]}
                onChange={(v) => setKeyDrafts((d) => ({ ...d, [c.name]: v }))}
                onReset={() => setKeyDrafts(({ [c.name]: _drop, ...rest }) => rest)}
              />
            ))}
          </section>
        )}

        <VoiceCheck />

        <RelaySetup />

        <TrustThisServer />
      </div>
    </div>
  );
}

/**
 * One vendor: its key, and which of its models to call.
 *
 * Collapsed until opened, because six expanded vendor cards is a wall and five
 * of them are usually irrelevant. The header carries the two facts worth
 * seeing without opening anything -- whether a key is set, and which model is
 * chosen.
 */
function ProviderRow({
  card, selected, inUse, keyDraft, modelDraft, urlDraft,
  onKey, onKeyCancel, onModel, onUrl, onModels, onUse,
}: {
  card: ProviderCard;
  selected: boolean;
  inUse: boolean;
  keyDraft: string | undefined;
  modelDraft: string | undefined;
  urlDraft: string | undefined;
  onKey: (v: string) => void;
  onKeyCancel: () => void;
  onModel: (v: string) => void;
  onUrl: (v: string) => void;
  onModels: (models: ModelOption[]) => void;
  onUse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; text: string } | null>(null);

  const model = modelDraft ?? card.model;
  const listed = card.models.some((m) => m.id === model);
  // A local server has no catalogue to offer, so it opens straight into the
  // text field rather than a picker with one item in it saying "Custom".
  const [custom, setCustom] = useState(card.open_ended);
  const chosen = card.models.find((m) => m.id === model);

  /** Ask the vendor whether this key works -- and, since the answer arrives as
      its model list, fill the picker from the same call. */
  const check = useCallback(async () => {
    setBusy(true);
    setChecked(null);
    try {
      const res = await fetch(`/api/providers/${card.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(keyDraft ? { key: keyDraft } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        setChecked({ ok: false, text: body.detail ?? "The key was refused." });
        return;
      }
      setChecked({ ok: true, text: `Key works — ${body.models} models available.` });
      const fresh = await fetch(`/api/providers/${card.id}/models`).then((r) => r.json());
      if (Array.isArray(fresh.models)) onModels(fresh.models);
    } catch {
      setChecked({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }, [card.id, keyDraft, onModels]);

  /** Re-ask the vendor for its catalogue. Worth a button of its own for
      OpenRouter, whose list changes weekly and is far too long to ship. */
  const refresh = useCallback(async () => {
    setBusy(true);
    setChecked(null);
    try {
      const res = await fetch(`/api/providers/${card.id}/models?refresh=1`);
      const body = await res.json();
      if (!res.ok) {
        setChecked({ ok: false, text: body.detail ?? "Could not list models." });
        return;
      }
      onModels(body.models);
      setChecked({ ok: true, text: `${body.found} models listed.` });
    } catch {
      setChecked({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }, [card.id, onModels]);

  const typing = custom || (!listed && model !== "");

  return (
    <div className={`prov ${open ? "is-open" : ""} ${inUse ? "is-live" : ""}`}>
      <button className="prov-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <IconChevron size={13} className={`prov-caret ${open ? "is-open" : ""}`} />
        <b>{card.label}</b>
        {card.key.set ? (
          <em className="set-badge">
            {card.key.source === "env" ? "environment" : card.key.masked}
          </em>
        ) : card.needs_key ? (
          <em className="set-badge is-unset">no key</em>
        ) : (
          <em className="set-badge is-unset">no key needed</em>
        )}
        <span className="prov-model">{model || "no model chosen"}</span>
      </button>

      {open && (
        <div className="prov-body">
          <p className="set-note">
            {card.note}
            {card.keys_url && (
              <>
                {" "}
                <a href={card.keys_url} target="_blank" rel="noreferrer">Get a key</a>.
              </>
            )}
          </p>

          {card.needs_key && (
            <KeyField
              label={`${card.label} API key`}
              note={
                card.key.source === "env"
                  ? `Currently coming from ${card.key.env_names.join(" or ")}. A key saved here takes over.`
                  : `Looks like ${card.key_hint}`
              }
              hint={card.key.source === "env" ? "from the environment" : card.key.masked}
              set={card.key.set}
              value={keyDraft}
              onChange={onKey}
              onReset={onKeyCancel}
            />
          )}

          <label className="jf-row">
            <span>Model</span>
            {typing ? (
              <input
                value={model}
                onChange={(e) => onModel(e.target.value)}
                placeholder={card.default_model || "model id"}
                spellCheck={false}
                className="jf-cron"
                aria-label={`${card.label} model id`}
              />
            ) : (
              <select
                className="set-select"
                value={model}
                onChange={(e) => {
                  if (e.target.value === "__custom") {
                    setCustom(true);
                    onModel("");
                  } else onModel(e.target.value);
                }}
                aria-label={`${card.label} model`}
              >
                {!model && <option value="">Choose a model…</option>}
                {card.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {price(m)}
                  </option>
                ))}
                <option value="__custom">Type a model id…</option>
              </select>
            )}
          </label>

          <div className="prov-actions">
            {card.needs_key && (
              <button className="btn ghost" onClick={check} disabled={busy}>
                {busy ? "Checking…" : "Check key"}
              </button>
            )}
            {card.listable && (
              <button className="btn ghost" onClick={refresh} disabled={busy}>
                <IconRepeat size={13} /> Refresh models
              </button>
            )}
            {typing && (
              <button
                className="btn ghost"
                onClick={() => {
                  setCustom(false);
                  onModel(card.default_model);
                }}
              >
                Back to the list
              </button>
            )}
            {!selected && (
              <button className="btn ghost" onClick={onUse}>Use this provider</button>
            )}
          </div>

          {checked && (
            <p className={checked.ok ? "prov-ok" : "set-warn"}>{checked.text}</p>
          )}

          {/* The price is already on the option in the list, so repeating it
              here would be noise; what the list has no room for is the note. */}
          {chosen?.note && <p className="prov-price">{chosen.label} · {chosen.note}</p>}
          {typing && model && (
            <p className="prov-price">
              {listed ? price(card.models.find((m) => m.id === model)!) : "Not in the price list — turns on this model are counted but not billed."}
            </p>
          )}

          <label className="jf-row">
            <span>API base URL</span>
            <input
              value={urlDraft ?? card.base_url}
              onChange={(e) => onUrl(e.target.value)}
              placeholder={card.default_base_url}
              spellCheck={false}
              className="jf-cron"
              aria-label={`${card.label} base URL`}
            />
          </label>
          <p className="jf-hint">
            Leave as it is unless you are going through a proxy or running the
            model yourself.
          </p>
        </div>
      )}
    </div>
  );
}

/** Which Autora is installed, and whether this page is that Autora. */
function VersionCard({ server }: { server: string | null }) {
  const { page, stale } = versions(server);
  return (
    <section className="set-card set-version-card">
      <h3>Version</h3>
      <div className="set-active-row">
        <code>{server ?? "…"}</code>
        <span>{stale ? `this page is running ${page}` : "installed and running"}</span>
      </div>
      {stale && (
        <p className="set-warn">
          Your browser is holding an older copy of the app. Reload the page —
          the banner at the top does it properly, clearing the cache first.
        </p>
      )}
    </section>
  );
}

function KeyField({
  label, note, hint, set, value, onChange, onReset,
}: {
  label: string;
  note: string;
  hint: string;
  set: boolean;
  value: string | undefined;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const editing = value !== undefined;
  return (
    <div className="set-key">
      <div className="set-key-head">
        <b>{label}</b>
        {set && !editing && <em className="set-badge">{hint}</em>}
        {!set && !editing && <em className="set-badge is-unset">not set</em>}
      </div>
      <p className="set-note">{note}</p>
      {editing ? (
        <div className="set-key-edit">
          <input
            type="password"
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={set ? "new key, or blank to remove" : "paste the key"}
            spellCheck={false}
            aria-label={`${label} value`}
          />
          <button className="btn ghost" onClick={onReset}>Cancel</button>
        </div>
      ) : (
        <button className="btn ghost" onClick={() => onChange("")}>
          {set ? "Replace" : "Add key"}
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
