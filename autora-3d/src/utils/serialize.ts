/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { Body3D } from '../types';
import { buildBodyGeometry } from './bodyGeometry';
import { frameMatrix } from './frame';

/** The visible shapes as one scene graph, with wall shapes stood on their walls. Needs no DOM, so it runs headless. */
const buildExportGroup = (bodies: Body3D[]) => {
  const group = new THREE.Group();
  bodies.forEach((body) => {
    if (!body.visible) return;
    const geometry = buildBodyGeometry(body);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry);
    mesh.name = body.name.replace(/\s+/g, '_');
    if (body.frame) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(frameMatrix(body.frame));
    }
    group.add(mesh);
  });
  return group;
};

/** Binary STL, Z-up for slicers (our scene is Y-up), or null when there is nothing to export. */
export function stlBytes(bodies: Body3D[]): Uint8Array | null {
  const group = buildExportGroup(bodies);
  if (group.children.length === 0) return null;
  group.rotation.x = Math.PI / 2;
  group.updateMatrixWorld(true);
  const data = new STLExporter().parse(group, { binary: true }) as unknown as DataView | ArrayBuffer | Uint8Array;
  if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** Wavefront OBJ text, or null when there is nothing to export. */
export function objText(bodies: Body3D[]): string | null {
  const group = buildExportGroup(bodies);
  if (group.children.length === 0) return null;
  group.updateMatrixWorld(true);
  return new OBJExporter().parse(group);
}

/** Bytes as base64, in browsers and in Node. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
