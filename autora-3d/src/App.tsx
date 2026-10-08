/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BevelStyle,
  Body3D,
  EdgeSel,
  FaceSel,
  Point2D,
  DrawForm,
  Frame,
  DrawSession,
  RepeatLink,
  RepeatSession,
  ShapeGroup,
  SWATCHES,
  LibraryItem,
} from './types';
import ModelViewer3D, { ViewerApi } from './components/ModelViewer3D';
import { installBridge } from './core/bridge';
import { embedded, useAutoraEmbed } from './embed';
import type { AgentHost } from './core/agent';
import Sidebar from './components/Sidebar';
import BottomBar from './components/BottomBar';
import TopBar from './components/TopBar';
import ConfirmDeleteModal from './components/ConfirmDeleteModal';
import { useHistory } from './hooks/useHistory';
import { defaultSession } from './utils/repeat';
import { thumbnailUrl } from './utils/thumbnail';
import { loadShared, mergeShared, saveShared, SHARED_KEY } from './utils/sharedLibrary';
import { groupOfSelection, pickInGroups, withGroupMates } from './utils/groups';
import { Doc, IdGen, emptyDoc, parseDoc, settle, starterDoc } from './core/doc';
import { AgentError } from './core/errors';
import * as ops from './core/ops';
import { DrawnOutline, drawnBody, shapeOutline } from './utils/draw';
import { outwardNormal, wallEnds, withOutline } from './utils/outline';
import { wallFrame } from './utils/frame';
import { extrudeFace, setFaceMeasure } from './utils/faces';
import { ShapeKind } from './utils/primitives';
import { applyEdgeChange, edgeKey } from './utils/edges';
import { BodyTransform, resizeBody, selectionBounds } from './utils/transform';
import {
  Box,
  EyeOff,
  Focus,
  Info,
  Trash2,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Redo2,
  Rotate3d,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';

const STORAGE_KEY = 'craft3d:document:v3';

const loadInitialDoc = (): Doc => {
  // Inside Autora the model lives on its server and comes down once the frame is up (see embed.ts).
  if (embedded()) return emptyDoc();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? parseDoc(JSON.parse(raw)) : null;
    if (parsed) return parsed;
  } catch {
    // storage unavailable or corrupt: fall through to the starter scene
  }
  return starterDoc();
};

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
};

export default function App() {
  const [doc, setDocState] = useState<Doc>(loadInitialDoc);
  const { bodies, groups, repeats, library } = doc;
  /** The newest document, updated the moment a change is made (state lags a render behind; agents send changes back to back). */
  const docRef = useRef(doc);
  const revRef = useRef(0);
  const trackRef = useRef<((d: Doc) => void) | null>(null);
  const listeners = useRef(new Set<(doc: Doc, revision: number) => void>());
  const setDocRaw = useCallback((next: Doc) => {
    if (next === docRef.current) return;
    docRef.current = next;
    revRef.current++;
    trackRef.current?.(next);
    setDocState(next);
    listeners.current.forEach((fn) => fn(next, revRef.current));
  }, []);

  /** Every document change goes through here so repeat copies never fall out of step with their source. */
  const setDoc = useCallback(
    (update: Partial<Doc> | ((d: Doc) => Partial<Doc>)) => {
      const d = docRef.current;
      setDocRaw(settle({ ...d, ...(typeof update === 'function' ? update(d) : update) }));
    },
    [setDocRaw]
  );

  /** Ids for new shapes made by the person at the screen. */
  const uiIds = useRef<IdGen>((kind) => `${kind}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`);

  /** Runs a shared document operation (the same ones an agent calls) and shows its refusal, if any, to the person. */
  const runOp = <T,>(fn: (d: Doc, ids: IdGen) => ops.OpResult<T>): T | null => {
    try {
      const out = fn(docRef.current, uiIds.current);
      if (out.doc !== docRef.current) setDocRaw(settle(out.doc));
      return out.result;
    } catch (e) {
      if (e instanceof AgentError) {
        notify(e.hint ? `${e.message} ${e.hint}` : e.message);
        return null;
      }
      throw e;
    }
  };

  const setBodies = useCallback(
    (update: Body3D[] | ((prev: Body3D[]) => Body3D[])) =>
      setDoc((d) => ({ ...d, bodies: typeof update === 'function' ? update(d.bodies) : update })),
    []
  );
  const setGroups = useCallback(
    (update: ShapeGroup[] | ((prev: ShapeGroup[]) => ShapeGroup[])) =>
      setDoc((d) => ({ ...d, groups: typeof update === 'function' ? update(d.groups) : update })),
    []
  );

  const history = useHistory(doc, setDocRaw);
  trackRef.current = history.track;

  // Autosave (not inside Autora: its server keeps the model)
  useEffect(() => {
    if (embedded()) return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
      } catch {
        // storage full or blocked: not fatal
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [doc]);

  // The app-wide library: objects kept in this browser for every project. A shared project object and its twin here stay equal.
  const [sharedItems, setSharedItems] = useState<LibraryItem[]>(() => loadShared());
  useEffect(() => {
    const stored = loadShared();
    const merged = mergeShared(docRef.current.library, stored);
    if (merged.shared !== stored) saveShared(merged.shared);
    setSharedItems(merged.shared);
    if (merged.project !== docRef.current.library) setDoc({ library: merged.project });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.library]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SHARED_KEY) return;
      const merged = mergeShared(docRef.current.library, loadShared());
      setSharedItems(merged.shared);
      if (merged.project !== docRef.current.library) setDoc({ library: merged.project });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const [selectedBodyId, setSelectedBodyId] = useState<string | null>(null);
  const [selectedBodyIds, setSelectedBodyIds] = useState<string[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<EdgeSel[]>([]);
  const [selectedFace, setSelectedFace] = useState<FaceSel | null>(null);
  /** When set, only these bodies are shown, in both 2D and 3D. */
  const [isolatedIds, setIsolatedIds] = useState<string[] | null>(null);
  const [hint, setHint] = useState('');
  /** Which bar menu is open (one at a time). */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  /** The X / Y / Z move arrows, toggled with a two-finger tap. */
  const [moveOn, setMoveOn] = useState(false);

  /** Shapes waiting on the "Delete?" confirmation. */
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);
  /** The open Repeat: ghost copies stay editable on the shape until it is finished or cancelled. */
  const [repeat, setRepeat] = useState<RepeatSession | null>(null);

  // Toasts
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const bodyCounter = useRef(bodies.length);

  /** The open Draw: a sketch on the ground or on the top of a shape, until it becomes a shape or is dropped. */
  const [draw, setDraw] = useState<DrawSession | null>(null);

  /** See-through mode: shapes turn glassy so what is inside another shape can be picked. */
  const [xray, setXray] = useState(false);

  const editingRepeatOf = repeat?.bodyId ?? null;

  // Isolation hides the rest of the scene from the viewport.
  const displayBodies = useMemo(
    () => {
      // Isolating a shape keeps its live copies; while its repeat is being edited, ghosts stand in for them.
      const shown = isolatedIds ? bodies.filter((b) => isolatedIds.includes(b.id) || (!!b.repeatOf && isolatedIds.includes(b.repeatOf))) : bodies;
      return editingRepeatOf ? shown.filter((b) => b.repeatOf !== editingRepeatOf) : shown;
    },
    [bodies, isolatedIds, editingRepeatOf]
  );

  // A repeat can't outlive the shape it copies (deleted or undone away).
  useEffect(() => {
    if (repeat && !bodies.some((b) => b.id === repeat.bodyId)) setRepeat(null);
  }, [bodies, repeat]);

  // Drop selections and isolation that no longer exist (after delete / undo).
  useEffect(() => {
    const ids = new Set(bodies.map((b) => b.id));
    setSelectedBodyIds((prev) => (prev.every((id) => ids.has(id)) ? prev : prev.filter((id) => ids.has(id))));
    setSelectedBodyId((prev) => (prev && !ids.has(prev) ? null : prev));
    setSelectedEdges((prev) => (prev.every((e) => ids.has(e.bodyId)) ? prev : prev.filter((e) => ids.has(e.bodyId))));
    setSelectedFace((prev) => (prev && !ids.has(prev.bodyId) ? null : prev));
    setIsolatedIds((prev) => {
      if (!prev) return prev;
      const alive = prev.filter((id) => ids.has(id));
      return alive.length === prev.length ? prev : alive.length ? alive : null;
    });
  }, [bodies]);

  const selectedBody = displayBodies.find((b) => b.id === selectedBodyId) || null;
  const selectedBodies = selectedBodyIds.map((id) => displayBodies.find((b) => b.id === id)).filter((b): b is Body3D => !!b);

  const selectOnly = (id: string | null) => {
    setSelectedBodyId(id);
    setSelectedBodyIds(id ? [id] : []);
    setSelectedEdges([]);
    setSelectedFace(null);
  };

  /** Selects several shapes at once (e.g. every piece of a joined shape). */
  const selectMany = (ids: string[]) => {
    setSelectedBodyId(ids[0] ?? null);
    setSelectedBodyIds(ids);
    setSelectedEdges([]);
    setSelectedFace(null);
  };

  // ---- Agent access ---------------------------------------------------------
  // The same tools the headless engine has, run on the live document so the person sees every change as it lands.
  const viewerApi = useRef<ViewerApi | null>(null);
  const hostRef = useRef<AgentHost>(null!);
  hostRef.current = {
    getDoc: () => docRef.current,
    // Each agent change is its own undo step, apart from whatever the person was doing a moment before.
    setDoc: (d) => {
      history.commit();
      setDocRaw(settle(d));
      history.commit();
    },
    newIds: () => uiIds.current,
    undo: () => history.undo(),
    redo: () => history.redo(),
    revision: () => revRef.current,
    ui: async (name, args) => {
      const api = viewerApi.current;
      if (name === 'ui_select') {
        const ids = (Array.isArray(args.ids) ? args.ids : []) as string[];
        const found = docRef.current.bodies.filter((b) => ids.includes(b.id) && !b.repeatOf);
        if (!found.length) throw new AgentError('None of those ids exist.', 'Call scene_get to list shapes.');
        const mates = found.flatMap((b) => withGroupMates(docRef.current.groups, docRef.current.bodies, b.id));
        selectMany([...new Set(mates)]);
        return { selected: [...new Set(mates)] };
      }
      if (name === 'ui_view') {
        if (!api) throw new AgentError('The 3D view is not ready yet.');
        api.view(args.view);
        return { view: args.view };
      }
      if (name === 'ui_xray') {
        setXray(!!args.on);
        return { xray: !!args.on };
      }
      if (name === 'ui_screenshot') {
        if (!api) throw new AgentError('The 3D view is not ready yet.');
        return { mime: 'image/png', dataUrl: api.screenshot() };
      }
      throw new AgentError(`Unknown screen command "${name}".`);
    },
  };
  useEffect(() => {
    const host: AgentHost = {
      getDoc: () => hostRef.current.getDoc(),
      setDoc: (d) => hostRef.current.setDoc(d),
      newIds: () => hostRef.current.newIds(),
      undo: () => hostRef.current.undo(),
      redo: () => hostRef.current.redo(),
      revision: () => hostRef.current.revision(),
      ui: (name, args) => hostRef.current.ui!(name, args),
    };
    const subscribe = (fn: (doc: Doc, revision: number) => void) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    };
    const origins = String(import.meta.env.VITE_CRAFT3D_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    return installBridge(host, subscribe, origins);
  }, []);

  // Inside Autora: take the agent's changes, send the person's.
  useAutoraEmbed(doc, (d) => hostRef.current.setDoc(d));

  // ---- Selection ----------------------------------------------------------
  const handleSelectBody = (id: string | null, isMultiSelect?: boolean) => {
    if (id === null) {
      selectOnly(null);
      return;
    }
    // Clicking a member of a group picks the whole group.
    // Tapping it again steps one group deeper, down to the shape itself.
    const picked = pickInGroups(bodies, groups, id, selectedBodyIds);
    const members = isMultiSelect ? withGroupMates(groups, bodies, id) : picked.ids;

    if (!isMultiSelect) {
      setSelectedBodyId(id);
      setSelectedBodyIds(members);
      setSelectedEdges((prev) => (prev.length && prev[0].bodyId !== id ? [] : prev));
      setSelectedFace((prev) => (prev && prev.bodyId !== id ? null : prev));
      return;
    }
    setSelectedEdges([]);
    setSelectedFace(null);
    if (selectedBodyIds.includes(id)) {
      const next = selectedBodyIds.filter((item) => !members.includes(item));
      setSelectedBodyIds(next);
      setSelectedBodyId(next.length > 0 ? next[next.length - 1] : null);
    } else {
      setSelectedBodyIds([...new Set([...selectedBodyIds, ...members])]);
      setSelectedBodyId(id);
    }
  };

  // ---- Body operations ----------------------------------------------------
  const handleUpdateBody = useCallback(
    (id: string, updates: Partial<Body3D>) => {
      setBodies((prev) => prev.map((body) => (body.id === id ? { ...body, ...updates } : body)));
    },
    [setBodies]
  );

  /** Rigid move/rotate of several bodies in one update. */
  const transformBodies = useCallback(
    (ids: string[], t: BodyTransform) => {
      // Copies of a live repeat are rebuilt from their shape, so only the shape and its path are moved.
      setDocRaw(settle(ops.applyTransform(docRef.current, ids, t)));
    },
    [setDocRaw]
  );

  const requestDelete = (targets: string[] = selectedBodyIds) => {
    if (targets.length) setConfirmDeleteIds(targets);
  };

  const moveSelection = (dx: number, dy: number, dz: number, angle = 0) => {
    const b = selectionBounds(selectedBodies);
    if (b) transformBodies(selectedBodyIds, { dx, dy, dz, angle, cx: b.centerX, cy: b.centerY });
  };

  const handleResize = (width: number, depth: number) => {
    if (selectedBody) handleUpdateBody(selectedBody.id, resizeBody(selectedBody, width, depth));
  };

  const handleExtrudeFace = (face: FaceSel, delta: number) => {
    const body = bodies.find((b) => b.id === face.bodyId);
    const updates = body && extrudeFace(body, face, delta);
    if (updates) setBodies((prev) => prev.map((b) => (b.id === face.bodyId ? { ...b, ...updates } : b)));
  };

  const hiddenCount = bodies.filter((b) => !b.visible).length;
  const commonGroupId =
    selectedBodies.length > 1 && selectedBodies[0].groupId && selectedBodies.every((b) => b.groupId === selectedBodies[0].groupId) ? selectedBodies[0].groupId : null;
  /** A joined shape is several pieces that act as one solid; it is never shown as a loose group. */
  const joinedSelected = !!commonGroupId && !!groups.find((g) => g.id === commonGroupId)?.joined;
  const selectedGroup = joinedSelected ? undefined : groupOfSelection(groups, selectedBodyIds);
  const selectedGroupId = selectedGroup?.id ?? null;

  const hideSelected = () => {
    if (!selectedBodyIds.length) return;
    const ids = new Set(selectedBodyIds);
    setBodies((prev) => prev.map((b) => (ids.has(b.id) ? { ...b, visible: false } : b)));
    notify(`Hid ${ids.size === 1 ? 'the shape' : `${ids.size} shapes`}. Use Organize → Show hidden to bring back.`);
    selectOnly(null);
  };

  const showHidden = () => setBodies((prev) => prev.map((b) => (b.visible ? b : { ...b, visible: true })));

  const handleFaceValue = (face: FaceSel, mm: number) => {
    const body = bodies.find((b) => b.id === face.bodyId);
    const updates = body && setFaceMeasure(body, face, mm);
    if (updates) setBodies((prev) => prev.map((b) => (b.id === face.bodyId ? { ...b, ...updates } : b)));
  };

  const handleDeleteSelected = (targets: string[] = selectedBodyIds) => {
    if (!targets.length) return;
    const label = targets.length === 1 ? bodies.find((b) => b.id === targets[0])?.name ?? 'shape' : `${new Set(targets).size} shapes`;
    // A shape takes the copies of its live repeat with it.
    if (runOp((d) => ops.deleteShapes(d, { ids: targets }))) notify(`Deleted ${label}. Press ⌘Z to undo.`);
    setConfirmDeleteIds(null);
  };

  const handleCloneBody = (id: string) => {
    const made = runOp((d, ids) => ops.duplicateShapes(d, ids, { ids: [id] }));
    if (!made) return;
    selectOnly(made.created[0]);
    notify('Duplicated.');
  };

  /** Drops a stock shape into the scene: on the selected top face if there is one, otherwise beside what is already there. */
  const addShape = (kind: ShapeKind) => {
    const onTop = selectedBody && selectedFace?.kind === 'top' && selectedFace.bodyId === selectedBody.id ? selectedBody : null;
    const made = runOp((d, ids) => ops.addShape(d, ids, { kind, onTopOf: onTop?.id }));
    if (!made) return;
    bodyCounter.current += 1;
    setIsolatedIds((prev) => (prev ? [...prev, made.id] : prev));
    selectOnly(made.id);
  };

  /**
   * Subtract: the shape you picked last is cut out of the others. Only the part that overlaps in height is cut,
   * so a short cutter leaves slabs above and below it (kept as one group).
   */
  const WALL_NOTE = 'Shapes drawn on a wall can be moved, resized, pulled out and repeated, but not joined or cut yet.';
  const hasWallShape = (ids: string[]) => bodies.some((b) => ids.includes(b.id) && b.frame);

  const handleSubtractSelected = () => {
    if (hasWallShape(selectedBodyIds)) {
      notify(WALL_NOTE);
      return;
    }
    const last = bodies.find((b) => b.id === selectedBodyId);
    if (selectedBodyIds.length < 2 || !last) {
      notify('Select 2+ shapes first: press and hold a shape to add it. The last one you pick is cut out of the others.');
      return;
    }
    // The shape picked last (and anything grouped with it) is the cutter.
    const cutterIds = withGroupMates(groups, bodies, last.id);
    const targets = bodies.filter((b) => selectedBodyIds.includes(b.id) && !cutterIds.includes(b.id));
    if (!targets.length) {
      notify('Select another shape to cut from.');
      return;
    }
    const out = runOp((d, ids) => ops.subtractShapes(d, ids, { from: targets.map((t) => t.id), cutters: cutterIds }));
    if (!out) return;
    if (!out.changed) {
      notify("Those shapes don't overlap, so there is nothing to subtract.");
      return;
    }
    setIsolatedIds((prev) => (prev ? prev.filter((id) => !cutterIds.includes(id)) : prev));
    if (out.created.length) selectMany(out.created);
    else selectOnly(null);
    notify(`Subtracted ${cutterIds.length === 1 ? `“${last.name}”` : 'the last pick'} from ${targets.length === 1 ? `“${targets[0].name}”` : `${targets.length} shapes`}. ⌘Z undoes.`);
  };

  /** Rounds every vertical corner of a body to the same radius. */
  const handleApplyCornerRadius = (id: string, radius: number) => {
    const target = bodies.find((b) => b.id === id);
    if (!target) return;
    const n = (target.basePoints ?? target.points).length;
    handleUpdateBody(id, withOutline(target, { cornerRadii: new Array(n).fill(radius) }));
  };

  /** Size / style changes from the bevel bar, the viewport handle and the inspector. */
  const handleEdgeChange = useCallback(
    (sels: EdgeSel[], patch: { size?: number; style?: BevelStyle }) => {
      if (!sels.length) return;
      setBodies((prev) => prev.map((b) => (sels.some((s) => s.bodyId === b.id) ? { ...b, ...applyEdgeChange(b, sels, patch) } : b)));
      if (patch.size !== undefined && patch.size <= 0) {
        setSelectedEdges((prev) => prev.filter((e) => !sels.some((s) => edgeKey(s) === edgeKey(e))));
      }
    },
    [setBodies]
  );

  // ---- Commands -------------------------------------------------------------
  /** Repeat opens ghost copies right on the shape; pressing it again (or Enter) keeps them. */
  const handleOpenRepeat = () => {
    if (repeat) {
      handleFinishRepeat();
      return;
    }
    if (!selectedBody) {
      notify('Select the shape you want to repeat first.');
      return;
    }
    setDraw(null);
    setSelectedFace(null);
    setSelectedEdges([]);
    setMoveOn(false);
    // A shape that already repeats opens its own repeat for editing; any other starts a fresh one.
    setRepeat(repeats.find((l) => l.bodyId === selectedBody.id) ?? defaultSession(selectedBody));
  };

  const handleGroupSelected = () => {
    if (selectedBodyIds.length < 2) {
      notify('Select at least two shapes to group (Shift-click to add).');
      return;
    }
    if (runOp((d, ids) => ops.groupShapes(d, ids, { ids: selectedBodyIds }))) notify(`Grouped ${selectedBodyIds.length} shapes. They now select and move together.`);
  };

  /** Selects everything in a group, once the document has settled (its shapes may have new ids). */
  const selectGroup = (groupId: string) => {
    const g = docRef.current.groups.find((x) => x.id === groupId);
    if (g?.bodyIds.length) selectMany(g.bodyIds);
  };

  const handleSaveToLibrary = () => {
    const single = selectedBodies.length === 1 && !selectedBodies[0].groupId ? selectedBodies[0] : null;
    if (!selectedGroup && !single) return;
    const made = runOp((d, ids) => ops.saveToLibrary(d, ids, selectedGroup ? { group: selectedGroup.id } : { id: single!.id }));
    if (!made) return;
    selectGroup(made.group);
    const name = docRef.current.library.find((i) => i.id === made.item)?.name ?? 'object';
    notify(made.updated ? `Updated “${name}”: every linked copy follows.` : `Saved “${name}” to the library. Place more from Shape.`);
  };

  const handlePlaceItem = (item: string) => {
    const onTop = selectedFace?.kind === 'top' && selectedBody && !selectedBody.frame ? selectedBody.id : undefined;
    // An object that only lives in the app-wide library is brought into this project first, in the same step.
    const fromShared = !docRef.current.library.some((i) => i.id === item) ? sharedItems.find((i) => i.id === item) : undefined;
    const made = runOp((d, ids) => {
      const base = fromShared ? ops.importLibrary(d, { items: [{ ...fromShared, shared: true }] }).doc : d;
      return ops.placeFromLibrary(base, ids, { item, onTopOf: onTop });
    });
    if (made) selectGroup(made.group);
  };

  const handleShareItem = (item: string) => {
    const now = !docRef.current.library.find((i) => i.id === item)?.shared;
    if (!runOp((d) => ops.shareLibraryItem(d, { item, shared: now }))) return;
    if (!now) {
      const rest = loadShared().filter((i) => i.id !== item);
      saveShared(rest);
      setSharedItems(rest);
    }
    notify(now ? 'Kept in every project.' : 'Only in this project now.');
  };

  const handleRemoveItem = (item: string) => {
    if (docRef.current.library.some((i) => i.id === item)) void runOp((d) => ops.removeLibraryItem(d, { item }));
    else {
      const rest = loadShared().filter((i) => i.id !== item);
      saveShared(rest);
      setSharedItems(rest);
      notify('Removed from every project.');
    }
  };

  const handleEditObject = () => {
    if (!selectedGroup) return;
    const made = runOp((d, ids) => ops.unlinkObject(d, ids, { group: selectedGroup.id }));
    if (!made) return;
    selectGroup(made.group);
    notify('Open for editing. Change it, then Save: every linked copy follows.');
  };

  const handleSeparateObject = () => {
    if (!selectedGroup) return;
    const made = runOp((d, ids) => ops.unlinkObject(d, ids, { group: selectedGroup.id, forget: true }));
    if (made) {
      selectGroup(made.group);
      notify('Now separate from the library.');
    }
  };

  const handleUngroup = (groupId: string) => {
    if (runOp((d, ids) => ops.ungroupShapes(d, ids, { group: groupId }))) notify('Group dissolved.');
  };

  const handleMergeSelected = () => {
    if (hasWallShape(selectedBodyIds)) {
      notify(WALL_NOTE);
      return;
    }
    if (selectedBodyIds.length < 2) {
      notify('Select at least two shapes to join (press and hold a shape to add it).');
      return;
    }
    const gone = new Set(selectedBodyIds);
    const out = runOp((d, ids) => ops.joinShapes(d, ids, { ids: selectedBodyIds }));
    if (!out) return;
    setIsolatedIds((prev) => (prev ? [...prev.filter((id) => !gone.has(id)), ...out.created] : prev));
    selectMany(out.created);
    notify(`Joined ${gone.size} shapes into one.`);
  };

  /** Draw: press it (or `D`) and sketch. With a top face selected the sketch starts on that face. */
  const handleToggleDraw = () => {
    if (draw) {
      setDraw(null);
      return;
    }
    if (repeat) setRepeat(null);
    const face = selectedFace?.kind === 'top' || selectedFace?.kind === 'wall' ? selectedFace : null;
    const host = face && bodies.find((b) => b.id === face.bodyId);
    // A selected wall starts the sketch on that wall, square on to it, at the middle of its height.
    let frame: Frame | undefined;
    if (host && face?.kind === 'wall' && face.index !== undefined && !host.frame) {
      const ends = wallEnds(host, face.index);
      if (ends) {
        const n = outwardNormal(ends.a, ends.b, ends.winding);
        frame = { ...wallFrame({ x: (ends.a.x + ends.b.x) / 2, y: (ends.a.y + ends.b.y) / 2 }, n), h: Math.round((host.elevation ?? 0) + host.extrusionHeight / 2) };
      }
    }
    setDraw({
      form: 'shape',
      planeY: frame ? 0 : host && face?.kind === 'top' ? Math.round(((host.elevation ?? 0) + host.extrusionHeight) * 100) / 100 : null,
      hostId: host && face?.kind === 'top' && !host.frame ? host.repeatOf ?? host.id : undefined,
      points: [],
      bends: [],
      ...(frame ? { frame } : {}),
    });
    setSelectedFace(null);
    setSelectedEdges([]);
    setMoveOn(false);
  };

  /** A finished sketch becomes an ordinary shape standing on its surface, with its top selected so it can be pulled up at once. */
  const handleFinishDraw = (outline: DrawnOutline, planeY: number, frame?: Frame) => {
    // Cut mode: the sketch is cut straight down through the shape it was drawn on, instead of becoming a shape.
    if (draw?.cut && draw.hostId && !frame) {
      const out = runOp((d, ids) => ops.cutWithOutline(d, ids, { target: draw.hostId!, outline, from: planeY }));
      setDraw(null);
      if (!out) return;
      if (!out.changed) {
        notify("That doesn't reach the shape, so nothing was cut. Draw on the shape's top face.");
        return;
      }
      selectMany(out.created);
      notify('Cut. ⌘Z undoes it.');
      return;
    }
    bodyCounter.current += 1;
    const id = `body_${Date.now()}`;
    const color = SWATCHES[(bodyCounter.current - 1) % SWATCHES.length].value;
    const body = drawnBody(outline, planeY, id, `${outline.name} ${bodyCounter.current}`, color, frame);
    setDraw(null);
    setBodies((prev) => [...prev, body]);
    setIsolatedIds((prev) => (prev ? [...prev, id] : prev));
    setSelectedBodyId(id);
    setSelectedBodyIds([id]);
    setSelectedEdges([]);
    setSelectedFace({ bodyId: id, kind: 'top' });
  };

  /** Takes back the last corner placed (Backspace, or the undo button on a phone). */
  const handleDrawUndoCorner = () =>
    setDraw((d) => (d && d.points.length ? { ...d, points: d.points.slice(0, -1), bends: d.bends.slice(0, Math.max(0, d.points.length - 1)), planeY: d.points.length === 1 && !d.frame ? null : d.planeY } : d));

  const handleDrawForm = (form: DrawForm) => setDraw((d) => (d ? { ...d, form, points: [], bends: [] } : d));

  /** Finish the corners placed so far (the green tick, or Enter). */
  const handleDrawDone = () => {
    const outline = draw && shapeOutline(draw);
    if (!draw || draw.planeY === null || !outline) {
      notify('Place at least three corners that make a shape.');
      return;
    }
    handleFinishDraw(outline, draw.planeY, draw.frame);
  };

  /** Keeps the repeat: from now on its copies follow the shape and the path. */
  const handleFinishRepeat = () => {
    const source = repeat && bodies.find((b) => b.id === repeat.bodyId);
    if (!repeat || !source) {
      setRepeat(null);
      return;
    }
    const link: RepeatLink = { ...repeat, linkId: repeat.linkId ?? `rep_${Date.now()}` };
    const fresh = !repeat.linkId;
    setRepeat(null);
    setDoc((d) => ({ repeats: [...d.repeats.filter((l) => l.linkId !== link.linkId), link] }));
    selectOnly(source.id);
    notify(fresh ? `${link.count} shapes in a row. Edit the first and the rest follow.` : 'Repeat updated.');
  };

  /** Lets go of a live repeat: its copies stay, as ordinary shapes you can edit one by one. */
  const handleBreakRepeat = () => {
    const ids = new Set(selectedBodyIds);
    if (!repeats.some((l) => ids.has(l.bodyId))) return;
    setDoc((d) => ({ repeats: d.repeats.filter((l) => !ids.has(l.bodyId)) }));
    notify('The copies are now separate shapes.');
  };

  const handleClearWorkspace = () => {
    if (window.confirm('Remove every shape and start from an empty workspace?')) {
      setDoc({ bodies: [], groups: [], repeats: [] });
      selectOnly(null);
      setIsolatedIds(null);
      notify('Workspace cleared. Press ⌘Z to bring it back.');
    }
  };

  const handleLoadDemo = () => {
    const fresh = starterDoc();
    setDoc(fresh);
    selectOnly(fresh.bodies[0].id);
    setIsolatedIds(null);
    notify('Loaded the starter block.');
  };

  /** Shows only the given shapes (or everything again), in 2D and 3D. */
  const isolate = (ids: string[] | null) => {
    if (!ids) {
      setIsolatedIds(null);
      return;
    }
    const withGroups = new Set(ids.flatMap((id) => withGroupMates(groups, bodies, id)));
    setIsolatedIds([...withGroups]);
  };

  const toggleIsolate = () => {
    if (isolatedIds) {
      isolate(null);
      notify('Showing everything.');
    } else if (selectedBodyIds.length) {
      isolate(selectedBodyIds);
      notify('Isolated. Press I again to show everything.');
    } else {
      notify('Select a shape to isolate it.');
    }
  };

  const doUndo = () => {
    if (!history.undo()) notify('Nothing to undo.');
  };
  const doRedo = () => {
    if (!history.redo()) notify('Nothing to redo.');
  };

  // ---- Keyboard shortcuts -------------------------------------------------
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if (key === 'y') {
        e.preventDefault();
        doRedo();
      } else if (key === 'd' && selectedBodyId) {
        e.preventDefault();
        handleCloneBody(selectedBodyId);
      }
      return;
    }
    if (e.altKey) return;

    if (key === 'escape') {
      // One step back each time: close dialogs, drop edge picks, deselect, show everything.
      if (openMenu) setOpenMenu(null);
      else if (confirmDeleteIds) setConfirmDeleteIds(null);
      else if (draw) setDraw(null);
      else if (repeat) setRepeat(null);
      else if (selectedEdges.length) setSelectedEdges([]);
      else if (selectedFace) setSelectedFace(null);
      else if (selectedBodyIds.length) selectOnly(null);
      else if (isolatedIds) isolate(null);
      return;
    }
    if (confirmDeleteIds) return;
    if (draw) {
      if (key === 'enter') {
        e.preventDefault();
        handleDrawDone();
      } else if (key === 'backspace' || key === 'delete') {
        e.preventDefault();
        handleDrawUndoCorner();
      } else if (key === 'd') handleToggleDraw();
      return;
    }
    if (repeat) {
      if (key === 'enter' || key === 'r') {
        e.preventDefault();
        handleFinishRepeat();
      }
      return; // everything else waits until the repeat is finished
    }

    switch (key) {
      case 'm':
        if (selectedBodyIds.length) setMoveOn((v) => !v);
        break;
      case 'h':
        hideSelected();
        break;
      case 'i':
        toggleIsolate();
        break;
      case 's':
        handleSubtractSelected();
        break;
      case 'r':
        handleOpenRepeat();
        break;
      case 'd':
        handleToggleDraw();
        break;
      case 'x':
        setXray((v) => !v);
        break;
      case 'g':
        if (joinedSelected) notify('This is a joined shape: it already moves as one.');
        else if (selectedGroupId) handleUngroup(selectedGroupId);
        else handleGroupSelected();
        break;
      case 'j':
        handleMergeSelected();
        break;
      case 'delete':
      case 'backspace':
        e.preventDefault();
        if (selectedEdges.length) handleEdgeChange(selectedEdges, { size: 0 });
        else requestDelete();
        break;
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ---- Render -------------------------------------------------------------
  const sidebarProps = {
    bodies,
    isolatedIds,
    selectedBodyId,
    selectedBodyIds,
    onSelectBody: handleSelectBody,
    onUpdateBody: handleUpdateBody,
    onDeleteBody: (id: string) => requestDelete([id]),
    onCloneBody: handleCloneBody,
    onClearWorkspace: handleClearWorkspace,
    onLoadDemo: handleLoadDemo,
    groups,
    onGroupSelected: handleGroupSelected,
    onUngroup: handleUngroup,
    onMergeSelected: handleMergeSelected,
    onApplyCornerRadius: handleApplyCornerRadius,
    onIsolate: (id: string) => {
      isolate([id]);
      selectOnly(id);
    },
    onShowAll: () => isolate(null),
    onEditEdge: (sel: EdgeSel) => {
      selectOnly(sel.bodyId);
      setSelectedEdges([sel]);
      },
    onRemoveEdge: (sel: EdgeSel) => handleEdgeChange([sel], { size: 0 }),
  };

  const isolatedNames = isolatedIds
    ? bodies
        .filter((b) => isolatedIds.includes(b.id))
        .map((b) => b.name)
        .slice(0, 2)
        .join(', ') + (isolatedIds.length > 2 ? ` +${isolatedIds.length - 2}` : '')
    : '';

  return (
    <div className="h-dvh flex flex-col bg-slate-950 text-slate-100 font-sans select-none overflow-hidden">
      <TopBar
        openId={openMenu}
        setOpenId={setOpenMenu}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={doUndo}
        onRedo={doRedo}
        selected={selectedBodies}
        joined={joinedSelected}
        edges={selectedEdges}
        face={selectedFace}
        onEdgeChange={handleEdgeChange}
        onClearEdges={() => setSelectedEdges([])}
        onSelectEdges={setSelectedEdges}
        onExtrudeFace={handleExtrudeFace}
        onClearFace={() => setSelectedFace(null)}
        onMove={(dx, dy, dz) => moveSelection(dx, dy, dz)}
        onResize={handleResize}
        onUpdateBody={handleUpdateBody}
        group={selectedGroup ? { id: selectedGroup.id, name: selectedGroup.name } : undefined}
        object={
          selectedGroup?.libraryId
            ? { state: selectedGroup.place ? 'linked' : 'editing', item: library.find((i) => i.id === selectedGroup.libraryId)?.name ?? 'object' }
            : undefined
        }
        canSave={
          !selectedGroup?.libraryId &&
          (selectedGroup ? !selectedGroup.joined : selectedBodies.length === 1 && !selectedBodies[0].groupId && !selectedBodies[0].repeatOf && !selectedBodies[0].instanceOf && !selectedBodies[0].frame)
        }
        onSaveToLibrary={handleSaveToLibrary}
        onEditObject={handleEditObject}
        onSeparateObject={handleSeparateObject}
        onRenameGroup={(group, name) => void runOp((d) => ops.renameGroup(d, { group, name }))}
        sidebar={sidebarProps}
      />

      <div className="flex-1 min-h-0 flex">
        {/* Viewport */}
        <main className="relative flex-1 min-w-0 min-h-0 bg-slate-950">
          <div className="absolute inset-0">
                <ModelViewer3D
                  bodies={displayBodies}
                  groups={groups}
                  selectedBodyId={selectedBodyId}
                  selectedBodyIds={selectedBodyIds}
                  onSelectBody={handleSelectBody}
                  onUpdateBody={handleUpdateBody}
                  onTransformBodies={transformBodies}
                  selectedEdges={selectedEdges}
                  onSelectEdges={setSelectedEdges}
                  selectedFace={selectedFace}
                  onSelectFace={setSelectedFace}
                  onEdgeChange={handleEdgeChange}
                  repeat={repeat}
                  onUpdateRepeat={setRepeat}
                  onFinishRepeat={handleFinishRepeat}
                  apiRef={viewerApi}
                  xray={xray}
                  onToggleXray={() => setXray((v) => !v)}
                  draw={draw}
                  onUpdateDraw={setDraw}
                  onFinishDraw={handleFinishDraw}
                  onNotify={notify}
                  onDrawForm={handleDrawForm}
                  onDrawDone={handleDrawDone}
                  onDrawCancel={() => setDraw(null)}
                  onDrawUndoCorner={handleDrawUndoCorner}
                  onDrawCut={(cut) => setDraw((d) => (d ? { ...d, cut } : d))}
                  onRepeatCancel={() => setRepeat(null)}
                  onDragStateChange={history.hold}
                  onHint={setHint}
                  moveOn={moveOn}
                  onFaceValue={handleFaceValue}
                  onToggleMove={() => setMoveOn((v) => !v)}
                />

                {displayBodies.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="pointer-events-auto max-w-xs text-center flex flex-col items-center gap-4 p-6">
                      <div className="w-12 h-12 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-slate-300">
                        <Box size={22} strokeWidth={1.5} />
                      </div>
                      <div>
                        <h2 className="text-base font-semibold text-white">Start your first part</h2>
                        <p className="mt-1 text-sm text-slate-400">Add a shape, then group, join or subtract.</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => addShape('box')}
                          className="px-4 h-9 rounded-full bg-accent-500 hover:bg-accent-400 text-white text-sm font-medium flex items-center gap-2 transition-colors"
                        >
                          <Box size={15} /> Add a box
                        </button>
                        <button
                          type="button"
                          onClick={handleLoadDemo}
                          className="px-4 h-9 rounded-full bg-white/8 hover:bg-white/12 text-slate-200 text-sm font-medium flex items-center gap-2 transition-colors"
                        >
                          <Sparkles size={15} /> Starter block
                        </button>
                      </div>
                    </div>
                  </div>
                )}
          </div>

          {/* Bottom-center stack: isolation state and toasts */}
          <div className="absolute z-30 left-1/2 -translate-x-1/2 bottom-3 w-[calc(100%-1.5rem)] max-w-xl flex flex-col items-center gap-2 pointer-events-none [&>*]:pointer-events-auto">
            <AnimatePresence>
              {isolatedIds && (
                <motion.div
                  key="isolated"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 rounded-xl bg-accent-500/20 border border-accent-400/40 backdrop-blur text-[13px] text-accent-100 shadow-xl max-w-full"
                >
                  <Focus size={14} className="shrink-0" />
                  <span className="truncate">
                    Isolated: <strong className="font-semibold text-white">{isolatedNames}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => isolate(null)}
                    className="h-7 px-2.5 rounded-full bg-white/12 hover:bg-white/20 text-xs font-medium text-white shrink-0"
                  >
                    Show all
                  </button>
                </motion.div>
              )}
              {hiddenCount > 0 && (
                <motion.div
                  key="hidden"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="flex items-center gap-2.5 pl-3 pr-1.5 py-1.5 rounded-full bg-slate-800/95 border border-white/12 backdrop-blur text-[13px] text-slate-200 shadow-xl max-w-full"
                >
                  <EyeOff size={14} className="shrink-0 text-slate-400" />
                  <span className="truncate">
                    {hiddenCount} hidden
                  </span>
                  <button type="button" onClick={showHidden} className="h-7 px-3 rounded-full bg-white/12 hover:bg-white/20 text-xs font-medium text-white shrink-0">
                    Show
                  </button>
                </motion.div>
              )}
              {toast && (
                <motion.div
                  key={toast}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  role="status"
                  className="px-3.5 py-2 rounded-xl bg-slate-950/95 backdrop-blur border border-white/10 shadow-xl text-[13px] text-slate-100 flex items-center gap-2 max-w-full"
                >
                  <Info size={14} className="text-accent-400 shrink-0" />
                  <span className="truncate">{toast}</span>
                </motion.div>
              )}
            </AnimatePresence>
            {hint && (
              <p className="text-xs text-slate-500 text-center leading-snug px-3">{hint}</p>
            )}
          </div>
        </main>

      </div>

      <BottomBar
        openId={openMenu}
        setOpenId={setOpenMenu}
        selectedCount={selectedBodyIds.length}
        bodyCount={displayBodies.length}
        isolated={!!isolatedIds}
        moveOn={moveOn && selectedBodyIds.length > 0}
        addOnTop={selectedFace?.kind === 'top' && selectedBodyIds.length === 1}
        onAddShape={addShape}
        library={[
          ...library.map((i) => ({ id: i.id, name: i.name, shapes: i.bodies.length, shared: !!i.shared, inProject: true, thumb: thumbnailUrl(i, 88) })),
          ...sharedItems.filter((i) => !library.some((x) => x.id === i.id)).map((i) => ({ id: i.id, name: i.name, shapes: i.bodies.length, shared: true, inProject: false, thumb: thumbnailUrl(i, 88) })),
        ]}
        onPlaceItem={handlePlaceItem}
        onShareItem={handleShareItem}
        onRemoveItem={handleRemoveItem}
        onToggleMove={() => setMoveOn((v) => !v)}
        onIsolate={toggleIsolate}
        grouped={!!selectedGroupId}
        hiddenCount={hiddenCount}
        onHide={hideSelected}
        onShowHidden={showHidden}
        onGroup={() => {
          if (joinedSelected) notify('This is a joined shape: it already moves as one.');
          else if (selectedGroupId) handleUngroup(selectedGroupId);
          else handleGroupSelected();
        }}
        onJoin={handleMergeSelected}
        onSubtract={handleSubtractSelected}
        repeatOn={!!repeat}
        drawOn={!!draw}
        onDraw={handleToggleDraw}
        repeated={selectedBodyIds.some((id) => repeats.some((l) => l.bodyId === id))}
        onBreakRepeat={handleBreakRepeat}
        onPattern={handleOpenRepeat}
        onDelete={() => requestDelete()}
      />

      <AnimatePresence>
        {confirmDeleteIds && (
          <ConfirmDeleteModal
            key="delete"
            names={(() => {
              const picked = confirmDeleteIds.map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body3D => !!b);
              const gid = picked[0]?.groupId;
              const oneJoined = !!gid && picked.every((b) => b.groupId === gid) && !!groups.find((g) => g.id === gid)?.joined;
              return oneJoined ? [picked[0].name] : picked.map((b) => b.name);
            })()}
            onConfirm={() => handleDeleteSelected(confirmDeleteIds)}
            onCancel={() => setConfirmDeleteIds(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
