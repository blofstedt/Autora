/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { House } from 'lucide-react';

export type CubeFace = 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left' | 'iso';

interface ViewCubeProps {
  camera: THREE.PerspectiveCamera | null;
  onSelectFace: (face: CubeFace) => void;
  onResetCamera: () => void;
  /** More view controls, stacked under Home. */
  children?: React.ReactNode;
}

const SIZE = 64;
const HALF = SIZE / 2;

// Each face sits on its world axis. The cube lives in a CSS frame that is the
// world frame with Y flipped (CSS y points down), hence the -90/90 on top/bottom.
const FACES: { face: Exclude<CubeFace, 'iso'>; label: string; transform: string }[] = [
  { face: 'front', label: 'Front', transform: `translateZ(${HALF}px)` },
  { face: 'back', label: 'Back', transform: `rotateY(180deg) translateZ(${HALF}px)` },
  { face: 'right', label: 'Right', transform: `rotateY(90deg) translateZ(${HALF}px)` },
  { face: 'left', label: 'Left', transform: `rotateY(-90deg) translateZ(${HALF}px)` },
  { face: 'top', label: 'Top', transform: `rotateX(90deg) translateZ(${HALF}px)` },
  { face: 'bottom', label: 'Bottom', transform: `rotateX(-90deg) translateZ(${HALF}px)` },
];

export default function ViewCube({ camera, onSelectFace, onResetCamera, children }: ViewCubeProps) {
  const cubeRef = useRef<HTMLDivElement | null>(null);

  // Mirror the camera orientation straight onto the DOM (no React re-render per frame).
  useEffect(() => {
    if (!camera) return;
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const e = new Array<number>(16);
    let raf = 0;
    const last = new THREE.Quaternion(0, 0, 0, 0);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = cubeRef.current;
      if (!el || last.equals(camera.quaternion)) return; // camera is still: leave the DOM alone
      last.copy(camera.quaternion);
      // World -> view rotation is the inverse of the camera orientation.
      q.copy(camera.quaternion).invert();
      m.makeRotationFromQuaternion(q);
      const r = m.elements; // column-major
      // S = F * R * F with F = diag(1,-1,1) converts to CSS's y-down frame.
      const f = [1, -1, 1];
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
          e[col * 4 + row] = f[row] * r[col * 4 + row] * f[col];
        }
        e[col * 4 + 3] = 0;
      }
      e[12] = e[13] = e[14] = 0;
      e[15] = 1;
      el.style.transform = `matrix3d(${e.join(',')})`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [camera]);

  return (
    <div className="absolute top-3 right-3 z-20 flex flex-col items-center gap-1 pointer-events-auto max-sm:scale-[0.78] max-sm:origin-top-right">
      <div className="relative" style={{ width: SIZE + 28, height: SIZE + 28, perspective: 380 }}>
        <div
          ref={cubeRef}
          className="absolute"
          style={{
            left: 14,
            top: 14,
            width: SIZE,
            height: SIZE,
            transformStyle: 'preserve-3d',
          }}
        >
          {FACES.map(({ face, label, transform }) => (
            <button
              key={face}
              type="button"
              onClick={() => onSelectFace(face)}
              aria-label={`${label} view`}
              className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-slate-300 bg-slate-800/90 border border-white/15 hover:bg-accent-500 hover:text-white hover:border-accent-300 transition-colors"
              style={{ transform, backfaceVisibility: 'hidden' }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={onResetCamera}
        aria-label="Fit model in view"
        title="Fit model in view"
        className="h-7 px-2.5 rounded-full bg-slate-800/90 border border-white/10 text-slate-300 hover:text-white hover:bg-slate-800 flex items-center gap-1.5 text-xs transition-colors"
      >
        <House size={13} />
        Home
      </button>
      {children}
    </div>
  );
}
