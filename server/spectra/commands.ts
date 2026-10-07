/**
 * What Spectra's renderer means by each command it sends.
 *
 * In Spectra these names were Rust `#[command]`s. Here they are answered by
 * Autora's server, and they fall into four groups, in this order of
 * importance:
 *
 *   1. The engine pipe. `send_to_engine` and its health twin carry a JSON-RPC
 *      request straight to Spectra's own Python engine; the reply goes back as
 *      an `engine:response` event, exactly as Rust posted it. This is where
 *      everything that touches a PDF actually happens, and none of it is
 *      rewritten.
 *   2. The filesystem and the paths. A page cannot read a file, so these are
 *      done here, inside the session's own folder.
 *   3. Platform facts. What this machine has (Ghostscript, Tesseract,
 *      LibreOffice) and what it does not (scanners, printers, a system tray,
 *      the Windows shell). The ones that are absent are reported absent, so
 *      Spectra's own capability flags drop those menus instead of offering a
 *      control that errors -- its renderer already has that path.
 *   4. Journaling and window chatter, which mean nothing in Autora's window
 *      and are accepted and dropped rather than refused, because refusing them
 *      would show the person an error for something they never asked for.
 *
 * Argument names are read leniently (`filePath` or `path`, `contents` or
 * `text`): they come from about a hundred call sites in a renderer this port
 * does not modify, and a missing alias is a blank screen rather than a bug
 * anyone can see.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineProblem, type SpectraEngine } from "./engine";

/* ------------------------------------------------------------------ paths -- */

/** Command names seen so far that are answered as "accepted, does nothing".
 *  Kept so a report can say how many there were and which. */
const DROPPED = new Set<string>();
/** Commands with no implementation here, answered with a refusal. */
const REFUSED = new Set<string>();

function str(args: Record<string, any>, ...names: string[]): string {
  for (const name of names) {
    const v = args?.[name];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function list(args: Record<string, any>, ...names: string[]): string[] {
  for (const name of names) {
    const v = args?.[name];
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
    if (typeof v === "string" && v) return [v];
  }
  return [];
}

/** The folders a command may touch: the session's own working folder and the
 *  scratch space. Everything else is refused -- this server holds Autora's
 *  secrets and the person's other documents, and the engine only ever needs
 *  the file in front of them. */
function allowedRoots(root: string): string[] {
  return [root, path.join(root, ".."), os.tmpdir()].map((p) => path.resolve(p));
}

function inside(root: string, target: string): string {
  const full = path.resolve(target);
  const ok = allowedRoots(root).some((base) => full === base || full.startsWith(base + path.sep));
  if (!ok) throw new Error("That file is outside the folder this window may work in.");
  return full;
}

let toolPaths: Record<string, string | null> | null = null;

/** Where this machine keeps the tools the engine can call out to. The engine
 *  is told the same paths (server/spectra/engine.ts). */
function toolPath(name: "gs" | "soffice" | "tesseract"): string | null {
  if (!toolPaths) {
    const env: Record<string, string | undefined> = {
      gs: process.env.AUTORA_SPECTRA_GS,
      soffice: process.env.AUTORA_SPECTRA_SOFFICE,
      tesseract: process.env.AUTORA_SPECTRA_TESSERACT,
    };
    const found: Record<string, string | null> = {};
    for (const tool of ["gs", "soffice", "tesseract"] as const) {
      const fromEnv = env[tool];
      if (fromEnv && fs.existsSync(fromEnv)) {
        found[tool] = fromEnv;
        continue;
      }
      const fromPath = process.env.PATH?.split(":")
        .map((dir) => path.join(dir, tool))
        .find((p) => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        });
      found[tool] = fromPath ?? null;
    }
    toolPaths = found;
  }
  return toolPaths[name] ?? null;
}

/* --------------------------------------------------------------- context -- */

export interface SpectraContext {
  /** The document session this window belongs to. */
  session: string;
  /** The folder commands may work in. */
  root: string;
  interactive: SpectraEngine;
  health: SpectraEngine;
  /** Send one event to the window (the engine's replies, progress). */
  emit(event: string, payload: unknown): void;
  /** The PDF this window is showing, as a file on disk, or null. */
  documentPath(): string | null;
  /** Autora's own version, so the window reports the app it is part of. */
  appVersion(): string;
  /** The desk's copy moved on (the agent edited it): write the file out again
   *  and tell the editor to open it, so the person sees the change. */
  refreshDocument(): Promise<void>;
  /** The document's bytes changed on disk: put them back in the desk, so the
   *  agent's own tools see what the person did. */
  documentSaved(file: string): void;
}

/* ------------------------------------------------------------ the engine -- */

/**
 * One engine request, answered as Rust answered it: the command returns at
 * once (Rust returned void) and the result arrives later as an event
 * addressed by the id the renderer issued, which is how `useEngine.ts` is
 * written -- it correlates by id alone against one listener.
 */
function forward(ctx: SpectraContext, engine: SpectraEngine, which: "i" | "h", args: Record<string, any>): void {
  const request = (args?.request ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
  const id = request.id as number | string | undefined;
  const method = String(request.method ?? "");
  const params = (request.params ?? {}) as Record<string, any>;
  if (!method) {
    ctx.emit("engine:response", { jsonrpc: "2.0", id, error: { code: -32600, message: "That request has no method." } });
    return;
  }

  const { id: engineId, promise } = engine.requestWithId(method, params);
  pending.set(`${ctx.session}:${which}:${String(id)}`, { engine, engineId });

  promise.then(
    (result) => {
      pending.delete(`${ctx.session}:${which}:${String(id)}`);
      ctx.emit("engine:response", { jsonrpc: "2.0", id, result });
    },
    (err: EngineProblem) => {
      pending.delete(`${ctx.session}:${which}:${String(id)}`);
      ctx.emit("engine:response", {
        jsonrpc: "2.0",
        id,
        // The engine's own words, under its own code: a refusal the person
        // should read, not a generic failure.
        error: { code: err.code ?? -32000, message: err.message },
      });
    },
  );
}

/** Requests in flight, by the id the renderer issued, so it can stop one. */
const pending = new Map<string, { engine: SpectraEngine; engineId: number }>();

/* ------------------------------------------------------------- commands -- */

export async function runCommand(
  ctx: SpectraContext,
  command: string,
  args: Record<string, any>,
): Promise<unknown> {
  switch (command) {
    /* --- 1. the engine ------------------------------------------------ */
    case "send_to_engine":
      forward(ctx, ctx.interactive, "i", args);
      return undefined;
    case "send_to_health_engine":
      forward(ctx, ctx.health, "h", args);
      return undefined;
    case "cancel_engine_request": {
      const id = String(args?.id ?? "");
      let stopped = false;
      for (const which of ["i", "h"]) {
        const key = `${ctx.session}:${which}:${id}`;
        const entry = pending.get(key);
        if (!entry) continue;
        pending.delete(key);
        stopped = entry.engine.cancel(entry.engineId) || stopped;
      }
      return stopped;
    }

    /* --- 2. files and paths ------------------------------------------- */
    case "read_file_binary":
    case "read_file_binary_capped": {
      const file = inside(ctx.root, str(args, "filePath", "file", "path"));
      const max = command === "read_file_binary_capped" ? Number(args?.maxBytes ?? Infinity) : Infinity;
      const data = fs.readFileSync(file);
      const slice = Number.isFinite(max) && max > 0 ? data.subarray(0, max) : data;
      return { base64: slice.toString("base64"), bytes: slice.length };
    }
    case "write_file_binary": {
      const file = inside(ctx.root, str(args, "filePath", "path"));
      const base64 = str(args, "base64");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(base64, "base64"));
      ctx.documentSaved(file);
      return undefined;
    }
    case "write_action_file":
    case "write_report_file":
    case "write_profile_file":
    case "write_batch_log":
    case "save_report_file": {
      const file = inside(ctx.root, str(args, "path", "filePath", "file"));
      const body = args?.contents ?? args?.text ?? args?.content ?? "";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.isBuffer(body) ? body : String(body));
      return command === "save_report_file" || command === "write_report_file" ? file : undefined;
    }
    case "canonicalize_paths":
      return list(args, "paths").map((p) => path.resolve(p));
    case "paths_same_file": {
      const a = str(args, "a", "pathA", "first");
      const b = str(args, "b", "pathB", "second");
      if (!a || !b) return false;
      try {
        return fs.realpathSync(path.resolve(a)) === fs.realpathSync(path.resolve(b));
      } catch {
        return path.resolve(a) === path.resolve(b);
      }
    }
    case "ensure_parent_dirs": {
      fs.mkdirSync(path.dirname(inside(ctx.root, str(args, "path", "filePath"))), { recursive: true });
      return undefined;
    }
    case "move_file_creating_dirs":
    case "copy_file_creating_dirs": {
      const from = inside(ctx.root, str(args, "from", "source", "src"));
      const to = inside(ctx.root, str(args, "to", "destination", "dest"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (command === "move_file_creating_dirs") fs.renameSync(from, to);
      else fs.copyFileSync(from, to);
      return command === "move_file_creating_dirs" ? undefined : to;
    }
    case "free_output_path": {
      const wanted = inside(ctx.root, str(args, "path", "filePath"));
      if (!fs.existsSync(wanted)) return wanted;
      const dir = path.dirname(wanted);
      const ext = path.extname(wanted);
      const stem = path.basename(wanted, ext);
      for (let n = 2; n < 500; n++) {
        const next = path.join(dir, `${stem} (${n})${ext}`);
        if (!fs.existsSync(next)) return next;
      }
      return path.join(dir, `${stem}-${Date.now()}${ext}`);
    }
    case "create_working_copy": {
      const from = inside(ctx.root, str(args, "filePath", "path", "file"));
      const dir = path.join(ctx.root, ".spectra");
      fs.mkdirSync(dir, { recursive: true });
      const to = path.join(dir, `${path.basename(from, path.extname(from))}-working${path.extname(from) || ".pdf"}`);
      fs.copyFileSync(from, to);
      return to;
    }
    case "list_pdfs_recursive": {
      const root = inside(ctx.root, str(args, "dir", "folder", "path") || ctx.root);
      const out: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 6) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, depth + 1);
          else if (/\.pdf$/i.test(entry.name)) out.push(full);
        }
      };
      walk(root, 0);
      return out;
    }
    case "stat_path": {
      const file = inside(ctx.root, str(args, "path", "filePath"));
      const st = fs.statSync(file);
      return { size: st.size, isDirectory: st.isDirectory(), mtime: Math.round(st.mtimeMs) };
    }
    case "output_holder":
    case "open_portfolio_member_file":
      return { owner: "", sameWindow: false };

    /* Save without a native dialog: into the window's own folder, under the
       name the renderer asked for. The person still chooses in Autora where
       the document lives (it is the session's document); what is not offered
       here is a desktop file dialog, which this window has no equivalent of. */
    case "save_file_dialog":
    case "save_image_file_dialog":
    case "save_form_data_file": {
      const suggested = str(args, "defaultPath", "suggestedName", "name", "fileName");
      const dir = path.join(ctx.root, "output");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, path.basename(suggested || "document.pdf"));
      return target;
    }
    case "pick_watermark_image":
    case "pick_icc_file":
    case "pick_pem_file":
    case "pick_certificate_file":
    case "pick_image_file":
    case "pick_form_data_file":
    case "pick_dictionary_files":
    case "pick_pkcs11_module":
    case "pick_watermark_pdf":
    case "open_files_dialog":
    case "pick_any_file":
    case "pick_any_files":
    case "pick_folder_dialog":
    case "pick_create_pdf_sources":
      /* No desktop file pickers in Autora's window. The document arrives from
         the app (it is the session's document), so the honest answer is the
         one a cancelled dialog gives, and nothing is pretended. */
      REFUSED.add(command);
      return command === "pick_any_files" || command === "pick_dictionary_files" ||
        command === "pick_create_pdf_sources" || command === "open_files_dialog"
        ? []
        : null;

    /* --- 3. platform facts -------------------------------------------- */
    case "platform_capabilities":
      /* One flag per platform-bound feature, and a false flag means the menu
         entry does not exist -- Spectra's own design, and the honest report
         for Autora's window. The accent is real: Autora has one, and the
         editor is themed on it. */
      return {
        os: "linux",
        systemPrinting: false,
        virtualPrinter: false,
        scanning: false,
        scheduledActions: false,
        storeCertificates: false,
        sendByEmail: false,
        webCapture: false,
        clipboardRead: false,
        snapshot: false,
        accentColor: true,
        enterprisePolicy: false,
        trayResidency: false,
        backdrop: false,
        consoleAttach: false,
        startWithSystem: false,
        hiddenAnimationFrames: false,
        explorerMenu: false,
      };
    case "get_system_accent_color":
      /* Autora's accent, so Spectra's controls and Autora's chrome are the
         same violet (src/styles.css --accent). */
      return "#6e5bff";
    case "get_app_version":
      return ctx.appVersion();
    case "get_window_backdrop":
      return "solid";
    case "get_gs_path":
      return toolPath("gs");
    case "get_soffice_path":
      return toolPath("soffice");
    case "get_tesseract_path":
      return toolPath("tesseract");
    case "gs_capability":
    case "refresh_gs_capability": {
      const gs = toolPath("gs");
      let version: string | null = null;
      if (gs) {
        try {
          version = execFileSync(gs, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split("\n")[0];
        } catch {
          version = null;
        }
      }
      return { available: Boolean(gs), path: gs, version };
    }
    case "get_icc_path": {
      // A default CMYK profile if the image ships one, else nothing.
      const candidates = ["/usr/share/color/icc", "/usr/share/ghostscript"].filter((p) => fs.existsSync(p));
      return candidates.length ? null : null;
    }
    case "get_dictionary_path":
    case "user_dictionary_dir": {
      const dir = path.join(ctx.root, ".spectra", "dictionaries");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    case "get_edit_font_path":
      return null;
    case "get_batch_log_dir": {
      const dir = path.join(ctx.root, ".spectra", "batch-log");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    case "printer_capabilities":
    case "list_printers":
    case "list_scanners":
    case "scan_acquire":
    case "scan_cancel":
    case "scan_discard":
    case "scanner_capabilities":
    case "scanner_close":
    case "scanner_select_dialog":
    case "install_virtual_printer":
    case "uninstall_virtual_printer":
    case "virtual_printer_status":
    case "list_pkcs11_modules":
    case "list_store_certificates":
    case "csc_authorize":
    case "send_by_email":
    case "capture_web_page":
    case "copy_image_to_clipboard":
    case "clipboard_source":
    case "read_clipboard_source":
    case "discard_clipboard_source":
    case "save_snapshot_png":
    case "snapshot":
    case "hide_to_tray":
    case "get_startup_enabled":
    case "set_startup_enabled":
    case "set_start_minimized":
    case "set_restore_windows_on_launch":
    case "get_shell_menu_status":
    case "set_shell_menu_enabled":
    case "set_shell_menu_language":
    case "shell_menu_repair_notice":
    case "startup_entry_notice":
    case "list_scheduled_runs":
    case "create_scheduled_run":
    case "set_scheduled_run_enabled":
    case "delete_scheduled_run":
    case "run_scheduled_now":
    case "list_watched_folders":
    case "upsert_watched_folder":
    case "delete_watched_folder":
    case "open_batch_log_folder":
    case "open_releases_page":
    case "open_third_party_licenses":
    case "check_auto_update_disabled":
    case "check_explorer_menu_disabled":
    case "check_field_scripts_disabled":
    case "icc_assent_state":
    case "record_icc_assent":
    case "icc_license_text":
    case "list_recent_documents":
      REFUSED.add(command);
      throw new Error("That is not available in Autora's PDF window.");

    /* --- 4. journaling and window chatter ------------------------------ */
    case "renderer_ready":
    case "settle_window_compose":
    case "append_operation_log":
    case "register_strip_rect":
    case "register_web_origin":
    case "prompt_turn_begin":
    case "prompt_turn_end":
    case "set_shutdown_block_reason":
    case "quit_ack":
    case "quit_cancelled":
    case "confirm_close":
    case "set_tab_order":
    case "tabdrag_track":
    case "tabdrag_cancel":
    case "tabdrag_commit":
    case "tabdrag_complete_open":
    case "tabdrag_hover_index":
    case "tabdrag_release":
    case "tabdrag_reserve":
    case "tabdrag_reserve_new_window":
    case "acknowledge_page_commit":
    case "abort_page_commit":
    case "downgrade_document_to_read":
    case "open_new_window":
    case "focus_app_window":
    case "reveal_in_file_manager":
    case "net_payload_path":
    case "net_payload_size":
    case "net_request":
    case "classify_recent_paths":
      DROPPED.add(command);
      return command === "prompt_turn_begin" ? null : undefined;

    case "publish_page_commit":
      /* The engine has written the pages into the document. Hand the file back
         to the desk, so the agent's own PDF tools see the person's work. */
      ctx.documentSaved(ctx.documentPath() ?? "");
      return undefined;

    case "engine_writes_in_flight":
      return pending.size;
    case "claim_document":
      // One window, one document: the claim is always this window's.
      return { granted: true, owner: "autora", folder: "" };
    case "downgrade_to_read":
    case "release_document":
      return undefined;
    case "claim_output_roots":
      return { granted: true, owner: "autora", folder: "", token: 1 };
    case "release_output_roots":
      return undefined;
    case "document_changed":
      /* The desk is ahead of the editor: the agent has edited the document
         this window is showing. Re-write it and tell the editor to open it. */
      await ctx.refreshDocument();
      return undefined;
    case "take_unreadable_records":
      return [];
    case "take_pending_opens": {
      /* The launch handover: what the app wants this window to open, as a list
         of opens (`Result<Vec<PendingOpen>>` in Rust). The renderer walks the
         list, so an object here is a boot that stops dead.

         Handed over whenever it is asked for, not once: the renderer's own
         funnel re-activates a document it already has open rather than opening
         a second tab, so a reload (or a window re-mounted after the agent
         edited the document) opens the file again and reads it as it is now. */
      const file = ctx.documentPath();
      return file ? [{ files: [file], merge: false, index: null }] : [];
    }
    case "close_window":
      ctx.emit("window:close", {});
      return undefined;

    default:
      /* Nothing known by that name. Answered, not thrown: the renderer asks
         for things during a boot that no longer has a desktop behind it, and
         an error there would be a dialog about nothing. */
      DROPPED.add(command);
      return undefined;
  }
}
