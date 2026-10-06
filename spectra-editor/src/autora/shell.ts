/**
 * `@tauri-apps/plugin-shell`, over Autora.
 *
 * Only "open this link" is used. Autora's browser window is the place for
 * that, so it is handed the address rather than the page navigating itself
 * out of the frame.
 */
import { call } from "./transport";

export async function open(path: string): Promise<void> {
  await call<void>("open_external", { path });
}

export async function openPath(path: string): Promise<void> {
  await call<void>("reveal_in_file_manager", { path });
}
