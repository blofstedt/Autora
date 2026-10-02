/*
 * The child process that runs one GenOffice app's main-process code (slides or
 * sheets) with the stand-in for Electron (electron-main.cjs). scripts/build-office.mjs
 * bundles this with that app's real main code into dist/office/host/<app>.cjs.
 *
 * The parent (server/officehost.ts) speaks to it over the fork's IPC channel
 * (advanced serialization, so buffers travel as they are):
 *   -> {t:"invoke", id, wc, channel, args}   an ipcRenderer.invoke from editor page `wc`
 *   -> {t:"send", wc, channel, args}         an ipcRenderer.send
 *   -> {t:"rpc-result", id, ok, value|error} the answer to a window request below
 *   -> {t:"closed", wc}                      the page went away
 *   <- {t:"ready", channels}                 the app's handlers are registered
 *   <- {t:"result", id, ok, value|error}
 *   <- {t:"push", wc, channel, args}         webContents.send
 *   <- {t:"rpc", id, op, payload}            a page to draw in (win.load / eval / pdf / shot / close)
 */
import { setUiLang } from "@genoffice/i18n";
import { register, extra } from "autora:register";


const electron = require("electron") as any;

if (!process.send) throw new Error("this is a child process of Autora's server");
const send = process.send.bind(process);

electron.__runtime.push = (wc: number, channel: string, args: unknown[]) => send({ t: "push", wc, channel, args });
// An editor page the engine expects (a window or view it made): the parent shows that page, under this id.
electron.__runtime.page = (wc: number) => send({ t: "page", wc });

try {
  // The engines name things in the interface language (dialogs, default names of shapes): GenOffice starts in Chinese.
  setUiLang("en");
  register();
  send({ t: "ready", channels: electron.__handlers.size });
} catch (err: any) {
  send({ t: "failed", error: String(err?.stack ?? err) });
  process.exit(1);
}

const page = (wc: number) => electron.__contents.get(wc) ?? electron.__makeContents(wc);

process.on("message", async (m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "invoke") {
    // Autora's own requests to the app's main-process code (see build.mjs for what `extra` holds).
    if (m.channel.startsWith("autora:")) {
      try {
        const fn = (extra as Record<string, (...a: any[]) => unknown>)[m.channel.slice(7)];
        if (!fn) throw new Error(`no such request: ${m.channel}`);
        const value = await fn(...(m.args ?? []));
        send({ t: "result", id: m.id, ok: true, value: value === undefined ? null : value });
      } catch (err: any) {
        send({ t: "result", id: m.id, ok: false, error: String(err?.message ?? err) });
      }
      return;
    }
    const handler = electron.__handlers.get(m.channel);
    // The editor's own AI (settings, providers) and chat projects are not here: Autora's agent is the assistant.
    if (!handler && /^(ai|project):/.test(m.channel)) { send({ t: "result", id: m.id, ok: true, value: null }); return; }
    if (!handler) { send({ t: "result", id: m.id, ok: false, error: `no handler for ${m.channel}` }); return; }
    try {
      const value = await handler({ sender: page(m.wc), senderFrame: {} }, ...(m.args ?? []));
      send({ t: "result", id: m.id, ok: true, value: value === undefined ? null : value });
    } catch (err: any) {
      send({ t: "result", id: m.id, ok: false, error: String(err?.message ?? err) });
    }
  } else if (m.t === "send") {
    for (const fn of electron.__listeners.get(m.channel) ?? []) {
      try { fn({ sender: page(m.wc), senderFrame: {}, returnValue: undefined }, ...(m.args ?? [])); } catch (err) { console.error(m.channel, err); }
    }
  } else if (m.t === "rpc-result") {
    electron.__settleRpc(m.id, m.ok, m.value, m.error);
  } else if (m.t === "closed") {
    const wc = electron.__contents.get(m.wc);
    wc?.emit("destroyed");
    electron.__contents.delete(m.wc);
  }
});

process.on("uncaughtException", (err) => { console.error("uncaught", err); });
process.on("unhandledRejection", (err) => { console.error("unhandled", err); });
process.on("disconnect", () => process.exit(0));
