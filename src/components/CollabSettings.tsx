import { useEffect, useState } from "react";
import { useAgentCursor } from "../lib/agentCursor";

/**
 * Working together: the two switches for how alive the shared windows feel.
 * Both are presentation -- the work is the same either way -- and apply at once.
 */
export function CollabSettings() {
  const [cursor, setCursor] = useAgentCursor();
  const [remarks, setRemarks] = useState<boolean | null>(null);
  const [threads, setThreads] = useState<boolean | null>(null);
  const [news, setNews] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/collaboration")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { remarks?: boolean; threads?: boolean; news?: boolean } | null) => {
        if (!live || !j) return;
        if (typeof j.remarks === "boolean") setRemarks(j.remarks);
        if (typeof j.threads === "boolean") setThreads(j.threads);
        if (typeof j.news === "boolean") setNews(j.news);
      })
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

  const toggleThreads = (next: boolean) => {
    setThreads(next);
    void fetch("/api/collaboration", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threads: next }),
    }).catch(() => undefined);
  };

  const toggleNews = (next: boolean) => {
    setNews(next);
    void fetch("/api/collaboration", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ news: next }),
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
      <label className="set-switch">
        <input type="checkbox" checked={threads ?? true} disabled={threads === null} onChange={(e) => toggleThreads(e.target.checked)} />
        <span>
          <b>Let the agents talk in Threads</b>
          <small>With two or more agents on, one now and then posts, answers another or you, or likes something. Uses a small model call each time, at most twelve an hour. Agents also post their own work and how it went.</small>
        </span>
      </label>
      <label className="set-switch">
        <input type="checkbox" checked={(news ?? true) && (threads ?? true)} disabled={news === null || !(threads ?? true)} onChange={(e) => toggleNews(e.target.checked)} />
        <span>
          <b>Let the agents bring news to Threads</b>
          <small>About once an hour one agent searches the web for its own subject and posts what matters, with the link, for the others to discuss. At most six searches a day.</small>
        </span>
      </label>
    </section>
  );
}
