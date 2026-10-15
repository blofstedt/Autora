import { useCallback, useEffect, useRef, useState } from "react";
import { IconCheck, IconSave } from "./Icons";

/**
 * Save, in every tool window's bar: what is in the window now, written at once
 * and kept in Artifacts (in this chat's folder), without asking the agent or
 * waking it. The windows also save as you go; this is the one to press when
 * you want to know it is kept, and where.
 *
 * `onSave` does the window's own part and says what was kept ("Kept as
 * Novel.png"); a throw is shown as the reason it was not.
 */
export function SaveButton({ onSave, disabled, phone, label = "Save" }: {
  onSave: () => Promise<string>;
  disabled?: boolean;
  /** A phone's bar is round buttons only: Save is one, its state in its icon and colour. */
  phone?: boolean;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [said, setSaid] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const press = useCallback(async () => {
    if (state === "saving") return;
    if (timer.current) window.clearTimeout(timer.current);
    setState("saving");
    setSaid("");
    try {
      setSaid(await onSave());
      setState("saved");
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 4000);
  }, [onSave, state]);

  return (
    <>
      <button
        className={`${phone ? "btn icon ghost" : "pdf-pill"} win-save is-${state}`}
        onClick={() => void press()}
        disabled={disabled || state === "saving"}
        title={state === "idle" ? "Save now, with a copy in Artifacts" : said || undefined}
        aria-label={state === "saved" ? `Saved. ${said}` : label}
      >
        {phone ? (state === "saved" ? <IconCheck size={15} /> : <IconSave size={15} />) : (
          <>
            {state === "saved" && <IconCheck size={12} />}
            {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "failed" ? "Not saved" : label}
          </>
        )}
      </button>
      <span className="sr-only" aria-live="polite">{state === "idle" || state === "saving" ? "" : said}</span>
    </>
  );
}

/** What a window's keep route answered, as the line the button shows. */
export async function keptAs(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { name?: string; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
  return body?.name ? `Kept in Artifacts as ${body.name}` : "Saved";
}

/** A moment for edits still on their way (the windows save a short pause after the last one). */
export const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
