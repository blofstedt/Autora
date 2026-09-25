/**
 * What the workspace keeps, and what it lets go.
 *
 * Nothing here had a policy: sessions, their logs and the Artifacts page grew
 * for as long as the app was installed, and the only way to get disk back was
 * to delete a thread by hand, one at a time. On a box that Umbrel shares with
 * everything else that is a slow leak with a bad ending, and the person
 * cannot see it happening because no screen says how much is stored.
 *
 * Two rules, both conservative, and both sayable out loud: nothing older than
 * the age limit, and never fewer than the newest N of anything. Pinned
 * sessions are never touched, and neither is a session that is busy. The
 * defaults are deliberately shy -- half a year, five hundred sessions -- so
 * that this is housekeeping rather than a thing that eats somebody's work.
 */

import fs from "node:fs";
import path from "node:path";
import { deleteArtifact, listArtifacts } from "./artifacts";
import { stateDir, type RetentionPolicy } from "./state";
import { deleteSession, sessionFolders } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Sized {
  count: number;
  bytes: number;
}

export interface StorageReport {
  sessions: Sized;
  artifacts: Sized;
  /** The settings file and the memory graph: everything else under the same roof. */
  settings: Sized;
  total: number;
}

function sizeOf(where: string): number {
  let bytes = 0;
  const walk = (at: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // Gone while we looked. Nothing to count.
        }
      }
    }
  };
  walk(where);
  return bytes;
}

/** What is on disk, by area, for the Status page. */
export function storageReport(): StorageReport {
  const folders = sessionFolders();
  const sessions = {
    count: folders.length,
    bytes: folders.reduce((sum, f) => sum + f.bytes, 0),
  };
  const files = listArtifacts();
  const artifacts = {
    count: files.length,
    bytes: files.reduce((sum, a) => sum + (a.size || 0), 0),
  };
  /* Everything else in the state directory -- settings.json, memory.db,
     tool health -- measured by walking it and leaving out the two areas
     already counted, so a new file added later is counted rather than
     forgotten. */
  const settings = {
    count: 0,
    bytes: Math.max(0, sizeOf(stateDir()) - sessions.bytes - artifacts.bytes),
  };
  return { sessions, artifacts, settings, total: sessions.bytes + artifacts.bytes + settings.bytes };
}

export interface PruneResult {
  sessions: Sized & { ids: string[] };
  artifacts: Sized & { ids: string[] };
  policy: RetentionPolicy;
}

/**
 * Apply the policy now.
 *
 * `busy` answers "is this session in use this second" -- the caller knows, and
 * deleting a thread somebody is watching a reply in is not housekeeping. Age
 * is measured from the newest file in the folder, so a session that was
 * reopened yesterday is young however old it is.
 */
export function prune(
  policy: RetentionPolicy,
  now = Date.now(),
  busy: (id: string) => boolean = () => false,
): PruneResult {
  const result: PruneResult = {
    sessions: { count: 0, bytes: 0, ids: [] },
    artifacts: { count: 0, bytes: 0, ids: [] },
    policy,
  };

  /* Newest first, so "keep the newest N" is a slice. */
  const folders = sessionFolders().sort((a, b) => b.modified - a.modified);
  const cutoff = policy.sessionDays > 0 ? now - policy.sessionDays * DAY_MS : 0;
  folders.forEach((folder, index) => {
    if (index < policy.keepSessions) return;
    if (folder.pinned) return;
    if (cutoff && folder.modified > cutoff) return;
    if (busy(folder.id)) return;
    deleteSession(folder.id);
    result.sessions.count += 1;
    result.sessions.bytes += folder.bytes;
    result.sessions.ids.push(folder.id);
  });

  const files = listArtifacts().sort((a, b) => b.ts - a.ts);
  const artifactCutoff = policy.artifactDays > 0 ? now - policy.artifactDays * DAY_MS : 0;
  files.forEach((file, index) => {
    if (index < policy.keepArtifacts) return;
    if (artifactCutoff && file.ts > artifactCutoff) return;
    if (!deleteArtifact(file.id)) return;
    result.artifacts.count += 1;
    result.artifacts.bytes += file.size || 0;
    result.artifacts.ids.push(file.id);
  });

  return result;
}
