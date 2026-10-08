/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import Module from 'manifold-3d';
import { weldVertices } from './meshHeal';

/**
 * Boolean cuts that always come out as a closed solid.
 *
 * A mesh boolean on triangles (three-bvh-csg) leaves hair-thin cracks and doubled faces wherever the cutter's surface
 * meets the body at a shallow angle or at a corner shared with another cutter. A slicer then has to guess. Manifold
 * (the library OpenSCAD now uses) is built to give a closed, correctly oriented result every time.
 * It starts up asynchronously (a WebAssembly module): call initManifold() once, before building geometry.
 */
type Wasm = Awaited<ReturnType<typeof Module>>;
let wasm: Wasm | null = null;
let starting: Promise<void> | null = null;

/** Starts the geometry engine. Safe to call again. `wasmUrl` is where the .wasm file is served from (browsers). */
export function initManifold(wasmUrl?: string): Promise<void> {
  if (wasm) return Promise.resolve();
  starting ??= (async () => {
    const m = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    m.setup();
    wasm = m;
  })();
  return starting;
}

export const manifoldReady = () => wasm !== null;

/** A closed triangle mesh as a Manifold, or null when it is not one (self-overlapping, open). */
function toManifold(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const count = idx ? idx.count : pos.count;
  const raw: number[] = [];
  for (let t = 0; t < count; t++) {
    const i = idx ? idx.getX(t) : t;
    raw.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  const { coords, ids } = weldVertices(raw, 1e-4);
  // Welding can collapse a sliver to a line: drop those, a solid has none.
  const tris: number[] = [];
  for (let t = 0; t + 2 < ids.length; t += 3) {
    if (ids[t] !== ids[t + 1] && ids[t + 1] !== ids[t + 2] && ids[t + 2] !== ids[t]) tris.push(ids[t], ids[t + 1], ids[t + 2]);
  }
  const mesh = new wasm!.Mesh({ numProp: 3, vertProperties: new Float32Array(coords), triVerts: new Uint32Array(tris) });
  try {
    const m = new wasm!.Manifold(mesh);
    return m.status() === 'NoError' && !m.isEmpty() ? m : null;
  } catch {
    return null;
  }
}

/** `body` with every cutter taken out of it, as an indexed geometry; null when the engine is not started or an input is not a solid. */
export function subtractAll(body: THREE.BufferGeometry, cutters: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!wasm) return null;
  let current = toManifold(body);
  if (!current) return null;
  for (const cutter of cutters) {
    const c = toManifold(cutter);
    if (!c) return null;
    current = current.subtract(c);
  }
  // Collapses the zero-area slivers a cut can leave (a slicer would have to delete them), keeping the solid closed.
  const out = current.simplify(1e-4).getMesh();
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array((out.vertProperties.length / out.numProp) * 3);
  for (let v = 0; v < positions.length / 3; v++) {
    positions[v * 3] = out.vertProperties[v * out.numProp];
    positions[v * 3 + 1] = out.vertProperties[v * out.numProp + 1];
    positions[v * 3 + 2] = out.vertProperties[v * out.numProp + 2];
  }
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(out.triVerts), 1));
  return g;
}
