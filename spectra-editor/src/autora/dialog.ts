/**
 * `@tauri-apps/plugin-dialog`, over Autora.
 *
 * Autora owns the file pickers: a chosen file has to exist in Autora's world,
 * not on a desktop. These forward to Autora's own dialogs.
 */
import { call } from "./transport";

export async function open(options?: Record<string, unknown>): Promise<string | string[] | null> {
  return call("pick_files", { options: options ?? {} });
}

export async function save(options?: Record<string, unknown>): Promise<string | null> {
  return call("pick_save_path", { options: options ?? {} });
}

export async function message(text: string, options?: Record<string, unknown>): Promise<void> {
  await call("show_message", { text, options: options ?? {} });
}

export async function ask(text: string, options?: Record<string, unknown>): Promise<boolean> {
  return call<boolean>("ask_confirm", { text, options: options ?? {} });
}

export async function confirm(text: string, options?: Record<string, unknown>): Promise<boolean> {
  return call<boolean>("ask_confirm", { text, options: options ?? {} });
}
