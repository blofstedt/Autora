import { useCallback, useEffect, useState } from "react";
import { IconX } from "./Icons";

type Version = { id: string; label: string; ts: number; files: number };

const when = (ts: number) => {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
};

/**
 * The folder the agent builds in, as saved versions: one per turn that
 * changed code. Restoring puts the files back as they were (and removes the
 * ones made since); the present is saved first, so a restore can be undone.
 */
export function VersionsPanel({ sessionId, busy, onClose }: { sessionId: string; busy: boolean; onClose: () => void }) {
  const [list, setList] = useState<Version[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/versions").then((r) => r.json()).then((d) => setList(d.versions ?? [])).catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  const restore = (id: string) => {
    setAsking(null);
    setNote("Restoring…");
    void fetch("/api/versions/restore", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, session: sessionId }),
    }).then((r) => r.json().then((d) => {
      if (!r.ok) throw new Error(d.error ?? "Could not restore that.");
      setList(d.versions ?? []);
      setNote("Restored. The previous state is the version below it, if you want it back.");
    })).catch((e: Error) => setNote(e.message));
  };

  return (
    <div className="shot-panel">
      <div className="shot-panel-head">
        <strong>Versions</strong>
        <button className="shot-tool" onClick={onClose} aria-label="Close versions"><IconX size={13} /></button>
      </div>
      <div className="shot-panel-list">
        {list === null && <p className="shot-panel-empty">Loading…</p>}
        {list?.length === 0 && <p className="shot-panel-empty">Nothing saved yet. A version is saved each time the agent finishes a turn that changed code.</p>}
        {list?.map((v, i) => (
          <div key={v.id} className="shot-ext">
            <span className="shot-ext-name" title={v.label}>
              {v.label} <em>{when(v.ts)}{v.files ? ` · ${v.files} file${v.files === 1 ? "" : "s"}` : ""}</em>
            </span>
            {i === 0 ? <em className="shot-exp">latest</em> : asking === v.id ? (
              <>
                <button className="cell-act" disabled={busy} onClick={() => restore(v.id)}>Restore</button>
                <button className="cell-act" onClick={() => setAsking(null)}>Cancel</button>
              </>
            ) : (
              <button className="cell-act" disabled={busy} onClick={() => setAsking(v.id)} title={busy ? "Wait for the agent to finish" : "Put the files back as they were then"}>
                Go back to this
              </button>
            )}
          </div>
        ))}
        {note && <p className="shot-panel-empty">{note}</p>}
      </div>
    </div>
  );
}

export const TEMPLATES: Array<{ name: string; prompt: string }> = [
  { name: "Landing page", prompt: "Build a clean, responsive landing page: hero with a headline and call to action, three feature blocks, a testimonial, pricing, and a footer. Plain HTML and CSS unless I say otherwise. Ask me for the product's name and what it does if you need it." },
  { name: "Dashboard", prompt: "Build a responsive dashboard: a sidebar, summary cards, two charts and a table with sorting and search, using sample data I can later replace. Make it work on a phone too." },
  { name: "To-do app", prompt: "Build a to-do app: add, check off, edit and delete tasks, filter by all, active and done, kept in the browser's storage so it survives a reload. Make it work well on a phone." },
  { name: "Portfolio", prompt: "Build a personal portfolio site: an intro, a grid of project cards, an about section and a contact form. Light and dark themes. Ask me for my name and projects if you need them." },
  { name: "Blog", prompt: "Build a small blog: an index of posts, a post page, and three sample posts written in Markdown files I can edit. Readable typography, and good on a phone." },
  { name: "Form with validation", prompt: "Build a multi-step sign-up form with live validation, clear error messages, a progress indicator, and a summary page before submitting. Accessible with the keyboard." },
];

/** Starting points: each is a message to the agent, sent as if typed. */
export function TemplatesPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [sent, setSent] = useState<string | null>(null);
  const start = (t: (typeof TEMPLATES)[number]) => {
    setSent(t.name);
    void fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t.prompt }),
    }).then(() => onClose()).catch(() => setSent(null));
  };
  return (
    <div className="shot-panel">
      <div className="shot-panel-head">
        <strong>Start from a template</strong>
        <button className="shot-tool" onClick={onClose} aria-label="Close templates"><IconX size={13} /></button>
      </div>
      <div className="shot-panel-list">
        {TEMPLATES.map((t) => (
          <button key={t.name} className="shot-panel-row" disabled={sent !== null} onClick={() => start(t)} title={t.prompt}>
            <span>{t.name}</span><em>{t.prompt.slice(0, 80)}…</em>
          </button>
        ))}
      </div>
    </div>
  );
}
