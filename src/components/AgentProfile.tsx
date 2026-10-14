import { useEffect, useState } from "react";
import { AgentDot } from "./pages/OrganizationPage";
import { PersonalityShape } from "./PersonalityShape";
import { IconX } from "./Icons";
import { fetchMind, forgetMemory, type Agent, type AgentMemory } from "../lib/organization";

/**
 * One agent's mind, in the Mind: its personality as a shape that grows (nobody
 * sets it), how well it works with each colleague, and what it has learned,
 * which it alone reads. Autora's own mind is the rest of the page.
 */
export function AgentProfile({ agent, agents }: { agent: Agent; agents: Agent[] }) {
  const [memories, setMemories] = useState<AgentMemory[] | null>(null);

  useEffect(() => {
    let live = true;
    setMemories(null);
    fetchMind(agent.id).then((d) => { if (live) setMemories(d.memories); }).catch(() => { if (live) setMemories([]); });
    return () => { live = false; };
  }, [agent.id, agent.updated]);

  const bonds = Object.entries(agent.bonds ?? {})
    .map(([id, value]) => ({ id, value, name: agents.find((a) => a.id === id)?.name ?? "" }))
    .filter((b) => b.name)
    .sort((a, b) => b.value - a.value);
  const done = agent.tasks?.done ?? 0;
  const failed = agent.tasks?.failed ?? 0;

  return (
    <div className="agent-profile">
      <section className="set-card">
        <div className="agent-profile-head">
          <AgentDot id={agent.id} name={agent.name} size={40} />
          <div>
            <h3>{agent.name}{agent.role ? <span>, {agent.role}</span> : null}</h3>
            <p className="jf-hint">
              {done + failed > 0 ? `${done} task${done === 1 ? "" : "s"} finished${failed ? `, ${failed} not` : ""}. ` : "No tasks yet. "}
            </p>
          </div>
        </div>
        <div className="agent-shape-wrap">
          <PersonalityShape traits={agent.traits} name={agent.name} />
          <p className="jf-hint">
            Every agent starts out genial: a friendly teammate who talks like a regular person. From there its personality
            grows by itself, from how it actually talks in Threads, and the shape stretches toward what it becomes.
            You cannot set it. It only changes how the agent sounds in Threads, never how well it works or how it
            works with the others.
          </p>
        </div>
      </section>

      <section className="set-card">
        <h3>Who it works well with</h3>
        {bonds.length === 0 ? (
          <p className="jf-hint">Nobody yet. Rapport builds as agents hand work to each other and talk in Threads.</p>
        ) : (
          <ul className="agent-bonds">
            {bonds.map((b) => (
              <li key={b.id}>
                <span>{b.name}</span>
                <span className="agent-bond-bar" aria-hidden="true"><i style={{ width: `${b.value}%` }} /></span>
                <small>{Math.round(b.value)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="set-card org-mind" aria-label={`${agent.name}'s memories`}>
        <h3>What {agent.name} has learned</h3>
        <p className="jf-hint">Its own, apart from Autora's: what it learns on its jobs and what Autora hands it. It reads only this.</p>
        {memories === null ? null : memories.length === 0 ? (
          <p className="jf-hint">Nothing yet.</p>
        ) : (
          <ul>
            {memories.map((m) => (
              <li key={m.id}>
                <span>{m.text}{m.from ? <small> — {m.from}</small> : null}</span>
                <button
                  type="button" className="btn ghost"
                  onClick={() => { setMemories((l) => (l ? l.filter((x) => x.id !== m.id) : l)); void forgetMemory(agent.id, m.id).catch(() => undefined); }}
                  aria-label={`Forget: ${m.text.slice(0, 40)}`}
                ><IconX size={11} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
