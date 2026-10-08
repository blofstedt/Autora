/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, Point2D } from '../types';

export type ShapeKind = 'box' | 'roundedBox' | 'cylinder' | 'triangle' | 'wedge' | 'pentagon' | 'hexagon' | 'octagon' | 'star';

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  box: 'Box',
  roundedBox: 'Rounded box',
  cylinder: 'Cylinder',
  triangle: 'Triangle',
  wedge: 'Wedge',
  pentagon: 'Pentagon',
  hexagon: 'Hexagon',
  octagon: 'Octagon',
  star: 'Star',
};

const SIZE = 60;

/** Outline of a stock shape centred on (cx, cy). A cylinder is a square whose corners are rounded all the way. */
export function primitiveOutline(kind: ShapeKind, cx: number, cy: number): Pick<Body3D, 'points'> & { basePoints: Point2D[]; cornerRadii?: number[] } {
  const h = SIZE / 2;
  const at = (pts: Point2D[]) => pts.map((p) => ({ x: Math.round(cx + p.x), y: Math.round(cy + p.y) }));
  switch (kind) {
    case 'triangle': {
      const pts = at([
        { x: -h, y: -h * 0.87 },
        { x: h, y: -h * 0.87 },
        { x: 0, y: h * 0.87 },
      ]);
      return { points: pts, basePoints: pts };
    }
    case 'wedge': {
      const pts = at([
        { x: -h, y: -h },
        { x: h, y: -h },
        { x: -h, y: h },
      ]);
      return { points: pts, basePoints: pts };
    }
    case 'pentagon':
    case 'hexagon':
    case 'octagon': {
      const n = kind === 'pentagon' ? 5 : kind === 'hexagon' ? 6 : 8;
      const pts = at(Array.from({ length: n }, (_, i) => ({ x: h * Math.cos((i * 2 * Math.PI) / n + Math.PI / 2), y: h * Math.sin((i * 2 * Math.PI) / n + Math.PI / 2) })));
      return { points: pts, basePoints: pts };
    }
    case 'star': {
      const pts = at(
        Array.from({ length: 10 }, (_, i) => {
          const r = i % 2 === 0 ? h : h * 0.45;
          const a = (i * Math.PI) / 5 + Math.PI / 2;
          return { x: r * Math.cos(a), y: r * Math.sin(a) };
        })
      );
      return { points: pts, basePoints: pts };
    }
    case 'roundedBox': {
      const pts = at([
        { x: -h, y: -h },
        { x: h, y: -h },
        { x: h, y: h },
        { x: -h, y: h },
      ]);
      return { points: pts, basePoints: pts, cornerRadii: pts.map(() => 10) };
    }
    case 'cylinder': {
      const pts = at([
        { x: -h, y: -h },
        { x: h, y: -h },
        { x: h, y: h },
        { x: -h, y: h },
      ]);
      return { points: pts, basePoints: pts, cornerRadii: pts.map(() => h) };
    }
    default: {
      const pts = at([
        { x: -h, y: -h },
        { x: h, y: -h },
        { x: h, y: h },
        { x: -h, y: h },
      ]);
      return { points: pts, basePoints: pts };
    }
  }
}
