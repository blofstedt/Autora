/**
 * Artifacts: the files that belong to the workspace rather than to a moment.
 *
 * Two kinds, kept apart because they answer different questions. What the
 * agent made -- an image it generated, a document it wrote, a file it built in
 * the terminal and chose to hand over -- and what you uploaded for it to work
 * with. Both are shown on the Artifacts page, and the agent can list and read
 * either.
 *
 * Unlike ./blobs.ts this is on disk, next to the settings file: a screenshot
 * is what a session saw and can go when the process does, but a document you
 * uploaded or a report the agent wrote is the point of the afternoon, and an
 * update that erased it would be erasing the work.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state";

export type ArtifactOrigin = "agent" | "user";

export interface Artifact {
  id: string;
  origin: ArtifactOrigin;
  name: string;
  mime: string;
  size: number;
  /** Milliseconds since the epoch. */
  ts: number;
  /** The session it was made in, when there was one. */
  session?: string;
  /** A line about what it is: the prompt behind an image, say. */
  note?: string;
}

/** Big enough for a scanned PDF or a phone photo, small enough that one
    upload cannot fill the disk Umbrel shares with everything else. */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const DIR = path.join(stateDir(), "artifacts");
const INDEX = path.join(DIR, "index.json");

let index: Artifact[] | null = null;

function load(): Artifact[] {
  if (index) return index;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX, "utf8"));
    index = Array.isArray(raw) ? raw.filter((a) => a && typeof a.id === "string") : [];
  } catch {
    index = [];
  }
  return index;
}

function persist() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${INDEX}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
  fs.renameSync(tmp, INDEX);
}

/** Ids are the file names on disk, so they are only ever ours: hex, fixed
    length, nothing a request could turn into a path. */
const fileFor = (id: string) => path.join(DIR, id);
const validId = (id: string) => /^file_[0-9a-f]{16}$/.test(id);

/** Where an artifact's bytes are on this host, for the terminal. */
export function artifactPath(id: string): string {
  return fileFor(id);
}

/** A name fit to show and to download as: no directories, no control
    characters, not empty. */
export function cleanName(name: string, fallback = "file"): string {
  const base = path.basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return base && base !== "." && base !== ".." ? base : fallback;
}

const BY_EXT: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".html": "text/html", ".htm": "text/html",
  ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".js": "text/javascript", ".ts": "text/plain", ".py": "text/x-python",
  ".sh": "text/x-shellscript", ".log": "text/plain", ".css": "text/css",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".avif": "image/avif", ".heic": "image/heic",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** What the file is, from what we were told, else from its name. */
export function mimeFor(name: string, told?: string): string {
  const t = String(told || "").split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t)) return t;
  return BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Whether the bytes can be read back to the model as text. */
export function isText(mime: string): boolean {
  return mime.startsWith("text/") ||
    ["application/json", "application/xml", "image/svg+xml"].includes(mime);
}

export function listArtifacts(): Artifact[] {
  return [...load()].sort((a, b) => b.ts - a.ts);
}

export function getArtifact(id: string): Artifact | null {
  if (!validId(id)) return null;
  return load().find((a) => a.id === id) ?? null;
}

export function readArtifact(id: string): Buffer | null {
  const meta = getArtifact(id);
  if (!meta) return null;
  try {
    return fs.readFileSync(fileFor(id));
  } catch {
    return null;
  }
}

export function saveArtifact(input: {
  origin: ArtifactOrigin;
  name: string;
  data: Buffer;
  mime?: string;
  session?: string;
  note?: string;
}): Artifact {
  if (input.data.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(`Too large: artifacts are capped at ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`);
  }
  const name = cleanName(input.name);
  const artifact: Artifact = {
    id: `file_${crypto.randomBytes(8).toString("hex")}`,
    origin: input.origin,
    name,
    mime: mimeFor(name, input.mime),
    size: input.data.byteLength,
    ts: Date.now(),
    ...(input.session ? { session: input.session } : {}),
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
  };
  const list = load();
  // Saving the same name again from the agent rewrites that file instead of
  // leaving a near-identical copy beside it: the id and its place in the list
  // stay, so a link, a note or an artifact id the person already has still
  // points at the thing. Uploads are exempt -- two files with one name can be
  // two different files, and neither is ours to overwrite.
  const at = input.origin === "agent" ? list.findIndex((a) => a.name === name) : -1;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (at >= 0) {
    const prev = list[at];
    const next: Artifact = { ...prev, mime: artifact.mime, size: artifact.size, ts: artifact.ts };
    if (artifact.session) next.session = artifact.session;
    // A note describes the file as it was; one that came with this save
    // replaces it, and a save without one does not leave the old behind.
    if (artifact.note) next.note = artifact.note; else delete next.note;
    list[at] = next;
    fs.writeFileSync(fileFor(prev.id), input.data, { mode: 0o600 });
    persist();
    return next;
  }
  fs.writeFileSync(fileFor(artifact.id), input.data, { mode: 0o600 });
  list.push(artifact);
  persist();
  return artifact;
}

export function deleteArtifact(id: string): boolean {
  const list = load();
  const at = list.findIndex((a) => a.id === id);
  if (at < 0) return false;
  list.splice(at, 1);
  persist();
  fs.rmSync(fileFor(id), { force: true });
  return true;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
