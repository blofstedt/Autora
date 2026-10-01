import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconCode, IconFile, IconGlobe, IconSparkle } from "../Icons";

type WindowKey = "widgets" | "browser" | "app" | "pdf";

type ToolsState = {
  config: Record<WindowKey, { enabled: boolean }>;
  groups: { group: string; available: boolean; enabled: boolean; detail: string }[];
};

const WINDOWS: { key: WindowKey; name: string; icon: ReactNode; what: string; tools: string }[] = [
  {
    key: "widgets",
    name: "Widget window",
    icon: <IconSparkle size={18} />,
    what: "Interactive explainers the agent builds in the thread — a mechanism you can turn, a graph you can drag.",
    tools: "widget_show",
  },
  {
    key: "browser",
    name: "Browser window",
    icon: <IconGlobe size={18} />,
    what: "A real Chromium the agent drives and you can watch or take over: reading pages, filling forms, taking screenshots.",
    tools: "browser_*",
  },
  {
    key: "app",
    name: "Construction window",
    icon: <IconCode size={18} />,
    what: "Where the websites and apps the agent builds run live beside the chat, for you to click through, comment on and review.",
    tools: "app_preview",
  },
  {
    key: "pdf",
    name: "PDF editor",
    icon: <IconFile size={18} />,
    what: "Writing reports as PDFs, reading, filling, signing, marking up, redacting, merging, splitting and shrinking PDFs, in a window beside the chat where you can move what it placed and add your own.",
    tools: "pdf_read, pdf_look, pdf_edit, pdf_compose, pdf_pages, pdf_redact, pdf_compress",
  },
];

/**
 * Tools: the built-in windows, each switched on or off. Off takes its tools
 * away from the agent from the next turn and tells it so.
 */
export function ToolsPage() {
  const [state, setState] = useState<ToolsState | null>(null);
  const [busy, setBusy] = useState<WindowKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((body: any) => {
    if (body?.tools?.config) setState(body.tools as ToolsState);
  }, []);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(adopt).catch(() => setError("Could not load the tools."));
  }, [adopt]);

  const toggle = async (key: WindowKey, enabled: boolean) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: { [key]: { enabled } } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.detail ?? "Could not change that.");
      else adopt(body);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint art-lede">
          The windows built into Autora. All are on to start with; switch one off and the agent
          stops using it from its next step, and is told it is off rather than left to guess.
        </p>
        {error && <p className="set-warn">{error}</p>}
        {state === null && !error && <p className="jf-hint">Loading…</p>}
        {state && (
          <div className="tw-grid">
            {WINDOWS.map((w) => {
              const on = state.config[w.key]?.enabled !== false;
              const group = w.key === "browser" ? state.groups.find((g) => g.group === "browser") : null;
              const trouble = on && group && !group.available ? group.detail : null;
              return (
                <section key={w.key} className={`tw-card${on ? " on" : ""}`}>
                  <div className="tw-head">
                    <span className="tw-icon">{w.icon}</span>
                    <b>{w.name}</b>
                    <span className={`tool-state ${on ? (trouble ? "warn" : "ok") : ""}`}>
                      {on ? (trouble ? "not usable" : "on") : "off"}
                    </span>
                    <div className="spacer" />
                    <button
                      className={`job-switch ${on ? "on" : ""}`}
                      role="switch"
                      aria-checked={on}
                      aria-label={`${w.name}: ${on ? "on" : "off"}`}
                      disabled={busy !== null}
                      onClick={() => void toggle(w.key, !on)}
                    >
                      <span className="job-knob" />
                    </button>
                  </div>
                  <p className="jf-hint">{w.what}</p>
                  {trouble && <p className="set-warn">{trouble}</p>}
                  <p className="tool-names"><code>{w.tools}</code></p>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
