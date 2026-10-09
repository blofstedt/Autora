import { useCallback, useEffect, useRef, useState } from "react";
import { useFullscreen } from "../lib/fullscreen";
import { gameStateNow, onGameState, useGameState, type GameCue } from "../lib/gamedesk";
import { useAgentCursor } from "../lib/agentCursor";
import { GameCursor } from "./GameCursor";
import { IconGame, IconMaximize, IconMinimize } from "./Icons";

/** The colours Autora sends the editor: the custom properties its own pages are drawn from (the editor's theme maps them). */
const THEME_TOKENS = ["--bg", "--s1", "--s2", "--s4", "--text", "--text-2", "--text-3", "--accent", "--accent-light"];

function themeNow(): string {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) out[token] = value;
  }
  return JSON.stringify(out);
}

/**
 * Autora Games: the game window, beside the conversation.
 *
 * The editor (gdevelop-editor/, GDevelop's, built into /gdevelop-editor/) is a page of this origin in a frame, so the person
 * has all of it: scenes, objects, behaviors, events, the preview. The game is not in the frame's hands: it lives on the
 * server (server/gamedesk.ts), where the agent's game_* tools work on it too. The editor saves what the person does there
 * by itself, a moment after they do it. This component is the rest of the wire, and a small one:
 *
 *   - the agent changes the game (the server says so) -> the editor is told to take the new version;
 *   - the editor says the game is open -> shown (until then a note says it is starting: the engine is a few megabytes);
 *   - Autora's theme changes -> the editor starts again with the new colours (its own pending changes are saved first).
 *
 * The frame's address is fixed for as long as the window is up: changing it reloads the editor.
 */
export function GameWindow({ sessionId, phone }: { sessionId: string; phone: boolean }) {
  const game = useGameState();
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  /** The newest revision that was already told to the editor, or made in it. */
  const known = useRef(-1);
  const [up, setUp] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [full, setFull] = useFullscreen();
  /* The colours the frame was opened with: its address, which must not change while it is up. */
  const [src] = useState(() => `/gdevelop-editor/index.html?autora=${encodeURIComponent(sessionId)}&theme=${encodeURIComponent(themeNow())}`);
  const lastTheme = useRef(themeNow());
  /* The agent's cursor goes to what it changed, then the editor takes the new version. */
  const [cursorOn] = useAgentCursor();
  const cursorRef = useRef(cursorOn);
  cursorRef.current = cursorOn;
  const [show, setShow] = useState<{ cues: GameCue[]; seq: number } | null>(null);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);
  const reloadAfter = useCallback(() => post({ autoraGameCmd: "reload" }), [post]);

  // What the editor says.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== window.location.origin) return;
      const msg = e.data as { autoraGame?: boolean; ready?: boolean; problem?: string } | null;
      if (!msg || typeof msg !== "object" || !msg.autoraGame) return;
      if (msg.ready) {
        ready.current = true;
        known.current = Math.max(known.current, gameStateNow().rev ?? 0);
        setUp(true);
        setTrouble(null);
      } else if (typeof msg.problem === "string") {
        setTrouble(`Your last change was not saved: ${msg.problem}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // What the agent did: the server says the game moved on, and who moved it. The editor's own saves are not echoed back.
  useEffect(
    () =>
      onGameState(() => {
        const now = gameStateNow();
        if (!now.open || now.rev === undefined || !ready.current) return;
        if (now.by === "agent" && now.rev > known.current) {
          known.current = now.rev;
          if (cursorRef.current && now.cues?.length) setShow({ cues: now.cues, seq: now.rev });
          else post({ autoraGameCmd: "reload" });
        } else {
          known.current = Math.max(known.current, now.rev);
        }
      }),
    [post],
  );

  // Autora's theme, followed as it is changed in Settings: the editor starts again with it.
  useEffect(() => {
    const watch = new MutationObserver(() => {
      const next = themeNow();
      if (!ready.current || next === lastTheme.current) return;
      lastTheme.current = next;
      post({ autoraGameCmd: "theme", query: `autora=${encodeURIComponent(sessionId)}&theme=${encodeURIComponent(next)}` });
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style"] });
    return () => watch.disconnect();
  }, [post, sessionId]);

  const scenes = game.scenes ?? 0;
  return (
    <div className={`pdf-window${phone ? " is-phone" : ""}${phone && full ? " is-full" : ""}`}>
      {phone && <div className="pdf-bar">
        <span className="pdf-bar-ico" aria-hidden="true"><IconGame size={14} /></span>
        <span className="pdf-bar-app">Autora Games</span>
        <span className="pdf-bar-name">{game.name ?? "Your game"}{scenes ? ` · ${scenes === 1 ? "1 scene" : `${scenes} scenes`}` : ""}</span>
        <span className="pdf-bar-note">{up ? "Saved as you go" : "Starting the engine…"}</span>
        <div className="spacer" />
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
      </div>}
      {trouble && <div className="pdf-problem" role="status">{trouble}</div>}
      <div className="game-stage">
      <iframe
        ref={frame}
        className="pdf-frame"
        src={src}
        title="Autora Games"
        /* No sandbox attribute: this is Autora's own build of GDevelop's editor, served from this origin under its own policy
           (server/gamedesk.ts serveGame: scripts from itself only, connections to this origin only, framed by this app only),
           and a sandbox that keeps the origin is no sandbox. It needs its origin for its engine's storage and for saving the
           game through Autora's routes. A game the person is making does not run here: previews are served apart (see previews). */
        allow="fullscreen; autoplay; gamepad"
      />
      {show && <GameCursor cues={show.cues} seq={show.seq} frame={frame} onDone={reloadAfter} />}
      </div>
    </div>
  );
}
