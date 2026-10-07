/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, ShapeGroup } from '../types';

/**
 * Groups nest: a body names its innermost group (`groupId`) and a group may name the one around it (`parentId`).
 * `bodyIds` is derived (every body anywhere inside), so edits only ever set those two pointers.
 */

/** The group a body sits in and every group around it, outermost first. */
export function groupChain(groups: ShapeGroup[], groupId: string | undefined): ShapeGroup[] {
  const chain: ShapeGroup[] = [];
  let g = groups.find((x) => x.id === groupId);
  while (g && !chain.includes(g)) {
    chain.unshift(g);
    g = g.parentId ? groups.find((x) => x.id === g!.parentId) : undefined;
  }
  return chain;
}

/** The groups directly inside `groupId` (or at the top, for undefined). */
export const childGroups = (groups: ShapeGroup[], groupId: string | undefined) => groups.filter((g) => g.parentId === groupId);

/** Every group inside `groupId`, at any depth. */
export function descendantGroups(groups: ShapeGroup[], groupId: string): ShapeGroup[] {
  const out: ShapeGroup[] = [];
  const walk = (id: string) => childGroups(groups, id).forEach((g) => (out.push(g), walk(g.id)));
  walk(groupId);
  return out;
}

/**
 * What a tap on `bodyId` selects. The outermost group first; tapping again while that group is the selection steps one
 * group deeper, and finally to the shape itself. Returns the group chosen (null for the lone shape) and its shapes.
 */
export function pickInGroups(bodies: Body3D[], groups: ShapeGroup[], bodyId: string, selected: string[]): { group: ShapeGroup | null; ids: string[] } {
  const body = bodies.find((b) => b.id === bodyId);
  let chain = groupChain(groups, body?.groupId);
  // A placed library object is one piece: tapping never steps inside it.
  const atom = chain.findIndex((g) => g.place);
  if (atom >= 0) chain = chain.slice(0, atom + 1);
  const same = (ids: string[]) => ids.length === selected.length && ids.every((i) => selected.includes(i));
  for (let i = 0; i < chain.length; i++) {
    if (same(chain[i].bodyIds)) return i + 1 < chain.length ? { group: chain[i + 1], ids: chain[i + 1].bodyIds } : { group: chain[i].place ? chain[i] : null, ids: chain[i].place ? chain[i].bodyIds : [bodyId] };
  }
  // Not stepping in: the outermost group, unless the selection is already inside one (then stay at its level or deeper).
  if (chain.length) return { group: chain[0], ids: chain[0].bodyIds };
  return { group: null, ids: [bodyId] };
}

/** The group made of exactly these shapes, if there is one (outermost when several are alike). */
export const groupOfSelection = (groups: ShapeGroup[], ids: string[]): ShapeGroup | undefined =>
  groups.find((g) => !g.joined && g.bodyIds.length === ids.length && ids.every((i) => g.bodyIds.includes(i)));

/**
 * Makes group data consistent: unknown references cleared, groups with fewer than two shapes dissolved (their contents
 * move up a level), `bodyIds` rebuilt. Returns the same arrays when nothing changed.
 */
export function normalizeGroups(bodies: Body3D[], groups: ShapeGroup[]): { bodies: Body3D[]; groups: ShapeGroup[] } {
  if (!groups.length && !bodies.some((b) => b.groupId)) return { bodies, groups };
  let gs = groups.map((g) => ({ ...g }));
  const byId = () => new Map(gs.map((g) => [g.id, g]));
  // Dangling or circular parents.
  let ids = byId();
  gs.forEach((g) => {
    if (g.parentId && (!ids.has(g.parentId) || g.parentId === g.id)) g.parentId = undefined;
    const seen = new Set([g.id]);
    for (let p = g.parentId ? ids.get(g.parentId) : undefined; p; p = p.parentId ? ids.get(p.parentId) : undefined) {
      if (seen.has(p.id)) {
        g.parentId = undefined;
        break;
      }
      seen.add(p.id);
    }
  });
  let owner = new Map(bodies.map((b) => [b.id, b.groupId && ids.has(b.groupId) ? b.groupId : undefined]));
  // Dissolve groups with under two shapes, repeatedly (removing one can leave its parent too small).
  for (;;) {
    ids = byId();
    const count = new Map<string, number>();
    owner.forEach((gid) => {
      for (const g of groupChain(gs, gid)) count.set(g.id, (count.get(g.id) ?? 0) + 1);
    });
    const dead = gs.find((g) => (count.get(g.id) ?? 0) < (g.place ? 1 : 2));
    if (!dead) break;
    gs.forEach((g) => g.parentId === dead.id && (g.parentId = dead.parentId));
    owner.forEach((gid, id) => gid === dead.id && owner.set(id, dead.parentId));
    gs = gs.filter((g) => g !== dead);
  }
  const outBodies = bodies.map((b) => (owner.get(b.id) === b.groupId ? b : { ...b, groupId: owner.get(b.id) }));
  const changedBodies = outBodies.some((b, i) => b !== bodies[i]);
  gs.forEach((g) => (g.bodyIds = bodies.filter((b) => groupChain(gs, owner.get(b.id)).some((x) => x.id === g.id)).map((b) => b.id)));
  const same = gs.length === groups.length && gs.every((g, i) => g.id === groups[i].id && g.name === groups[i].name && g.parentId === groups[i].parentId && g.joined === groups[i].joined && g.bodyIds.length === groups[i].bodyIds.length && g.bodyIds.every((x, k) => x === groups[i].bodyIds[k]));
  return { bodies: changedBodies ? outBodies : bodies, groups: same ? groups : gs };
}

/** The shape and everything in the outermost group around it: what moves together when it is dragged. */
export function withGroupMates(groups: ShapeGroup[], bodies: Body3D[], id: string): string[] {
  const top = groupChain(groups, bodies.find((b) => b.id === id)?.groupId)[0];
  return top ? top.bodyIds : [id];
}
