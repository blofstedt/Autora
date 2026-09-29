import { useState } from "react";
import type { PermissionPrompt } from "../lib/derive";
import { IconCheck, IconShield, IconX } from "./Icons";

export function PermissionCell({
  prompt,
  onDecide,
  readOnly,
}: {
  prompt: PermissionPrompt;
  onDecide: (requestId: string, approved: boolean, response?: string) => void;
  readOnly: boolean;
}) {
  const [userInput, setUserInput] = useState(prompt.response || "");
  const [chosenOption, setChosenOption] = useState<string | null>(null);

  const isInputRequested = prompt.inputType === "text" || prompt.inputType === "choice";

  /* One card per request, and this is not it.
     The strip above the message box is where an approval is answered: it is in
     the same place whatever the thread has scrolled to, and it is where the
     standing-agreement button lives. This cell used to carry its own Deny and
     Allow as well, so one request put two cards on the screen asking the same
     question in two different sets of words -- which reads as the console
     asking twice. So a plain yes/no prompt waits here as the record of what was
     asked and what the command was, and the answer is given above.
     A prompt that wants a value is the exception: the strip has nowhere to
     type one, so that kind is still answered here. */
  if (!prompt.settled && !isInputRequested) {
    return (
      <div className="perm-cell waiting">
        <div className="perm-header">
          <div className="perm-badge-title">
            <span className="perm-shield-icon">
              <IconShield size={14} />
            </span>
            <b>Approval needed</b>
            <span className="perm-tool-tag">{prompt.tool}</span>
          </div>
        </div>

        <div className="perm-reason">{prompt.reason}</div>

        {prompt.rendered && (
          <div className="perm-code-wrap">
            <div className="perm-code-label">Proposed Action:</div>
            <code className="perm-code">{prompt.rendered}</code>
          </div>
        )}

        <p className="perm-waiting">
          Waiting on your answer — Run it and Deny are on the card above the
          message box.
        </p>
      </div>
    );
  }

  const handleAllow = () => {
    onDecide(prompt.requestId, true, isInputRequested ? (chosenOption || userInput) : undefined);
  };

  const handleDeny = () => {
    onDecide(prompt.requestId, false);
  };

  if (prompt.settled) {
    return (
      <div className={`perm-cell settled ${prompt.approved ? "approved" : "denied"}`}>
        <div className="perm-settled-bar">
          <span className="perm-status-icon">
            {prompt.approved ? <IconCheck size={13} /> : <IconX size={13} />}
          </span>
          <span className="perm-status-text">
            {prompt.approved ? "You allowed it" : "You declined it"}
          </span>
          <span className="perm-tool-badge">{prompt.tool}</span>
          {prompt.response && (
            <span className="perm-user-val">Input: "{prompt.response}"</span>
          )}
        </div>
        {prompt.rendered && (
          <code className="perm-cmd-compact">{prompt.rendered}</code>
        )}
      </div>
    );
  }

  return (
    <div className="perm-cell active" role="alert" aria-live="assertive">
      <div className="perm-header">
        <div className="perm-badge-title">
          <span className="perm-shield-icon">
            <IconShield size={14} />
          </span>
          <b>Interactive Permission Request</b>
          <span className="perm-tool-tag">{prompt.tool}</span>
        </div>
      </div>

      <div className="perm-reason">{prompt.reason}</div>

      {prompt.rendered && (
        <div className="perm-code-wrap">
          <div className="perm-code-label">Proposed Action:</div>
          <code className="perm-code">{prompt.rendered}</code>
        </div>
      )}

      {/* Dynamic input if model needs input of some sort */}
      {prompt.inputType === "choice" && prompt.choices && (
        <div className="perm-choices-wrap">
          <div className="perm-input-label">Select Option:</div>
          <div className="perm-choice-chips">
            {prompt.choices.map((c) => (
              <button
                key={c}
                type="button"
                className={`perm-choice-chip ${chosenOption === c ? "selected" : ""}`}
                onClick={() => setChosenOption(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {prompt.inputType === "text" && (
        <div className="perm-input-wrap">
          <label className="perm-input-label">Required Model Input:</label>
          <input
            type="text"
            className="perm-text-input"
            placeholder={prompt.placeholder || "Enter parameter or value..."}
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && userInput.trim()) handleAllow();
            }}
          />
        </div>
      )}

      <div className="perm-actions">
        <button
          className="btn deny"
          disabled={readOnly}
          onClick={handleDeny}
        >
          <IconX size={13} /> Deny
        </button>

        <button
          className="btn allow"
          disabled={readOnly || (isInputRequested && !userInput && !chosenOption)}
          onClick={handleAllow}
        >
          <IconCheck size={13} /> {isInputRequested ? "Submit & Approve" : "Allow & Run"}
        </button>
      </div>
    </div>
  );
}
