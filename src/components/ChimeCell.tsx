import { memo } from "react";
import type { AgentLook } from "../lib/agentlook";
import { AutoraMark } from "./AutoraMark";

/**
 * An agent of the Organization speaking up as it is called: its own mark (shape
 * and colour), moving the way Autora's does -- building while it works, then the
 * settle bloom as it reports back -- and a line saying what it has taken on.
 */
export const ChimeCell = memo(function ChimeCell({ name, role, look, text, working }: {
  name: string;
  role: string;
  look: AgentLook | null;
  text: string;
  working: boolean;
}) {
  return (
    <div className="cell-chime" role="status">
      <span className="chime-mark"><AutoraMark size={26} look={look} state={working ? "building" : "rest"} /></span>
      <div className="chime-body">
        <div className="chime-who">{name}{role ? <span> · {role}</span> : null}</div>
        <div className="chime-text">{text}</div>
      </div>
    </div>
  );
});
