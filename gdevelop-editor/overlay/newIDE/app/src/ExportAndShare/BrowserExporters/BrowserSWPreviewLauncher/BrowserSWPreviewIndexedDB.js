// @flow
import { gameApi } from '../../../Autora/session';

/**
 * Where a preview's files are kept. GDevelop keeps them in the browser (IndexedDB) and serves them
 * with a service worker; a service worker on Autora's address would answer for the whole app, so
 * they are kept by Autora's server instead (server/gamedesk.ts), served from
 * /api/game/<chat>/preview/<instance>/... in a box of their own (Content-Security-Policy: sandbox:
 * a game is code, and it runs without the app's origin). The names and shapes are GDevelop's, so
 * nothing that uses them has to change.
 */

let currentInstanceId: ?string = null;

const previewApi = (): string => gameApi('/preview');

export const getBrowserSWPreviewRootUrl = (): string =>
  `${window.location.origin}${previewApi()}`;

export const getBrowserSWPreviewBaseUrl = (): string => {
  if (!currentInstanceId) {
    throw new Error(
      'Preview instance not initialised. Call ensureBrowserSWPreviewSession() first.'
    );
  }
  return `${getBrowserSWPreviewRootUrl()}/${currentInstanceId}`;
};

/** Stores a "file" of a preview. `path` is "/<instance>/preview/index.html" and the like. */
export const putFile = async (
  path: string,
  bytes: ArrayBuffer,
  contentType: string
): Promise<void> => {
  const res = await fetch(`${previewApi()}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      (body && body.error) || `Autora could not keep ${path} (${res.status})`
    );
  }
};

/** Deletes all the "files" of a preview under a path prefix, and says how many there were. */
export const deleteFilesWithPrefix = async (
  pathPrefix: string
): Promise<number> => {
  const res = await fetch(
    `${previewApi()}?prefix=${encodeURIComponent(pathPrefix)}`,
    { method: 'DELETE' }
  );
  const body = await res.json().catch(() => null);
  return (body && body.deleted) || 0;
};

/** This editor's own place among the previews of the chat: one per page load. */
export const ensureBrowserSWPreviewSession = async (): Promise<void> => {
  if (currentInstanceId) return;
  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  currentInstanceId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};
