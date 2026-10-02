import { useEffect, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";

/**
 * Working together: the two switches for how alive the shared windows feel.
 * Both are presentation -- the work is the same either way -- and apply at once.
 */
export function CollabSettings() {
  const [cursor, setCursor] = useAgentCursor();
  const [remarks, setRemarks] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/collaboration")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { remarks?: boolean } | null) => { if (live && j && typeof j.remarks === "boolean") setRemarks(j.remarks); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const toggleRemarks = (next: boolean) => {
    setRemarks(next);
    void fetch("/api/collaboration", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remarks: next }),
    }).catch(() => undefined);
  };

  return (
    <section className="set-card">
      <h3>Working together</h3>
      <p className="jf-hint">
        You and the agent can work in the same PDF, app window, browser and code at the same time.
        What you touch is yours: the agent leaves it alone and works on something else, and "Take control"
        in a window holds it until you hand it back.
      </p>
      <label className="set-switch">
        <input type="checkbox" checked={cursor} onChange={(e) => setCursor(e.target.checked)} />
        <span>
          <b>Show the agent's cursor and typing</b>
          <small>Its cursor in the PDF and app windows, and code typed out as it is written.</small>
        </span>
      </label>
      <label className="set-switch">
        <input type="checkbox" checked={remarks ?? true} disabled={remarks === null} onChange={(e) => toggleRemarks(e.target.checked)} />
        <span>
          <b>Let the agent say a word about what I do</b>
          <small>A short remark between turns when you move or change something in a shared window. Uses a small model call each time.</small>
        </span>
      </label>
    </section>
  );
}
