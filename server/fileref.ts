/**
 * A file named the way the agent names one: an artifact id, a path on this
 * host, or an artifact's name. Shared by the tools that read documents (the
 * PDF tools, the Office tools), so they find the same things the same way.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_ARTIFACT_BYTES, formatSize, getArtifact, listArtifacts, readArtifact, type Artifact } from "./artifacts";

export type FileInput = { data: Buffer; name: string; artifact: Artifact | null };

/** A file that cannot be found or used, said in so many words. */
export class FileRefError extends Error {}

export function readFileRef(given: unknown, cwd: string, what: string, tools = "the tools"): FileInput {
  const ref = String(given ?? "").trim();
  if (!ref) throw new FileRefError(`Say which ${what}: an artifact id (file_...) or a path on this host.`);
  const artifact = /^file_[0-9a-f]{16}$/.test(ref) ? getArtifact(ref) : null;
  if (artifact) {
    const data = readArtifact(artifact.id);
    if (data) return { data, name: artifact.name, artifact };
  }
  const full = path.resolve(cwd, ref);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(full);
  } catch {
    stat = null;
  }
  if (stat?.isFile()) {
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new FileRefError(`${full} is ${formatSize(stat.size)}; ${tools} take files up to ${formatSize(MAX_ARTIFACT_BYTES)}.`);
    }
    return { data: fs.readFileSync(full), name: path.basename(full), artifact: null };
  }
  const named = listArtifacts().find((a) => a.name.toLowerCase() === path.basename(ref).toLowerCase());
  const data = named ? readArtifact(named.id) : null;
  if (named && data) return { data, name: named.name, artifact: named };
  throw new FileRefError(`There is no ${what} "${ref}": give an artifact id (artifact_list shows them) or a path on this host.`);
}
