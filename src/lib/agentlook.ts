/**
 * What an agent of the Organization looks like: the Autora mark's way of moving,
 * in its own shape and colour. The server hands each agent one when it is made
 * (server/agents.ts) and never gives two the same; this is how the page draws it.
 */

/** Corners, and a hue in degrees. Autora itself keeps the triangle and its violet. */
export type AgentLook = { sides: number; hue: number };

const rgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
};

const hex = (c: [number, number, number]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The three colours the mark's gradient turns through, and the same as the
    "r, g, b" lists the stylesheet's glows are written from. */
export function lookColors(look: AgentLook) {
  const h = ((look.hue % 360) + 360) % 360;
  const accent = rgb(h, 78, 62);
  const accent2 = rgb((h + 40) % 360, 82, 60);
  const glow = rgb((h + 320) % 360, 85, 68);
  const list = (c: number[]) => c.join(", ");
  return {
    colors: { accent: hex(accent), accent2: hex(accent2), glow: hex(glow) },
    css: { "--accent-rgb": list(accent), "--glow-rgb": list(glow), "--glow-light-rgb": list(rgb(h, 90, 78)) },
  };
}

/** A look from an event or a stored record, or null when it is not one. */
export function readLook(raw: unknown): AgentLook | null {
  const r = raw as { sides?: unknown; hue?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  const sides = Number(r.sides);
  const hue = Number(r.hue);
  return Number.isInteger(sides) && sides >= 4 && sides <= 12 && Number.isFinite(hue) ? { sides, hue } : null;
}
