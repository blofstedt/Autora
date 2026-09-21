import { useState } from "react";
import type { SpanState } from "../lib/derive";
import { IconChevron } from "./Icons";

/**
 * Everything else the agent did, one line each.
 *
 * A memory lookup or a file read does not deserve a card, but it does deserve
 * to be in the record: the transcript is the record now, and a transcript with
 * holes in it is the thing the old hidden timeline was rightly criticised for.
 */
export function ToolCell({ span }: { span: SpanState }) {
  const [open, setOpen] = useState(false);
  const detail = span.output || span.preview;
  const tone = span.status === "error" ? "is-bad"
    : span.status === "denied" ? "is-warn" : "";

  return (
    <div className={`cell-line ${tone} ${open ? "is-open" : ""}`}>
      <button
        className="cell-line-top"
        onClick={() => detail && setOpen((v) => !v)}
        aria-expanded={detail ? open : undefined}
      >
        {detail ? <IconChevron size={10} /> : <span className="cell-line-dot" />}
        <b>{span.name}</b>
        <span className="cell-line-text">{describeArgs(span.args)}</span>
        {span.status === "running" && <em className="cell-chip is-running">running</em>}
        {span.status === "denied" && <em className="cell-chip is-warn">declined</em>}
        {span.status === "error" && <em className="cell-chip is-bad">failed</em>}
      </button>
      {open && detail && <pre className="cell-line-body">{detail.slice(0, 8000)}</pre>}
    </div>
  );
}

function describeArgs(args: Record<string, any>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (typeof args.url === "string") return args.url;
  if (typeof args.action === "string") {
    return `${args.action} ${args.selector ?? args.url ?? args.text ?? ""}`.trim();
  }
  return Object.entries(args)
    .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
    .join(" ");
}
