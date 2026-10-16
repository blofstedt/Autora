/** Notebooks as the client sees them: see server/notebooks.ts. */

/** A window event asking the app to open a notebook; its detail is the id. */
export const OPEN_NOTEBOOK = "autora:open-notebook";

export type NotebookEntry = {
  id: string;
  kind: "artifact" | "note";
  artifact?: string;
  title?: string;
  text?: string;
  cites?: string[];
  by: "agent" | "user";
  added: number;
  updated?: number;
};

export type Notebook = {
  id: string;
  title: string;
  purpose: string;
  by: "agent" | "user";
  created: number;
  updated: number;
  entries: NotebookEntry[];
};

export type NotebookRef = { id: string; title: string };

export type ArtifactInfo = {
  id: string;
  origin: "agent" | "user";
  name: string;
  mime: string;
  size: number;
  ts: number;
  session?: string;
  /** The folder it was moved to, if the person moved it (otherwise it is in its chat's folder, if that has one). */
  folder?: string;
  note?: string;
};

/** A project folder on the Artifacts page. */
export type ArtifactFolder = { id: string; name: string; ts: number };

/** Everything the Artifacts page lists: the files, the folders, and which folder each chat's files are in. */
export type ArtifactLibrary = { artifacts: ArtifactInfo[]; folders: ArtifactFolder[]; chats: Record<string, string> };

/** The folder a file is shown in: the one it was moved to, else its chat's (null: loose, or in its chat's own place). */
export function folderOfFile(file: ArtifactInfo, lib: Pick<ArtifactLibrary, "folders" | "chats">): string | null {
  if (file.folder && lib.folders.some((f) => f.id === file.folder)) return file.folder;
  const chat = file.session ? lib.chats[file.session] : undefined;
  return chat && lib.folders.some((f) => f.id === chat) ? chat : null;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? body.detail ?? `Request failed (${res.status}).`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const fetchNotebooks = () => call<{ notebooks: Notebook[] }>("/api/notebooks").then((d) => d.notebooks ?? []);
export const fetchArtifacts = () => call<{ artifacts: ArtifactInfo[] }>("/api/artifacts").then((d) => d.artifacts ?? []);
export const fetchLibrary = () => call<Partial<ArtifactLibrary>>("/api/artifacts")
  .then((d): ArtifactLibrary => ({ artifacts: d.artifacts ?? [], folders: d.folders ?? [], chats: d.chats ?? {} }));

export const createNotebook = (title: string, purpose = "") =>
  call<{ notebook: Notebook }>("/api/notebooks", json("POST", { title, purpose })).then((d) => d.notebook);

export const updateNotebook = (id: string, patch: { title?: string; purpose?: string }) =>
  call<{ notebook: Notebook }>(`/api/notebooks/${id}`, json("PATCH", patch)).then((d) => d.notebook);

export const deleteNotebook = (id: string) => call<{ ok: true }>(`/api/notebooks/${id}`, { method: "DELETE" });

export const addToNotebook = (id: string, add: { artifacts?: string[]; title?: string; text?: string; cites?: string[] }) =>
  call<{ notebook: Notebook; unknown: string[] }>(`/api/notebooks/${id}/entries`, json("POST", add));

export const updateEntry = (id: string, entry: string, patch: { title?: string; text?: string; cites?: string[]; position?: number }) =>
  call<{ notebook: Notebook }>(`/api/notebooks/${id}/entries/${entry}`, json("PATCH", patch)).then((d) => d.notebook);

export const removeEntry = (id: string, entry: string) =>
  call<{ notebook: Notebook }>(`/api/notebooks/${id}/entries/${entry}`, { method: "DELETE" }).then((d) => d.notebook);

export function countsOf(book: Notebook): string {
  const files = book.entries.filter((e) => e.kind === "artifact").length;
  const notes = book.entries.length - files;
  return [`${files} file${files === 1 ? "" : "s"}`, `${notes} note${notes === 1 ? "" : "s"}`].join(" · ");
}

export const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const isPictureMime = (mime: string) => mime.startsWith("image/") && mime !== "image/svg+xml";
