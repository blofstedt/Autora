import { useEffect, useState } from "react";
import { AgentDot } from "./pages/OrganizationPage";
import { IconX } from "./Icons";
import {
  TRAITS, fetchMind, forgetMemory, updateAgent, type Agent, type AgentMemory,
} from "../lib/organization";

/**
 * One agent's mind, in the Mind: who it is (personality and attributes, both
 * yours to change), how well it works with each colleague, and what it has
 * learned, which it alone reads. Autora's own mind is the rest of the page.
 * Teamwork and the bonds grow by themselves as the agent works with others.
 */
export function AgentProfile({ agent, agents, onSaved }: { agent: Agent; agents: Agent[]; onSaved: (a: Agent) => void }) {
  const [personality, setPersonality] = useState(agent.personality ?? "");
  const [traits, setTraits] = useState<NonNullable<Agent["traits"]>>(agent.traits ?? {});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memories, setMemories] = useState<AgentMemory[] | null>(null);

  // A different agent, or one that grew while this was open and has not been touched here.
  useEffect(() => {
    setPersonality(agent.personality ?? "");
    setTraits(agent.traits ?? {});
    setDirty(false);
    setError(null);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) setTraits(agent.traits ?? {});
  }, [agent.traits, dirty]);

  useEffect(() => {
    let live = true;
    setMemories(null);
    fetchMind(agent.id).then((d) => { if (live) setMemories(d.memories); }).catch(() => { if (live) setMemories([]); });
    return () => { live = false; };
  }, [agent.id, agent.updated]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateAgent(agent.id, { personality, traits }));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

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
              Its personality and attributes shape how it works and how it talks in Threads.
            </p>
          </div>
        </div>
        <label className="org-field">Personality
          <textarea
            rows={3} value={personality} maxLength={600}
            placeholder="How it works and talks. Left blank, one is drawn from its role."
            onChange={(e) => { setPersonality(e.target.value); setDirty(true); }}
          />
        </label>
        <fieldset className="org-traits">
          <legend>Attributes <small>— yours to change; teamwork grows as it works well with others</small></legend>
          {TRAITS.map((t) => (
            <label key={t.key} className="org-trait">
              <span className="org-trait-name">{t.label}</span>
              <small>{t.low}</small>
              <input
                type="range" min={0} max={100} step={1} value={Math.round(traits[t.key] ?? 50)}
                onChange={(e) => { setDirty(true); setTraits((v) => ({ ...v, [t.key]: Number(e.target.value) })); }}
                aria-label={`${t.label}: ${t.low} to ${t.high}`}
              />
              <small>{t.high}</small>
            </label>
          ))}
        </fieldset>
        {error && <p className="set-warn">{error}</p>}
        <div className="jf-actions">
          <button type="button" className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>Save</button>
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
