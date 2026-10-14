import { TRAITS, type Agent } from "../lib/organization";
import { asPoints, corner, shapeCorners } from "../lib/personalityshape";

const SIZE = 220;
const MID = SIZE / 2;
/** Room either side for the labels at the left and right corners, which would otherwise be cut off. */
const PAD = 34;
const RADIUS = 62;
const KEYS = TRAITS.map((t) => t.key);

/**
 * An agent's personality as a five-point shape: it begins as the same rounded
 * default for every agent, and stretches toward the points it has grown into as
 * it talks in Threads. It is only drawn -- there is nothing here to drag.
 */
export function PersonalityShape({ traits, name }: { traits: Agent["traits"]; name: string }) {
  const ring = (share: number) => asPoints(KEYS.map((_, i) => corner(i, KEYS.length, RADIUS * share, MID, MID)));
  const mine = shapeCorners(traits, KEYS, RADIUS, MID, MID);
  const said = TRAITS.map((t) => `${t.label} ${Math.round(traits?.[t.key] ?? 50)}`).join(", ");
  return (
    <svg className="agent-shape" viewBox={`${-PAD} 0 ${SIZE + 2 * PAD} ${SIZE}`} role="img" aria-label={`${name}'s personality: ${said}`}>
      <title>{said}</title>
      <polygon className="agent-shape-ring" points={ring(1)} />
      <polygon className="agent-shape-ring" points={ring(0.55)} />
      {KEYS.map((key, i) => {
        const end = corner(i, KEYS.length, RADIUS, MID, MID);
        return <line key={key} className="agent-shape-axis" x1={MID} y1={MID} x2={end.x} y2={end.y} />;
      })}
      <polygon className="agent-shape-self" points={asPoints(mine)} />
      {mine.map((p, i) => <circle key={KEYS[i]} className="agent-shape-dot" cx={p.x} cy={p.y} r={2.6} />)}
      {TRAITS.map((t, i) => {
        const at = corner(i, KEYS.length, RADIUS + 15, MID, MID + 3);
        const anchor = Math.abs(at.x - MID) < 4 ? "middle" : at.x < MID ? "end" : "start";
        return <text key={t.key} className="agent-shape-label" x={at.x} y={at.y} textAnchor={anchor}>{t.label}</text>;
      })}
    </svg>
  );
}
