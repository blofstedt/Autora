/*
 * What GenOffice's main-process code (apps/slides, apps/sheets) expects from
 * Electron, supplied by Autora instead so the same code runs under plain Node
 * as a child process (see entry.ts, server/officehost.ts).
 *
 * The parts that are about windows are not faked, they are routed: a window
 * the code makes (to print a page to PDF, say) is a page in the server's
 * Chromium, reached by an rpc to the parent; what the code sends to a window
 * (webContents.send) is told to the parent, which tells the editor in the
 * frame. Everything cosmetic (menus, the dock, recent documents) does nothing.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const handlers = new Map();
const listeners = new Map();
const noop = () => undefined;
/** Anything not listed answers undefined to everything, and can be called, constructed and chained. */
const inert = (name) => new Proxy(function () {}, {
  get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => name : inert(`${name}.${String(k)}`)),
  apply: () => undefined,
  construct: () => ({}),
});

// ---- to the parent ----
let nextRpc = 1;
const waiting = new Map();
const rt = { push: noop, log: noop, page: noop };
/** Ask the parent to do something only it can (draw a page in Chromium). */
function rpc(op, payload) {
  return new Promise((resolve, reject) => {
    const id = nextRpc++;
    waiting.set(id, { resolve, reject });
    process.send({ t: "rpc", id, op, payload });
  });
}
function settleRpc(id, ok, value, error) {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if (ok) w.resolve(value); else w.reject(new Error(String(error ?? "refused")));
}

// ---- web contents: one per editor page, and one per page the code makes ----
const contents = new Map();
function makeContents(id, extra = {}) {
  const events = new Map();
  const wc = {
    id,
    isDestroyed: () => Boolean(wc.destroyed),
    send: (channel, ...args) => rt.push(id, channel, args),
    on: (e, fn) => { (events.get(e) ?? events.set(e, new Set()).get(e)).add(fn); return wc; },
    once: (e, fn) => { const g = (...a) => { events.get(e)?.delete(g); fn(...a); }; return wc.on(e, g); },
    off: (e, fn) => { events.get(e)?.delete(fn); return wc; },
    removeListener: (e, fn) => { events.get(e)?.delete(fn); return wc; },
    emit: (e, ...a) => { for (const fn of [...(events.get(e) ?? [])]) fn(...a); },
    getURL: () => "",
    getTitle: () => "",
    setWindowOpenHandler: noop,
    setZoomFactor: noop,
    setBackgroundThrottling: noop,
    isLoading: () => false,
    session: inert("session"),
    ...extra,
  };
  contents.set(id, wc);
  return wc;
}

// ---- windows: Chromium pages in the parent ----
let nextWin = 1000;
class BrowserWindow {
  constructor(options = {}) {
    this.id = nextWin++;
    this.options = options;
    this.destroyedFlag = false;
    const id = this.id;
    this.webContents = makeContents(this.id, {
      loadFile: (file) => rpc("win.load", { win: id, file }),
      loadURL: (url) => rpc("win.load", { win: id, url }),
      executeJavaScript: (script) => rpc("win.eval", { win: id, script }),
      printToPDF: async (opts) => Buffer.from(await rpc("win.pdf", { win: id, options: opts })),
      capturePage: async () => nativeImage.createFromBuffer(Buffer.from(await rpc("win.shot", { win: id }))),
    });
    // A window made with the app's preload is an editor page: the parent shows that page itself, under this id.
    this.editor = Boolean(options.webPreferences && options.webPreferences.preload);
    if (this.editor) {
      this.webContents.loadURL = async () => undefined;
      this.webContents.loadFile = async () => undefined;
      rt.page(this.id);
    }
  }
  loadFile(file) { return this.webContents.loadFile(file); }
  loadURL(url) { return this.webContents.loadURL(url); }
  static getAllWindows() { return []; }
  static getFocusedWindow() { return null; }
  static fromWebContents() { return null; }
  static fromId() { return null; }
  isDestroyed() { return this.destroyedFlag; }
  destroy() { this.destroyedFlag = true; this.webContents.destroyed = true; contents.delete(this.id); rpc("win.close", { win: this.id }).catch(noop); }
  close() { this.destroy(); }
  show() {} hide() {} focus() {} setBounds() {} setSize() {} setTitle() {} setMenu() {} setMenuBarVisibility() {}
  isVisible() { return false; } isMinimized() { return false; } isMaximized() { return false; } isFullScreen() { return false; }
  getBounds() { return { x: 0, y: 0, width: this.options.width || 1280, height: this.options.height || 800 }; }
  on() { return this; } once() { return this; } off() { return this; }
  setRepresentedFilename() {} setDocumentEdited() {}
}

// ---- pictures: sizes are read from the file's own header ----
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.length > 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
  }
  return null;
}
function image(buf) {
  const size = buf && buf.length ? imageSize(buf) : null;
  const isPng = size && buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47;
  return {
    isEmpty: () => !size,
    getSize: () => size || { width: 0, height: 0 },
    toPNG: () => (isPng ? buf : Buffer.alloc(0)),
    toJPEG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
    toDataURL: () => (isPng ? `data:image/png;base64,${buf.toString("base64")}` : ""),
    resize: () => image(buf),
    crop: () => image(buf),
    getAspectRatio: () => (size ? size.width / size.height : 1),
  };
}
const nativeImage = {
  createFromBuffer: (b) => image(Buffer.from(b)),
  createFromPath: (p) => { try { return image(fs.readFileSync(p)); } catch { return image(null); } },
  createEmpty: () => image(null),
  createThumbnailFromPath: async () => image(null),
  createFromDataURL: (u) => image(Buffer.from(String(u).split(",")[1] || "", "base64")),
};

// ---- the rest ----
const home = () => process.env.AUTORA_OFFICE_HOME || path.join(require("node:os").tmpdir(), "autora-office-host");
const dirs = { temp: () => require("node:os").tmpdir(), userData: home, appData: home, documents: home, downloads: home, desktop: home, home: home, logs: home, cache: home };
const app = {
  getPath: (name) => { const d = (dirs[name] ?? home)(); try { fs.mkdirSync(d, { recursive: true }); } catch { /* read-only */ } return d; },
  setPath: noop,
  isPackaged: true,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: noop, once: noop, off: noop, removeListener: noop, emit: noop,
  quit: noop, exit: noop, focus: noop,
  getVersion: () => "0.0.0",
  getName: () => "autora-office",
  getLocale: () => "en-US", getSystemLocale: () => "en-US", getPreferredSystemLanguages: () => ["en-US"],
  getAppPath: () => process.cwd(),
  getGPUFeatureStatus: () => ({}),
  commandLine: { appendSwitch: noop, hasSwitch: () => false },
  requestSingleInstanceLock: () => true,
  setAppUserModelId: noop, addRecentDocument: noop, setBadgeCount: noop, dock: inert("dock"),
};
const ipcMain = {
  handle: (c, f) => { handlers.set(c, f); },
  handleOnce: (c, f) => { handlers.set(c, f); },
  on: (c, f) => { (listeners.get(c) ?? listeners.set(c, new Set()).get(c)).add(f); },
  once: (c, f) => { (listeners.get(c) ?? listeners.set(c, new Set()).get(c)).add(f); },
  off: (c, f) => { listeners.get(c)?.delete(f); },
  removeListener: (c, f) => { listeners.get(c)?.delete(f); },
  removeHandler: (c) => { handlers.delete(c); },
  removeAllListeners: (c) => { listeners.delete(c); },
};
const dialog = {
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
  showErrorBox: noop,
};
const clipboardData = { text: "", buffers: new Map() };
const clipboard = {
  readText: () => clipboardData.text, writeText: (t) => { clipboardData.text = String(t); },
  readBuffer: (f) => clipboardData.buffers.get(f) ?? Buffer.alloc(0), writeBuffer: (f, b) => { clipboardData.buffers.set(f, Buffer.from(b)); },
  availableFormats: () => [...clipboardData.buffers.keys()], write: noop, clear: noop, readImage: () => image(null), readHTML: () => "",
};
const shell = { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: noop, trashItem: async () => undefined, beep: noop };

module.exports = {
  app, ipcMain, BrowserWindow, dialog, clipboard, shell, nativeImage,
  webContents: { fromId: (id) => contents.get(id) ?? null, getAllWebContents: () => [...contents.values()], getFocusedWebContents: () => null },
  screen: { getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), getAllDisplays: () => [], getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }), on: noop },
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({ popup: noop }), getApplicationMenu: () => null },
  MenuItem: class {}, Tray: class {}, Notification: class { show() {} static isSupported() { return false; } },
  WebContentsView: class { constructor() { this.id = nextWin++; this.webContents = makeContents(this.id, { loadURL: async () => undefined, loadFile: async () => undefined }); rt.page(this.id); } setBounds() {} },
  BaseWindow: class {}, MessageChannelMain: class {},
  nativeTheme: { shouldUseDarkColors: true, themeSource: "dark", on: noop },
  systemPreferences: inert("systemPreferences"),
  powerMonitor: { on: noop }, powerSaveBlocker: { start: () => 0, stop: noop },
  protocol: { handle: noop, registerSchemesAsPrivileged: noop, registerFileProtocol: noop },
  net: { fetch: (...a) => fetch(...a), request: inert("net.request") },
  session: { defaultSession: inert("defaultSession"), fromPartition: () => inert("session") },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => Buffer.from(b).toString() },
  desktopCapturer: inert("desktopCapturer"), globalShortcut: inert("globalShortcut"), crashReporter: inert("crashReporter"), autoUpdater: inert("autoUpdater"),
  // The entry point's side of the wiring.
  __handlers: handlers, __listeners: listeners, __contents: contents, __makeContents: makeContents, __runtime: rt, __settleRpc: settleRpc, __rpc: rpc,
};
