/**
 * Spectra's PDF engine, as a process Autora owns.
 *
 * In Spectra the engine is a sidecar the Rust core spawns: a long-lived
 * Python child spoke to in JSON-RPC 2.0 over its own stdin/stdout, one line
 * per message. That is exactly what it is here too — the only thing that
 * changed is who holds the other end of the pipe. Nothing in the engine is
 * patched, so all 221 of its operations behave as they do in Spectra itself.
 *
 * Two processes, as Spectra has them:
 *   - the interactive one, which does the person's work and is kept warm;
 *   - the health one, for inspecting a document that may be hostile. It has a
 *     wall-clock deadline and is killed rather than waited on, so a malformed
 *     file cannot sit in front of the person's own request.
 *
 * They are per document session, so one session's wedged document is not
 * another's problem.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** How long any single engine operation may take before it is given up on.
 *  Generous: OCR of a long scan and a full preflight sweep are both slow, and
 *  the person has asked for them. */
const RUN_MS = Number(process.env.AUTORA_SPECTRA_TIMEOUT_MS ?? 15 * 60 * 1000);

/** The health worker is for hostile input, so its deadline is not generous. */
const HEALTH_MS = Number(process.env.AUTORA_SPECTRA_HEALTH_TIMEOUT_MS ?? 60 * 1000);

/** How much of the engine's own chit-chat is kept for a bug report. */
const STDERR_KEEP = 64 * 1024;

export class EngineProblem extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, message: string, code = -32000) {
    super(message);
    this.name = "EngineProblem";
    this.method = method;
    this.code = code;
  }
}

/** Where the engine lives. Set by the image; the fallbacks are this
 *  workspace's own checkouts, which is how it runs in development. */
function engineRoot(): string | null {
  const fromEnv = process.env.AUTORA_SPECTRA_HOME;
  const candidates = [
    fromEnv,
    "/app/dist/spectra-engine",
    // Where `node scripts/build-spectra.mjs` puts it, for a development
    // checkout run from its own directory (the same arrangement dist/office
    // has for the Office tools).
    path.join(process.cwd(), "dist", "spectra-engine"),
    "/data/work/spectra",
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    // The package directory, not the repo root: `python -m engine` needs the
    // directory that CONTAINS the engine package on the import path.
    if (fs.existsSync(path.join(dir, "src", "engine", "__main__.py"))) return path.resolve(dir);
    if (fs.existsSync(path.join(dir, "engine", "__main__.py"))) return path.resolve(dir, "..");
  }
  return null;
}

function pythonBin(root: string): string | null {
  const candidates = [
    process.env.AUTORA_SPECTRA_PYTHON,
    path.join(root, "venv", "bin", "python"),
    path.join(root, "python", "bin", "python3"),
    "/usr/bin/python3",
  ].filter(Boolean) as string[];
  for (const bin of candidates) if (fs.existsSync(bin)) return bin;
  return null;
}

/** Whether this install can run the engine at all — asked before a window is
 *  offered, so the person is not shown an editor that cannot open a file. */
export function spectraAvailable(): { ok: boolean; reason?: string } {
  const root = engineRoot();
  if (!root) return { ok: false, reason: "The PDF engine is not installed on this server." };
  const bin = pythonBin(root);
  if (!bin) return { ok: false, reason: "The PDF engine has no Python interpreter installed." };
  return { ok: true };
}

/** One JSON-RPC request as it goes on the wire. */
interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class SpectraEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private starting: Promise<void> | null = null;
  private stopping = false;
  /** Whether the engine has told us it is ready (`engine: ready` on stderr). */
  private ready = false;

  constructor(
    private readonly role: "interactive" | "health",
    private readonly onEvent?: (event: string, payload: unknown) => void,
  ) {}

  /** Start the process and wait for it to answer. Idempotent. */
  async start(): Promise<void> {
    if (this.child && this.ready) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const root = engineRoot();
      if (!root) return reject(new EngineProblem("start", "The PDF engine is not installed on this server."));
      const bin = pythonBin(root);
      if (!bin) return reject(new EngineProblem("start", "The PDF engine has no Python interpreter installed."));

      const src = fs.existsSync(path.join(root, "src", "engine", "__main__.py"))
        ? path.join(root, "src")
        : root;

      /* A restricted environment, as the Office engine gets: the engine has
         no business reading this server's secrets, and its own stdout is a
         protocol channel that must not be polluted by a banner. */
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "C.UTF-8",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        PYTHONPATH: src,
        PYTHONUNBUFFERED: "1",
        // The engine reconfigures its own stdio to UTF-8 (and documents why);
        // this is the belt to that pair of braces.
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        // Ghostscript/Tesseract/LibreOffice, when the image has them.
        ...(process.env.AUTORA_SPECTRA_GS ? { SPECTRA_GS_PATH: process.env.AUTORA_SPECTRA_GS } : {}),
        ...(process.env.AUTORA_SPECTRA_TESSERACT ? { SPECTRA_TESSERACT_PATH: process.env.AUTORA_SPECTRA_TESSERACT } : {}),
        ...(process.env.AUTORA_SPECTRA_SOFFICE ? { SPECTRA_SOFFICE_PATH: process.env.AUTORA_SPECTRA_SOFFICE } : {}),
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, ["-m", "engine"], { cwd: path.dirname(src), env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        this.starting = null;
        return reject(new EngineProblem("start", `The PDF engine could not start (${(err as Error).message}).`));
      }
      this.child = child;

      const settle = (fn: () => void) => {
        this.starting = null;
        fn();
      };

      const welcome = setTimeout(() => {
        settle(() => reject(new EngineProblem("start", `The PDF engine did not start within ${HEALTH_MS / 1000} seconds.`)));
      }, HEALTH_MS);

      child.on("error", (e) => {
        clearTimeout(welcome);
        settle(() => reject(new EngineProblem("start", `The PDF engine could not start (${e.message}).`)));
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.read(chunk));

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (this.stderr.length < STDERR_KEEP) this.stderr += chunk;
        /* The engine says this once its registrations are in. It is the only
           signal that a request will be answered rather than queued behind an
           import, so the first request waits on it. */
        if (!this.ready && /engine: ready/.test(this.stderr)) {
          this.ready = true;
          clearTimeout(welcome);
          settle(() => resolve());
        }
      });

      child.on("close", (code) => {
        clearTimeout(welcome);
        this.child = null;
        this.ready = false;
        const why = new EngineProblem("engine", this.diagnosis(code));
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(why);
        }
        this.pending.clear();
        if (!this.starting) return;
        settle(() => reject(why));
      });
    });

    return this.starting;
  }

  /** Why an engine that stopped, stopped. Its own last words beat a code. */
  private diagnosis(code: number | null): string {
    const tail = this.stderr.trim().split("\n").slice(-3).join(" ").trim();
    return tail || `The PDF engine stopped (exit ${code}).`;
  }

  /** One line of the engine's output: exactly one JSON-RPC message. */
  private read(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // Not protocol: keep it, it is the best clue when something is wrong.
        if (this.stderr.length < STDERR_KEEP) this.stderr += `${line}\n`;
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    /* A notification (no id) is the engine reporting something rather than
       answering: progress, a long operation's state. */
    if (message.id === undefined || message.id === null) {
      if (typeof message.method === "string") this.onEvent?.(message.method, message.params);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new EngineProblem(entry.method, String(message.error.message ?? "the engine refused it"), Number(message.error.code ?? -32000)),
      );
      return;
    }
    entry.resolve(message.result);
  }

  /** One operation. Rejects with the engine's own words when it refuses. */
  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child) throw new EngineProblem(method, "The PDF engine is not running.");
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return await new Promise<T>((resolve, reject) => {
      const budget = this.role === "health" ? HEALTH_MS : RUN_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        /* A request that has run out of time is not left running: the engine
           would keep working on a document nobody is waiting for, holding the
           file. The whole child goes, and the next request starts a fresh one. */
        this.kill();
        reject(new EngineProblem(method, `That took longer than ${Math.round(budget / 1000)} seconds and was stopped.`));
      }, budget);
      this.pending.set(id, { method, resolve: resolve as (v: any) => void, reject, timer });
      child.stdin.write(line, (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new EngineProblem(method, `The PDF engine could not be written to (${err.message}).`));
      });
    });
  }

  /** One operation, with the handle needed to stop it by the caller's own id. */
  requestWithId<T = any>(method: string, params: Record<string, any> = {}): { id: number; promise: Promise<T> } {
    /* The id is minted here rather than inside request(), because the caller
       has to be able to name the same request to cancel it. */
    const id = this.nextId++;
    const promise = (async () => {
      await this.start();
      const child = this.child;
      if (!child) throw new EngineProblem(method, "The PDF engine is not running.");
      const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      return await new Promise<T>((resolve, reject) => {
        const budget = this.role === "health" ? HEALTH_MS : RUN_MS;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.kill();
          reject(new EngineProblem(method, `That took longer than ${Math.round(budget / 1000)} seconds and was stopped.`));
        }, budget);
        this.pending.set(id, { method, resolve: resolve as (v: any) => void, reject, timer });
        child.stdin.write(line, (err) => {
          if (!err) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new EngineProblem(method, `The PDF engine could not be written to (${err.message}).`));
        });
      });
    })();
    return { id, promise };
  }

  /** Stop one operation by the id this side issued. The engine still answers
   *  under that id, so the caller's promise settles either way. */
  cancel(id: number): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(new EngineProblem(entry.method, "Stopped."));
    return true;
  }

  /** What the engine has said that is not protocol — its own diagnostics. */
  diagnostics(): string {
    return this.stderr;
  }

  kill(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }

  /** Whether the child is up and has said it is ready. */
  get alive(): boolean {
    return Boolean(this.child) && this.ready;
  }
}
