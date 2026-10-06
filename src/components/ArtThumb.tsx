import { useEffect, useState } from "react";
import { IconFile, IconImage, IconSlides } from "./Icons";

/** A file of the workspace, as the artifacts API describes it. */
export type Artifact = {
  id: string;
  origin: "agent" | "user";
  name: string;
  mime: string;
  size: number;
  ts: number;
  session?: string;
  note?: string;
};

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A word for what the file is: its own extension where it says something. */
export function kindOf(a: Artifact): string {
  const ext = a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase() : "";
  if (ext && ext.length <= 5) return ext;
  return a.mime.split("/")[1]?.toUpperCase().slice(0, 5) || "FILE";
}

/** What sort of thing it is, for the colour of its tile. */
export function toneOf(a: Artifact): string {
  if (a.mime === "application/pdf") return "pdf";
  if (a.mime.startsWith("image/")) return "image";
  if (a.mime === DOCX || a.mime === "application/msword" || a.mime.startsWith("text/")) return "doc";
  if (a.mime === XLSX || a.mime.includes("spreadsheet") || a.mime === "text/csv") return "sheet";
  if (a.mime === PPTX || a.mime.includes("presentation")) return "slide";
  if (/zip|tar|gzip|7z/.test(a.mime)) return "zip";
  return "file";
}

/** Files the card shows a picture of: their own first page, or their pixels. */
export const canPicture = (a: Artifact) =>
  a.mime.startsWith("image/") || a.mime === "application/pdf";

/** Files whose first lines can be read out: the ones with no picture of
    their own, so the card can show what is inside them instead. */
const canReadText = (a: Artifact) =>
  a.mime === DOCX || a.mime === PPTX || a.mime.startsWith("text/")
  || /^(application\/(json|xml|x-yaml|javascript))/.test(a.mime);

const iconFor = (tone: string, size = 22) =>
  tone === "image" ? <IconImage size={size} /> : tone === "slide" ? <IconSlides size={size} /> : <IconFile size={size} />;

/** How many lines of a document the card shows. */
const PAPER_LINES = 5;
const PAPER_CHARS = 46;

/**
 * The picture on an artifact's card. A picture or a PDF gets its own first
 * page, drawn by the server and kept; a document gets its first lines as text
 * on a page; anything else gets a tile that names its kind and colours it, so
 * a wall of files can be read at a glance instead of five identical PDFs.
 *
 * Nothing here waits for the page: a card that has no picture yet is simply
 * the tile, which the drawing replaces when it arrives, and one that can never
 * be drawn stays that way without asking again.
 */
export function ArtThumb({ a }: { a: Artifact }) {
  const [picture, setPicture] = useState(() => canPicture(a));
  const [lines, setLines] = useState<string[] | null>(null);
  const [asked, setAsked] = useState(false);
  const tone = toneOf(a);

  // A card showing a different file reuses this component: start it clean.
  useEffect(() => {
    setPicture(canPicture(a));
    setLines(null);
    setAsked(false);
  }, [a]);

  useEffect(() => {
    if (picture || asked || !canReadText(a)) return;
    let live = true;
    setAsked(true);
    fetch(`/api/artifacts/${a.id}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { lines?: string[] } | null) => { if (live && d?.lines?.length) setLines(d.lines); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [a, picture, asked]);

  if (picture) {
    return (
      <img
        className="art-shot"
        src={`/api/artifacts/${a.id}/thumb`}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setPicture(false)}
      />
    );
  }

  if (lines?.length) {
    return (
      <span className={`art-paper is-${tone}`}>
        <span className="art-paper-tag">{kindOf(a)}</span>
        <span className="art-paper-text">
          {lines.slice(0, PAPER_LINES).map((line, i) => (
            <i key={i}>{line.length > PAPER_CHARS ? `${line.slice(0, PAPER_CHARS - 1)}…` : line}</i>
          ))}
        </span>
      </span>
    );
  }

  return (
    <span className={`art-tile is-${tone}`} aria-hidden="true">
      {iconFor(tone)}
      <b>{kindOf(a)}</b>
    </span>
  );
}
