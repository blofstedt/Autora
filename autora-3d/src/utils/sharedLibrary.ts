/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LibraryItem } from '../types';

/**
 * The app-wide library: objects kept in this browser so every project can place them.
 * A project object marked `shared` and its app-wide twin (same id) are kept equal, the newer `rev` winning.
 * Nothing here knows about React or the DOM except the two storage functions, which never throw.
 */
export const SHARED_KEY = 'craft3d:library:v1';

export function loadShared(): LibraryItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SHARED_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((i) => i && typeof i.id === 'string' && Array.isArray(i.bodies)) : [];
  } catch {
    return [];
  }
}

export function saveShared(items: LibraryItem[]): void {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(items));
  } catch {
    // storage full or blocked: the project still has its copy
  }
}

/**
 * Brings a project's library and the app-wide one into agreement. Returns the same arrays when nothing changed,
 * so it settles after one pass.
 */
export function mergeShared(project: LibraryItem[], shared: LibraryItem[]): { project: LibraryItem[]; shared: LibraryItem[] } {
  let nextProject = project;
  let nextShared = shared;
  for (const item of project) {
    if (!item.shared) continue;
    const twin = nextShared.find((i) => i.id === item.id);
    if (!twin || (item.rev ?? 0) > (twin.rev ?? 0)) {
      nextShared = twin ? nextShared.map((i) => (i.id === item.id ? item : i)) : [...nextShared, item];
    } else if ((twin.rev ?? 0) > (item.rev ?? 0)) {
      nextProject = nextProject.map((i) => (i.id === item.id ? { ...twin, shared: true } : i));
    }
  }
  return { project: nextProject, shared: nextShared };
}
