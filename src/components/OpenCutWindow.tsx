import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";
import { holdSurface, useCollab } from "../lib/collab";
import { useFullscreen } from "../lib/fullscreen";
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "../lib/humanPath";
import { clearCursor, reportCursor } from "../lib/cursorPos";
import { onVideoCommand, useVideoState, type VideoCommand } from "../lib/opencut";
import { IconMaximize, IconMinimize, IconVideo, IconX } from "./Icons";

/**
 * The video window: OpenCut's editor, beside the conversation.
 *
 * The editor is its own build (opencut-editor/), served at /opencut-editor/
 * and run in a frame sandboxed without an origin, so it cannot reach this app
 * or its API. This component is its only way out, and the whole wire between
 * them is `postMessage`:
 *
 *   frame -> here   store requests (where its projects and media are kept: the
 *                   server, see server/opencut.ts), its state, a finished export
 *   here -> frame   the answers, Autora's theme, and the agent's commands
 *
 * The agent does not edit the project behind the editor's back. It asks the
 * editor to, and the editor does it with its own timeline commands. Before it
 * does, the agent's cursor goes to the place the way the other windows' do --
 * an arc, a rest, a click -- and a title is typed a few letters at a time into
 * the project, so the person watches the cut being made and can take over.
 */

/** The theme tokens the editor takes from this page (opencut-editor/src/autora/autora.css, `--a-*`). */
const THEME: Array<[string, string]> = [
  ["--bg", "--a-bg"], ["--s1", "--a-s1"], ["--s2", "--a-s2"], ["--s3", "--a-s3"], ["--s4", "--a-s4"], ["--sink", "--a-sink"],
  ["--border", "--a-border"], ["--border-strong", "--a-border-strong"],
  ["--text", "--a-text"], ["--text-2", "--a-text-2"], ["--text-3", "--a-text-3"],
  ["--accent", "--a-accent"], ["--accent-light", "--a-accent-light"], ["--accent-deep", "--a-accent-deep"], ["--on-accent", "--a-on-accent"],
  ["--accent-soft", "--a-accent-soft"], ["--accent-line", "--a-accent-line"], ["--accent-2", "--a-accent-2"],
  ["--live", "--a-live"], ["--warn", "--a-warn"], ["--danger", "--a-danger"],
  ["--sans", "--a-sans"], ["--mono", "--a-mono"], ["--r-sm", "--a-r-sm"], ["--r", "--a-r"], ["--r-lg", "--a-r-lg"],
];

function themeVars(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [from, to] of THEME) {
    const v = css.getPropertyValue(from).trim();
    if (v) out[to] = v;
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What each command is, to the cursor: where on the timeline it acts, and whether it is typed. */
function timeOf(cmd: VideoCommand): number | null {
  const a = cmd.args;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  switch (cmd.name) {
    case "add_clip":
    case "add_text":
    case "move":
      return n(a.start);
    case "split":
    case "seek":
      return n(a.time);
    default:
      return null;
  }
}

const SHOWN = new Set(["add_clip", "add_text", "split", "trim", "move", "delete", "set_params", "seek"]);
type Located = { x: number; y: number; view: { w: number; h: number } };

export function OpenCutWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const desk = useVideoState();
  const frame = useRef<HTMLIFrameElement>(null);
  const [cursorOn] = useAgentCursor();
  const cursorOnRef = useRef(cursorOn);
  cursorOnRef.current = cursorOn;
  /* The project the frame opens on is the one open when the window mounted, and the frame's address never changes
     after that: it moves between projects itself, and a new address would reload it in the middle of the agent's work. */
  const [opening] = useState(desk.projectId ?? null);
  const mine = useCollab().held.includes("video");
  const [full, setFull] = useFullscreen();
  const [trouble, setTrouble] = useState<string | null>(null);

  // The agent's cursor, over the editor.
  const [cursor, setCursor] = useState<Point | null>(null);
  const [ring, setRing] = useState<Point | null>(null);
  const [doing, setDoing] = useState<"" | "press" | "type">("");
  const [gone, setGone] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const cursorAt = useRef<Point | null>(null);

  /** This window's frame has said it is up: until then a command sent to it would be lost, so it claims none. */
  const up = useRef(false);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  const query = `session=${encodeURIComponent(sessionId)}`;

  /** What the editor keeps, kept on the server. Media files go as bytes; everything else as JSON. */
  const store = useCallback(async (req: { op: string; ns: string; key?: string; value?: unknown }): Promise<unknown> => {
    const isFiles = req.ns.startsWith("files/");
    if (isFiles && req.op === "get") {
      const res = await fetch(`/api/opencut/file?ns=${encodeURIComponent(req.ns)}&key=${encodeURIComponent(req.key ?? "")}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Autora answered ${res.status}`);
      const meta = JSON.parse(decodeURIComponent(res.headers.get("X-Opencut-Meta") ?? "%7B%7D")) as { name?: string; type?: string; lastModified?: number };
      return { name: meta.name ?? req.key, type: meta.type ?? "", lastModified: meta.lastModified ?? 0, blob: await res.blob() };
    }
    if (isFiles && req.op === "set") {
      const kept = req.value as { name: string; type: string; lastModified: number; blob: Blob };
      const q = new URLSearchParams({ ns: req.ns, key: req.key ?? "", name: kept.name, type: kept.type, modified: String(kept.lastModified) });
      const res = await fetch(`/api/opencut/file?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: kept.blob });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `Autora answered ${res.status}`);
      return null;
    }
    // Not application/json: the app's own parser stops at 5 MB, and a project with its thumbnail is not far off.
    const res = await fetch("/api/opencut/kv", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(req) });
    const body = (await res.json().catch(() => null)) as { value?: unknown; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
    return body?.value ?? null;
  }, []);

  const send = useCallback((path: string, body: unknown) => {
    void fetch(`/api/opencut/${path}?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  }, [query]);

  /** Commands in flight to the frame: its answers find their way back here. */
  const waiting = useRef(new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>());
  const seq = useRef(0);
  const toFrame = useCallback((name: string, args: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++seq.current;
    waiting.current.set(id, { resolve, reject });
    post({ type: "autora:opencut:command", id, name, args });
  }), [post]);

  // What the frame says.
  useEffect(() => {
    const answer = (id: unknown, run: () => Promise<unknown>) => {
      if (typeof id !== "number") return;
      run().then(
        (value) => post({ type: "autora:opencut:result", id, ok: true, value }),
        (err: unknown) => {
          const message = String((err as Error)?.message ?? err);
          setTrouble(message);
          post({ type: "autora:opencut:result", id, ok: false, value: { message } });
        },
      );
    };
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "autora:opencut:store":
          answer(msg.id, () => store(msg.req as { op: string; ns: string }));
          break;
        case "autora:opencut:deliver":
          answer(msg.id, async () => {
            const q = new URLSearchParams({ session: sessionId, name: String(msg.name ?? "video.mp4"), mime: String(msg.mime ?? "video/mp4") });
            const res = await fetch(`/api/opencut/deliver?${q}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: msg.data as ArrayBuffer });
            const body = (await res.json().catch(() => null)) as { artifact?: string; error?: { message?: string } } | null;
            if (!res.ok || !body?.artifact) throw new Error(body?.error?.message ?? `Autora answered ${res.status}`);
            return { artifact: body.artifact };
          });
          break;
        case "autora:opencut:state":
          send("state", { projectId: msg.projectId ?? null, name: msg.name ?? null });
          break;
        case "autora:opencut:ready":
          up.current = true;
          setTrouble(null);
          post({ type: "autora:opencut:theme", vars: themeVars() });
          send("ready", { ready: true });
          break;
        case "autora:opencut:reply": {
          const w = typeof msg.id === "number" ? waiting.current.get(msg.id) : undefined;
          if (!w || typeof msg.id !== "number") break;
          waiting.current.delete(msg.id);
          if (msg.ok) w.resolve(msg.value);
          else w.reject(new Error(String((msg.value as { message?: string } | null)?.message ?? "The editor could not do that")));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, send, sessionId, store]);

  // A window that has just mounted has a frame that has not started: the server must not send it commands yet.
  useEffect(() => {
    up.current = false;
    send("ready", { ready: false });
  }, [send]);

  // Autora's theme, followed: another theme, font or text size here is another one in the editor.
  useEffect(() => {
    const push = () => post({ type: "autora:opencut:theme", vars: themeVars() });
    const observer = new MutationObserver(push);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style", "class"] });
    return () => observer.disconnect();
  }, [post]);

  // ----------------------------------------------------- the agent's hand --

  const tween = useCallback((ms: number, step: (p: number) => void) => new Promise<void>((resolve) => {
    const started = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - started) / ms);
      step(p);
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  }), []);

  /** Go to a spot the way a hand does, and press there. */
  const goTo = useCallback(async (target: Point, view: { w: number; h: number }) => {
    setGone(false);
    const from = cursorAt.current ?? { x: Math.min(view.w - 8, Math.max(8, target.x + 70)), y: Math.max(6, target.y - 46) };
    setCursor(from);
    const route = humanRoute(from, target);
    await tween(routeMs(Math.hypot(target.x - from.x, target.y - from.y)), (p) => setCursor(along(route, p)));
    cursorAt.current = target;
    await sleep(restMs());
    setRing(target);
    setDoing("press");
    await sleep(160);
    setDoing("");
    await sleep(200);
    setRing(null);
  }, [tween]);

  /** Where the editor has this time on its timeline: it moves its playhead there and says where that is. */
  const locate = useCallback(async (time: number | null): Promise<Located | null> => {
    try {
      return (await toFrame("locate", time === null ? {} : { time })) as Located | null;
    } catch {
      return null;
    }
  }, [toFrame]);

  /** One command from the agent: shown, then done, then answered. */
  const play = useCallback(async (cmd: VideoCommand): Promise<unknown> => {
    let args = cmd.args;
    // A file to import comes through the app's own route, by a link the agent's tool made.
    if (cmd.name === "import_media" && typeof args.sourceToken === "string") {
      const res = await fetch(`/api/opencut/source/${encodeURIComponent(args.sourceToken)}?${query}`);
      if (!res.ok) throw new Error("The file to import is no longer available");
      const { sourceToken: _t, ...rest } = args;
      args = { ...rest, file: await res.blob() };
    }
    const name = cmd.name;
    const shown = cursorOnRef.current && SHOWN.has(name);
    if (shown) {
      const spot = await locate(timeOf({ ...cmd, args }));
      if (spot) {
        await goTo({ x: spot.x, y: spot.y }, spot.view);
        // A title is typed: the words arrive in the project a few letters at a time, as a person would type them.
        if (name === "add_text" && typeof args.text === "string" && args.text.length > 1) {
          setDoing("type");
          const chars = Array.from(args.text);
          const gaps = typingDelays(args.text, 2400);
          const chunk = Math.max(1, Math.ceil(chars.length / 14));
          let made = (await toFrame("add_text", { ...args, text: chars.slice(0, chunk).join("") })) as { tracks?: Array<{ clips: Array<{ id: string; type: string; text?: string }> }> };
          const clipId = made.tracks?.flatMap((t) => t.clips).filter((c) => c.type === "text" && c.text === chars.slice(0, chunk).join("")).pop()?.id;
          for (let at = chunk; clipId && at < chars.length; at += chunk) {
            await sleep(gaps.slice(at - chunk, at).reduce((a, b) => a + b, 0) || 90);
            made = (await toFrame("set_params", { elementId: clipId, params: { content: chars.slice(0, at + chunk).join("") }, history: false })) as typeof made;
          }
          setDoing("");
          setGone(true);
          return made;
        }
      }
    }
    const result = await toFrame(name, args);
    if (shown) {
      await sleep(500);
      setGone(true);
    }
    return result;
  }, [goTo, locate, query, toFrame]);

  // The agent's commands for this chat. The first window to claim one does it: the same chat open in two tabs must not cut twice.
  useEffect(() => onVideoCommand((cmd) => {
    if (!up.current) return;
    void (async () => {
      const claim = await fetch(`/api/opencut/claim?${query}&id=${encodeURIComponent(cmd.id)}`, { method: "POST" })
        .then((r) => (r.ok ? (r.json() as Promise<{ won?: boolean }>) : { won: false }))
        .catch(() => ({ won: false }));
      if (!claim.won) return;
      try {
        send("reply", { id: cmd.id, ok: true, value: await play(cmd) });
      } catch (err) {
        send("reply", { id: cmd.id, ok: false, value: { message: String((err as Error)?.message ?? err) } });
      }
    })();
  }), [play, query, send]);

  // Where the cursor is on screen, for the line the agent says beside it.
  useEffect(() => {
    const r = layer.current?.getBoundingClientRect();
    if (cursor && r) reportCursor(r.left + cursor.x, r.top + cursor.y);
  }, [cursor]);
  useEffect(() => clearCursor, []);

  const close = useCallback(() => {
    void fetch(`/api/opencut/close?${query}`, { method: "POST" }).catch(() => undefined);
  }, [query]);

  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconVideo size={14} /></span>
        <span className="pdf-bar-app">Autora Video</span>
        <span className="pdf-bar-name" title={desk.name ?? undefined}>{desk.name ?? "Video"}</span>
        <span className="pdf-bar-note">Saved as you go</span>
        <div className="spacer" />
        <button
          className={`pdf-pill${mine ? " is-accept" : ""}`}
          onClick={() => void holdSurface(sessionId, "video", !mine)}
          aria-pressed={mine}
          title={mine ? "Let the agent work on the video again" : "Work on the video yourself; the agent carries on with other work"}
        >
          {mine ? "Hand back" : "Take control"}
        </button>
        {phone && (
          <button
            className="btn icon ghost pdf-full-btn"
            onClick={() => setFull(!full)}
            title={full ? "Back to the conversation" : "Full screen"}
            aria-label={full ? "Back to the conversation" : "Full screen"}
            aria-pressed={full}
          >
            {full ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
        {!phone && (
          <button className="btn icon ghost" onClick={close} title="Put Autora Video away" aria-label="Put Autora Video away">
            <IconX size={14} />
          </button>
        )}
      </div>
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <div className="office-stage">
        <iframe
          ref={frame}
          className="pdf-frame"
          src={`/opencut-editor/index.html?session=${encodeURIComponent(sessionId)}${opening ? `&project=${encodeURIComponent(opening)}` : ""}`}
          title={`${desk.name ?? "Video"}, in Autora Video`}
          sandbox="allow-scripts allow-downloads allow-modals allow-popups"
          allow="autoplay; fullscreen"
        />
        {cursor && (
          <div ref={layer} className="office-cursor-layer" aria-hidden="true" data-office-cursor={gone ? "gone" : "on"}>
            {ring && <span className="office-click" style={{ left: ring.x - 14, top: ring.y - 14 }} />}
            <div className={`office-cursor${doing ? ` is-${doing}` : ""}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, opacity: gone ? 0 : 1 }}>
              <svg width="16" height="20" viewBox="0 0 16 20" className="office-cursor-arrow" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
                <path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
              <span className="office-cursor-name">Autora</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
