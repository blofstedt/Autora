/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, LibraryItem, Point2D, RepeatLink, ShapeGroup } from '../types';
import { syncInstances } from '../utils/library';
import { normalizeGroups } from '../utils/groups';
import { syncRepeats } from '../utils/repeat';

/** Everything that is saved: the shapes, how they are grouped, and the live repeats that make some of them. */
export interface Doc {
  bodies: Body3D[];
  groups: ShapeGroup[];
  /** Kept repeats: their copies are derived from the source shape and rebuilt on every change. */
  repeats: RepeatLink[];
  /** Reusable objects kept in this project. Placed copies (groups with `place`) follow them. */
  library: LibraryItem[];
}

/** Makes ids. Each caller supplies its own so ids stay unique (the app uses time, an agent session a counter). */
export type IdGen = (kind: string) => string;

export const emptyDoc = (): Doc => ({ bodies: [], groups: [], repeats: [], library: [] });

/** Settles a document: live-repeat copies are always rebuilt to match their source and path. */
export const settle = (d: Doc): Doc => {
  const placed = syncInstances(d.bodies, d.groups, d.library);
  const synced = syncRepeats(placed.bodies, d.repeats);
  const grouped = normalizeGroups(synced.bodies, placed.groups);
  return grouped.bodies === d.bodies && synced.repeats === d.repeats && grouped.groups === d.groups ? d : { ...d, repeats: synced.repeats, ...grouped };
};

/** The scene a new document starts with: one plain block. */
export const starterBodies = (): Body3D[] => {
  const outline: Point2D[] = [
    { x: -60, y: -40 },
    { x: 60, y: -40 },
    { x: 60, y: 40 },
    { x: -60, y: 40 },
  ];
  return [
    {
      id: 'body_block',
      name: 'Block',
      points: outline,
      extrusionHeight: 50,
      color: '#6f7a93',
      materialType: 'matte',
      visible: true,
      createdAt: new Date().toISOString(),
    },
  ];
};

export const starterDoc = (): Doc => ({ bodies: starterBodies(), groups: [], repeats: [], library: [] });

/** Reads a saved document, tolerating older ones (no repeats) and refusing anything that is not one. */
export function parseDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Doc>;
  if (!Array.isArray(d.bodies) || !Array.isArray(d.groups)) return null;
  return settle({ bodies: d.bodies, groups: d.groups, repeats: Array.isArray(d.repeats) ? d.repeats : [], library: Array.isArray(d.library) ? d.library : [] });
}

/** A counter-based id generator that never reuses an id already in `doc`. */
export function counterIds(doc: Doc, start = 1): IdGen {
  const used = new Set([...doc.bodies.map((b) => b.id), ...doc.groups.map((g) => g.id), ...doc.repeats.map((r) => r.linkId), ...doc.library.map((i) => i.id)]);
  let n = start;
  return (kind) => {
    let id = `${kind}_${n++}`;
    while (used.has(id)) id = `${kind}_${n++}`;
    used.add(id);
    return id;
  };
}
