import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  IconShield,
  IconLock,
  IconKey,
  IconEye,
  IconEyeOff,
  IconTrash,
  IconCopy,
  IconCheck,
  IconPlus,
  IconSearch,
  IconAlert,
  IconTerminal,
  IconRepeat,
  IconMark,
} from "./Icons";
import { sure } from "../lib/sure";

interface SecretItem {
  name: string;
  source: "app" | "env";
  masked: string;
  length: number;
  preset?: {
    label: string;
    description: string;
  };
}

interface PresetDef {
  label: string;
  description: string;
  placeholder: string;
}

export function SecretStore() {
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [presets, setPresets] = useState<Record<string, PresetDef>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // New secret form state
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showNewValue, setShowNewValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Revealed secrets cache (name -> raw value)
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealingName, setRevealingName] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Fetch secrets and presets
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const [resSecrets, resPresets] = await Promise.all([
        fetch("/api/secrets"),
        fetch("/api/secrets/presets"),
      ]);
      if (resSecrets.ok) {
        setSecrets(await resSecrets.json());
      }
      if (resPresets.ok) {
        setPresets(await resPresets.json());
      }
    } catch {
      setError("Failed to load secrets from server.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-dismiss success message
  useEffect(() => {
    if (successMsg) {
      const timer = setTimeout(() => setSuccessMsg(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [successMsg]);

  // Handle adding or updating a secret
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newName.trim().toUpperCase();
    if (!cleanName) {
      setError("Please specify a secret environment variable name.");
      return;
    }
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(cleanName)) {
      setError("Variable name must be valid uppercase alphanumeric (e.g. GITHUB_TOKEN).");
      return;
    }
    if (!newValue) {
      setError("Please provide a secret value.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName, value: newValue }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to store secret");
        return;
      }

      const data = await res.json();
      setSecrets(data.secrets);
      setNewName("");
      setNewValue("");
      setShowNewValue(false);
      setSuccessMsg(`Secret ${cleanName} securely saved and ready for tool execution.`);
    } catch {
      setError("Network error while connecting to secrets service.");
    } finally {
      setBusy(false);
    }
  };

  // Handle deleting a secret
  const handleDelete = async (name: string) => {
    if (!(await sure(`Remove ${name} from the secret store?`, "Remove"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const data = await res.json();
        setSecrets(data.secrets);
        setRevealed((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        setSuccessMsg(`Secret ${name} removed.`);
      } else {
        setError("Failed to delete secret.");
      }
    } catch {
      setError("Network error while deleting secret.");
    } finally {
      setBusy(false);
    }
  };

  // Handle reveal request
  const handleToggleReveal = async (name: string) => {
    if (revealed[name]) {
      // Hide
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      return;
    }

    setRevealingName(name);
    try {
      const res = await fetch("/api/secrets/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const data = await res.json();
        setRevealed((prev) => ({ ...prev, [name]: data.value }));
        // Auto-hide after 15 seconds for privacy
        setTimeout(() => {
          setRevealed((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
          });
        }, 15000);
      }
    } catch {
      setError("Unable to reveal secret value.");
    } finally {
      setRevealingName(null);
    }
  };

  // Copy secret value to clipboard
  const handleCopy = async (name: string) => {
    let textToCopy = revealed[name];
    if (!textToCopy) {
      try {
        const res = await fetch("/api/secrets/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (res.ok) {
          const data = await res.json();
          textToCopy = data.value;
        }
      } catch {}
    }

    // No clipboard over plain http (an Umbrel on the LAN), and a refused
    // write rejects: say "copied" only when it was.
    if (textToCopy && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(textToCopy);
        setCopiedKey(name);
        setTimeout(() => setCopiedKey(null), 2000);
      } catch {}
    }
  };

  // Preset selection helper
  const handleSelectPreset = (presetName: string) => {
    setNewName(presetName);
    setError(null);
  };

  // Filtered secrets
  const filteredSecrets = useMemo(() => {
    if (!searchQuery.trim()) return secrets;
    const q = searchQuery.toLowerCase();
    return secrets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.preset?.label.toLowerCase().includes(q) ||
        s.preset?.description.toLowerCase().includes(q)
    );
  }, [secrets, searchQuery]);

  const appSecretsCount = secrets.filter((s) => s.source === "app").length;
  const envSecretsCount = secrets.filter((s) => s.source === "env").length;

  return (
    <section className="set-card" id="secret-store-panel">
      <div className="ss-head">
        <div className="ss-title">
          <div className="ss-ico"><IconShield size={18} /></div>
          <div>
            <h3>Secret Store &amp; Environment Variables</h3>
            <span className="ss-sub">Zero-leak credentials store for terminal subprocesses &amp; API tools</span>
          </div>
        </div>

        <div className="ss-counts">
          <span className={`set-badge ${appSecretsCount > 0 ? "is-good" : "is-unset"}`}>{appSecretsCount} stored</span>
          {envSecretsCount > 0 && <span className="set-badge is-info">{envSecretsCount} from system</span>}
          <button
            type="button"
            className="btn ghost ss-small"
            onClick={() => load(true)}
            title="Refresh secret store"
            disabled={refreshing}
          >
            <IconRepeat size={13} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </div>

      <div className="ss-note">
        <span className="ss-note-ico"><IconLock size={16} /></span>
        <div>
          <strong>Zero Conversation Logging:</strong> Sensitive variables defined here
          are strictly redacted from conversation history, transcript messages, and WebSocket broadcasts. When commands run
          or APIs execute, matching secret values are automatically masked as <code>[REDACTED_SECRET]</code>.
        </div>
      </div>

      <div className="ss-presets">
        <div className="ss-label-row">
          <span className="ss-accent"><IconMark size={13} /></span>
          <span className="ss-caps">Quick Presets</span>
        </div>
        <div className="ss-chips">
          {Object.entries(presets).map(([k, p]) => {
            const isSet = secrets.some((s) => s.name === k);
            return (
              <button
                key={k}
                type="button"
                className={`btn ghost ss-chip${isSet ? " is-set" : ""}`}
                onClick={() => handleSelectPreset(k)}
                title={p.description}
              >
                {isSet && <IconCheck size={11} />}
                <code>{k}</code>
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="ss-flash is-bad" role="alert">
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="ss-flash is-good" role="status">
          <IconCheck size={15} />
          <span>{successMsg}</span>
        </div>
      )}

      <div className="ss-list-wrap">
        <div className="ss-list-head">
          <span className="ss-list-title">Configured Variables ({filteredSecrets.length})</span>
          {secrets.length > 3 && (
            <div className="ss-search">
              <span className="ss-search-ico"><IconSearch size={12} /></span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter secrets..."
              />
            </div>
          )}
        </div>

        {loading ? (
          <div className="ss-empty is-plain">Loading secret store...</div>
        ) : filteredSecrets.length === 0 ? (
          <div className="ss-empty">
            <div className="ss-empty-ico"><IconKey size={24} /></div>
            <div>{searchQuery ? "No secrets match your filter." : "No secrets configured yet. Add your first API token below."}</div>
          </div>
        ) : (
          <div className="ss-list">
            {filteredSecrets.map((s) => {
              const isRevealed = Boolean(revealed[s.name]);
              const displayVal = isRevealed ? revealed[s.name] : s.masked;
              const isCopied = copiedKey === s.name;

              return (
                <div key={s.name} className="ss-row">
                  <div className="ss-info">
                    <div className="ss-name-row">
                      <code className="ss-name">{s.name}</code>
                      <span className={`set-badge ss-source ${s.source === "app" ? "is-good" : "is-info"}`}>
                        {s.source === "app" ? "App Secret" : "Container Env"}
                      </span>
                    </div>

                    {s.preset?.description && <span className="ss-desc">{s.preset.description}</span>}

                    <div className="ss-value-row">
                      <code className={`ss-value${isRevealed ? " is-revealed" : ""}`}>{displayVal}</code>
                      {isRevealed && <span className="ss-autohide">(Auto-hides in 15s)</span>}
                    </div>
                  </div>

                  <div className="ss-actions">
                    <button
                      type="button"
                      className="btn ghost ss-act"
                      onClick={() => handleToggleReveal(s.name)}
                      disabled={revealingName === s.name}
                      title={isRevealed ? "Hide secret value" : "Reveal secret value"}
                    >
                      {isRevealed ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                      <span>{isRevealed ? "Hide" : "Reveal"}</span>
                    </button>

                    <button
                      type="button"
                      className={`btn ghost ss-act${isCopied ? " is-done" : ""}`}
                      onClick={() => void handleCopy(s.name)}
                      title="Copy secret value to clipboard"
                    >
                      {isCopied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                      <span>{isCopied ? "Copied" : "Copy"}</span>
                    </button>

                    {s.source === "app" && (
                      <button
                        type="button"
                        className="btn ghost ss-act is-danger"
                        onClick={() => handleDelete(s.name)}
                        disabled={busy}
                        title="Remove secret from store"
                      >
                        <IconTrash size={13} />
                        <span>Remove</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="ss-form">
        <div className="ss-label-row ss-form-head">
          <span className="ss-accent"><IconKey size={15} /></span>
          <span className="ss-form-title">Add / Update Secret</span>
        </div>

        <div className="ss-fields">
          <label className="ss-field">
            <span className="ss-field-label">Variable Name</span>
            <input
              type="text"
              className="jf-cron ss-mono ss-upper"
              placeholder="e.g. GITHUB_TOKEN or TAVILY_API_KEY"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toUpperCase())}
              disabled={busy}
            />
            {presets[newName] && (
              <span className="ss-hint">{presets[newName].label}: {presets[newName].description}</span>
            )}
          </label>

          <label className="ss-field">
            <div className="ss-field-head">
              <span className="ss-field-label">Secret Value / Token</span>
              <button type="button" className="btn ghost ss-tiny" onClick={() => setShowNewValue(!showNewValue)}>
                {showNewValue ? "Hide" : "Show"}
              </button>
            </div>
            <input
              type={showNewValue ? "text" : "password"}
              className="jf-cron ss-mono ss-wide"
              placeholder={presets[newName]?.placeholder || "Paste secret token..."}
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        <div className="ss-submit-row">
          <div className="ss-injects">
            <IconTerminal size={13} />
            <span>Injected as environment variable into subcommands and tools</span>
          </div>

          <button type="submit" className="btn ss-submit" disabled={busy || !newName.trim() || !newValue}>
            <IconPlus size={14} />
            <span>{secrets.some((s) => s.name === newName.trim().toUpperCase()) ? "Update Secret" : "Save Secret"}</span>
          </button>
        </div>
      </form>
    </section>
  );
}
