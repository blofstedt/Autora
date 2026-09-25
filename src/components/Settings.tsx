import { useCallback, useEffect, useState } from "react";
import {
  IconBrain, IconCheck, IconChevron, IconGear, IconGlobe, IconMonitor, IconRepeat,
  IconTerminal, IconX,
} from "./Icons";
import { VoiceCheck } from "./VoiceCheck";
import { RelaySetup } from "./RelaySetup";
import { Billing } from "./Billing";
import { SecretStore } from "./SecretStore";
import { Credentials } from "./Credentials";
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

export type ToolGroupName = "terminal" | "browser" | "computer" | "memory";
export type ApprovalMode = "always" | "risky" | "never";

/** What the server says about one group of tools: whether it is on, whether it
    can actually be used, and in one sentence why not when it cannot. */
type ToolGroupState = {
  group: ToolGroupName;
  label: string;
  enabled: boolean;
  available: boolean;
  detail: string;
  approval: ApprovalMode;
  tools: string[];
};

type ToolConfig = {
  terminal: { enabled: boolean; cwd: string; timeout: number; approval: ApprovalMode };
  browser: { enabled: boolean; approval: ApprovalMode };
  computer: { enabled: boolean; approval: ApprovalMode };
  memory: { enabled: boolean; approval: ApprovalMode };
};

type LoopConfig = {
  warnAt: number;
  stopAt: number;
  staleAfter: number;
  checkEvery: number;
};

type RetentionPolicy = {
  sessionDays: number;
  keepSessions: number;
  artifactDays: number;
  keepArtifacts: number;
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
  /** When a turn is called a loop, and how much is kept. Both sets used to be
      constants in the server's source, invisible and unchangeable. */
  loop?: LoopConfig;
  retention?: RetentionPolicy;
  state_file: string;
  credentials: Credential[];
  tools: { config: ToolConfig; groups: ToolGroupState[] };
  jev?: JevState;
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
/** Which part of the settings a page shows. The full panel is all of them. */
export type SettingsSection = "config" | "keys" | "analytics" | "system";

/** Config's three parts: the model, tools and instructions; the API keys and
    secrets; and the person's own details and sign-ins. */
export type ConfigTab = "general" | "keys" | "credentials";

export function Settings({
  onClose, section, embedded = false, initialTab = "general",
}: {
  onClose?: () => void;
  section?: SettingsSection;
  /** Rendered as a page inside the app rather than as a full-screen sheet. */
  embedded?: boolean;
  /** On Config, which half to open on. */
  initialTab?: ConfigTab;
}) {
  /* API Keys is a section of Config rather than a page of its own. One
     component, so a key typed on one tab and a model picked on the other are
     saved together by the one Save button. */
  const [tab, setTab] = useState<ConfigTab>(initialTab);
  useEffect(() => {
    if (section !== "config" || !embedded) return;
    const url = new URL(location.href);
    url.searchParams.set("page", "config");
    if (tab === "general") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    history.replaceState(null, "", url.toString());
  }, [tab, section, embedded]);
  const shows = (s: SettingsSection) =>
    section === "config"
      ? (s === "config" && tab === "general") || (s === "keys" && tab === "keys")
      : !section || section === s;
  /* Credentials are the person's own details and sign-ins, not keys for a
     service, so on Config they are a tab of their own. */
  const showsCredentials = section === "config" ? tab === "credentials" : shows("keys");
  const title = section === "config" ? "Config"
    : section === "keys" ? "API Keys"
      : section === "analytics" ? "Analytics"
        : section === "system" ? "System" : "Settings";
  const [state, setState] = useState<SettingsState | null>(null);
  const serverVersion = useServerVersion();
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [urlDrafts, setUrlDrafts] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [budget, setBudget] = useState("");
  const [loop, setLoop] = useState<LoopConfig | null>(null);
  const [keep, setKeep] = useState<RetentionPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((next: SettingsState) => {
    setState(next);
    setProvider(next.provider);
    setPrompt(next.system_prompt ?? "");
    setBudget(next.budget_usd === null ? "" : String(next.budget_usd));
    setLoop(next.loop ?? null);
    setKeep(next.retention ?? null);
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
          ...(loop ? { loop } : {}),
          ...(keep ? { retention: keep } : {}),
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
  }, [provider, modelDrafts, urlDrafts, prompt, keyDrafts, budget, loop, keep, adopt]);

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
      <div className={`sched ${embedded ? "is-embedded" : ""}`}>
        <div className="sched-top">
          <div className="brand">
            <span className="brand-mark"><IconGear size={13} /></span>
            <span className="brand-word">{title}</span>
          </div>
          <div className="spacer" />
          {onClose && !embedded && (
            <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
              <IconX size={14} />
            </button>
          )}
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
    budget.trim() !== savedBudget ||
    JSON.stringify(loop) !== JSON.stringify(state.loop ?? null) ||
    JSON.stringify(keep) !== JSON.stringify(state.retention ?? null);

  // Credentials save as they are entered; the Save button is for the rest.
  const saveable = section !== "system" && !(section === "config" && tab === "credentials");

  return (
    <div className={`sched ${embedded ? "is-embedded" : ""}`}>
      <div className="sched-top">
        <div className="brand">
          <span className="brand-mark"><IconGear size={13} /></span>
          <span className="brand-word">{title}</span>
        </div>
        {section === "config" && (
          <div className="seg" role="tablist" aria-label="Config sections">
            <button role="tab" aria-selected={tab === "general"} className={tab === "general" ? "on" : ""}
                    onClick={() => setTab("general")}>Model &amp; tools</button>
            <button role="tab" aria-selected={tab === "keys"} className={tab === "keys" ? "on" : ""}
                    onClick={() => setTab("keys")}>API Keys</button>
            <button role="tab" aria-selected={tab === "credentials"} className={tab === "credentials" ? "on" : ""}
                    onClick={() => setTab("credentials")}>Credentials</button>
          </div>
        )}
        <div className="spacer" />
        {saveable && (
          <button className="btn primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        {onClose && !embedded && (
          <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
            <IconX size={14} />
          </button>
        )}
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
        {shows("system") && <VersionCard server={serverVersion} />}
        {section === "system" && <HostCard />}

        {shows("config") && <>
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

        <ToolsCard tools={state.tools} onSaved={adopt} />

        {state.jev && <JevCard jev={state.jev} onSaved={adopt} />}
        </>}

        {section && shows("keys") && (
          <section className="set-card">
            <h3>Model providers</h3>
            <p className="jf-hint">
              One key per vendor. Typing replaces the saved key; clearing it
              removes it. Which provider and model answer is chosen under Model &amp; tools.
            </p>
            {state.credentials.filter((c) => c.role === "model").map((c) => (
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
            <p className="set-note set-where">
              Keys saved here are written to <code>{state.state_file}</code> on the
              server, readable only by the account Autora runs as.
            </p>
          </section>
        )}

        {showsCredentials && <Credentials />}

        {shows("keys") && <SecretStore />}

        {shows("analytics") && <Billing budget={budget} onBudget={setBudget} />}

        {shows("config") && (
        <section className="set-card">
          <h3>Limits</h3>
          <p className="jf-hint">
            When a turn is called a loop, and how much of this workspace is kept.
            Both are saved with the button above; 0 days means never on age alone,
            and the keep counts are always kept whatever else is set.
          </p>
          <div className="limit-grid">
            {loop && ([
              ["warnAt", "Note a repeat after", "repeats of the same call"],
              ["stopAt", "Stop the turn after", "repeats"],
              ["staleAfter", "Note no progress after", "calls in a row"],
              ["checkEvery", "Ask it to check itself every", "rounds"],
            ] as [keyof LoopConfig, string, string][]).map(([key, label, unit]) => (
              <label className="tool-opt" key={key}>
                <span className="tool-label">{label}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={loop[key]}
                  onChange={(e) => setLoop({ ...loop, [key]: Number(e.target.value) })}
                />
                <span className="tool-unit">{unit}</span>
              </label>
            ))}
            {keep && ([
              ["sessionDays", "Delete sessions older than", "days (0 = never)"],
              ["keepSessions", "Always keep the newest", "sessions"],
              ["artifactDays", "Delete artifacts older than", "days (0 = never)"],
              ["keepArtifacts", "Always keep the newest", "artifacts"],
            ] as [keyof RetentionPolicy, string, string][]).map(([key, label, unit]) => (
              <label className="tool-opt" key={key}>
                <span className="tool-label">{label}</span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={keep[key]}
                  onChange={(e) => setKeep({ ...keep, [key]: Number(e.target.value) })}
                />
                <span className="tool-unit">{unit}</span>
              </label>
            ))}
          </div>
        </section>
        )}

        {shows("config") && (
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
        )}

        {shows("keys") && voiceKeys.length > 0 && (
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

        {shows("system") && <VoiceCheck />}

        {shows("system") && <TrustThisServer />}
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

/**
 * What the agent can actually do, and how tightly each part of it is held.
 *
 * This is the panel the console was missing. Before it, the three capabilities
 * were configured nowhere, described in a memory graph that could not be
 * edited, and -- in two cases out of three -- not implemented at all. The agent
 * was told none of it, so it answered questions about its own abilities by
 * guessing, and guessed wrong in both directions.
 *
 * Every row is the same registry the model's tool schemas are built from (see
 * server/tools.ts), so what this panel says is what the agent gets. Turning a
 * group off removes those tools from the model's next request entirely and
 * changes the sentence it is given about that group; it is not a UI preference.
 *
 * Changes apply on their own rather than waiting for Save at the top: a
 * capability switch that needs a second click somewhere else to take effect is
 * how you end up believing the terminal is off when it is not.
 */
type JevState = {
  enabled: boolean;
  threshold: number;
  /** The hosted Jev API key: whether one is set, never the key itself. */
  key?: { set: boolean; source: "app" | "secret" | "env" | null; name?: string; masked: string };
  backend?: "hosted" | "model";
  support: { state: "yes" | "no" | "unknown"; reason?: string };
  last: {
    task: string; mode: "jev" | "fallback"; ms: number; fields: number;
    min: number | null; reason?: string; at: number;
  } | null;
};

/**
 * Jev Mode: fast, scored decisions.
 *
 * Says plainly whether the current model can do it -- most reasoning models
 * and Anthropic's API cannot, because they do not return token probabilities
 * -- and what the last decision did, so "is this doing anything?" has an
 * answer on the page.
 */
function JevCard({ jev, onSaved }: { jev: JevState; onSaved: (next: SettingsState) => void }) {
  const [threshold, setThreshold] = useState(jev.threshold);
  const [error, setError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  useEffect(() => setThreshold(jev.threshold), [jev.threshold]);

  const patch = async (change: { enabled?: boolean; threshold?: number; key?: string }) => {
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jev: change }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.detail ?? "Could not change that."); return; }
      if (change.key !== undefined) setKeyDraft("");
      onSaved(body);
    } catch {
      setError("Could not reach the server.");
    }
  };

  const support = !jev.enabled
    ? { cls: "", text: "off" }
    : jev.support.state === "yes"
      ? { cls: "ok", text: "active" }
      : jev.support.state === "no"
        ? { cls: "warn", text: "not supported" }
        : { cls: "", text: "ready" };

  return (
    <section className="set-card">
      <div className="tool-head">
        <h3 style={{ margin: 0 }}>Jev Mode</h3>
        <span className={`tool-state ${support.cls}`}>{support.text}</span>
        <div className="spacer" />
        <button
          className={`job-switch ${jev.enabled ? "on" : ""}`}
          role="switch"
          aria-checked={jev.enabled}
          aria-label={`Jev Mode: ${jev.enabled ? "on" : "off"}`}
          onClick={() => void patch({ enabled: !jev.enabled })}
        >
          <span className="job-knob" />
        </button>
      </div>
      <p className="jf-hint">
        Quick decisions with a fixed set of answers are scored all at once
        instead of written out: every option's probability is read in one
        parallel pass, and the answer is taken only if each part of it clears
        the confidence threshold. Anything less certain goes to the model's
        normal reasoning, exactly as before. It decides three things: which
        memories each turn recalls; whether a message needs an answer, action,
        or a clarifying question first; and, for commands that could destroy
        something, whether it looks destructive and unasked-for — in which case
        the agent must ask you before it runs.
      </p>
      <p className="jf-hint">
        {jev.backend === "hosted"
          ? "Decisions go to the hosted Jev API (TypeSafe), whatever chat model you use."
          : "No Jev API key is set, so decisions are scored by the chat model itself, " +
            "which only works for models that return token probabilities (not Anthropic's)."}
      </p>
      <div className="jf-row" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={jev.key?.set
            ? (jev.key.source === "env"
                ? `Jev key from the server environment (${jev.key.name})`
                : jev.key.source === "secret"
                  ? `Jev key from Secrets (${jev.key.name}, ${jev.key.masked})`
                  : `Jev key saved (${jev.key.masked})`)
            : "Jev API key (jev_...)"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          aria-label="Jev API key"
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <button
          className="btn"
          disabled={!keyDraft.trim()}
          onClick={() => void patch({ key: keyDraft.trim() })}
        >
          Save key
        </button>
        {jev.key?.source === "app" && (
          <button className="btn" onClick={() => void patch({ key: "" })}>Remove</button>
        )}
      </div>
      {jev.enabled && jev.support.state === "no" && jev.support.reason && (
        <p className="set-warn">{jev.support.reason} Autora uses its normal path instead.</p>
      )}
      <label className="jf-row">
        <span>Confidence threshold · {threshold.toFixed(2)}</span>
        <input
          type="range" min={0.5} max={0.99} step={0.01}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          onPointerUp={() => void patch({ threshold })}
          onKeyUp={() => void patch({ threshold })}
          aria-label="Confidence threshold"
        />
      </label>
      {jev.last && (
        <p className="jf-hint">
          Last: {jev.last.task} ·{" "}
          {jev.last.mode === "jev"
            ? `fast path, ${jev.last.fields} fields in ${jev.last.ms} ms, lowest confidence ${
                (jev.last.min ?? 0).toFixed(2)}`
            : `fell back (${jev.last.reason ?? "unknown"})`}
        </p>
      )}
      {error && <p className="set-warn">{error}</p>}
    </section>
  );
}

function ToolsCard({
  tools, onSaved,
}: {
  tools: { config: ToolConfig; groups: ToolGroupState[] };
  onSaved: (next: SettingsState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Send one group's change and adopt whatever the server says the state is
      now -- including availability, which only it can answer. */
  const patch = useCallback(
    async (group: ToolGroupName, change: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tools: { [group]: change } }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.detail ?? "Could not change that.");
          return;
        }
        onSaved(body);
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [onSaved],
  );

  const icons: Record<ToolGroupName, JSX.Element> = {
    terminal: <IconTerminal size={14} />,
    browser: <IconGlobe size={14} />,
    computer: <IconMonitor size={14} />,
    memory: <IconBrain size={14} />,
  };

  return (
    <section className="set-card">
      <h3>Tools</h3>
      <p className="jf-hint">
        What the agent can reach. Each of these is real: the terminal runs
        commands on the machine Autora is installed on, the browser opens real
        pages, computer control drives whichever machine is running the relay,
        and memory outlives the session. Turning one off removes it from the
        model's tools entirely — the agent is then told that group is switched
        off, rather than left to work out why it cannot do something.
      </p>

      {error && <p className="set-warn">{error}</p>}

      <div className="tool-rows">
        {tools.groups.map((group) => {
          const config = tools.config[group.group];
          return (
            <div className={`tool-row ${group.available ? "on" : ""}`} key={group.group}>
              <div className="tool-head">
                <span className="tool-icon">{icons[group.group]}</span>
                <b>{group.label}</b>
                <span className={`tool-state ${
                  group.available ? "ok" : group.enabled ? "warn" : ""}`}
                >
                  {group.available ? "ready" : group.enabled ? "not usable" : "off"}
                </span>
                <div className="spacer" />
                <button
                  className={`job-switch ${config.enabled ? "on" : ""}`}
                  role="switch"
                  aria-checked={config.enabled}
                  aria-label={`${group.label}: ${config.enabled ? "on" : "off"}`}
                  disabled={busy}
                  onClick={() => patch(group.group, { enabled: !config.enabled })}
                >
                  <span className="job-knob" />
                </button>
              </div>

              <p className={group.enabled && !group.available ? "set-warn" : "jf-hint"}>
                {group.detail}
              </p>

              {config.enabled && (
                <>
                  <p className="jf-hint">Runs without asking (yolo mode).</p>

                  {group.group === "browser" && (
                    <div className="set-note" style={{ marginTop: "8px", fontSize: "12px", background: "rgba(255,255,255,0.03)", padding: "8px 12px", borderRadius: "6px" }}>
                      <strong>Browser &amp; OAuth notice:</strong> Most identity providers (Google, GitHub, Cloudflare) block automated Chromium browsers from completing interactive OAuth / SSO logins. When encountering a login or CAPTCHA, click <em>&ldquo;take control&rdquo;</em> on the browser card to type directly, or provide an API token via the <strong>Workspace Secrets</strong> store below.
                    </div>
                  )}

                  {group.group === "terminal" && (
                    <TerminalOptions
                      cwd={tools.config.terminal.cwd}
                      timeout={tools.config.terminal.timeout}
                      busy={busy}
                      onChange={(change) => patch("terminal", change)}
                    />
                  )}

                  {group.available && (
                    <p className="tool-names">
                      {group.tools.map((name) => <code key={name}>{name}</code>)}
                    </p>
                  )}
                </>
              )}

              {/* The relay is the only part of any of this that has to be
                  installed somewhere else, so its instructions belong on its
                  own row rather than in a card further down the panel where
                  the connection between the two is left to be inferred. */}
              {group.group === "computer" && config.enabled && !group.available && (
                <RelaySetup />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Where commands run, and how long they may take.
 *
 * Committed on blur and on Enter rather than per keystroke: each of these is a
 * PATCH, and saving a working directory letter by letter would leave the agent
 * pointed at `/ho` for a moment.
 */
function TerminalOptions({
  cwd, timeout, busy, onChange,
}: {
  cwd: string;
  timeout: number;
  busy: boolean;
  onChange: (change: Record<string, unknown>) => void;
}) {
  const [dir, setDir] = useState(cwd);
  const [secs, setSecs] = useState(String(timeout));

  // Adopt what the server came back with, so a rejected or clamped value
  // (a timeout of 9000 becomes 1800) is visible rather than silently kept.
  useEffect(() => { setDir(cwd); }, [cwd]);
  useEffect(() => { setSecs(String(timeout)); }, [timeout]);

  return (
    <div className="tool-opts">
      <label className="tool-opt">
        <span className="tool-label">Working directory</span>
        <input
          type="text"
          value={dir}
          placeholder="the server's own directory"
          disabled={busy}
          onChange={(e) => setDir(e.target.value)}
          onBlur={() => { if (dir !== cwd) onChange({ cwd: dir }); }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
      </label>
      <label className="tool-opt narrow">
        <span className="tool-label">Give up after</span>
        <input
          type="number"
          min={5}
          max={1800}
          value={secs}
          disabled={busy}
          onChange={(e) => setSecs(e.target.value)}
          onBlur={() => {
            const value = Number(secs);
            if (Number.isFinite(value) && value !== timeout) onChange({ timeout: value });
            else setSecs(String(timeout));
          }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <span className="tool-unit">seconds</span>
      </label>
    </div>
  );
}

/** Which Autora is installed, and whether this page is that Autora. */
type HostInfo = {
  version: string; node: string; platform: string; hostname: string;
  uptime_s: number; host_uptime_s: number; cpus: number; load: number[];
  memory: { rss: number; heap: number; total: number; free: number };
  sessions: number; busy: number; browsers: number; state_file: string; cwd: string;
};

const mb = (n: number) => `${Math.round(n / 1048576).toLocaleString()} MB`;
export function duration(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/** The machine Autora runs on, refreshed while the page is open. */
function HostCard() {
  const [host, setHost] = useState<HostInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/system").then((r) => r.json()).then((d) => alive && setHost(d)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if (!host) return null;
  const used = host.memory.total - host.memory.free;
  return (
    <section className="set-card">
      <h3>Host</h3>
      <dl className="host-grid">
        <dt>Machine</dt><dd>{host.hostname} · {host.platform}</dd>
        <dt>Node</dt><dd>{host.node}</dd>
        <dt>Autora up</dt><dd>{duration(host.uptime_s)}</dd>
        <dt>Host up</dt><dd>{duration(host.host_uptime_s)}</dd>
        <dt>CPU</dt><dd>{host.cpus} cores · load {host.load.map((l) => l.toFixed(2)).join(" / ")}</dd>
        <dt>Memory</dt>
        <dd>
          Autora {mb(host.memory.rss)} · host {mb(used)} of {mb(host.memory.total)}
          <span className="host-meter"><i style={{ width: `${Math.round((used / host.memory.total) * 100)}%` }} /></span>
        </dd>
        <dt>Sessions</dt><dd>{host.sessions} open · {host.busy} working · {host.browsers} browser{host.browsers === 1 ? "" : "s"}</dd>
        <dt>Settings file</dt><dd><code>{host.state_file}</code></dd>
        <dt>Working dir</dt><dd><code>{host.cwd}</code></dd>
      </dl>
    </section>
  );
}

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
