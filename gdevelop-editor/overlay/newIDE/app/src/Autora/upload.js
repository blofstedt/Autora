// @flow
import { gameApi } from './session';

/** The most one file may weigh: the artifact limit of Autora's server. */
export const PROJECT_RESOURCE_MAX_SIZE_IN_BYTES = 50 * 1000 * 1000;

/**
 * A file the person chose for their game, kept by Autora's server with the game
 * (server/gamedesk.ts) and used by address, like a file anywhere else on the web.
 * The answer has the shape GDevelop's own upload gives, so the chooser needs no other change.
 */
export const uploadResourceFilesToAutora = async (
  files: Array<File>,
  onProgress: (current: number, total: number) => void
): Promise<Array<any>> => {
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const res = await fetch(gameApi(`/assets?name=${encodeURIComponent(file.name)}`), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.url) throw new Error((body && body.error) || `Autora answered ${res.status}`);
      results.push({ resourceFile: file, url: new URL(body.url, window.location.origin).href });
    } catch (error) {
      results.push({ resourceFile: file, error });
    }
    onProgress(i + 1, files.length);
  }
  return results;
};
