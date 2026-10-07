import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { hostMounted, useQuestion } from "../lib/sure";

/** Draws the question `sure()` is asking, if there is one. Mounted once. */
export function SureHost() {
  const q = useQuestion();
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => hostMounted(), []);
  useEffect(() => {
    if (!q) return;
    // Focus the safe answer: Enter alone never deletes anything.
    no.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") q.settle(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q]);
  if (!q) return null;
  return createPortal(
    <div className="scrim" role="presentation" onClick={() => q.settle(false)}>
      <div className="modal sure" role="alertdialog" aria-modal="true" aria-label={q.message} onClick={(e) => e.stopPropagation()}>
        <div className="modal-body sure-body">{q.message}</div>
        <div className="modal-foot sure-foot">
          <button ref={no} className="btn ghost" onClick={() => q.settle(false)}>Cancel</button>
          <button className="btn danger" onClick={() => q.settle(true)}>{q.yes}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
