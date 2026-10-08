import "./storage-shim";
import "./autora.css";
import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Editor from "@/app/editor/[project_id]/page";
import { EditorCore } from "@/core";
import { announce, onTheme, ready, store } from "./bridge";
import { installCommands } from "./commands";
import { preferences, watchPreferences } from "./storage-shim";
import { openProject, useCurrentProject, whenMoved } from "./shims/navigation";

/** Preferences are kept as one record on the server, under this key. */
const PREFS = { ns: "autora", key: "preferences" };

async function restorePreferences(): Promise<void> {
  if (!preferences) return;
  const saved = await store<{ values?: Record<string, string> } | null>({ op: "get", ...PREFS }).catch(() => null);
  for (const [k, v] of Object.entries(saved?.values ?? {})) preferences.setItem(k, v);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watchPreferences(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const values: Record<string, string> = {};
      for (let i = 0; i < (preferences?.length ?? 0); i++) {
        const k = preferences?.key(i);
        if (k) values[k] = preferences?.getItem(k) ?? "";
      }
      void store({ op: "set", ...PREFS, value: { id: PREFS.key, values } }).catch(() => undefined);
    }, 800);
  });
}

/** Autora's theme, as the window reads it off its own page. */
onTheme((vars) => {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    if (/^--a-[a-z0-9-]+$/.test(name) && typeof value === "string") root.style.setProperty(name, value);
  }
});

/** The project to open: the one asked for, else the one touched last, else a new one. */
async function firstProject(): Promise<string> {
  const asked = new URLSearchParams(location.search).get("project");
  if (asked) return asked;
  const all = await store<{ id: string; updatedAt?: string }[]>({ op: "all", ns: "video-editor-projects/projects" }).catch(() => []);
  const latest = [...all].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
  return latest?.id ?? "new";
}

function App() {
  const projectId = useCurrentProject();
  return (
    <ThemeProvider attribute="class" forcedTheme="dark" defaultTheme="dark" disableTransitionOnChange>
      <TooltipProvider>
        <Toaster />
        {projectId && <Editor key={projectId} />}
      </TooltipProvider>
    </ThemeProvider>
  );
}

async function start(): Promise<void> {
  await restorePreferences();
  const editor = EditorCore.getInstance();
  const sync = () => {
    const p = editor.project.getActiveOrNull();
    announce({ projectId: p?.metadata.id ?? null, name: p?.metadata.name ?? null });
  };
  /* Ready is said once there is a project to work on, not when the page is up: a command that arrived between
     the two would find nothing to act on. */
  let said = false;
  editor.project.subscribe(() => {
    sync();
    if (!said && editor.project.getActiveOrNull() && !editor.project.getIsLoading()) {
      said = true;
      ready();
    }
  });
  whenMoved(sync);
  installCommands();
  openProject(await firstProject());
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
