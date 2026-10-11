import { glyphPoints, useCursorWho } from "../lib/cursorWho";

/** The name on the agent's cursor: its shape (the polygon of its mark) and its name, Autora's own when no agent of the Organization is working. */
export function CursorTag({ extra }: { extra?: string }) {
  const who = useCursorWho();
  return (
    <span className="office-cursor-name">
      <svg className="cursor-glyph" viewBox="0 0 10 10" aria-hidden="true"><polygon points={glyphPoints(who.look?.sides ?? 3)} /></svg>
      <b>{who.name}</b>{extra ? ` · ${extra}` : ""}
    </span>
  );
}
