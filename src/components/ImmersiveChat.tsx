import { useEffect, useRef, useState } from "react";
import { IconArrow, IconX } from "./Icons";

/**
 * Messaging lite, over a tool that is full screen on a phone: what the agent
 * says shows for a few seconds as a short line (so you can see what it is
 * thinking while you watch it work), and a small translucent chat button in
 * the corner opens a one-line box at the bottom to talk to it -- without
 * leaving full screen. The whole conversation is still in the thread behind.
 */

/** The first sentence of a reply, without markdown, cut to a glance. */
export function glance(text: string, max = 110): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
  const one = sentence.length >= 12 ? sentence : plain;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const SHOWN_MS = 5200;

export function ImmersiveChat({
  say, onSend, canFollow, following, onFollow,
}: {
  /** What the agent last said, as it is written. */
  say: string;
  onSend: (text: string) => void;
  canFollow: boolean;
  following: boolean;
  onFollow: () => void;
}) {
  const [line, setLine] = useState("");
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [lift, setLift] = useState(0);
  /** What was said before the screen went full is not news. */
  const seen = useRef(glance(say));
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = glance(say);
    if (!next || next === seen.current) return;
    seen.current = next;
    setLine(next);
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [say]);

  // Keep the box above the phone's keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !open) { setLift(0); return; }
    const move = () => setLift(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    move();
    vv.addEventListener("resize", move);
    vv.addEventListener("scroll", move);
    return () => { vv.removeEventListener("resize", move); vv.removeEventListener("scroll", move); };
  }, [open]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    setOpen(false);
  };

  return (
    <div className="immersive" data-immersive>
      {line && (
        <div className={`immersive-say${visible ? " is-on" : ""}`} role="status" aria-live="polite">
          <span className="immersive-name">Autora</span>
          <span>{line}</span>
        </div>
      )}
      {!open && (
        <div className="immersive-corner">
          {canFollow && (
            <button type="button" className={`immersive-follow${following ? " on" : ""}`} aria-pressed={following} onClick={onFollow}
              title={following ? "Following the agent between tools" : "Follow the agent between tools"}>
              Follow
            </button>
          )}
          <button type="button" className="immersive-chat" onClick={() => setOpen(true)} aria-label="Message Autora" title="Message Autora">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            </svg>
          </button>
        </div>
      )}
      {open && (
        <form className="immersive-sheet" style={{ bottom: lift }} onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message Autora…"
            aria-label="Message Autora"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className="immersive-send" disabled={!text.trim()} aria-label="Send"><IconArrow size={15} /></button>
          <button type="button" className="immersive-close" onClick={() => setOpen(false)} aria-label="Close"><IconX size={15} /></button>
        </form>
      )}
    </div>
  );
}
