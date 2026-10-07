/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Everything is stored and shown in millimetres; centimetres appear beside it once a length passes 100 mm. */
export function formatLength(mm: number): { main: string; alt?: string } {
  const rounded = Math.round(mm * 10) / 10;
  const main = `${rounded} mm`;
  if (Math.abs(rounded) < 100) return { main };
  const cm = Math.round(rounded) / 10;
  return { main, alt: `${cm} cm` };
}

const FACTORS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4 };

/** Reads "12", "12 mm", "1.2cm", "0.3 m", "5in" as millimetres. A bare number is millimetres. */
export function parseLength(text: string): number | null {
  const m = text.trim().toLowerCase().replace(',', '.').match(/^(-?\d*\.?\d+)\s*(mm|cm|m|in|")?$/);
  if (!m) return null;
  const v = parseFloat(m[1]) * FACTORS[m[2] ?? 'mm'];
  return Number.isFinite(v) ? v : null;
}
