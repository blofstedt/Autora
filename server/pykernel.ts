/**
 * The python tool: a data workbench that remembers.
 *
 * `terminal` runs one script and forgets. Analysis is a conversation with the
 * data: load a file, look at it, clean it, look again, plot it. So each chat
 * gets one long-lived Python process -- a kernel -- and every `run` executes in
 * the same namespace: what was loaded or defined in one call is there in the
 * next. The value of a last expression comes back as it would in a notebook
 * (a DataFrame as its first rows and its shape, not a wall of repr), what the
 * code printed comes back, an error comes back as the traceback, and every
 * matplotlib figure that was open is saved and returned as a picture.
 *
 * The kernel talks to this process over a private pipe (fd 3), so nothing the
 * code prints, or any program it starts, can be mistaken for an answer.
 * A run that exceeds its time limit, or is cancelled, kills the kernel: the
 * namespace is lost and the result says so, rather than leaving a wedged
 * process behind. Kernels are not shared between chats and are stopped after
 * half an hour idle.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const KERNEL_PY = String.raw`
import ast, contextlib, io, json, os, sys, traceback

proto = os.fdopen(3, "w", buffering=1)
G = {"__name__": "__main__"}
MAXREPR = 6000

def short(value, limit=MAXREPR):
    try:
        mod = type(value).__module__ or ""
        if mod.startswith("pandas") and hasattr(value, "shape"):
            import pandas as pd
            with pd.option_context("display.width", 200, "display.max_columns", 30, "display.max_rows", 30):
                if hasattr(value, "head") and len(value) > 30:
                    text = repr(value.head(30)) + "\n... %d rows total" % len(value)
                else:
                    text = repr(value)
            text = "%s\n[shape %s]" % (text, tuple(value.shape))
        else:
            text = repr(value)
    except Exception as exc:
        text = "<%s: could not show: %s>" % (type(value).__name__, exc)
    return text if len(text) <= limit else text[:limit] + "... (%d more characters)" % (len(text) - limit)

def describe(value):
    kind = type(value).__name__
    try:
        if hasattr(value, "shape"):
            return "%s %s" % (kind, tuple(value.shape))
        if hasattr(value, "__len__") and not isinstance(value, (str, bytes)):
            return "%s (%d)" % (kind, len(value))
    except Exception:
        pass
    text = repr(value)
    return "%s = %s" % (kind, text if len(text) <= 80 else text[:80] + "...")

def figures(outdir, n):
    if "matplotlib.pyplot" not in sys.modules:
        return []
    plt = sys.modules["matplotlib.pyplot"]
    saved = []
    for num in list(plt.get_fignums()):
        path = os.path.join(outdir, "fig-%d-%d.png" % (n, num))
        try:
            plt.figure(num).savefig(path, dpi=110, bbox_inches="tight")
            saved.append(path)
        except Exception:
            pass
        plt.close(num)
    return saved

def run(code, n, outdir):
    out, err = io.StringIO(), io.StringIO()
    result, error = None, None
    try:
        tree = ast.parse(code, "<cell>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(tree, "<cell>", "exec"), G)
            if last is not None:
                value = eval(compile(last, "<cell>", "eval"), G)
                if value is not None:
                    result = short(value)
                    G["_"] = value
    except SystemExit:
        error = "SystemExit: the code called exit()."
    except BaseException:
        error = traceback.format_exc(limit=6)
    return {"stdout": out.getvalue(), "stderr": err.getvalue(), "result": result, "error": error, "figures": figures(outdir, n)}

for line in sys.stdin:
    try:
        msg = json.loads(line)
        if msg.get("op") == "vars":
            names = sorted(k for k in G if not k.startswith("_") and k != "__name__")
            reply = {"vars": [[k, describe(G[k])] for k in names if not type(G[k]).__name__ == "module" or True]}
        else:
            reply = run(msg.get("code", ""), msg.get("n", 0), msg.get("outdir", "."))
    except BaseException:
        reply = {"error": traceback.format_exc(limit=4)}
    reply["id"] = msg.get("id") if isinstance(msg, dict) else None
    proto.write(json.dumps(reply) + "\n")
    proto.flush()
`;

export interface PyFigure { name: string; png: Buffer }

export interface PyResult {
  ok: boolean;
  summary: string;
  preview?: string;
  figures: PyFigure[];
}

interface Kernel {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, (reply: Record<string, any>) => void>;
  seq: number;
  runs: number;
  outdir: string;
  idle: NodeJS.Timeout | null;
  dead: boolean;
  /** What the process itself wrote to stderr (a crash, an import-time failure). */
  noise: string;
  cwd: string;
}

const kernels = new Map<string, Kernel>();
const IDLE_MS = 30 * 60 * 1000;
const MAX_OUT = 20_000;

let found: string | null | undefined;
/** The interpreter, or null when this host has none. */
export function pythonPath(): string | null {
  if (found !== undefined) return found;
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  found = null;
  for (const name of ["python3", "python"]) {
    for (const d of dirs) {
      try {
        fs.accessSync(path.join(d, name), fs.constants.X_OK);
        found = path.join(d, name);
        return found;
      } catch {
        // next
      }
    }
  }
  return found;
}

function stop(session: string) {
  const k = kernels.get(session);
  if (!k) return;
  kernels.delete(session);
  k.dead = true;
  if (k.idle) clearTimeout(k.idle);
  try { k.child.kill("SIGKILL"); } catch { /* gone */ }
  for (const done of k.pending.values()) done({ error: "The kernel was stopped." });
  k.pending.clear();
  try { fs.rmSync(k.outdir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Stop a chat's kernel (the chat is deleted, or the person asked to start over). */
export function stopKernel(session: string) {
  stop(session);
}

export function stopAllKernels() {
  for (const s of [...kernels.keys()]) stop(s);
}

// A kernel must not outlive the server that started it.
process.once("exit", () => {
  for (const k of kernels.values()) {
    try { k.child.kill("SIGKILL"); } catch { /* gone */ }
  }
});

export function kernelRunning(session: string): boolean {
  return kernels.has(session);
}

function start(session: string, cwd: string): Kernel | string {
  const py = pythonPath();
  if (!py) return "Python is not installed on this host, so there is no kernel to run. Tell the person, or use the terminal if another language will do.";
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-py-"));
  const child = spawn(py, ["-u", "-c", KERNEL_PY], {
    cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MPLBACKEND: "Agg",
      MPLCONFIGDIR: path.join(outdir, "mpl"),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
    },
  }) as ChildProcessWithoutNullStreams;
  const k: Kernel = { child, pending: new Map(), seq: 0, runs: 0, outdir, idle: null, dead: false, noise: "", cwd };
  child.stdout.on("data", () => undefined); // from programs the code started; the answer comes on fd 3
  child.stderr.on("data", (d) => { k.noise = (k.noise + String(d)).slice(-4000); });
  const proto = (child.stdio as any)[3] as NodeJS.ReadableStream;
  readline.createInterface({ input: proto }).on("line", (line) => {
    try {
      const reply = JSON.parse(line);
      const done = k.pending.get(reply.id);
      if (done) { k.pending.delete(reply.id); done(reply); }
    } catch {
      // not ours
    }
  });
  child.on("exit", (code) => {
    if (kernels.get(session) === k) kernels.delete(session);
    k.dead = true;
    for (const done of k.pending.values()) done({ error: `The kernel stopped (exit ${code ?? "?"})${k.noise.trim() ? `: ${k.noise.trim().slice(-600)}` : "."}` });
    k.pending.clear();
  });
  child.on("error", () => undefined);
  kernels.set(session, k);
  return k;
}

function touch(k: Kernel, session: string) {
  if (k.idle) clearTimeout(k.idle);
  k.idle = setTimeout(() => stop(session), IDLE_MS);
  k.idle.unref?.();
}

function ask(k: Kernel, message: Record<string, any>, timeoutMs: number, onStop?: (stop: () => void) => void): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const id = ++k.seq;
    const timer = setTimeout(() => {
      k.pending.delete(id);
      resolve({ timedOut: true });
    }, timeoutMs);
    k.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    onStop?.(() => { clearTimeout(timer); k.pending.delete(id); resolve({ cancelled: true }); });
    try {
      k.child.stdin.write(JSON.stringify({ id, ...message }) + "\n");
    } catch {
      clearTimeout(timer);
      k.pending.delete(id);
      resolve({ error: "The kernel is not accepting code." });
    }
  });
}

const cap = (text: string) => (text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n... (${text.length - MAX_OUT} more characters)` : text);

export interface PyCall {
  session: string;
  cwd: string;
  args: Record<string, any>;
  /** Register something that stops the run when the turn is interrupted. */
  onCancel?: (stop: () => void) => void;
}

export async function runPython(call: PyCall): Promise<PyResult> {
  const { session, cwd, args } = call;
  const action = String(args.action ?? "run").trim().toLowerCase();
  const none = (ok: boolean, summary: string, preview?: string): PyResult => ({ ok, summary, preview, figures: [] });

  if (action === "reset") {
    const had = kernels.has(session);
    stop(session);
    return none(true, had ? "The kernel was stopped; the next run starts with an empty namespace." : "There was no kernel running.", "kernel reset");
  }

  if (action === "vars") {
    const k = kernels.get(session);
    if (!k || k.dead) return none(true, "No kernel is running, so nothing is defined yet.");
    const reply = await ask(k, { op: "vars" }, 10_000);
    if (reply.timedOut || reply.error) return none(false, reply.error ?? "The kernel did not answer.");
    const rows: [string, string][] = reply.vars ?? [];
    return none(true, rows.length ? rows.map(([n, d]) => `${n}: ${d}`).join("\n") : "The namespace is empty.", `${rows.length} names`);
  }

  if (action !== "run") return none(false, "action is run (the default), vars or reset.");
  const code = String(args.code ?? "");
  if (!code.trim()) return none(false, "No code was given.");

  let k = kernels.get(session);
  let fresh = false;
  if (k && (k.dead || k.cwd !== cwd)) {
    // A new working folder starts a new kernel: relative paths would mean something else.
    stop(session);
    k = undefined;
  }
  if (!k) {
    const made = start(session, cwd);
    if (typeof made === "string") return none(false, made);
    k = made;
    fresh = true;
  }
  touch(k, session);

  const seconds = Math.min(600, Math.max(5, Math.round(Number(args.timeout) || 120)));
  const n = ++k.runs;
  const reply = await ask(k, { code, n, outdir: k.outdir }, seconds * 1000, call.onCancel);

  if (reply.timedOut) {
    stop(session);
    return none(false, `The code ran past ${seconds} seconds and was stopped. Because the process had to be killed, the kernel was reset: everything defined so far is gone. Do the slow part in a smaller step, or pass a longer timeout (up to 600).`, "timed out");
  }
  if (reply.cancelled) {
    stop(session);
    return none(false, "Stopped. The kernel was reset, so what was defined earlier is gone.", "stopped");
  }

  const figures: PyFigure[] = [];
  for (const file of (reply.figures ?? []) as string[]) {
    try {
      figures.push({ name: path.basename(file), png: fs.readFileSync(file) });
      fs.rmSync(file, { force: true });
    } catch {
      // gone
    }
  }

  const parts: string[] = [];
  if (fresh) parts.push("(A new kernel started for this chat; it keeps its variables between runs.)");
  if (reply.stdout) parts.push(cap(String(reply.stdout).replace(/\n+$/, "")));
  if (reply.stderr) parts.push(`stderr:\n${cap(String(reply.stderr).replace(/\n+$/, ""))}`);
  if (reply.result) parts.push(`=> ${cap(String(reply.result))}`);
  if (figures.length) parts.push(`${figures.length} figure${figures.length === 1 ? "" : "s"} drawn${figures.length ? " and shown" : ""}.`);
  if (reply.error) {
    parts.push(cap(String(reply.error).trim()));
    return { ok: false, summary: parts.join("\n"), preview: String(reply.error).trim().split("\n").slice(-1)[0], figures };
  }
  if (parts.length === (fresh ? 1 : 0)) parts.push("Done (no output).");
  const first = String(reply.result ?? reply.stdout ?? "").trim().split("\n")[0] ?? "";
  return { ok: true, summary: parts.join("\n"), preview: first.slice(0, 120) || (figures.length ? "figure" : "ran"), figures };
}
