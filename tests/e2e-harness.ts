/**
 * A whole Autora, for tests that need the parts to work together.
 *
 * The real server in a child process on its own data directory and port, a
 * fake model on another -- an OpenAI-compatible endpoint whose replies the
 * test writes out -- and helpers to talk to it the way the page does: HTTP for
 * the routes, the event log for what happened. Nothing here is mocked inside
 * the app, so what passes is what a person would get.
 *
 * Not a test file (no `.test.ts`), so the runner leaves it alone.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface Scripted {
  text?: string;
  tools?: { name: string; args?: Record<string, unknown> }[];
  /** Stream slowly, so a turn can be interrupted part-way. */
  slow?: boolean;
  /** Answer with an HTTP error instead. */
  status?: number;
  error?: string;
}

export interface Seen {
  system: string;
  messages: { role: string; content: any; tool_call_id?: string; tool_calls?: any[] }[];
  tools: string[];
  last: string;
}

export interface Ev {
  seq: number; kind: string; actor: string; span: string | null; payload: Record<string, any>; blob: string | null;
}

const free = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface App {
  base: string;
  home: string;
  /** What the model was asked, in order. */
  seen: Seen[];
  /** What the model will answer next; or a function to decide per request. */
  script: Scripted[];
  decide: ((req: Seen) => Scripted | null) | null;
  api(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }>;
  newSession(title?: string, mode?: string): Promise<string>;
  say(session: string, text: string): Promise<void>;
  events(session: string): Promise<Ev[]>;
  until(session: string, pred: (events: Ev[]) => boolean, what: string, ms?: number): Promise<Ev[]>;
  /** Say something and wait for the turn to end. */
  turn(session: string, text: string, ms?: number): Promise<Ev[]>;
  stop(): Promise<void>;
  /** Stop the server and start it again on the same data. */
  restart(): Promise<void>;
  log(): string;
}

const LOCAL_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export async function startApp(opts: { env?: Record<string, string> } = {}): Promise<App> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-e2e-"));
  const seen: Seen[] = [];
  const app: App = {
    base: "", home, seen, script: [], decide: null,
    api: async () => ({ status: 0, body: null }),
    newSession: async () => "", say: async () => undefined, events: async () => [],
    until: async () => [], turn: async () => [], stop: async () => undefined, restart: async () => undefined, log: () => "",
  };

  // ---- the fake model
  const llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method === "GET") { res.setHeader("content-type", "application/json"); return void res.end(JSON.stringify({ data: [{ id: "fake-1" }] })); }
      let body: any = {};
      try { body = JSON.parse(raw); } catch { /* not json */ }
      const messages: Seen["messages"] = body.messages ?? [];
      const sys = messages.find((m) => m.role === "system");
      const lastUser = [...messages].reverse().find((m) => m.role === "user" || m.role === "tool");
      const asText = (c: any) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "";
      const view: Seen = {
        system: asText(sys?.content), messages, tools: (body.tools ?? []).map((t: any) => t.function?.name),
        last: asText(lastUser?.content),
      };
      seen.push(view);
      const reply = (app.decide?.(view)) ?? app.script.shift() ?? { text: "ok" };
      if (reply.status) {
        res.statusCode = reply.status;
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ error: { message: reply.error ?? "fake failure" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const chunks: unknown[] = [];
      const words = (reply.text ?? "").match(/\S+\s*/g) ?? [];
      for (const w of words) chunks.push({ choices: [{ delta: { content: w } }] });
      (reply.tools ?? []).forEach((t, i) => {
        chunks.push({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${seen.length}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }] } }] });
      });
      chunks.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
      chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
      let i = 0;
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        if (i >= chunks.length) { res.write("data: [DONE]\n\n"); return void res.end(); }
        send(chunks[i++]);
        setTimeout(pump, reply.slow ? 150 : 0);
      };
      pump();
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  const llmPort = (llm.address() as net.AddressInfo).port;

  // ---- the app
  const port = await free();
  let output = "";
  const boot = (): ChildProcess => {
    const c = spawn(path.resolve("node_modules/.bin/tsx"), ["server.ts"], {
      env: {
        ...process.env,
        AUTORA_HOME: home, AUTORA_PORT: String(port), AUTORA_HOST: "127.0.0.1", AUTORA_TLS: "0",
        AUTORA_WORKDIR: home,
        // This sandbox's Chromium when it is here; elsewhere (CI) the server
        // finds the system's own. Naming a path that does not exist left the
        // server with no browser at all, so widgets went unchecked on CI.
        ...(fs.existsSync(LOCAL_CHROME) && !process.env.AUTORA_BROWSER_PATH ? { AUTORA_BROWSER_PATH: LOCAL_CHROME } : {}),
        NODE_ENV: "development", ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.stdout?.on("data", (d) => { output += d; });
    c.stderr?.on("data", (d) => { output += d; });
    return c;
  };
  let child = boot();
  app.base = `http://127.0.0.1:${port}`;
  app.log = () => output;
  const ready = async () => {
    const end = Date.now() + 40_000;
    for (;;) {
      try { if ((await fetch(app.base + "/api/settings")).ok) return; } catch { /* not yet */ }
      if (Date.now() > end) { child.kill(); throw new Error(`the app did not start:\n${output}`); }
      await sleep(150);
    }
  };
  const down = async () => {
    child.kill("SIGTERM");
    await new Promise((r) => { child.on("exit", r); setTimeout(r, 4000); });
  };

  app.api = async (method, url, body) => {
    const res = await fetch(app.base + url, {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: parsed };
  };
  /* A chat here starts in Build, so a test that drives a tool is not turned
     back at the door by Agent's planning; the tests of Agent say so. */
  app.newSession = async (title = "Test", mode = "build") => {
    const id = (await app.api("POST", "/api/sessions", { title })).body.id;
    if (mode !== "agent") await app.api("PATCH", `/api/sessions/${id}`, { mode });
    return id;
  };
  app.say = async (session, text) => {
    const r = await app.api("POST", `/api/sessions/${session}/message`, { text });
    if (r.status >= 300) throw new Error(`message refused: ${r.status} ${JSON.stringify(r.body)}`);
  };
  app.events = async (session) => (await app.api("GET", `/api/sessions/${session}/events`)).body as Ev[];
  app.until = async (session, pred, what, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const events = await app.events(session);
      if (Array.isArray(events) && pred(events)) return events;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${(Array.isArray(events) ? events : []).slice(-8).map((e) => `  ${e.seq} ${e.kind} ${JSON.stringify(e.payload).slice(0, 100)}`).join("\n")}\n--- server ---\n${output.split("\n").slice(-15).join("\n")}`);
      await sleep(60);
    }
  };
  app.turn = async (session, text, ms = 25_000) => {
    const before = (await app.events(session)).filter((e) => e.kind === "turn.agent.done").length;
    await app.say(session, text);
    return app.until(session, (ev) => ev.filter((e) => e.kind === "turn.agent.done").length > before, `the turn for "${text}" to end`, ms);
  };
  app.stop = async () => {
    await down();
    llm.close();
    fs.rmSync(home, { recursive: true, force: true });
  };
  app.restart = async () => {
    await down();
    child = boot();
    await ready();
  };

  await ready();
  const set = await app.api("PATCH", "/api/settings", {
    provider: "local", models: { local: "fake-1" }, base_urls: { local: `http://127.0.0.1:${llmPort}/v1` },
  });
  // The look back after a turn is its own model call and would take a scripted reply.
  await app.api("PATCH", "/api/memory-settings", { learning: false });
  if (set.status >= 300) throw new Error(`could not point the app at the fake model: ${JSON.stringify(set.body)}`);
  return app;
}
