/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, LibraryItem, Placement, ROOT, ShapeGroup } from '../types';
import { transformBody, selectionBounds } from './transform';
import { descendantGroups } from './groups';

/**
 * A library object, as a template and as placed copies.
 *
 * The template (`LibraryItem`) is centred on the ground at the origin. A placed copy is a group with `libraryId` and
 * `place`; its shapes and inner groups are *derived* (`instanceOf`), rebuilt from the template on every change, exactly
 * like the copies of a live repeat. So editing the item updates every copy, and moving/turning a copy only changes its `place`.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
export const placeKey = (p: Placement) => `${p.x},${p.y},${p.z},${p.angle}`;
const derivedId = (instance: string, id: string) => `${instance}~${id}`;

/** The template of `group`'s contents (or of one shape), or why it cannot be one. */
export function templateOf(bodies: Body3D[], groups: ShapeGroup[], group: ShapeGroup | null, single?: Body3D): { item: Pick<LibraryItem, 'bodies' | 'groups'>; place: Placement } | string {
  const members = group ? bodies.filter((b) => group.bodyIds.includes(b.id)) : single ? [single] : [];
  if (!members.length) return 'Nothing to save.';
  if (members.some((b) => b.repeatOf)) return 'It contains copies made by a live repeat. Make the copies separate first.';
  if (members.some((b) => b.instanceOf)) return 'It contains a linked library object. Make that separate first.';
  if (members.some((b) => b.frame)) return 'Shapes drawn on a wall cannot be saved to the library yet.';
  const box = selectionBounds(members)!;
  const move = { dx: -box.centerX, dy: -box.centerY, dz: -box.minElevation, angle: 0, cx: 0, cy: 0 };
  const inner = group ? descendantGroups(groups, group.id) : [];
  const innerIds = new Set(inner.map((g) => g.id));
  return {
    item: {
      bodies: members.map((b) => ({ ...b, ...transformBody(b, move), groupId: group && b.groupId !== group.id && innerIds.has(b.groupId ?? '') ? b.groupId : ROOT })),
      groups: inner.map((g) => ({ ...g, parentId: g.parentId === group!.id ? ROOT : g.parentId, libraryId: undefined, place: undefined, instanceOf: undefined })),
    },
    place: { x: round2(box.centerX), y: round2(box.centerY), z: round2(box.minElevation), angle: 0 },
  };
}

function derive(instance: ShapeGroup, item: LibraryItem): { bodies: Body3D[]; groups: ShapeGroup[] } {
  const p = instance.place!;
  const t = { dx: p.x, dy: p.y, dz: p.z, angle: p.angle, cx: 0, cy: 0 };
  const owner = (gid: string | undefined) => (!gid || gid === ROOT ? instance.id : derivedId(instance.id, gid));
  return {
    bodies: item.bodies.map((b) => ({ ...b, ...transformBody(b, t), id: derivedId(instance.id, b.id), groupId: owner(b.groupId), instanceOf: instance.id })),
    groups: item.groups.map((g) => ({ ...g, id: derivedId(instance.id, g.id), parentId: owner(g.parentId), instanceOf: instance.id, bodyIds: [] })),
  };
}

const cache = new Map<string, { item: LibraryItem; key: string; out: { bodies: Body3D[]; groups: ShapeGroup[] } }>();
const sameList = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Makes placed objects match the library. An object whose item is gone becomes ordinary shapes (open for editing);
 * shapes of an object that no longer exists vanish with it.
 */
export function syncInstances(bodies: Body3D[], groups: ShapeGroup[], library: LibraryItem[]): { bodies: Body3D[]; groups: ShapeGroup[] } {
  if (!library.length && !groups.some((g) => g.libraryId || g.instanceOf) && !bodies.some((b) => b.instanceOf)) return { bodies, groups };
  const items = new Map(library.map((i) => [i.id, i]));
  let orphaned = false;
  const base = groups
    .filter((g) => !g.instanceOf)
    .map((g) => {
      if (g.place && !items.has(g.libraryId ?? '')) {
        orphaned = true;
        return { ...g, place: undefined, libraryId: undefined };
      }
      return g;
    });
  const live = new Set(base.filter((g) => g.place).map((g) => g.id));
  const keptBodies: Body3D[] = [];
  const keptGroups: ShapeGroup[] = [];
  const derivedBodies: Body3D[] = [];
  const derivedGroups: ShapeGroup[] = [];
  // Shapes of an object that lost its item stay, as plain shapes.
  const orphanIds = new Set(groups.filter((g) => g.place && !items.has(g.libraryId ?? '') && !g.instanceOf).map((g) => g.id));
  bodies.forEach((b) => {
    if (!b.instanceOf) keptBodies.push(b);
    else if (orphanIds.has(b.instanceOf)) keptBodies.push({ ...b, instanceOf: undefined });
  });
  groups.forEach((g) => {
    if (g.instanceOf && orphanIds.has(g.instanceOf)) keptGroups.push({ ...g, instanceOf: undefined });
  });
  for (const g of base) {
    if (!g.place || !live.has(g.id)) continue;
    const item = items.get(g.libraryId!)!;
    const key = placeKey(g.place);
    const hit = cache.get(g.id);
    const out = hit && hit.item === item && hit.key === key ? hit.out : derive(g, item);
    cache.set(g.id, { item, key, out });
    derivedBodies.push(...out.bodies);
    derivedGroups.push(...out.groups);
  }
  const nextBodies = [...keptBodies, ...derivedBodies];
  const nextGroups = [...base, ...keptGroups, ...derivedGroups];
  const unchanged = !orphaned && sameList(nextBodies, bodies) && sameList(nextGroups, groups);
  return unchanged ? { bodies, groups } : { bodies: nextBodies, groups: nextGroups };
}

/** A placement after a rigid move/turn (about (cx, cy)) of the whole object. */
export function movePlace(p: Placement, t: { dx: number; dy: number; dz: number; angle: number; cx: number; cy: number }): Placement {
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const rx = p.x - t.cx;
  const ry = p.y - t.cy;
  return { x: round2(t.cx + rx * cos - ry * sin + t.dx), y: round2(t.cy + rx * sin + ry * cos + t.dy), z: Math.max(0, round2(p.z + t.dz)), angle: p.angle + t.angle };
}
