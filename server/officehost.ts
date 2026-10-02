/**
 * GenOffice's PowerPoint and Excel editors keep their document in Electron's
 * main process. Here that code runs as a child process under a stand-in for
 * Electron (office/host, built into dist/office/host/<app>.cjs), and the editor
 * page -- in the server's Chromium or in a window's frame -- reaches it the way
 * it would reach Electron: ipcRenderer.invoke becomes `invoke()`, what the code
 * sends to the page (webContents.send) arrives as a push, and a window the code
 * wants to print with is a page in the server's Chromium (`windows`).
 *
 * One host per document being worked on, started on demand and stopped when it
 * has been idle or its owner is done with it.
 */

import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { officeDir } from "./office";

export type HostApp = "slides" | "sheets";

/** What the host asks of whoever runs it: pages to draw in. */
export interface HostWindows {
  /** Handles `win.open|load|eval|pdf|shot|close`; the value goes back to the host. */
  rpc(op: string, payload: any): Promise<unknown>;
}

export type Push = (wc: number, channel: string, args: unknown[]) => void;

const READY_MS = 60_000;
const CALL_MS = 10 * 60_000;

export function hostBuilt(app: HostApp): boolean {
  const dir = officeDir();
  return Boolean(dir && fs.existsSync(path.join(dir, "host", `${app}.cjs`)));
}

export class OfficeHost {
  private child: ChildProcess;
  private nextId = 1;
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pushes = new Set<Push>();
  private ended = false;
  /** Set once the process is gone. */
  readonly exited: Promise<void>;
  private ready: Promise<void>;
  private pageWaiters: Array<(wc: number) => void> = [];
  private pagesSeen: number[] = [];

  private constructor(readonly app: HostApp, private windows: HostWindows | null, env: Record<string, string>) {
    const dir = officeDir();
    if (!dir) throw new Error("the Office tools are not built on this server");
    const script = path.join(dir, "host", `${app}.cjs`);
    if (!fs.existsSync(script)) throw new Error(`the ${app} editor's engine is not built on this server (node scripts/build-office.mjs)`);
    this.child = fork(script, [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "" },
    });
    let stderr = "";
    this.child.stderr?.on("data", (d) => { stderr = (stderr + String(d)).slice(-4000); });
    let onReady!: () => void, onFail!: (e: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { onReady = resolve; onFail = reject; });
    this.exited = new Promise<void>((resolve) => {
      this.child.once("exit", (code) => {
        this.ended = true;
        const err = new Error(`the ${app} engine stopped${code ? ` (exit ${code})` : ""}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
        onFail(err);
        for (const [, c] of this.calls) { clearTimeout(c.timer); c.reject(err); }
        this.calls.clear();
        resolve();
      });
    });
    this.child.on("message", (m: any) => this.onMessage(m, onReady, onFail));
    const t = setTimeout(() => onFail(new Error(`the ${app} engine did not start`)), READY_MS);
    this.ready.finally(() => clearTimeout(t)).catch(() => undefined);
  }

  /** Start the app's main-process code. `env` can point it at the spreadsheet engine and a folder to keep its state in. */
  static async start(app: HostApp, windows: HostWindows | null, env: Record<string, string> = {}): Promise<OfficeHost> {
    const dir = officeDir();
    const sidecar = dir && ["xlsx-sidecar-x64", "xlsx-sidecar-arm64", "xlsx-sidecar"]
      .map((n) => path.join(dir, "native", n))
      .find((p) => fs.existsSync(p) && (path.basename(p) === "xlsx-sidecar" || path.basename(p).endsWith(process.arch === "arm64" ? "arm64" : "x64")));
    const host = new OfficeHost(app, windows, { ...(sidecar ? { XLSX_SIDECAR_PATH: sidecar } : {}), ...env });
    try {
      await host.ready;
    } catch (err) {
      host.stop();
      throw err;
    }
    return host;
  }

  private onMessage(m: any, onReady: () => void, onFail: (e: Error) => void) {
    if (!m || typeof m !== "object") return;
    if (m.t === "ready") onReady();
    else if (m.t === "page") {
      const w = this.pageWaiters.shift();
      if (w) w(m.wc); else this.pagesSeen.push(m.wc);
    } else if (m.t === "failed") onFail(new Error(String(m.error)));
    else if (m.t === "result") {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.ok) c.resolve(m.value); else c.reject(new Error(String(m.error)));
    } else if (m.t === "push") {
      for (const fn of this.pushes) { try { fn(m.wc, m.channel, m.args ?? []); } catch { /* a listener's trouble is its own */ } }
    } else if (m.t === "rpc") {
      void (async () => {
        try {
          if (!this.windows) throw new Error("no window to draw in");
          const value = await this.windows.rpc(m.op, m.payload);
          this.child.send({ t: "rpc-result", id: m.id, ok: true, value: value ?? null });
        } catch (err: any) {
          if (!this.ended) this.child.send({ t: "rpc-result", id: m.id, ok: false, error: String(err?.message ?? err) });
        }
      })();
    }
  }

  /** The next editor page the engine makes for itself (a window or tab): the id the page must use. */
  expectPage(): Promise<number> {
    const seen = this.pagesSeen.shift();
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => this.pageWaiters.push(resolve));
  }

  /** ipcRenderer.invoke from editor page `wc`. */
  invoke(wc: number, channel: string, args: unknown[] = []): Promise<any> {
    if (this.ended) return Promise.reject(new Error(`the ${this.app} engine is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${channel} took too long`)); }, CALL_MS);
      this.calls.set(id, { resolve, reject, timer });
      this.child.send({ t: "invoke", id, wc, channel, args });
    });
  }

  /** ipcRenderer.send. */
  send(wc: number, channel: string, args: unknown[] = []) {
    if (!this.ended) this.child.send({ t: "send", wc, channel, args });
  }

  /** The page `wc` went away. */
  closed(wc: number) {
    if (!this.ended) this.child.send({ t: "closed", wc });
  }

  onPush(fn: Push): () => void {
    this.pushes.add(fn);
    return () => this.pushes.delete(fn);
  }

  stop() {
    this.ended = true;
    try { this.child.kill("SIGKILL"); } catch { /* gone already */ }
  }
}

/**
 * Buffers and typed arrays as the editor's page sends them in JSON (office/shim/common.js):
 * `{ $b: base64, t: "Uint8Array" }`. `wire.dec` turns what a page sent into what the engine
 * expects (Node Buffers), `wire.enc` the other way.
 */
export const wire = {
  dec(v: any): any {
    if (Array.isArray(v)) return v.map((x) => wire.dec(x));
    if (v && typeof v === "object") {
      if (typeof v.$b === "string") return Buffer.from(v.$b, "base64");
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = wire.dec(v[k]);
      return out;
    }
    return v;
  },
  enc(v: any): any {
    if (v instanceof ArrayBuffer) return { $b: Buffer.from(v).toString("base64"), t: "ArrayBuffer" };
    if (ArrayBuffer.isView(v)) return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"), t: v.constructor.name === "Buffer" ? "Uint8Array" : v.constructor.name };
    if (Array.isArray(v)) return v.map((x) => wire.enc(x));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v)) out[k] = wire.enc(v[k]);
      return out;
    }
    return v;
  },
};
