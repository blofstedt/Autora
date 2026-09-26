/**
 * What a message came with.
 *
 * A file attached to a message is an artifact like any other -- it is on the
 * Artifacts page, `artifact_list` shows it, and `artifact_read` reads it. What
 * this adds is the link the model cannot otherwise see: that these particular
 * files were handed over *with this message*, and that they are part of what
 * was asked rather than scenery the workspace happens to contain.
 *
 * Pictures go one step further and travel as pictures. The note still names
 * them, because a note survives into later turns where the bytes do not: the
 * pixels of a message are sent with the turn it belongs to and dropped after
 * it, so a photograph the agent has already looked at is not re-uploaded on
 * every turn for the rest of the session. Reading it again later is a tool
 * call, which is the right price for something already answered.
 */
import { getArtifact, readArtifact, formatSize, type Artifact } from "./artifacts";
import { type ChatImage } from "./llm";

export type AttachmentRef = { id: string; name: string; mime: string; size: number };

/** What the vendors accept as a picture. SVG is deliberately not here: it is
    a document that can carry script, not a photograph. */
export const PICTURE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Above this a picture is named but not sent: providers refuse the request
    outright past their own limits (Anthropic at 5 MB), and a turn that dies
    because a photo was large is worse than a turn that asks for it by id. */
export const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

/** The artifacts a message asks for, in the order they were given. Anything
    that is not a known artifact id is dropped rather than failing the send:
    a file deleted between picking it and pressing Send should not lose the
    words typed beside it. */
export function attachmentRefs(raw: unknown): AttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (const id of raw.slice(0, 20)) {
    const key = String(id ?? "");
    if (!key || seen.has(key)) continue;
    const meta: Artifact | null = getArtifact(key);
    if (!meta) continue;
    seen.add(key);
    out.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size });
  }
  return out;
}

/** Ref lookups pass straight through; ids from a request are resolved above. */
function refs(list: unknown): AttachmentRef[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => item as AttachmentRef)
    .filter((item) => typeof item?.id === "string" && typeof item?.name === "string");
}

/**
 * The line the model reads.
 *
 * Written in the voice of the console rather than the person, in one bracketed
 * sentence, because it is a fact about the message and not something they
 * said. It names each file, its size and its id -- the id being what makes the
 * note still useful on a later turn, when the picture itself is gone from the
 * prompt and only this is left.
 */
export function attachmentNote(list: unknown): string {
  const files = refs(list);
  if (files.length === 0) return "";
  const one = files.length === 1;
  const parts = files.map((f) => {
    const shown = PICTURE_MIMES.has(f.mime) && f.size <= MAX_PICTURE_BYTES;
    const how = shown
      ? `${f.mime}, ${formatSize(f.size)}, shown to you as a picture`
      : `${f.mime}, ${formatSize(f.size)}, read it with artifact_read ${f.id}`;
    return `${f.name} (${how})`;
  });
  return `[Autora: ${one ? "a file is" : `${files.length} files are`} attached to this message, part of what is being asked: ${parts.join("; ")}.]`;
}

/** The pictures to send with this turn, base64, as each vendor's API wants
    them. Anything unreadable, too large or not a picture is skipped: the note
    already says it is there. */
export function picturesFor(list: unknown): ChatImage[] {
  const out: ChatImage[] = [];
  for (const f of refs(list)) {
    if (!PICTURE_MIMES.has(f.mime) || f.size > MAX_PICTURE_BYTES) continue;
    const data = readArtifact(f.id);
    if (!data) continue;
    out.push({ mime: f.mime, data: data.toString("base64") });
  }
  return out;
}
