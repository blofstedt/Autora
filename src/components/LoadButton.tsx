import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconFolder } from "./Icons";
import { LibraryPicker } from "./LibraryPicker";
import { LOAD_WHAT, loadable, type LoadApp } from "../lib/loadable";
import type { ArtifactInfo } from "../lib/notebooks";

/**
 * Load, beside Save in every tool window's bar: pick a saved file from Artifacts and it opens in this window, with no
 * message to the agent and no turn. Only the files this app can open are offered (`loadable`, shared with the server's
 * route), and the chat's own folder is where they are listed with the rest, by project.
 *
 * What it opened is said in the button for a few seconds; a refusal is shown as the reason it did not.
 */
export function LoadButton({ app, session, disabled, phone, label = "Load" }: {
  app: LoadApp;
  session: string;
  disabled?: boolean;
  /** A phone's bar is round buttons only. */
  phone?: boolean;
  label?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [said, setSaid] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const filter = useCallback((f: ArtifactInfo) => loadable(app, f), [app]);
  const close = useCallback(() => setPicking(false), []);

  const load = useCallback(async (file: ArtifactInfo) => {
    setPicking(false);
    if (timer.current) window.clearTimeout(timer.current);
    setState("loading");
    setSaid("");
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app, artifact: file.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { said?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Autora answered ${res.status}`);
      setSaid(body.said ?? `${file.name} is open.`);
      setState("loaded");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 5000);
  }, [app, session]);

  return (
    <>
      <button
        className={`${phone ? "btn icon ghost" : "pdf-pill"} win-save win-load is-${state}`}
        onClick={() => setPicking(true)}
        disabled={disabled || state === "loading"}
        title={state === "idle" ? `Load ${LOAD_WHAT[app]} from Artifacts` : said || undefined}
        aria-label={state === "loaded" ? `Loaded. ${said}` : state === "failed" ? `Not loaded. ${said}` : label}
      >
        {phone ? (state === "loaded" ? <IconCheck size={15} /> : <IconFolder size={15} />) : (
          <>
            {state === "loaded" && <IconCheck size={12} />}
            {state === "loading" ? "Loading…" : state === "loaded" ? "Loaded" : state === "failed" ? "Not loaded" : label}
          </>
        )}
      </button>
      <span className="sr-only" aria-live="polite">{state === "loaded" || state === "failed" ? said : ""}</span>
      {picking && (
        <LibraryPicker
          tabs={["files"]}
          title={`Load ${LOAD_WHAT[app]}`}
          action="Load"
          filter={filter}
          single
          onClose={close}
          onPick={(picked) => { if (picked.files[0]) void load(picked.files[0]); }}
        />
      )}
    </>
  );
}
