import { useRef, useState } from "react";
import type { PreviewApi } from "../lib/appApi";
import type { ReviewComment } from "../lib/preview";
import { IconTrash } from "./Icons";

/**
 * The comments so far, as one review. Nothing has gone to the agent yet: they
 * collect here -- each with the picture taken when it was made -- and go
 * together, so one turn answers all of them. A comment can be reworded or
 * dropped until then.
 */
function label(c: ReviewComment): string {
  if (c.kind === "region" && c.region) return `Region ${Math.round(c.region.w)}×${Math.round(c.region.h)}`;
  const first = c.elements[0];
  if (!first) return "Element";
  const more = c.elements.length > 1 ? ` +${c.elements.length - 1}` : "";
  return `${first.tag}${first.id ? `#${first.id}` : first.classes[0] ? `.${first.classes[0]}` : ""}${more}`;
}

function summary(c: ReviewComment): string {
  if (c.text) return c.text;
  if (c.textEdit) return `Text: “${c.textEdit.to}”`;
  if (c.styleChanges.length) return c.styleChanges.map((s) => `${s.property}: ${s.to}`).join(", ");
  return "(see the picture)";
}

export function AppReview({
  sessionId, api, comments, open, onToggle, hover, onHover, onSent,
}: {
  sessionId: string;
  api: PreviewApi;
  comments: ReviewComment[];
  open: boolean;
  onToggle: () => void;
  hover: string | null;
  onHover: (id: string | null) => void;
  onSent: () => void;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Escape leaves an edit without saving it; the blur that follows must know. */
  const dropEdit = useRef(false);
  const n = comments.length;
  const canSend = !sending && (n > 0 || note.trim().length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const r = await api.send(note.trim());
    setSending(false);
    if (!r.ok) { setError(r.error); return; }
    setNote("");
    onSent();
  };

  const reword = async (c: ReviewComment) => {
    setEditing(null);
    if (dropEdit.current) { dropEdit.current = false; return; }
    if (draft.trim() === c.text.trim()) return;
    const r = await api.reword(c.id, draft);
    if (!r.ok) setError(r.error);
  };

  const remove = async (id: string) => {
    const r = await api.remove(id);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className={`app-review${open ? " is-open" : ""}${n === 0 ? " is-empty" : ""}`}>
      <div className="app-review-bar">
        <button type="button" className="app-review-toggle" onClick={onToggle} aria-expanded={open}>
          <span className="app-review-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <b>Review</b>
          <span className="app-review-count">{n === 0 ? "nothing yet" : `${n} comment${n === 1 ? "" : "s"}`}</span>
        </button>
        <button type="button" className="btn small primary app-send" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Sending…" : n === 0 ? "Send" : `Send ${n} comment${n === 1 ? "" : "s"}`}
        </button>
      </div>
      {open && (
        <div className="app-review-body">
          {n === 0 && (
            <p className="app-review-hint">
              Choose <b>Select</b> and tap something on the page, or <b>Region</b> and drag a box, then say what should change.
              Comments collect here and go together.
            </p>
          )}
          <ol className="app-comments">
            {comments.map((c, i) => (
              <li
                key={c.id}
                className={`app-comment${hover === c.id ? " is-hover" : ""}`}
                onMouseEnter={() => onHover(c.id)}
                onMouseLeave={() => onHover(null)}
              >
                <span className="app-comment-n">{i + 1}</span>
                {c.blob ? (
                  <a className="app-comment-pic-link" href={`/api/sessions/${sessionId}/blobs/${c.blob}`} target="_blank" rel="noreferrer" title="Open the picture">
                    <img className="app-comment-pic" alt={`Comment ${i + 1}`} loading="lazy" src={`/api/sessions/${sessionId}/blobs/${c.blob}`} />
                  </a>
                ) : <span className="app-comment-pic is-none" />}
                <div className="app-comment-main">
                  <span className="app-comment-what">{label(c)}</span>
                  {editing === c.id ? (
                    <textarea
                      className="app-comment-edit"
                      autoFocus
                      rows={2}
                      value={draft}
                      maxLength={2000}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void reword(c)}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Escape") { e.preventDefault(); dropEdit.current = true; (e.target as HTMLTextAreaElement).blur(); }
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
                      }}
                    />
                  ) : (
                    <button type="button" className="app-comment-text" onClick={() => { setDraft(c.text); setEditing(c.id); }} title="Edit">
                      {summary(c)}
                    </button>
                  )}
                </div>
                <button type="button" className="btn icon ghost app-x" onClick={() => void remove(c.id)} aria-label={`Remove comment ${i + 1}`}>
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ol>
          <input
            className="app-note"
            value={note}
            maxLength={2000}
            placeholder="A word about the whole thing (optional)"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void send(); }}
          />
          {error && <p className="app-err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
