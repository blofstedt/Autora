/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D } from '../types';
import { glbBytes, GlbOptions } from './glb';
import { objText, stlBytes } from './serialize';

const stamp = () => new Date().toISOString().slice(0, 10);

const download = (data: BlobPart, filename: string, type: string) => {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/** Returns false when there was nothing to export. */
export function exportSTL(bodies: Body3D[]): boolean {
  const data = stlBytes(bodies);
  if (!data) return false;
  download(data as BlobPart, `autora-3d-${stamp()}.stl`, 'model/stl');
  return true;
}

export function exportOBJ(bodies: Body3D[]): boolean {
  const data = objText(bodies);
  if (!data) return false;
  download(data, `autora-3d-${stamp()}.obj`, 'text/plain');
  return true;
}

/** A game-ready binary glTF: metres, Y-up, colours and materials kept. */
export function exportGLB(bodies: Body3D[], options?: GlbOptions): boolean {
  const data = glbBytes(bodies, options);
  if (!data) return false;
  download(data as BlobPart, `autora-3d-${stamp()}.glb`, 'model/gltf-binary');
  return true;
}

export function exportJSON(bodies: Body3D[]): void {
  download(JSON.stringify(bodies, null, 2), `autora-3d-${stamp()}.json`, 'application/json');
}
