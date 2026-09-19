import type { FileChange } from "../lib/derive";

/** Every file the agent touched, newest first, as reviewable hunks. */
export function DiffView({ files }: { files: FileChange[] }) {
  if (files.length === 0) {
    return (
      <div className="stage-empty">
        <p>No file changes yet.</p>
        <p className="dim">Edits appear here as diffs the moment they are written.</p>
      </div>
    );
  }
  return (
    <div className="diff-list">
      {[...files].reverse().map((file) => (
        <div className="diff-card" key={`${file.path}-${file.seq}`}>
          <div className="diff-head">
            <span className="path">{file.path}</span>
            <span className="counts">
              {file.created && <em className="new">new</em>}
              <span className="added">+{file.added}</span>
              <span className="removed">-{file.removed}</span>
            </span>
          </div>
          <pre className="diff-body">
            {file.diff.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "l-add"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "l-del"
                      : line.startsWith("@@")
                        ? "l-hunk"
                        : ""
                }
              >
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
