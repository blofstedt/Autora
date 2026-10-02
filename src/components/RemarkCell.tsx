import { memo } from "react";

/**
 * A word from the agent about what you just did in a window you share -- a
 * line, not a message: small, in its own voice, and gone from view as the
 * conversation moves on.
 */
export const RemarkCell = memo(function RemarkCell({ text }: { text: string }) {
  return (
    <div className="cell-remark" role="status">
      <i className="remark-mark" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
});
