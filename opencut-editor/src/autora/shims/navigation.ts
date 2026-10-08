import { useSyncExternalStore } from "react";

/**
 * next/navigation for a window that is one editor: the only place it ever goes
 * is to another project (or out of the project, which the window handles).
 * The address is kept here, not in the URL: a frame's URL is not its own to
 * move around.
 */
type Where = { projectId: string | null };

let where: Where = { projectId: new URLSearchParams(location.search).get("project") };
const listeners = new Set<() => void>();
const projectIn = (href: string): string | null => /^\/editor\/([^/?#]+)/.exec(href)?.[1] ?? null;

/** Called with the project the editor moved to, or null when it left the project. */
let onMove: (projectId: string | null) => void = () => undefined;
export function whenMoved(fn: (projectId: string | null) => void): void {
  onMove = fn;
}

function go(href: string) {
  const projectId = projectIn(href);
  where = { projectId };
  for (const l of listeners) l();
  onMove(projectId);
}

export function openProject(projectId: string | null): void {
  go(projectId ? `/editor/${projectId}` : "/projects");
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useCurrentProject(): string | null {
  return useSyncExternalStore(subscribe, () => where.projectId, () => null);
}

const router = { push: go, replace: go, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };

export function useRouter() {
  return router;
}
export function useParams(): Record<string, string> {
  const projectId = useCurrentProject();
  return projectId ? { project_id: projectId } : {};
}
export function usePathname(): string {
  const projectId = useCurrentProject();
  return projectId ? `/editor/${projectId}` : "/";
}
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
