/**
 * `@tauri-apps/api/webviewWindow`, over Autora.
 *
 * Only the drop zone uses it — to learn whether the pointer is over the web
 * view. There is one web view here, so the answer is always yes.
 */
import { getCurrentWindow } from "./window";

/** What Tauri says about a file dragged over the window; here nothing ever does. */
export type DragDropPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths?: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

export function getCurrentWebviewWindow() {
  return Object.assign(getCurrentWindow(), {
    async onDragDropEvent(_handler: (event: { payload: DragDropPayload }) => void): Promise<() => void> {
      return () => {};
    },
    async setZoom(_scale: number): Promise<void> {},
  });
}

export function getAllWebviewWindows() {
  return [getCurrentWebviewWindow()];
}
