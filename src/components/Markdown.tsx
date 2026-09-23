import { Fragment, useState, type ReactNode } from "react";
import { splitImages } from "../lib/images";
import { InlineImage } from "./ImageCell";
import { IconCheck, IconCopy } from "./Icons";

/**
 * The agent's replies, as the Markdown they are written in.
 *
 * Hand-rolled over the subset models actually produce -- headings, lists,
 * quotes, fenced code, tables, emphasis, links -- and built as React elements
 * rather than an HTML string, so nothing in a reply is ever parsed as markup
 * by the browser. It runs over the whole reply on every streamed token, so it
 * has to tolerate half-written input: an unclosed fence is code to the end,
 * an unclosed `**` is just two asterisks.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; body: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i += 1; // the closing fence, if it has arrived yet
      out.push({ kind: "code", lang: fence[2], body: body.join("\n") });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }

    const heading = line.match(HEADING);
    if (heading) {
      out.push({ kind: "h", level: heading[1].length, text: heading[2].replace(/\s#+\s*$/, "") });
      i += 1;
      continue;
    }
    if (RULE.test(line)) { out.push({ kind: "hr" }); i += 1; continue; }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", lines: quoted });
      continue;
    }

    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOrdered ? lines[i].match(ORDERED) : lines[i].match(BULLET);
        if (m) {
          items.push(isOrdered ? m[2] : m[1]);
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // A continuation line, indented under the item it belongs to.
          items[items.length - 1] += `\n${lines[i].trim()}`;
        } else break;
        i += 1;
      }
      out.push({ kind: "list", ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !/^\s*>/.test(lines[i]) && !RULE.test(lines[i])
    ) para.push(lines[i++]);
    out.push({ kind: "p", lines: para });
  }
  return out;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function blocks(text: string): ReactNode[] {
  return parse(text).map((b, key) => {
    switch (b.kind) {
      case "p":
        return <p key={key}>{b.lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l)}</Fragment>)}</p>;
      case "h": {
        const Tag = (`h${Math.min(b.level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
        return <Tag key={key}>{inline(b.text)}</Tag>;
      }
      case "code":
        return <CodeBlock key={key} lang={b.lang} body={b.body} />;
      case "quote":
        return <blockquote key={key}>{blocks(b.lines.join("\n"))}</blockquote>;
      case "list": {
        const items = b.items.map((item, i) => {
          const task = item.match(/^\[([ xX])\]\s+(.*)$/s);
          return (
            <li key={i} className={task ? "is-task" : undefined}>
              {task && <span className={`md-check ${task[1] !== " " ? "on" : ""}`}>{task[1] !== " " && <IconCheck size={10} />}</span>}
              {(task ? task[2] : item).split("\n").map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>)}
            </li>
          );
        });
        return b.ordered
          ? <ol key={key} start={b.start}>{items}</ol>
          : <ul key={key}>{items}</ul>;
      }
      case "table":
        return (
          <div key={key} className="md-table">
            <table>
              <thead><tr>{b.head.map((c, i) => <th key={i}>{inline(c)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={key} />;
    }
  });
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-top">
        <span>{lang || "code"}</span>
        <button
          className="md-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(body).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
          aria-label="Copy code"
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre><code>{body}</code></pre>
    </div>
  );
}

/** `code`, **bold**, *italic*, ~~strike~~, [links](url), bare links, and
    pictures wherever they were written. */
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)|~~([^~\n]+?)~~|\[([^\]\n]+)\]\(\s*<?([^()\s>]+)>?\s*\)|(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  splitImages(text).forEach((piece, p) => {
    if (piece.kind === "image") {
      out.push(<InlineImage key={`i${p}`} url={piece.url} alt={piece.alt} />);
      return;
    }
    const s = piece.text;
    let at = 0;
    for (const m of s.matchAll(INLINE)) {
      const start = m.index ?? 0;
      if (start > at) out.push(s.slice(at, start));
      const k = `${p}-${start}`;
      if (m[1]) out.push(<code key={k}>{m[2]}</code>);
      else if (m[3] || m[4]) out.push(<strong key={k}>{inline(m[3] || m[4])}</strong>);
      else if (m[5] || m[6]) out.push(<em key={k}>{inline(m[5] || m[6])}</em>);
      else if (m[7]) out.push(<del key={k}>{inline(m[7])}</del>);
      else if (m[8]) out.push(link(m[9], inline(m[8]), k));
      else if (m[10]) out.push(link(m[10], m[10], k));
      at = start + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
  });
  return out;
}

function link(href: string, label: ReactNode, key: string): ReactNode {
  // Only real destinations: a `javascript:` link in a reply is not one.
  if (!/^(https?:|mailto:)/i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>;
}
