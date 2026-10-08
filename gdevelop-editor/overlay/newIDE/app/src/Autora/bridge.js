// @flow
/**
 * The editor's wire to Autora's window around it (src/components/GameWindow.tsx), by postMessage:
 *
 *   editor -> window   {ready}            a game is open in the editor
 *   window -> editor   {reload}           the agent changed the game on the server: take it
 *   window -> editor   {theme}            Autora's colours changed: start again with them
 *
 * and, on its own, the saving: the person never presses Save. A change is saved a moment after
 * it is made, to the same place the agent's tools work on.
 *
 * MainFrame hands the editor's hands over as window.__autoraEditor (patches.mjs): open a game,
 * save it, and whether there are changes not saved yet.
 */
import { AUTORA_STORAGE_NAME } from '../ProjectsStorage/AutoraStorageProvider';
import { serializeToJSObject } from '../Utils/Serializer';
import { getAutoraSession, tellAutora, isInAutora } from './session';

/** How long the person must have been still before what they did is saved. */
const QUIET_MS = 1200;
const CHECK_EVERY_MS = 400;

type Editor = {
  open: (any, any) => Promise<void>,
  save: () => Promise<any>,
  hasUnsavedChanges: boolean,
  project: any,
  saving: boolean,
};

const editor = (): ?Editor => (window: any).__autoraEditor;

/** The game as the editor would save it, as text: to tell whether it has changed. */
const snapshot = (project: any): string =>
  JSON.stringify(serializeToJSObject(project));

let started = false;
let reloading = false;
/** The game as it was last opened or saved. */
let baseline: ?string = null;

const reload = async () => {
  const e = editor();
  if (!e || reloading) return;
  reloading = true;
  try {
    await e.open(
      {
        fileMetadata: { fileIdentifier: getAutoraSession() },
        storageProviderName: AUTORA_STORAGE_NAME,
      },
      { ignoreUnsavedChanges: true, ignoreAutoSave: true }
    );
    const now = editor();
    baseline = now && now.project ? snapshot(now.project) : null;
  } finally {
    reloading = false;
  }
};

export const startAutoraBridge = () => {
  if (started || !isInAutora()) return;
  started = true;

  /*
   * When to save. GDevelop says "there are unsaved changes" for most of what a person does but not
   * for all of it (renaming an object, for one, is not counted), and a game must never lose what was
   * done. So: after anything the hands do (a click, a key, a drag, a field), and once they have been
   * still for a moment, the game is compared with what was last saved, and saved if it differs.
   */
  let announced = false;
  let touched = false;
  let lastTouch = 0;
  let busy = false;
  const touch = () => {
    touched = true;
    lastTouch = Date.now();
  };
  for (const type of ['pointerup', 'keyup', 'input', 'change', 'paste', 'cut', 'drop']) {
    window.addEventListener(type, touch, true);
  }

  setInterval(async () => {
    const e = editor();
    if (!e || !e.project || busy || reloading) return;
    if (!announced) {
      announced = true;
      baseline = snapshot(e.project);
      tellAutora({ ready: true });
      return;
    }
    if (!(touched || e.hasUnsavedChanges) || e.saving) return;
    if (Date.now() - lastTouch < QUIET_MS) return;
    busy = true;
    touched = false;
    try {
      const now = snapshot(e.project);
      if (now === baseline && !e.hasUnsavedChanges) return;
      const saved = await e.save();
      if (saved) baseline = now;
    } catch (err) {
      tellAutora({ problem: String((err && err.message) || err) });
    } finally {
      busy = false;
    }
  }, CHECK_EVERY_MS);

  window.addEventListener('autora-game-conflict', () => {
    reload();
  });

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || !msg.autoraGameCmd) return;
    if (msg.autoraGameCmd === 'reload') reload();
    else if (msg.autoraGameCmd === 'theme' && typeof msg.query === 'string') {
      const e = editor();
      const go = () => window.location.replace(`${window.location.pathname}?${msg.query}`);
      if (e && e.project && snapshot(e.project) !== baseline) e.save().then(go, go);
      else go();
    }
  });
};
