import type { Approval } from "../lib/derive";

/**
 * Pending permission requests.
 *
 * Shows the exact rendered command, not a summary. The entire value of an
 * approval prompt is that you can read precisely what is about to run -- a
 * prompt saying "allow bash?" trains you to click yes.
 */
export function Approvals({
  approvals,
  onDecide,
  readOnly,
}: {
  approvals: Approval[];
  onDecide: (requestId: string, approved: boolean) => void;
  readOnly: boolean;
}) {
  const pending = approvals.filter((a) => !a.settled);
  if (pending.length === 0) return null;

  return (
    <div className="approvals">
      {pending.map((approval) => (
        <div className="approval" key={approval.requestId}>
          <div className="approval-head">
            <strong>Approval needed</strong>
            <span className="reason">{approval.reason}</span>
          </div>
          <code className="approval-cmd">{approval.rendered}</code>
          <div className="approval-actions">
            <button
              className="btn deny"
              disabled={readOnly}
              onClick={() => onDecide(approval.requestId, false)}
            >
              Deny
            </button>
            <button
              className="btn allow"
              disabled={readOnly}
              onClick={() => onDecide(approval.requestId, true)}
            >
              Run it
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
