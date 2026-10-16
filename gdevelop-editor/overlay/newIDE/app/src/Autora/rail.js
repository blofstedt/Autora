// @flow
/**
 * The editor's half of Autora's tool bar (src/components/GameWindow.tsx, src/components/game/rail.tsx).
 *
 * The bar is drawn by Autora's window, round and coloured like every other app's, and this is what it
 * drives: each tool is one thing the editor's own toolbar, tabs and menus did, run with the editor's own
 * members (the scene editor's methods, MainFrame's openLayout and the rest, handed over as
 * window.__autoraEditor.rail by patches.mjs). The editor's old toolbar and tab strip are hidden, not
 * removed (autora.css), so nothing the editor could do is lost.
 *
 *   window -> editor   {autoraGameCmd: 'run', id}    press a tool (ids are in `run` below)
 *   editor -> window   {autoraGame: true, rail}      what the tools should look like now (see `stateOf`)
 *                      {autoraGame: true, playing}   a game started or stopped playing in the window
 *
 * The state is read from the editor every few hundred milliseconds and sent only when it changed.
 */
import { canRedo, canUndo } from '../Utils/History';
import newNameGenerator from '../Utils/NewNameGenerator';
import { addDefaultLightToAllLayers } from '../ProjectCreation/CreateProject';
import {
  isPlaying,
  stopPlaying,
} from '../ExportAndShare/BrowserExporters/BrowserPreview/BrowserPreviewWindow';
import { tellAutora } from './session';

type Hands = {
  openLayout: (string, any) => void,
  toggleProjectManager: () => void,
  projectManagerOpen: boolean,
  openResources: () => void,
  openShareDialog: () => void,
  launchNewPreview: () => Promise<void>,
  onSceneAdded: () => void,
  itemModified: () => void,
  activeTab: () => any,
};

const editor = (): any => (window: any).__autoraEditor;
const hands = (): ?Hands => {
  const e = editor();
  return e && e.rail ? e.rail : null;
};

const PANELS = {
  objects: 'objects-list',
  properties: 'properties',
  layers: 'layers-list',
  instances: 'instances-list',
  groups: 'object-groups-list',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The scene editor of a tab, when the tab is one. */
const sceneEditorOf = (tab: any): any =>
  tab && tab.kind === 'layout' && tab.editorRef && tab.editorRef.editor
    ? tab.editorRef.editor
    : null;

/** The scene a tab is for, by name (a scene's editor and its events editor are both "of" it). */
const sceneNameOf = (tab: any): ?string =>
  tab && (tab.kind === 'layout' || tab.kind === 'layout events')
    ? tab.projectItemName
    : null;

const scenesOf = (project: any): Array<string> => {
  const out = [];
  for (let i = 0; i < project.getLayoutsCount(); i++) {
    out.push(project.getLayoutAt(i).getName());
  }
  return out;
};

/** The name of the object the person has picked: an instance on the canvas, else one in the Objects list. */
const pickedObject = (scene: any): ?string => {
  if (!scene) return null;
  const instances = scene.instancesSelection
    ? scene.instancesSelection.getSelectedInstances()
    : [];
  if (instances.length) return instances[0].getObjectName();
  const listed = scene.state && scene.state.selectedObjectFolderOrObjectsWithContext;
  if (listed && listed.length && listed[0].objectFolderOrObject) {
    const item = listed[0].objectFolderOrObject;
    if (item.isFolder && item.isFolder()) return null;
    return item.getObject().getName();
  }
  return null;
};

/** What the tools should look like now: which are lit, which are dimmed, and the scenes to switch to. */
export const stateOf = (): ?{ [string]: any } => {
  const e = editor();
  const h = hands();
  if (!e || !h || !e.project) return null;
  const tab = h.activeTab();
  const scene = sceneEditorOf(tab);
  const name = sceneNameOf(tab);
  const display = scene && scene.editorDisplay;
  const visible = (panel: string): boolean =>
    !!(display && display.isEditorVisible && display.isEditorVisible(panel));
  const settings = scene && scene.state && scene.state.instancesEditorSettings;
  return {
    // Which editor is showing: the scene, its events, or something else (resources, a dialog's page).
    on: tab && tab.kind === 'layout' ? 'scene' : tab && tab.kind === 'layout events' ? 'events' : 'other',
    scene: name || null,
    scenes: scenesOf(e.project),
    playing: isPlaying(),
    mode: settings && settings.gameEditorMode === 'embedded-game' ? '3d' : '2d',
    grid: !!(settings && settings.grid),
    canUndo: scene ? canUndo(scene.state.history) : false,
    canRedo: scene ? canRedo(scene.state.history) : false,
    picked: pickedObject(scene) || null,
    instances: scene ? scene.instancesSelection.getSelectedInstances().length : 0,
    panels: {
      objects: visible(PANELS.objects),
      properties: visible(PANELS.properties),
      layers: visible(PANELS.layers),
      instances: visible(PANELS.instances),
      groups: visible(PANELS.groups),
    },
    projectManager: !!h.projectManagerOpen,
  };
};

/** The scene editor, switching to the scene first when something else is showing. */
const sceneEditor = async (): Promise<any> => {
  const h = hands();
  const e = editor();
  if (!h || !e || !e.project) return null;
  const now = sceneEditorOf(h.activeTab());
  if (now) return now;
  const name = sceneNameOf(h.activeTab()) || scenesOf(e.project)[0];
  if (!name) return null;
  h.openLayout(name, { openEventsEditor: false, openSceneEditor: true, focusWhenOpened: 'scene' });
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const scene = sceneEditorOf(h.activeTab());
    if (scene && scene.editorDisplay) return scene;
  }
  return null;
};

/** A button of the editor's own toolbar, found by what it says (the events sheet has no ids on its buttons). */
const toolbarButton = (words: Array<string>): ?HTMLElement => {
  const all = Array.from(document.querySelectorAll('button, [role="button"]'));
  return (
    all.find(b => {
      const said = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`.toLowerCase();
      return words.some(w => said.includes(w));
    }) || null
  );
};

const addScene = (): ?string => {
  const e = editor();
  const h = hands();
  if (!e || !h || !e.project) return null;
  const project = e.project;
  const name = newNameGenerator('Scene', n => project.hasLayoutNamed(n));
  const layout = project.insertNewLayout(name, project.getLayoutsCount());
  layout.setName(name);
  layout.updateBehaviorsSharedData(project);
  addDefaultLightToAllLayers(layout);
  h.onSceneAdded();
  h.itemModified();
  return name;
};

/** Press a tool. Anything it cannot do right now (nothing picked, no scene) is quietly nothing. */
export const run = async (id: string): Promise<void> => {
  const h = hands();
  const e = editor();
  if (!h || !e || !e.project) return;
  const tab = h.activeTab();
  const name = sceneNameOf(tab);

  if (id === 'play') {
    if (isPlaying()) stopPlaying();
    else await h.launchNewPreview();
    return;
  }
  if (id === 'restart') {
    stopPlaying();
    await h.launchNewPreview();
    return;
  }
  if (id === 'rules') {
    const scene = name || scenesOf(e.project)[0];
    if (!scene) return;
    if (tab && tab.kind === 'layout events') {
      h.openLayout(scene, { openEventsEditor: false, openSceneEditor: true, focusWhenOpened: 'scene' });
    } else {
      h.openLayout(scene, { openEventsEditor: true, openSceneEditor: true, focusWhenOpened: 'events' });
    }
    return;
  }
  if (id.startsWith('scene:')) {
    h.openLayout(id.slice(6), { openEventsEditor: false, openSceneEditor: true, focusWhenOpened: 'scene' });
    return;
  }
  if (id === 'newScene') {
    const made = addScene();
    if (made) h.openLayout(made, { openEventsEditor: false, openSceneEditor: true, focusWhenOpened: 'scene' });
    return;
  }
  if (id === 'pictures') return h.openResources();
  if (id === 'project') return h.toggleProjectManager();
  if (id === 'export') return h.openShareDialog();

  // Undo and redo on the events sheet are its own toolbar's.
  if ((id === 'undo' || id === 'redo') && tab && tab.kind === 'layout events') {
    const b = toolbarButton(id === 'undo' ? ['undo the last'] : ['redo the']);
    if (b) b.click();
    return;
  }

  // Everything else is the scene editor's.
  const scene = await sceneEditor();
  if (!scene) return;
  switch (id) {
    case 'addObject':
      if (scene.editorDisplay) scene.editorDisplay.openNewObjectDialog();
      return;
    case 'objects': return scene.toggleObjectsList();
    case 'properties': return scene.toggleProperties();
    case 'layers': return scene.toggleLayersList();
    case 'instances': return scene.toggleInstancesList();
    case 'groups': return scene.toggleObjectGroupsList();
    case 'abilities': {
      const object = pickedObject(scene);
      if (object) scene.editObjectByName({ objectName: object, initialTab: 'behaviors', shouldSelectTheObject: false });
      return;
    }
    case 'sceneSettings': return scene.openSceneProperties();
    case 'sceneVariables': return scene.openSceneVariables(true);
    case 'mode': {
      const now = scene.state.instancesEditorSettings.gameEditorMode;
      return scene.setGameEditorMode(now === 'embedded-game' ? 'instances-editor' : 'embedded-game');
    }
    case 'grid': return scene.toggleGrid();
    case 'zoomIn': return scene.zoomIn();
    case 'zoomOut': return scene.zoomOut();
    case 'fit': return scene.zoomToFitContent();
    case 'undo': return scene.undo();
    case 'redo': return scene.redo();
    case 'delete': return scene.deleteSelection();
    default:
  }
};

let started = false;

/** Listen for the window's tools, and tell it how they should look. */
export const startAutoraRail = () => {
  if (started) return;
  started = true;
  document.documentElement.classList.add('autora-rail-ui');

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.autoraGameCmd !== 'run' || typeof msg.id !== 'string') return;
    run(msg.id).catch(err => console.warn('[autora rail]', msg.id, err));
  });

  let last = '';
  setInterval(() => {
    let now = null;
    try {
      now = stateOf();
    } catch (err) {
      return;
    }
    if (!now) return;
    const text = JSON.stringify(now);
    if (text === last) return;
    last = text;
    tellAutora({ rail: now });
  }, 400);
};
