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
  IconSpark,
} from "./Icons";

export interface SecretItem {
  name: string;
  source: "app" | "env";
  masked: string;
  length: number;
  preset?: {
    label: string;
    description: string;
  };
}

export interface PresetDef {
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
    load();
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
    if (!confirm(`Are you sure you want to remove ${name} from the secret store?`)) return;
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
  const handleCopy = async (name: string, maskedVal: string) => {
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

    if (textToCopy) {
      navigator.clipboard.writeText(textToCopy);
      setCopiedKey(name);
      setTimeout(() => setCopiedKey(null), 2000);
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
      {/* Header section */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "8px",
              background: "rgba(var(--accent-rgb), 0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)",
            }}
          >
            <IconShield size={18} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 650, letterSpacing: "0.02em", color: "var(--text)" }}>
              Secret Store &amp; Environment Variables
            </h3>
            <span style={{ fontSize: "12px", color: "var(--text-3)" }}>
              Zero-leak credentials store for terminal subprocesses &amp; API tools
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            className="set-badge"
            style={{
              background: appSecretsCount > 0 ? "rgba(52, 211, 153, 0.15)" : "var(--s3)",
              color: appSecretsCount > 0 ? "var(--live, #34d399)" : "var(--text-3)",
            }}
          >
            {appSecretsCount} stored
          </span>
          {envSecretsCount > 0 && (
            <span className="set-badge" style={{ background: "rgba(34, 211, 238, 0.15)", color: "var(--accent-2, #22d3ee)" }}>
              {envSecretsCount} from system
            </span>
          )}
          <button
            type="button"
            className="btn ghost"
            style={{ padding: "4px 8px", fontSize: "12px" }}
            onClick={() => load(true)}
            title="Refresh secret store"
            disabled={refreshing}
          >
            <IconRepeat size={13} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </div>

      {/* Security explanation banner */}
      <div
        style={{
          background: "rgba(var(--accent-rgb), 0.08)",
          border: "1px solid rgba(var(--accent-rgb), 0.2)",
          borderRadius: "var(--r-sm, 8px)",
          padding: "10px 14px",
          marginBottom: "16px",
          display: "flex",
          gap: "10px",
          alignItems: "flex-start",
        }}
      >
        <div style={{ color: "var(--accent)", marginTop: "2px", flexShrink: 0 }}>
          <IconLock size={16} />
        </div>
        <div style={{ fontSize: "12px", lineHeight: "1.5", color: "var(--text-2)" }}>
          <strong style={{ color: "var(--text)" }}>Zero Conversation Logging:</strong> Sensitive variables defined here
          are strictly redacted from conversation history, transcript messages, and WebSocket broadcasts. When commands run
          or APIs execute, matching secret values are automatically masked as <code>[REDACTED_SECRET]</code>.
        </div>
      </div>

      {/* Preset Suggestions */}
      <div style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
          <span style={{ color: "var(--accent)" }}>
            <IconSpark size={13} />
          </span>
          <span style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Quick Presets
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {Object.entries(presets).map(([k, p]) => {
            const isSet = secrets.some((s) => s.name === k);
            return (
              <button
                key={k}
                type="button"
                className="btn ghost"
                onClick={() => handleSelectPreset(k)}
                style={{
                  fontSize: "11px",
                  padding: "4px 9px",
                  borderRadius: "99px",
                  background: isSet ? "rgba(52, 211, 153, 0.08)" : "var(--s2)",
                  border: isSet ? "1px solid rgba(52, 211, 153, 0.3)" : "1px solid var(--border)",
                  color: isSet ? "var(--live, #34d399)" : "var(--text-2)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
                title={p.description}
              >
                {isSet && <IconCheck size={11} />}
                <code>{k}</code>
              </button>
            );
          })}
        </div>
      </div>

      {/* Feedback notices */}
      {error && (
        <div
          style={{
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "12px",
            fontSize: "12px",
            color: "#f87171",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div
          style={{
            background: "rgba(52, 211, 153, 0.12)",
            border: "1px solid rgba(52, 211, 153, 0.3)",
            borderRadius: "6px",
            padding: "8px 12px",
            marginBottom: "12px",
            fontSize: "12px",
            color: "var(--live, #34d399)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <IconCheck size={15} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Existing Secrets List */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-2)" }}>
            Configured Variables ({filteredSecrets.length})
          </span>
          {secrets.length > 3 && (
            <div style={{ position: "relative", width: "160px" }}>
              <div style={{ position: "absolute", left: "8px", top: "50%", transform: "translateY(-50%)", color: "var(--text-3)", pointerEvents: "none" }}>
                <IconSearch size={12} />
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter secrets..."
                style={{
                  width: "100%",
                  padding: "4px 8px 4px 26px",
                  fontSize: "11.5px",
                  borderRadius: "var(--r-xs, 6px)",
                  background: "var(--s2)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              />
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ padding: "20px", textAlign: "center", color: "var(--text-3)", fontSize: "13px" }}>
            Loading secret store...
          </div>
        ) : filteredSecrets.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              background: "var(--s2)",
              borderRadius: "var(--r-sm, 8px)",
              border: "1px dashed var(--border-strong)",
              color: "var(--text-3)",
              fontSize: "12.5px",
            }}
          >
            <div style={{ opacity: 0.4, margin: "0 auto 8px", display: "inline-block" }}>
              <IconKey size={24} />
            </div>
            <div>{searchQuery ? "No secrets match your filter." : "No secrets configured yet. Add your first API token below."}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filteredSecrets.map((s) => {
              const isRevealed = Boolean(revealed[s.name]);
              const displayVal = isRevealed ? revealed[s.name] : s.masked;
              const isCopied = copiedKey === s.name;

              return (
                <div
                  key={s.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "var(--s2)",
                    borderRadius: "var(--r-sm, 8px)",
                    border: "1px solid var(--border)",
                    flexWrap: "wrap",
                    gap: "10px",
                  }}
                >
                  {/* Left info */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: "220px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <code style={{ fontWeight: 650, fontSize: "13px", color: "var(--accent)" }}>
                        {s.name}
                      </code>
                      <span
                        className="set-badge"
                        style={{
                          fontSize: "10px",
                          padding: "1px 6px",
                          background: s.source === "app" ? "rgba(52, 211, 153, 0.12)" : "rgba(34, 211, 238, 0.12)",
                          color: s.source === "app" ? "var(--live, #34d399)" : "var(--accent-2, #22d3ee)",
                        }}
                      >
                        {s.source === "app" ? "App Secret" : "Container Env"}
                      </span>
                    </div>

                    {s.preset?.description && (
                      <span style={{ fontSize: "11px", color: "var(--text-3)" }}>
                        {s.preset.description}
                      </span>
                    )}

                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
                      <code
                        style={{
                          fontSize: "11.5px",
                          color: isRevealed ? "var(--live, #34d399)" : "var(--text-2)",
                          background: "rgba(0,0,0,0.25)",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {displayVal}
                      </code>
                      {isRevealed && (
                        <span style={{ fontSize: "10px", color: "var(--warn, #fbbf24)" }}>
                          (Auto-hides in 15s)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right actions */}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: "5px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      onClick={() => handleToggleReveal(s.name)}
                      disabled={revealingName === s.name}
                      title={isRevealed ? "Hide secret value" : "Reveal secret value"}
                    >
                      {isRevealed ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                      <span>{isRevealed ? "Hide" : "Reveal"}</span>
                    </button>

                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: "5px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                      onClick={() => handleCopy(s.name, s.masked)}
                      title="Copy secret value to clipboard"
                    >
                      {isCopied ? <span style={{ color: "var(--live, #34d399)", display: "inline-flex" }}><IconCheck size={13} /></span> : <IconCopy size={13} />}
                      <span>{isCopied ? "Copied" : "Copy"}</span>
                    </button>

                    {s.source === "app" && (
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ color: "var(--danger, #fb7185)", padding: "5px 8px", fontSize: "11.5px", display: "inline-flex", alignItems: "center", gap: "4px" }}
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

      {/* Add new secret form */}
      <form
        onSubmit={handleSubmit}
        style={{
          background: "var(--s2)",
          padding: "16px",
          borderRadius: "var(--r-sm, 8px)",
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <span style={{ color: "var(--accent)" }}>
            <IconKey size={15} />
          </span>
          <span style={{ fontSize: "13px", fontWeight: 650, color: "var(--text)" }}>
            Add / Update Secret
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px", marginBottom: "14px" }}>
          {/* Variable Name */}
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text-2)" }}>
              Variable Name
            </span>
            <input
              type="text"
              className="jf-cron"
              placeholder="e.g. GITHUB_TOKEN or TAVILY_API_KEY"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toUpperCase())}
              disabled={busy}
              style={{ fontFamily: "var(--mono)", textTransform: "uppercase" }}
            />
            {presets[newName] && (
              <span style={{ fontSize: "11px", color: "var(--accent)" }}>
                {presets[newName].label}: {presets[newName].description}
              </span>
            )}
          </label>

          {/* Variable Value */}
          <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "11.5px", fontWeight: 600, color: "var(--text-2)" }}>
                Secret Value / Token
              </span>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: "1px 6px", fontSize: "11px" }}
                onClick={() => setShowNewValue(!showNewValue)}
              >
                {showNewValue ? "Hide" : "Show"}
              </button>
            </div>
            <div style={{ position: "relative" }}>
              <input
                type={showNewValue ? "text" : "password"}
                className="jf-cron"
                placeholder={presets[newName]?.placeholder || "Paste secret token..."}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                disabled={busy}
                style={{ fontFamily: "var(--mono)", width: "100%" }}
              />
            </div>
          </label>
        </div>

        {/* Action button */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: "var(--text-3)" }}>
            <IconTerminal size={13} />
            <span>Injected as environment variable into subcommands and tools</span>
          </div>

          <button
            type="submit"
            className="btn"
            disabled={busy || !newName.trim() || !newValue}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 16px" }}
          >
            <IconPlus size={14} />
            <span>{secrets.some((s) => s.name === newName.trim().toUpperCase()) ? "Update Secret" : "Save Secret"}</span>
          </button>
        </div>
      </form>
    </section>
  );
}
