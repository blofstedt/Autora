import { useEffect, useRef, useState } from "react";
import { IconX } from "./Icons";

type Notice = {
  id: number;
  ts: number;
  tone: "ok" | "error" | "info";
  title: string;
  detail: string;
  session: string | null;
};

const POLL_MS = 10_000;
const SHOW_MS = 15_000;

/**
 * A scheduled task finishing while you are somewhere else in the app.
 *
 * Runs open sessions of their own, which nothing on screen would otherwise
 * point at; this says one finished (or failed) and takes you to it. Only
 * what happens while the page is open is shown -- the first poll is the
 * starting line, not a backlog.
 */
export function Notices({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [shown, setShown] = useState<Notice[]>([]);
  const after = useRef<number | null>(null);

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
          setShown((prev) => [...prev, ...body.notices].slice(-3));
          for (const n of body.notices) {
            window.setTimeout(() => setShown((prev) => prev.filter((x) => x.id !== n.id)), SHOW_MS);
          }
        })
        .catch(() => undefined);
    void poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  if (shown.length === 0) return null;
  return (
    <div className="notices" role="status" aria-live="polite">
      {shown.map((n) => (
        <div key={n.id} className={`notice is-${n.tone}`}>
          <button
            type="button"
            className="notice-main"
            disabled={!n.session}
            onClick={() => {
              if (n.session) onOpenSession(n.session);
              setShown((prev) => prev.filter((x) => x.id !== n.id));
            }}
          >
            <b>{n.title}</b>
            <span>{n.detail}</span>
          </button>
          <button
            type="button"
            className="btn icon ghost"
            aria-label="Dismiss"
            onClick={() => setShown((prev) => prev.filter((x) => x.id !== n.id))}
          >
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
