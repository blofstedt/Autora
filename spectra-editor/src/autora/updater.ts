/**
 * `@tauri-apps/plugin-updater`, over Autora.
 *
 * Spectra checks for its own updates and shows an update bar. Autora updates
 * as a whole (the image), so there is nothing for this window to offer: the
 * check reports no update and the bar stays hidden. This is a deliberate
 * difference, not a stub left unfinished.
 */
export interface Update {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall: () => Promise<void>;
  close: () => Promise<void>;
}

export async function check(): Promise<Update | null> {
  return null;
}
