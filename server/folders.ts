/**
 * Folders on the Artifacts page: one per project.
 *
 * A chat's files start out in a folder of their own, named after the chat
 * (nothing is written for that: it is where a file with no folder lives). When
 * another chat works on one of those files -- reads it, opens it in a window,
 * edits it -- the two are one project: a real folder is made, named after the
 * first chat, and both chats' files go in it, the ones they made and the ones
 * they make from then on. A chat already in a folder stays there; the person
 * can rename a folder, and move files or a whole chat into another.
 *
 * Kept next to the artifacts' index, apart from it, so the index stays the
 * plain list it always was and an old one reads as "every file in its chat's
 * folder".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state";

export interface Folder {
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  ts: number;
}

interface Store {
  folders: Folder[];
  /** Which folder a chat's files go in, by chat id. */
  chats: Record<string, string>;
}

const FILE = path.join(stateDir(), "artifacts", "folders.json");
const validId = (id: string) => /^fold_[0-9a-f]{12}$/.test(id);

let store: Store | null = null;

/** How a chat is called, for naming the folder a project gets; server.ts
    says, since the chats are its. */
let titleOf: (chat: string) => string | null = () => null;
export function chatTitles(fn: (chat: string) => string | null) {
  titleOf = fn;
}
/** What a chat is called, as far as anyone has said. */
export function chatTitle(chat: string): string | null {
  return titleOf(chat);
}

function load(): Store {
  if (store) return store;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const folders = Array.isArray(raw?.folders)
      ? raw.folders.filter((f: any) => f && validId(String(f.id)) && typeof f.name === "string")
      : [];
    const known = new Set(folders.map((f: Folder) => f.id));
    const chats: Record<string, string> = {};
    for (const [chat, id] of Object.entries(raw?.chats ?? {})) {
      if (typeof id === "string" && known.has(id)) chats[chat] = id;
    }
    store = { folders, chats };
  } catch {
    store = { folders: [], chats: {} };
  }
  return store;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2));
  fs.renameSync(tmp, FILE);
}

/** A folder name fit to show: one line, not empty, not endless. */
export function cleanFolderName(name: string, fallback = "Project"): string {
  const one = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return one || fallback;
}

export function listFolders(): { folders: Folder[]; chats: Record<string, string> } {
  const s = load();
  return { folders: [...s.folders], chats: { ...s.chats } };
}

export function getFolder(id: string): Folder | null {
  return load().folders.find((f) => f.id === id) ?? null;
}

/** The folder a chat's files go in, when it is in one. */
export function folderOfChat(chat: string | undefined): string | null {
  if (!chat) return null;
  return load().chats[chat] ?? null;
}

/** The folder a file is shown in: the one it was moved to, else its chat's.
    Null is "its chat's own folder" (or, with no chat, loose). */
export function folderOfFile(file: { folder?: string; session?: string }): string | null {
  if (file.folder && getFolder(file.folder)) return file.folder;
  return folderOfChat(file.session);
}

/** One key per folder a file can be in, real or a chat's own: two files with
    one name in the same key are the same file. */
export function placeKey(file: { folder?: string; session?: string }): string {
  const real = folderOfFile(file);
  if (real) return real;
  return file.session ? `chat:${file.session}` : "loose";
}

export function createFolder(name: string): Folder {
  const folder: Folder = { id: `fold_${crypto.randomBytes(6).toString("hex")}`, name: cleanFolderName(name), ts: Date.now() };
  load().folders.push(folder);
  persist();
  return folder;
}

export function renameFolder(id: string, name: string): Folder | null {
  const folder = load().folders.find((f) => f.id === id);
  if (!folder) return null;
  folder.name = cleanFolderName(name, folder.name);
  persist();
  return folder;
}

/** A folder goes; its files go back to their chats' own folders. Files moved
    into it by hand keep a dangling id, which reads the same way. */
export function deleteFolder(id: string): boolean {
  const s = load();
  const at = s.folders.findIndex((f) => f.id === id);
  if (at < 0) return false;
  s.folders.splice(at, 1);
  for (const [chat, f] of Object.entries(s.chats)) if (f === id) delete s.chats[chat];
  persist();
  return true;
}

/** Put a chat in a folder (its files, and the ones it makes from now on), or
    with null take it out again. */
export function setChatFolder(chat: string, id: string | null): boolean {
  const s = load();
  if (id !== null && !getFolder(id)) return false;
  if (id === null) delete s.chats[chat];
  else s.chats[chat] = id;
  persist();
  return true;
}

/**
 * A chat worked on a file: if the file belongs to another chat's work, this
 * chat joins that project. Returns the folder it joined, when it joined one.
 *
 * - a chat already in a folder stays where it is (the person put it there, or
 *   it joined a project earlier);
 * - a file in a folder takes the chat into that folder;
 * - a file from another chat with no folder yet makes one, named after that
 *   chat, and both chats go in it.
 */
export function joinWork(chat: string, file: { folder?: string; session?: string }): Folder | null {
  if (!chat || folderOfChat(chat)) return null;
  const real = folderOfFile(file);
  if (real) {
    setChatFolder(chat, real);
    return getFolder(real);
  }
  if (!file.session || file.session === chat) return null;
  const folder = createFolder(titleOf(file.session) ?? titleOf(chat) ?? "Project");
  const s = load();
  s.chats[file.session] = folder.id;
  s.chats[chat] = folder.id;
  persist();
  return folder;
}

/** For the tests: read the file again. */
export function reloadFolders() {
  store = null;
}
