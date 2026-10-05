import { useCallback, useEffect, useRef, useState } from "react";
import { clearOfficePick, setOfficePick, useOfficePick } from "../lib/officeSelection";
import type { OfficeKind } from "../lib/officedesk";

/**
 * A document as pictures of its pages, for a phone (server/officepages.ts): the
 * same pages the full editor lays out, drawn once and kept, so it opens at once
 * and costs nothing to come back to. Tap the words to point at them; the next
 * message to the agent carries what was pointed at, which is how a document is
 * changed from a phone. The full editor is one button away.
 */
type Meta = { w: number; h: number };
type Reply = {
  kind: OfficeKind; name: string; status: "ready" | "working" | "failed";
  hash?: string; pages?: Meta[]; total?: number; error?: string;
  stale?: { hash: string; pages: Meta[]; total: number };
};
type Box = [number, number, number, number];
type Words = { s: string; box: Box; ref?: string }[];
type Area = { box: Box; ref: string; label: string };
type Info = { words: Words; areas: Area[] };

const ZOOMS = [1, 1.6, 2.4];

export function OfficePages({ sessionId, kind, name, rev, onEdit }: { sessionId: string; kind: OfficeKind; name: string; rev: number; onEdit: () => void }) {
  /** Each app's document has its own window and its own drawn pages, so every call says which one. */
  const api = useCallback((path: string) => `/api/officedesk/${encodeURIComponent(sessionId)}${path}?kind=${kind}`, [sessionId, kind]);
  const [reply, setReply] = useState<Reply | null>(null);
  const [zoom, setZoom] = useState(0);
  const words = useRef(new Map<string, Promise<Info>>());
  const pick = useOfficePick();

  // Ask until the pages are drawn; a change to the document (rev) asks again after a moment.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      let next: Reply | null = null;
      try {
        const res = await fetch(api("/pages"), { method: "POST" });
        if (res.ok) next = (await res.json()) as Reply;
      } catch { /* the next try */ }
      if (!live) return;
      if (next) setReply(next);
      if (!next || next.status === "working") timer = setTimeout(() => void ask(), 1500);
    };
    timer = setTimeout(() => void ask(), reply ? 1200 : 0);
    return () => { live = false; if (timer) clearTimeout(timer); };
    // `reply` is deliberately left out: it only decides how soon the first ask is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, rev]);

  const shown = reply?.status === "ready" ? { hash: reply.hash!, pages: reply.pages!, total: reply.total ?? reply.pages!.length } : reply?.stale ?? null;
  const updating = reply !== null && reply.status === "working";

  const wordsOf = useCallback((hash: string, n: number) => {
    const key = `${hash}:${n}`;
    let got = words.current.get(key);
    if (!got) {
      // Older pictures kept a plain list of words; newer ones also say which cell or element is where.
      got = fetch(api(`/pages/${hash}/${n}.json`))
        .then((r) => (r.ok ? r.json() : []))
        .then((v: unknown): Info => (Array.isArray(v) ? { words: v as Words, areas: [] } : { words: (v as Info).words ?? [], areas: (v as Info).areas ?? [] }))
        .catch((): Info => ({ words: [], areas: [] }));
      words.current.set(key, got);
    }
    return got;
  }, [api]);

  const tap = useCallback(async (e: React.MouseEvent<HTMLDivElement>, hash: string, n: number, meta: Meta) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * meta.w;
    const y = ((e.clientY - r.top) / r.height) * meta.h;
    const info = await wordsOf(hash, n);
    // The words under the finger; a finger is not a pixel, so the nearest within a thumb's width will do.
    let best: Words[number] | null = null;
    let bestD = Infinity;
    for (const it of info.words) {
      const [x0, y0, x1, y1] = it.box;
      const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { best = it; bestD = d; }
    }
    const hit = best && bestD <= 24 ? best : null;
    // No words there: a picture or a shape, the smallest thing the finger is inside.
    const thing = hit ? null : info.areas
      .filter((a) => x >= a.box[0] && x <= a.box[2] && y >= a.box[1] && y <= a.box[3])
      .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0] ?? null;
    setOfficePick({
      session: sessionId, file: name, kind: reply?.kind ?? "docx", page: n,
      text: hit ? hit.s.trim() : null, box: hit ? hit.box : thing ? thing.box : null,
      ref: hit ? hit.ref ?? null : thing ? thing.ref : null, label: thing ? thing.label : null,
    });
  }, [name, reply?.kind, sessionId, wordsOf]);

  return (
    <div className="office-pages">
      <div className="office-pages-bar">
        <span className="office-pages-hint">
          {pick && pick.session === sessionId ? "Now tell Autora what to change." : "Tap text to point at it."}
        </span>
        <div className="spacer" />
        {updating && <span className="office-pages-updating">Updating…</span>}
        <button className="pdf-pill" onClick={() => setZoom((z) => (z + 1) % ZOOMS.length)} aria-label="Zoom">
          {Math.round(ZOOMS[zoom] * 100)}%
        </button>
        <button className="pdf-pill" onClick={onEdit} title="Open the full editor (best on a bigger screen)">
          Full editor
        </button>
      </div>
      <div className="office-pages-scroll">
        {!shown && reply?.status !== "failed" && <p className="office-pages-note">Drawing the pages…</p>}
        {reply?.status === "failed" && !shown && (
          <p className="office-pages-note">The pages could not be drawn: {reply.error ?? "unknown reason"}. The full editor still opens it.</p>
        )}
        {shown && (
          <div className="office-pages-list" style={{ width: `${ZOOMS[zoom] * 100}%` }}>
            {shown.pages.map((meta, i) => {
              const n = i + 1;
              const sel = pick && pick.session === sessionId && pick.page === n ? pick : null;
              return (
                <div
                  key={`${shown.hash}-${n}`}
                  className={`office-page${updating ? " is-stale" : ""}`}
                  style={{ aspectRatio: `${meta.w} / ${meta.h}` }}
                  onClick={(e) => void tap(e, shown.hash, n, meta)}
                >
                  <img src={api(`/pages/${shown.hash}/${n}.jpg`)} alt={`${name}, page ${n}`} loading="lazy" draggable={false} />
                  {sel?.box && (
                    <span
                      className="office-pick"
                      style={{
                        left: `${(sel.box[0] / meta.w) * 100}%`, top: `${(sel.box[1] / meta.h) * 100}%`,
                        width: `${((sel.box[2] - sel.box[0]) / meta.w) * 100}%`, height: `${((sel.box[3] - sel.box[1]) / meta.h) * 100}%`,
                      }}
                    />
                  )}
                  {sel && !sel.box && <span className="office-pick is-page" />}
                </div>
              );
            })}
            {shown.total > shown.pages.length && (
              <p className="office-pages-note">The first {shown.pages.length} of {shown.total} pages are shown. The full editor has the rest.</p>
            )}
          </div>
        )}
      </div>
      {pick && pick.session === sessionId && (
        <button className="office-pages-clear" onClick={clearOfficePick}>Clear what I pointed at</button>
      )}
    </div>
  );
}
