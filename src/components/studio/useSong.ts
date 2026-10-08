import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fitBars, newProject, normalizeProject, type Project } from "../../lib/studio/model";
import { onStudioState, studioStateNow } from "../../lib/studio";

type SaveState = "saved" | "saving" | "error";
export type Edit = (draft: Project) => void;
/** What a component calls to change the song; `key` joins a quick run of one kind of edit (a slider) into one undo step. */
export type Editor = (fn: Edit, key?: string) => void;

/** The ids of clips whose notes, place or length differ between two songs: what the agent just touched. */
function touched(before: Project, after: Project): Set<string> {
  const was = new Map<string, string>();
  for (const t of before.tracks) for (const c of t.clips) was.set(c.id, JSON.stringify([t.id, c.start, c.length, c.notes.map((n) => [n.pitch, n.start, n.length, n.vel])]));
  const out = new Set<string>();
  for (const t of after.tracks) {
    for (const c of t.clips) {
      if (was.get(c.id) !== JSON.stringify([t.id, c.start, c.length, c.notes.map((n) => [n.pitch, n.start, n.length, n.vel])])) out.add(c.id);
    }
  }
  return out;
}

const HISTORY = 100;

/**
 * The song in the browser: edited here, kept on the server (server/studio.ts) where the agent works on it too.
 *
 *   - `edit` changes a copy, remembers the old one for undo, and saves after a pause in the person's edits;
 *   - when the agent changes the song the server says so and the new one is loaded; the old one goes on the undo
 *     stack, so the person can take any of the agent's changes back with Ctrl+Z;
 *   - while a note is being dragged (`hold`), an agent's change waits for the pointer to come up.
 */
export function useSong(sessionId: string) {
  const [project, setProject] = useState<Project>(() => newProject("My song"));
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string | null>(null);
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const live = useRef(project);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  /** The newest server revision this window has: loaded, or made by saving. */
  const known = useRef(-1);
  const holding = useRef(0);
  const waiting = useRef(false);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const dirty = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const base = `/api/studio/${encodeURIComponent(sessionId)}`;

  const put = useCallback((next: Project) => {
    live.current = next;
    setProject(next);
  }, []);

  const counts = () => setDepth({ undo: past.current.length, redo: future.current.length });

  const flush = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (dirty.current) {
        dirty.current = false;
        setSave("saving");
        const res = await fetch(`${base}/doc`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: live.current, rev: known.current }),
        });
        const body = (await res.json().catch(() => null)) as { rev?: number; error?: string } | null;
        if (res.status === 409) {
          // The agent changed the song since this window last loaded it: take theirs rather than undo it unseen.
          known.current = Number(body?.rev ?? known.current);
          waiting.current = false;
          dirty.current = false;
          const fresh = await fetch(`${base}/doc`).then((r) => r.json()).catch(() => null) as { doc?: unknown; rev?: number } | null;
          const doc = normalizeProject(fresh?.doc);
          if (doc) {
            past.current.push(live.current);
            future.current = [];
            known.current = Number(fresh?.rev ?? known.current);
            put(doc);
            counts();
          }
          setNotice("Autora changed the song while you were editing, so your last change was not kept. Undo (Ctrl+Z) brings it back.");
          setSave("saved");
          return;
        }
        if (!res.ok) throw new Error(body?.error ?? `Autora answered ${res.status}`);
        known.current = Math.max(known.current, Number(body?.rev ?? 0));
        setSave(dirty.current ? "saving" : "saved");
      }
    } catch (err) {
      setSave("error");
      setNotice(`Your last change was not saved: ${err instanceof Error ? err.message : String(err)}`);
      dirty.current = true;
    } finally {
      saving.current = false;
    }
  }, [base, put]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 300);
  }, [flush]);

  /** The song as the server has it, taken in. `mark` says the agent made the change, so what it touched is shown. */
  const load = useCallback(async (mark: boolean) => {
    try {
      const res = await fetch(`${base}/doc`);
      const body = (await res.json().catch(() => null)) as { doc?: unknown; rev?: number; error?: string } | null;
      const doc = normalizeProject(body?.doc);
      if (!res.ok || !doc) throw new Error(body?.error ?? `Autora answered ${res.status}`);
      const before = live.current;
      known.current = Number(body?.rev ?? 0);
      if (mark && JSON.stringify(before) !== JSON.stringify(doc)) {
        past.current.push(before);
        if (past.current.length > HISTORY) past.current.shift();
        future.current = [];
        counts();
        const hit = touched(before, doc);
        if (hit.size) {
          setFlash(hit);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(new Set()), 2200);
        }
      }
      put(doc);
      setReady(true);
    } catch (err) {
      setNotice(`The song could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [base, put]);

  useEffect(() => {
    void load(false);
  }, [load]);

  // The agent changed the song.
  useEffect(
    () =>
      onStudioState(() => {
        const now = studioStateNow();
        if (!now.open || now.rev === undefined) return;
        if (now.by === "agent" && now.rev > known.current) {
          if (holding.current > 0) waiting.current = true;
          else void load(true);
        } else known.current = Math.max(known.current, now.rev);
      }),
    [load],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    // Leaving with an edit not yet sent: send it now.
    if (dirty.current) void flush();
  }, [flush]);

  /** Change the song. `key` joins edits of one kind that come in a quick run (a slider) into one undo step. */
  const edit = useCallback((fn: Edit, key?: string) => {
    const next = structuredClone(live.current);
    fn(next);
    fitBars(next);
    const now = Date.now();
    const joined = key && lastKey.current?.key === key && now - lastKey.current.at < 900;
    lastKey.current = key ? { key, at: now } : null;
    if (!joined) {
      past.current.push(live.current);
      if (past.current.length > HISTORY) past.current.shift();
      counts();
    }
    future.current = [];
    counts();
    put(next);
    schedule();
  }, [put, schedule]);

  const undo = useCallback(() => {
    const back = past.current.pop();
    if (!back) return;
    future.current.push(live.current);
    lastKey.current = null;
    put(back);
    counts();
    schedule();
  }, [put, schedule]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(live.current);
    lastKey.current = null;
    put(next);
    counts();
    schedule();
  }, [put, schedule]);

  /** Called with true when the pointer goes down on something being dragged, false when it comes up. */
  const hold = useCallback((on: boolean) => {
    holding.current = Math.max(0, holding.current + (on ? 1 : -1));
    if (holding.current === 0 && waiting.current) {
      waiting.current = false;
      void load(true);
    }
  }, [load]);

  const dismiss = useCallback(() => setNotice(null), []);

  return useMemo(
    () => ({ project, live, ready, save, notice, flash, edit, undo, redo, hold, dismiss, canUndo: depth.undo > 0, canRedo: depth.redo > 0 }),
    [project, ready, save, notice, flash, edit, undo, redo, hold, dismiss, depth],
  );
}
