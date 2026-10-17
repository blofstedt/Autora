import { useCallback, useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";
import { every } from "../lib/poll";
import { batchNotices, type Notice } from "../lib/noticeBatch";

const POLL_MS = 10_000;
/** Long enough to read a line, short enough that it is gone before you look. */
const SHOW_MS = 5_000;
/** The leaving animation's own length, so it is unmounted once it has slid
    back off the top rather than sitting there invisible. */
const OUT_MS = 320;

/**
 * A scheduled task finishing while you are somewhere else in the app.
 *
 * Runs open sessions of their own, which nothing on screen would otherwise
 * point at; this says one finished (or failed) and takes you to it. Only
 * what happens while the page is open is shown -- the first poll is the
 * starting line, not a backlog.
 *
 * It drops from the top of the screen, under the header, so it never covers
 * the message box or the last thing said. Runs that piled up while you were
 * away (the poll pauses with the tab) arrive as one card per task --
 * "ran 5x from ... to ..." -- not a screenful. The sentence wraps to three
 * lines before it is ellipsised, because the task's name is the whole point
 * of the card.
 */
export function Notices({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [shown, setShown] = useState<Notice[]>([]);
  const [leaving, setLeaving] = useState<number[]>([]);
  const after = useRef<number | null>(null);

  const dismiss = useCallback((id: number) => {
    setLeaving((prev) => (prev.includes(id) ? prev : [...prev, id]));
    window.setTimeout(() => {
      setShown((prev) => prev.filter((x) => x.id !== id));
      setLeaving((prev) => prev.filter((x) => x !== id));
    }, OUT_MS);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetch(`/api/notices?after=${after.current ?? 0}`)
        .then((r) => r.json())
        .then((body: { notices: Notice[]; latest: number }) => {
          if (!alive) return;
          const first = after.current === null;
          after.current = body.latest;
          if (first || body.notices.length === 0) return;
          const batched = batchNotices(body.notices);
          setShown((prev) => [...prev, ...batched].slice(-3));
          for (const n of batched) window.setTimeout(() => dismiss(n.id), SHOW_MS);
        })
        .catch(() => undefined);
    void poll();
    const stop = every(poll, POLL_MS);
    return () => { alive = false; stop(); };
  }, [dismiss]);

  if (shown.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {shown.map((n) => (
        <div key={n.id} className={`notice is-${n.tone}${leaving.includes(n.id) ? " is-leaving" : ""}`}>
          <button
            type="button"
            className="notice-main"
            disabled={!n.session}
            title={n.detail}
            onClick={() => {
              if (n.session) onOpenSession(n.session);
              dismiss(n.id);
            }}
          >
            <b>{n.title}</b>{" "}
            <span>{n.detail}</span>
          </button>
          <button
            type="button"
            className="btn icon ghost notice-x"
            aria-label="Dismiss"
            onClick={() => dismiss(n.id)}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
