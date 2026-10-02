/*
 * The `electron` a GenOffice preload script imports, for a page that is not in
 * Electron: ipcRenderer is the host's ipc (common.js), contextBridge puts the
 * API on window as Electron would. The real preload is bundled over this, so
 * every channel the editor knows works without being listed here.
 */
const ipc = () => window.__autora.ipc;
const listeners = new Map();

export const ipcRenderer = {
  invoke: (channel, ...args) => ipc().invoke(channel, ...args),
  send: (channel, ...args) => ipc().send(channel, ...args),
  sendSync: () => undefined,
  on(channel, fn) {
    const off = ipc().on(channel, fn);
    (listeners.get(channel) ?? listeners.set(channel, new Map()).get(channel)).set(fn, off);
    return ipcRenderer;
  },
  once(channel, fn) {
    const wrapped = (...a) => { ipcRenderer.removeListener(channel, wrapped); fn(...a); };
    return ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel, fn) {
    const off = listeners.get(channel)?.get(fn);
    if (off) { off(); listeners.get(channel).delete(fn); }
    return ipcRenderer;
  },
  removeAllListeners(channel) {
    for (const off of listeners.get(channel)?.values() ?? []) off();
    listeners.delete(channel);
    return ipcRenderer;
  },
};
ipcRenderer.off = ipcRenderer.removeListener;

export const contextBridge = {
  exposeInMainWorld(name, api) { window[name] = api; },
};

export const webUtils = { getPathForFile: () => "" };
export const clipboard = { readText: () => "", writeText: () => undefined };
export default { ipcRenderer, contextBridge, webUtils, clipboard };
