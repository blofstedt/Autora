/**
 * Files on their way into a message.
 *
 * An attachment is not a second kind of message: it is an artifact -- the
 * same thing the Artifacts page lists and the same thing the agent sees in
 * `artifact_list` -- that the turn about to be sent is told about. So it is
 * uploaded the moment it is picked or the shutter is pressed, not when Send
 * is; the wait happens where the person can see it, in a chip beside the box,
 * and what the message carries is only the id.
 */
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
};

/** Matches the server's cap (server/artifacts.ts). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const sizeLabel = (bytes: number) =>
  bytes < 1024 ? `${bytes} B`
    : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Whether the artifact is a picture that can be shown in place. */
export const isPicture = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml";

/**
 * Send one file to the artifacts store and answer with what it was given.
 *
 * The body is the file itself and its name rides in a header, which is the one
 * shape this endpoint takes -- there is no multipart parser in the server, and
 * adding one for this would be a second way to do the one thing.
 */
export async function uploadAttachment(file: File, name?: string): Promise<Attachment> {
  const named = name ?? file.name ?? "upload";
  const res = await fetch("/api/artifacts", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      // Header values are latin-1, so a name outside it has to travel encoded;
      // the server decodes it back.
      "X-File-Name": encodeURIComponent(named),
      "X-File-Type": file.type || "",
    },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.artifact) {
    throw new Error(data?.error ?? `Could not attach ${named}.`);
  }
  const { id, name: saved, mime, size } = data.artifact as Attachment;
  return { id, name: saved, mime, size };
}
