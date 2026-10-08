/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Body3D, MATERIAL_PRESETS, ShapeGroup } from '../types';
import { buildBodyGeometry } from './bodyGeometry';
import { frameMatrix } from './frame';

export interface GlbOptions {
  /** Scene units per metre of output. Default 0.001: our mm become glTF metres, which is what game engines expect. */
  scale?: number;
  /**
   * Where each shape's origin sits. "scene" keeps the placement you see; "asset" centres the whole export on the ground
   * (its footprint centre at x/z 0, its lowest point at y 0); "shape" gives every shape its own pivot at the centre of its
   * base, so each can be moved or spun alone in an engine.
   */
  pivot?: 'scene' | 'asset' | 'shape';
  /** The document's groups: each becomes a named parent node holding its shapes and inner groups (so "head" arrives as "head"). */
  groups?: ShapeGroup[];
}

const pad = (n: number) => (4 - (n % 4)) % 4;

/** A binary glTF (.glb), Y-up, in metres: one named node + PBR material per visible shape. Needs no DOM. Null when nothing is visible. */
export function glbBytes(bodies: Body3D[], options: GlbOptions = {}): Uint8Array | null {
  const unit = options.scale ?? 0.001;
  const pivot = options.pivot ?? 'scene';
  type Part = { body: Body3D; pos: Float32Array; nrm: Float32Array; idx: Uint32Array; min: THREE.Vector3; max: THREE.Vector3 };
  const parts: Part[] = [];
  for (const body of bodies) {
    if (!body.visible) continue;
    const g = buildBodyGeometry(body);
    if (!g) continue;
    const m = body.frame ? frameMatrix(body.frame) : new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(m);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const pos = new Float32Array(p.count * 3);
    const nrm = new Float32Array(p.count * 3);
    const v = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos.set([v.x, v.y, v.z], i * 3);
      min.min(v);
      max.max(v);
      if (n) {
        v.fromBufferAttribute(n, i).applyMatrix3(normalMatrix).normalize();
        nrm.set([v.x, v.y, v.z], i * 3);
      }
    }
    const index = g.getIndex();
    const idx = new Uint32Array(index ? index.count : p.count);
    for (let i = 0; i < idx.length; i++) idx[i] = index ? index.getX(i) : i;
    if (!n) {
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      tmp.setIndex(new THREE.BufferAttribute(idx, 1));
      tmp.computeVertexNormals();
      nrm.set(tmp.getAttribute('normal').array as Float32Array);
    }
    parts.push({ body, pos, nrm, idx, min, max });
  }
  if (!parts.length) return null;

  const all = new THREE.Box3();
  parts.forEach((q) => all.union(new THREE.Box3(q.min, q.max)));
  const assetShift = new THREE.Vector3((all.min.x + all.max.x) / 2, all.min.y, (all.min.z + all.max.z) / 2);

  const nodes: object[] = [];
  const partNode = new Map<string, number>();
  const partOrigin = new Map<string, THREE.Vector3>();
  const meshes: object[] = [];
  const materials: object[] = [];
  const accessors: object[] = [];
  const views: object[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const addView = (bytes: Uint8Array, target: number) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    const padded = new Uint8Array(bytes.length + pad(bytes.length));
    padded.set(bytes);
    chunks.push(padded);
    offset += padded.length;
    return views.length - 1;
  };

  for (const q of parts) {
    // Pivot: the point (in scene units) that becomes this node's origin.
    const origin =
      pivot === 'shape' ? new THREE.Vector3((q.min.x + q.max.x) / 2, q.min.y, (q.min.z + q.max.z) / 2) : pivot === 'asset' ? assetShift : new THREE.Vector3();
    const pos = new Float32Array(q.pos.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const val = (q.pos[i + k] - (pivot === 'shape' ? origin.getComponent(k) : pivot === 'asset' ? origin.getComponent(k) : 0)) * unit;
        pos[i + k] = val;
        lo[k] = Math.min(lo[k], val);
        hi[k] = Math.max(hi[k], val);
      }
    }
    const aPos = accessors.length;
    accessors.push({ bufferView: addView(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: lo, max: hi });
    accessors.push({ bufferView: addView(new Uint8Array(q.nrm.buffer), 34962), componentType: 5126, count: q.nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: addView(new Uint8Array(q.idx.buffer), 34963), componentType: 5125, count: q.idx.length, type: 'SCALAR' });

    const preset = MATERIAL_PRESETS.find((m) => m.id === q.body.materialType) || MATERIAL_PRESETS[0];
    const c = new THREE.Color(q.body.color || preset.color); // THREE.Color reads hex as sRGB and stores linear
    const material: Record<string, any> = {
      name: `${q.body.name}_${q.body.materialType}`.replace(/\s+/g, '_'),
      pbrMetallicRoughness: { baseColorFactor: [c.r, c.g, c.b, 1], metallicFactor: preset.metalness, roughnessFactor: preset.roughness },
    };
    if (q.body.materialType === 'glass') {
      material.pbrMetallicRoughness.baseColorFactor[3] = 0.35;
      material.alphaMode = 'BLEND';
    }
    if (q.body.materialType === 'neon') material.emissiveFactor = [c.r, c.g, c.b];
    materials.push(material);
    meshes.push({ name: q.body.name.replace(/\s+/g, '_'), primitives: [{ attributes: { POSITION: aPos, NORMAL: aPos + 1 }, indices: aPos + 2, material: materials.length - 1, mode: 4 }] });
    const node: Record<string, any> = { name: q.body.name.replace(/\s+/g, '_'), mesh: meshes.length - 1 };
    if (pivot === 'shape') node.translation = [origin.x * unit, origin.y * unit, origin.z * unit];
    // With "asset" the shift is baked in, so the node stays at the origin.
    nodes.push(node);
    partNode.set(q.body.id, nodes.length - 1);
    partOrigin.set(q.body.id, origin.clone());
  }

  // Groups: a named parent node per group. Under "shape" pivots a group's origin is the centre of its base, and children
  // are placed relative to it.
  const groups = (options.groups ?? []).filter((g) => g.bodyIds.some((id) => partNode.has(id)));
  const groupNode = new Map<string, number>();
  const groupOrigin = new Map<string, THREE.Vector3>();
  groups.forEach((g) => {
    const box = new THREE.Box3();
    parts.forEach((q) => g.bodyIds.includes(q.body.id) && box.union(new THREE.Box3(q.min, q.max)));
    groupOrigin.set(g.id, pivot === 'shape' ? new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2) : new THREE.Vector3());
    nodes.push({ name: g.name.replace(/\s+/g, '_'), children: [] as number[] });
    groupNode.set(g.id, nodes.length - 1);
  });
  const rel = (node: Record<string, any>, origin: THREE.Vector3, parent?: THREE.Vector3) => {
    if (pivot !== 'shape') return;
    const d = parent ? origin.clone().sub(parent) : origin;
    node.translation = [d.x * unit, d.y * unit, d.z * unit];
  };
  const placed = new Set<number>();
  groups.forEach((g) => {
    const me = nodes[groupNode.get(g.id)!] as Record<string, any>;
    const parent = g.parentId && groupNode.has(g.parentId) ? g.parentId : undefined;
    rel(me, groupOrigin.get(g.id)!, parent ? groupOrigin.get(parent) : undefined);
    if (parent) {
      (nodes[groupNode.get(parent)!] as any).children.push(groupNode.get(g.id)!);
      placed.add(groupNode.get(g.id)!);
    }
  });
  parts.forEach((q) => {
    const owner = groups.find((g) => g.id === q.body.groupId);
    if (!owner) return;
    const idx = partNode.get(q.body.id)!;
    rel(nodes[idx] as Record<string, any>, partOrigin.get(q.body.id)!, groupOrigin.get(owner.id));
    (nodes[groupNode.get(owner.id)!] as any).children.push(idx);
    placed.add(idx);
  });

  const json = {
    asset: { version: '2.0', generator: 'Autora 3D' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i).filter((i) => !placed.has(i)) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(jsonBytes.length + pad(jsonBytes.length)).fill(0x20);
  jsonPadded.set(jsonBytes);
  jsonBytes = jsonPadded;
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  let at = 20 + jsonBytes.length;
  dv.setUint32(at, offset, true);
  dv.setUint32(at + 4, 0x004e4942, true); // "BIN\0"
  at += 8;
  for (const ch of chunks) {
    out.set(ch, at);
    at += ch.length;
  }
  return out;
}
