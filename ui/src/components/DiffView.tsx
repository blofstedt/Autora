import type { FileChange } from "../lib/derive";
import { IconFile } from "./Icons";

/** Every file the agent touched, newest first, as reviewable hunks. */
export function DiffView({ files }: { files: FileChange[] }) {
  if (files.length === 0) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconFile size={20} /></span>
        <h3>No file changes</h3>
        <p>Edits appear here as diffs the moment they are written to disk.</p>
      </div>
    );
  }

  return (
    <div className="diffs">
      {[...files].reverse().map((file) => (
        <div className="diff" key={`${file.path}-${file.seq}`}>
          <div className="diff-top">
            <span className="diff-path">
              <IconFile size={13} />
              {/* Directory dimmed and truncating, filename always fully visible.
                  The filename is what you are looking for; the path is context. */}
              <span className="dir">{dirOf(file.path)}</span>
              <b>{baseOf(file.path)}</b>
            </span>
            <span className="stats">
              {file.created && <em className="tag">new</em>}
              <span className="plus">+{file.added}</span>
              <span className="minus">−{file.removed}</span>
            </span>
          </div>
          <pre className="diff-code">
            {file.diff.split("\n").map((line, i) => (
              <div key={i} className={lineClass(line)}>{line || " "}</div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

const baseOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function dirOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (parts.length === 0) return "";
  // Keep the last two directories: deep absolute paths are mostly noise, and
  // the immediate parent is what actually disambiguates two same-named files.
  const tail = parts.slice(-2).join("/");
  return (parts.length > 2 ? "…/" : path.startsWith("/") ? "/" : "") + tail + "/";
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "l-meta";
  if (line.startsWith("@@")) return "l-hunk";
  if (line.startsWith("+")) return "l-add";
  if (line.startsWith("-")) return "l-del";
  return "";
}
