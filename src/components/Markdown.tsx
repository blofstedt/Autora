import { Fragment, memo, useState, type ReactNode } from "react";
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
 *
 * A fence whose language is exactly `detail` is not code but a folded
 * disclosure: its first line is the label on a closed <details> and the rest
 * is Markdown again, so the dense material an agent's colleagues need (a
 * number, a path, a source, a command) sits behind a toggle and the visible
 * words stay short. It works wherever this component does -- thread replies,
 * the forum, notebooks.
 *
 * Memoised on its two props, so a reply that is not the one streaming is
 * never parsed again because something else in the thread changed.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <div className={`md ${streaming ? "is-streaming" : ""}`.trim()}>{blocks(text, streaming)}</div>;
});

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; body: string }
  | { kind: "detail"; label: string; body: string; open: boolean }
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
      const closed = i < lines.length;
      i += 1; // the closing fence, if it has arrived yet
      if (fence[2] === "detail") {
        /* The first line is the label on the toggle; the rest is Markdown in
           its own right. An empty body is a label with nothing behind it yet,
           and an unclosed fence is an open disclosure to the end -- the same
           tolerance the code fence has, because a streaming reply is parsed
           halfway through all the time, and a post whose closing fence never
           arrived must not have its whole body folded away out of sight. */
        const [first = "", ...rest] = body;
        out.push({ kind: "detail", label: first.trim() || "Detail", body: rest.join("\n"), open: !closed });
      } else {
        out.push({ kind: "code", lang: fence[2], body: body.join("\n") });
      }
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

/**
 * While a reply is still arriving, its words are drawn one element each, so
 * each new word can fade in as it lands -- spoken rather than printed. React
 * keeps every word it has already drawn (same place, same key), so only the
 * new ones animate. Once the reply is done it is plain text again.
 */
function words(text: string, key: string): ReactNode[] {
  return text.split(/(?<=\s)/).map((w, i) => <span key={`${key}w${i}`} className="md-w">{w}</span>);
}

function blocks(text: string, live = false): ReactNode[] {
  const inline = (t: string) => inlineOf(t, live);
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
      case "detail":
        return <Detail key={key} label={b.label} body={b.body} open={b.open} live={live} />;
      case "quote":
        return <blockquote key={key}>{blocks(b.lines.join("\n"), live)}</blockquote>;
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

/**
 * A folded section under a post or a reply: closed when it lands, so the words
 * on screen stay the short, human ones, and one click or Enter away when a
 * colleague wants the detail. Memoised on its props like the rest of this
 * file, so the body is parsed once and not again on every token of a reply
 * that is streaming somewhere else.
 *
 * `open` is for the one case that is not a landing: a fence whose closing line
 * has not arrived, where folding the sender's words away would hide them.
 *
 * Native <details>/<summary>: the folding, the keyboard and the accessibility
 * come from the browser, not from a click handler of ours.
 */
const Detail = memo(function Detail({ label, body, open, live }: { label: string; body: string; open: boolean; live: boolean }) {
  return (
    <details className="md-detail" open={open || undefined}>
      <summary className="md-detail-head">{label}</summary>
      {body.trim() ? <div className="md-detail-body">{blocks(body, live)}</div> : null}
    </details>
  );
});

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

function inlineOf(text: string, live: boolean): ReactNode[] {
  const inline = (t: string) => inlineOf(t, live);
  const plain = (t: string, key: string): ReactNode => (live ? <Fragment key={key}>{words(t, key)}</Fragment> : t);
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
      if (start > at) out.push(plain(s.slice(at, start), `${p}t${at}`));
      const k = `${p}-${start}`;
      if (m[1]) out.push(<code key={k}>{m[2]}</code>);
      else if (m[3] || m[4]) out.push(<strong key={k}>{inline(m[3] || m[4])}</strong>);
      else if (m[5] || m[6]) out.push(<em key={k}>{inline(m[5] || m[6])}</em>);
      else if (m[7]) out.push(<del key={k}>{inline(m[7])}</del>);
      else if (m[8]) out.push(link(m[9], inline(m[8]), k));
      else if (m[10]) out.push(link(m[10], m[10], k));
      at = start + m[0].length;
    }
    if (at < s.length) out.push(plain(s.slice(at), `${p}t${at}`));
  });
  return out;
}

function link(href: string, label: ReactNode, key: string): ReactNode {
  // Only real destinations: a `javascript:` link in a reply is not one.
  if (!/^(https?:|mailto:)/i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>;
}
