import type { Approval } from "../lib/derive";
import { IconCheck, IconShield, IconX } from "./Icons";

/**
 * Pending permission requests.
 *
 * Shows the exact rendered command, never a summary. The whole value of an
 * approval prompt is being able to read precisely what is about to run; a prompt
 * that says "allow bash?" just trains you to click yes.
 *
 * The container is an assertive live region: this is the one moment the UI
 * genuinely needs the reader, and a screen reader should say so without
 * waiting to be asked.
 */
export function Approvals({
  approvals, onDecide, readOnly,
}: {
  approvals: Approval[];
  onDecide: (requestId: string, approved: boolean, remember?: boolean) => void;
  readOnly: boolean;
}) {
  const pending = approvals.filter((a) => !a.settled);
  if (pending.length === 0) return null;

  return (
    <div className="approvals" role="alert" aria-live="assertive">
      {pending.map((approval) => (
        <div className="approval" key={approval.requestId}>
          <div className="approval-top">
            <IconShield size={14} />
            <b>Approval needed</b>
          </div>
          <div className="approval-why">{approval.reason}</div>
          <code className="approval-cmd">{approval.rendered}</code>
          <div className="approval-act">
            <button
              className="btn deny"
              disabled={readOnly}
              onClick={() => onDecide(approval.requestId, false)}
            >
              <IconX size={13} /> Deny
            </button>
            <button
              className="btn allow"
              disabled={readOnly}
              onClick={() => onDecide(approval.requestId, true)}
            >
              <IconCheck size={13} /> Run it
            </button>
            {/* Offered only where the server says it may be: never on the
                tier that cannot be undone. It is a standing agreement, so it
                says so rather than "remember this". */}
            {approval.remember && (
              <button
                className="btn ghost"
                disabled={readOnly}
                title="Run this and calls like it without asking again. Listed in Scheduled tasks, where it can be revoked."
                onClick={() => onDecide(approval.requestId, true, true)}
              >
                <IconCheck size={13} /> Always allow this kind
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
