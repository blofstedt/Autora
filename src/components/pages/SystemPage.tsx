import { useEffect, useState } from "react";
import type { SessionRow } from "../Sessions";
import type { PageId } from "../Rail";
import { Settings } from "../Settings";
import { StatusPage } from "./StatusPage";
import { LogsPage } from "./LogsPage";

export type SystemTab = "status" | "logs" | "host";

export const SYSTEM_TABS: { id: SystemTab; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "logs", label: "Logs" },
  { id: "host", label: "Host" },
];

export const isSystemTab = (v: unknown): v is SystemTab =>
  SYSTEM_TABS.some((t) => t.id === v);

/**
 * System: the installation itself, in one place. Status is the overview,
 * Logs is what the server has been doing, and Host is the version, the
 * machine and the checks that used to be the whole of this page.
 */
export function SystemPage({
  initialTab = "status", sessions, onOpenSession, onNavigate,
}: {
  initialTab?: SystemTab;
  sessions: SessionRow[];
  onOpenSession: (id: string) => void;
  onNavigate: (page: PageId) => void;
}) {
  const [tab, setTab] = useState<SystemTab>(initialTab);

  // Kept in the address with the page, so a reload stays on the same section.
  // Also rewrites an old ?page=status or ?page=logs link to where it now lives.
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("page", "system");
    if (tab === "status") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    history.replaceState(null, "", url.toString());
  }, [tab]);

  return (
    <div className="system-page">
      <div className="system-tabs">
        <div className="seg" role="tablist" aria-label="System sections">
          {SYSTEM_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "on" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="system-body">
        {tab === "status" && (
          <StatusPage
            sessions={sessions}
            onOpenSession={onOpenSession}
            onNavigate={onNavigate}
            onTab={setTab}
          />
        )}
        {tab === "logs" && <LogsPage />}
        {tab === "host" && <Settings key="system" section="system" embedded />}
      </div>
    </div>
  );
}
