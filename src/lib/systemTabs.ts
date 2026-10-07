// The sections of the System page. Kept apart from the page itself so the app
// can read them without loading the page (which is fetched when it is opened).
export type SystemTab = "status" | "logs" | "host";

export const SYSTEM_TABS: { id: SystemTab; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "logs", label: "Logs" },
  { id: "host", label: "Host" },
];

export const isSystemTab = (v: unknown): v is SystemTab =>
  SYSTEM_TABS.some((t) => t.id === v);
