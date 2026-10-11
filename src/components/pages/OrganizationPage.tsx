import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AutoraMark } from "../AutoraMark";
import { IconArrowDown, IconArrowUp, IconBot, IconChevron, IconOrg, IconPlus, IconTrash, IconX } from "../Icons";
import {
  createAgent, deleteAgent, fetchAgents, hueOf, underneath, updateAgent, useLook,
  type Agent, type AgentPatch,
} from "../../lib/organization";
import { every } from "../../lib/poll";
import { sure } from "../../lib/sure";

/** The agent's own mark (shape and colour; Autora's triangle for the lead), or for someone who is not an agent,
    a round dot in a colour of their own with their first letter. */
export function AgentDot({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const look = useLook(id);
  if (look !== undefined) {
    return (
      <span className="agent-mark" style={{ width: size, height: size }} aria-hidden="true">
        <AutoraMark size={Math.round(size * 1.15)} look={look} state="rest" />
      </span>
    );
  }
  return (
    <span
      className="agent-dot"
      style={{ width: size, height: size, background: `hsl(${hueOf(id)} 42% 36%)`, fontSize: size * 0.46 }}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

const BLANK = { name: "", role: "", instructions: "", when: "", reportsTo: "", next: [] as string[] };

/**
 * The organization: every agent and where it fits. The map shows who reports
 * to whom and, on each card, which agents it hands work to next; selecting
 * one opens it for editing. The lead (Autora) is whatever answers in the chat
 * and is told this map, so it knows which agent to start and when.
 */
export function OrganizationPage({ topSlot }: { topSlot?: HTMLElement | null }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  /** The editor has unsaved words in it: the poll leaves the page alone. */
  const dirty = useRef(false);
  /** The agent being dragged to a new place in the chart, and the one it hovers over. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Managers whose team is folded away, as in Teams and Outlook. */
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const fold = (id: string) => setFolded((f) => { const n = new Set(f); if (!n.delete(id)) n.add(id); return n; });

  const load = useCallback(() => {
    if (dirty.current) return;
    fetchAgents().then(setAgents).catch(() => setError("Could not load the organization."));
  }, []);

  useEffect(() => {
    load();
    return every(load, 10_000);
  }, [load]);

  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const lead = (agents ?? []).find((a) => a.builtin) ?? null;
  const picked = selected && selected !== "new" ? byId.get(selected) ?? null : null;

  /** Whether the dragged agent may go under `target`: not itself, not its own team, not where it already is. */
  const canDrop = (target: Agent) => {
    const moving = dragging ? byId.get(dragging) : null;
    return !!moving && !moving.builtin && target.id !== moving.id && target.id !== moving.reportsTo
      && !underneath(agents ?? [], moving.id).has(target.id);
  };

  const drop = async (target: Agent) => {
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (!id || !canDrop(target)) return;
    setError(null);
    try {
      await updateAgent(id, { reportsTo: target.id });
      setAgents(await fetchAgents());
    } catch (err: any) {
      setError(err?.message ?? "Could not move the agent.");
    }
  };

  const node = (a: Agent, seen: Set<string>): JSX.Element => {
    const kids = (agents ?? []).filter((k) => k.reportsTo === a.id && !seen.has(k.id));
    const nextSeen = new Set(seen).add(a.id);
    const target = dragging !== null && canDrop(a);
    const shut = folded.has(a.id);
    return (
      <li key={a.id}>
        <div className="org-node">
          <button
            className={`org-card ${a.builtin ? "is-lead" : ""} ${selected === a.id ? "on" : ""} ${a.enabled ? "" : "is-off"} ${dragging === a.id ? "is-dragged" : ""} ${over === a.id && target ? "is-target" : ""}`}
            onClick={() => { dirty.current = false; setSelected(a.id); }}
            aria-pressed={selected === a.id}
            draggable={!a.builtin}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", a.id); setDragging(a.id); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={(e) => { if (target) { e.preventDefault(); setOver(a.id); } }}
            onDragLeave={() => setOver((o) => (o === a.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); void drop(a); }}
          >
            <AgentDot id={a.id} name={a.name} size={40} />
            <span className="org-card-main">
              <b>{a.name}</b>
              <span className="org-role">{a.role || (a.builtin ? "Lead" : "No role yet")}</span>
              {!a.enabled && <span className="org-role">Switched off</span>}
              {a.next.length > 0 && (
                <span className="org-next" title="Hands its result to, in order">
                  then{" "}
                  {a.next.map((n, i) => (
                    <span key={n} className="org-chip">{i > 0 ? "→ " : ""}{byId.get(n)?.name ?? "?"}</span>
                  ))}
                </span>
              )}
            </span>
          </button>
          {kids.length > 0 && (
            <button
              className={`org-toggle ${shut ? "is-shut" : ""}`}
              onClick={() => fold(a.id)}
              aria-expanded={!shut}
              aria-label={`${shut ? "Show" : "Hide"} the ${kids.length} direct report${kids.length === 1 ? "" : "s"} of ${a.name}`}
              title={`${kids.length} direct report${kids.length === 1 ? "" : "s"}`}
            >
              {kids.length} <IconChevron size={11} />
            </button>
          )}
        </div>
        {kids.length > 0 && !shut && <ul>{kids.map((k) => node(k, nextSeen))}</ul>}
      </li>
    );
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint art-lede">
          Your agents and where they fit. Each has its own task and a note on when it should be called; the
          lead, Autora, is told this map and starts the right one — and the ones that follow it, in order —
          when a job calls for it.{" "}
          <span className="org-drag-hint">
            Drag an agent onto another to move it (and its team) under them, or select one to edit it.
          </span>
          <span className="org-tap-hint">Select an agent to edit it; "Reports to" there moves it under another.</span>
        </p>
        {error && <p className="set-warn">{error}</p>}

        {topSlot && createPortal(
          <button className="btn primary top-action" onClick={() => { dirty.current = false; setSelected("new"); }}>
            <IconPlus size={13} /> <span className="top-action-word">New agent</span>
          </button>,
          topSlot,
        )}
        {!topSlot && (
          <div className="art-toolbar">
            <div className="spacer" />
            <button className="btn primary" onClick={() => setSelected("new")}><IconPlus size={14} /> New agent</button>
          </div>
        )}

        {agents !== null && agents.length <= 1 && selected !== "new" && (
          <div className="nb-empty">
            <IconOrg size={28} />
            <p>It is only Autora so far.</p>
            <p className="jf-hint">
              Add an agent for a kind of work you do often — a researcher, an editor, a bookkeeper — and
              say when Autora should call it.
            </p>
          </div>
        )}

        <div className="org-layout">
          <div className="orgchart" aria-label="Organization chart">
            <ul>{lead && node(lead, new Set())}</ul>
          </div>

          {selected && agents && (
            <AgentEditor
              key={selected}
              agent={picked}
              agents={agents}
              dirty={dirty}
              onClose={() => { dirty.current = false; setSelected(null); }}
              onSaved={(a) => {
                dirty.current = false;
                setAgents((list) => (list ?? []).some((x) => x.id === a.id)
                  ? (list ?? []).map((x) => (x.id === a.id ? a : x)) : [...(list ?? []), a]);
                setSelected(null);
                load();
              }}
              onDeleted={() => { dirty.current = false; setSelected(null); load(); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AgentEditor({
  agent, agents, dirty, onClose, onSaved, onDeleted,
}: {
  /** null: making a new one. */
  agent: Agent | null;
  agents: Agent[];
  dirty: React.MutableRefObject<boolean>;
  onClose: () => void;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState(() => agent
    ? { name: agent.name, role: agent.role, instructions: agent.instructions, when: agent.when, reportsTo: agent.reportsTo ?? "", next: agent.next }
    : { ...BLANK, reportsTo: agents.find((a) => a.builtin)?.id ?? "" });
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    dirty.current = true;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const blocked = agent ? underneath(agents, agent.id).add(agent.id) : new Set<string>();
  const others = agents.filter((a) => a.id !== agent?.id);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const move = (i: number, by: -1 | 1) => {
    const next = [...form.next];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set("next", next);
  };

  const save = async () => {
    if (agent && !form.name.trim()) return; // a new agent left unnamed is given a name
    setBusy(true);
    setError(null);
    const body: AgentPatch = {
      name: form.name, role: form.role, instructions: form.instructions, when: form.when, next: form.next,
      ...(agent?.builtin ? {} : { reportsTo: form.reportsTo || null, enabled }),
    };
    try {
      onSaved(agent ? await updateAgent(agent.id, body) : await createAgent(body));
    } catch (err: any) {
      setError(err?.message ?? "Could not save the agent.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent || !(await sure(`Remove ${agent.name}? Agents that report to it move up a level.`))) return;
    try {
      await deleteAgent(agent.id);
      onDeleted();
    } catch (err: any) {
      setError(err?.message ?? "Could not remove the agent.");
    }
  };

  return (
    <div className="scrim" onClick={onClose} role="presentation">
    <form className="modal org-modal org-editor nb-new" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={agent ? `Edit ${agent.name}` : "New agent"}>
      <div className="org-editor-head">
        <b>{agent ? `Edit ${agent.name}` : "New agent"}</b>
        <div className="spacer" />
        <button type="button" className="rail-icon-btn" onClick={onClose} aria-label="Close"><IconX size={14} /></button>
      </div>

      <label className="org-field">Name
        <input value={form.name} maxLength={60} placeholder={agent ? "e.g. Sabrina" : "e.g. Sabrina (leave blank for one)"} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="org-field">Role
        <input value={form.role} maxLength={80} placeholder="e.g. Family Lawyer" onChange={(e) => set("role", e.target.value)} />
      </label>
      <label className="org-field">Its task — what it is told to be and do
        <textarea
          rows={5} value={form.instructions} maxLength={8000}
          placeholder="How it works, what it must always do, what it must never do."
          onChange={(e) => set("instructions", e.target.value)}
        />
      </label>
      <label className="org-field">When to call it
        <textarea
          rows={2} value={form.when} maxLength={1000}
          placeholder="e.g. When a claim needs checking against sources before it goes in a report."
          onChange={(e) => set("when", e.target.value)}
        />
      </label>

      {!agent?.builtin && (
        <label className="org-field">Reports to
          <select value={form.reportsTo} onChange={(e) => set("reportsTo", e.target.value)}>
            {agents.filter((a) => !blocked.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}

      <div className="org-field">
        Then hands its result to, in order
        {form.next.length === 0 && <span className="jf-hint">No one — it reports back and stops.</span>}
        <ol className="org-seq">
          {form.next.map((id, i) => (
            <li key={id}>
              <AgentDot id={id} name={name(id)} size={20} />
              <span>{name(id)}</span>
              <div className="spacer" />
              <button type="button" className="rail-icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${name(id)} earlier`}><IconArrowUp size={12} /></button>
              <button type="button" className="rail-icon-btn" onClick={() => move(i, 1)} disabled={i === form.next.length - 1} aria-label={`Move ${name(id)} later`}><IconArrowDown size={12} /></button>
              <button type="button" className="rail-icon-btn" onClick={() => set("next", form.next.filter((n) => n !== id))} aria-label={`Stop handing to ${name(id)}`}><IconX size={12} /></button>
            </li>
          ))}
        </ol>
        {others.some((a) => !form.next.includes(a.id)) && (
          <select
            value={adding}
            aria-label="Add an agent to the sequence"
            onChange={(e) => { if (e.target.value) set("next", [...form.next, e.target.value]); setAdding(""); }}
          >
            <option value="">Add an agent to the sequence…</option>
            {others.filter((a) => !form.next.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>

      {!agent?.builtin && (
        <label className="org-check">
          <input type="checkbox" checked={enabled} onChange={(e) => { dirty.current = true; setEnabled(e.target.checked); }} />
          Available — Autora can start it
        </label>
      )}
      {agent?.builtin && (
        <p className="jf-hint"><IconBot size={11} /> This is the agent that answers in the chat. It heads the organization and cannot be removed.</p>
      )}

      {agent && !agent.builtin && <p className="jf-hint">Its personality, attributes and what it has learned are in Mind.</p>}

      {error && <p className="set-warn">{error}</p>}
      <div className="nb-new-acts">
        {agent && !agent.builtin && (
          <button type="button" className="btn ghost danger" onClick={() => void remove()}><IconTrash size={13} /> Remove</button>
        )}
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        <button type="submit" className="btn primary" disabled={busy || (!!agent && !form.name.trim())}>{agent ? "Save" : "Add agent"}</button>
      </div>
    </form>
    </div>
  );
}
