/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Boxes,
  Circle,
  Combine,
  Eye,
  EyeOff,
  FileDown,
  Focus,
  Globe,
  Hexagon,
  LayoutGrid,
  Layers3,
  Library,
  Move,
  Move3d,
  Octagon,
  Palette,
  Pencil,
  PenTool,
  Pentagon,
  Pin,
  Repeat,
  Shapes,
  SlidersHorizontal,
  Square,
  SquareDashed,
  SquareMinus,
  SquareRoundCorner,
  Star,
  Trash2,
  Triangle,
  TriangleRight,
  Ungroup,
  Unlink,
  X,
  type LucideIcon,
} from 'lucide-react';
import { SHAPE_LABELS, ShapeKind } from '../utils/primitives';
import Sidebar from './Sidebar';
import { EdgePanel, FacePanel, SizePositionPanel, selectionMode, type TopBarProps } from './TopBar';

const SHAPE_ICONS: Record<ShapeKind, LucideIcon> = {
  box: Square,
  roundedBox: SquareRoundCorner,
  cylinder: Circle,
  triangle: Triangle,
  wedge: TriangleRight,
  pentagon: Pentagon,
  hexagon: Hexagon,
  octagon: Octagon,
  star: Star,
};

/** One colour per verb, the same ones every Autora app's tool bar uses (docs/TOOL-RAIL.md in Autora). */
const C = { select: '#2563eb', text: '#059669', amber: '#f59e0b', draw: '#9333ea', shape: '#4f46e5', note: '#0284c7', gold: '#d97706', remove: '#e11d48', insert: '#0891b2' };

export interface RailProps extends TopBarProps {
  selectedCount: number;
  bodyCount: number;
  isolated: boolean;
  moveOn: boolean;
  /** True when the next shape will be placed on the selected top face. */
  addOnTop: boolean;
  onAddShape: (kind: ShapeKind) => void;
  /** The project's saved objects: tapping one places a linked copy. */
  library: { id: string; name: string; shapes: number; shared: boolean; inProject: boolean; thumb: string }[];
  onPlaceItem: (id: string) => void;
  onShareItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onToggleMove: () => void;
  onIsolate: () => void;
  /** The selection is already a group, so the Group tool becomes Ungroup. */
  grouped: boolean;
  hiddenCount: number;
  onHide: () => void;
  onShowHidden: () => void;
  onGroup: () => void;
  onJoin: () => void;
  onSubtract: () => void;
  /** A repeat is open: the tool shows as on and pressing it keeps the copies. */
  repeatOn: boolean;
  /** A sketch is open: the Draw tool shows as on. */
  drawOn: boolean;
  onDraw: () => void;
  /** The selected shape has a live repeat, so its copies can be let go. */
  repeated: boolean;
  onBreakRepeat: () => void;
  onPattern: () => void;
  onDelete: () => void;
}

interface Tool {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  color: string;
  phone?: boolean;
  desktop?: boolean;
  on?: boolean;
  disabled?: boolean;
  hint?: string;
  run: () => void;
}

const PINS = 'autora-3d-rail-pins';
const BTN = { phone: 40, desktop: 44 };

const usePhone = () => {
  const q = '(max-width: 639px)';
  const [phone, setPhone] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
};

/**
 * Every tool of the modeller, in the one bar the PDF window and the other Autora apps wear: round coloured buttons down the
 * right side on a desktop and along the bottom on a phone, as many as fit and never scrolling, and an All tools grid for
 * the rest (with pins on a desktop). The panels a tool opens (shapes, size, material, bevel...) are cards beside the bar.
 * Nothing is repeated elsewhere: the top bar holds only undo, redo and what is selected.
 */
export default function Rail(props: RailProps) {
  const phone = usePhone();
  const kind = phone ? 'phone' : 'desktop';
  const { selectedCount: n, openId, setOpenId } = props;
  const mode = selectionMode(props);
  const [grid, setGrid] = useState(false);
  const [room, setRoom] = useState(99);
  const [toast, setToast] = useState<string | null>(null);
  const bar = useRef<HTMLElement>(null);

  const addHint = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'Hold a shape to add it' : 'Shift-click a shape to add it';
  const picked = 'Select a shape';
  const open = (id: string) => setOpenId(openId === id ? null : id);
  const toggleOpen = (id: string) => () => open(id);

  const tools: Tool[] = [
    { id: 'shapes', label: 'Shape', group: 'Build', icon: Shapes, color: C.shape, phone: true, desktop: true, on: openId === 'shapes', run: toggleOpen('shapes') },
    { id: 'draw', label: 'Draw', group: 'Build', icon: PenTool, color: C.draw, phone: true, desktop: true, on: props.drawOn, run: props.onDraw },
    { id: 'library', label: 'Library', group: 'Build', icon: Library, color: C.gold, on: openId === 'library', run: toggleOpen('library') },
    { id: 'move', label: 'Move', group: 'Edit', icon: Move3d, color: C.select, phone: true, desktop: true, on: props.moveOn, disabled: n < 1, hint: picked, run: props.onToggleMove },
    { id: 'group', label: props.grouped ? 'Ungroup' : 'Group', group: 'Edit', icon: props.grouped ? Ungroup : Boxes, color: C.text, phone: true, desktop: true, disabled: !props.grouped && n < 2, hint: addHint, run: props.onGroup },
    { id: 'repeat', label: 'Repeat', group: 'Edit', icon: Repeat, color: C.note, phone: true, desktop: true, on: props.repeatOn, disabled: !props.repeatOn && n < 1, hint: picked, run: props.onPattern },
    { id: 'join', label: 'Join', group: 'Combine', icon: Combine, color: C.insert, desktop: true, disabled: n < 2, hint: addHint, run: props.onJoin },
    { id: 'subtract', label: 'Subtract', group: 'Combine', icon: SquareMinus, color: C.remove, desktop: true, disabled: n < 2, hint: addHint, run: props.onSubtract },
    { id: 'isolate', label: props.isolated ? 'Show everything' : 'Isolate', group: 'Combine', icon: Focus, color: C.amber, desktop: true, on: props.isolated, disabled: !props.isolated && n < 1, hint: picked, run: props.onIsolate },
    { id: 'hide', label: 'Hide', group: 'Combine', icon: EyeOff, color: C.amber, desktop: true, disabled: n < 1, hint: picked, run: props.onHide },
    { id: 'unhide', label: `Show hidden${props.hiddenCount ? ` (${props.hiddenCount})` : ''}`, group: 'Combine', icon: Eye, color: C.amber, disabled: props.hiddenCount < 1, run: props.onShowHidden },
    { id: 'breakrepeat', label: 'Make copies separate', group: 'Combine', icon: Unlink, color: C.note, disabled: !props.repeated, run: props.onBreakRepeat },
    { id: 'size', label: 'Size & position', group: 'Shape', icon: Move, color: C.insert, phone: true, desktop: true, on: openId === 'size', disabled: n < 1, hint: picked, run: toggleOpen('size') },
    { id: 'props', label: 'Properties', group: 'Shape', icon: SlidersHorizontal, color: C.select, on: openId === 'props', disabled: !(props.selected.length === 1 && !props.group), hint: picked, run: toggleOpen('props') },
    { id: 'material', label: 'Material', group: 'Shape', icon: Palette, color: C.text, desktop: true, on: openId === 'material', disabled: !(props.selected.length === 1 && !props.group), hint: picked, run: toggleOpen('material') },
    { id: 'edges', label: 'Pick edges', group: 'Shape', icon: SquareDashed, color: C.shape, on: openId === 'edges', disabled: mode !== 'edge', hint: 'Tap an edge of a shape', run: toggleOpen('edges') },
    { id: 'face', label: 'Push & pull', group: 'Shape', icon: Layers3, color: C.note, on: openId === 'face', disabled: mode !== 'face', hint: 'Tap a face of a shape', run: toggleOpen('face') },
    { id: 'save', label: props.object?.state === 'editing' ? `Save to “${props.object.item}”` : 'Save to library', group: 'Library', icon: BookmarkPlus, color: C.gold, disabled: !props.canSave && props.object?.state !== 'editing', hint: 'Select a group or a shape', run: props.onSaveToLibrary },
    { id: 'editobject', label: 'Edit object', group: 'Library', icon: Pencil, color: C.select, disabled: props.object?.state !== 'linked', hint: 'Select a copy from the library', run: props.onEditObject },
    { id: 'separate', label: 'Separate', group: 'Library', icon: Unlink, color: C.remove, disabled: !props.object, hint: 'Select a library copy', run: props.onSeparateObject },
    { id: 'file', label: 'Export & file', group: 'File', icon: FileDown, color: C.shape, desktop: true, on: openId === 'file', run: toggleOpen('file') },
    { id: 'delete', label: 'Delete', group: 'Edit', icon: Trash2, color: C.remove, phone: true, desktop: true, disabled: n < 1, hint: picked, run: props.onDelete },
  ];
  const byId = new Map(tools.map((t) => [t.id, t]));

  const [pins, setPins] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PINS) ?? 'null') as unknown;
      if (Array.isArray(saved)) return saved.filter((x): x is string => typeof x === 'string');
    } catch { /* no storage: the defaults */ }
    return tools.filter((t) => t.desktop).map((t) => t.id);
  });
  const savePins = (next: string[]) => {
    setPins(next);
    try { localStorage.setItem(PINS, JSON.stringify(next)); } catch { /* still works this session */ }
  };
  const ids = phone ? tools.filter((t) => t.phone).map((t) => t.id) : pins.filter((id) => byId.has(id));

  // The window's own size is the room: its height on a desktop (the bar is a column), its width on a phone (a row).
  useLayoutEffect(() => {
    const measure = () => {
      const space = phone ? window.innerWidth : window.innerHeight - 48 - 24;
      setRoom(Math.max(1, Math.floor((space - 16 - 12 + 4) / (BTN[kind] + 4)) - 1));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [phone, kind]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!grid) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setGrid(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [grid]);

  const auto = openId;
  const closePanel = () => setOpenId(null);

  const press = (t: Tool) => { setGrid(false); t.run(); };
  const sidebar = props.sidebar;
  const panel = (() => {
    switch (auto) {
      case 'shapes':
        return (
          <div className="p-3 w-[min(19rem,calc(100vw-1.5rem))]">
            <p className="px-2 pb-2 text-xs text-slate-400">{props.addOnTop ? 'Adds on top of the selected face' : 'Add a shape'}</p>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => {
                const Icon = SHAPE_ICONS[k];
                return (
                  <button key={k} type="button" onClick={() => { props.onAddShape(k); setOpenId(null); }} className="h-16 rounded-[1.2rem] bg-white/6 hover:bg-white/12 flex flex-col items-center justify-center gap-1 text-slate-200 hover:text-white transition-colors">
                    <Icon size={22} strokeWidth={1.6} />
                    <span className="text-[11px]">{SHAPE_LABELS[k]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      case 'library':
        return (
          <div className="p-3 w-[min(19rem,calc(100vw-1.5rem))]">
            <p className="px-2 pb-2 text-xs text-slate-400">{props.library.length ? 'Your objects · placed copies stay linked · globe = in every project' : 'Nothing saved yet. Select a group or a shape and use Save to library.'}</p>
            <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
              {props.library.map((item) => (
                <div key={item.id} className="flex items-center gap-1">
                  <button type="button" onClick={() => { props.onPlaceItem(item.id); setOpenId(null); }} className="flex-1 min-w-0 h-14 pl-2 pr-4 rounded-full bg-white/6 hover:bg-white/12 text-left text-sm font-medium text-slate-100 flex items-center gap-2.5 transition-colors">
                    <img src={item.thumb} alt="" width={44} height={44} className="w-11 h-11 shrink-0 rounded-full bg-slate-950/60" draggable={false} />
                    <span className="truncate">{item.name}</span>
                    <span className="ml-auto text-[11px] text-slate-400">{item.shapes} {item.shapes === 1 ? 'shape' : 'shapes'}</span>
                  </button>
                  {item.inProject ? (
                    <button type="button" onClick={() => props.onShareItem(item.id)} aria-pressed={item.shared} aria-label={item.shared ? `${item.name} is in every project: tap to keep it in this project only` : `Keep ${item.name} in every project`} title={item.shared ? 'In every project (tap to keep it only here)' : 'Keep in every project'} className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center transition-colors ${item.shared ? 'bg-accent-500/25 text-accent-200' : 'text-slate-400 hover:text-white hover:bg-white/10'}`}>
                      <Globe size={16} />
                    </button>
                  ) : (
                    <span className="w-11 h-11 shrink-0 flex items-center justify-center text-accent-200" title="From the app-wide library"><Globe size={16} /></span>
                  )}
                  <button type="button" onClick={() => props.onRemoveItem(item.id)} aria-label={item.inProject ? `Remove ${item.name} from this project's library` : `Remove ${item.name} from every project`} title={item.inProject ? 'Remove from this project (placed copies stay as shapes)' : 'Remove from every project'} className="w-11 h-11 shrink-0 rounded-full text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 flex items-center justify-center transition-colors">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      case 'size': return <SizePositionPanel {...props} />;
      case 'props': return <Sidebar {...sidebar} section="properties" />;
      case 'material': return <Sidebar {...sidebar} section="material" />;
      case 'file': return <Sidebar {...sidebar} section="export" />;
      case 'edges': return <EdgePanel {...props} />;
      case 'face': return <FacePanel {...props} />;
      default: return null;
    }
  })();
  const panelTool = auto ? byId.get(auto) ?? null : null;

  const groups: string[] = [];
  for (const t of tools) if (!groups.includes(t.group)) groups.push(t.group);

  return (
    <>
      {panel && panelTool && (
        <section
          aria-label={`${panelTool.label} options`}
          style={{ ['--tc' as string]: panelTool.color }}
          className={`z-40 max-h-[min(60dvh,34rem)] overflow-y-auto rounded-[1.5rem] bg-slate-800 border shadow-2xl shadow-black/60 ${phone ? 'fixed left-1/2 -translate-x-1/2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)]' : 'fixed right-[4.75rem] top-1/2 -translate-y-1/2'}`}
        >
          <div style={{ borderColor: panelTool.color }} className="sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-1 bg-slate-800 border-t-0">
            <span style={{ color: panelTool.color }} className="flex items-center gap-2 text-[13px] font-medium"><panelTool.icon size={16} strokeWidth={1.75} />{panelTool.label}</span>
            <div className="flex-1" />
            <button type="button" aria-label="Close options" onClick={closePanel} className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10"><X size={14} /></button>
          </div>
          {panel}
        </section>
      )}

      <nav
        ref={bar}
        aria-label="Tools"
        className={
          phone
            ? 'shrink-0 flex items-center justify-center gap-0.5 px-2 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] bg-slate-900 border-t border-white/8 z-40'
            : 'fixed right-2.5 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1 p-2 rounded-full bg-slate-800/90 backdrop-blur border border-white/10 shadow-2xl shadow-black/50 max-h-[calc(100%-1.5rem)] overflow-hidden'
        }
      >
        {ids.slice(0, room).map((id) => {
          const t = byId.get(id)!;
          const Icon = t.icon;
          return (
            <button
              key={id}
              type="button"
              aria-label={t.label}
              aria-pressed={t.on || undefined}
              title={t.disabled && t.hint ? `${t.label} · ${t.hint}` : t.label}
              disabled={t.disabled}
              onClick={() => press(t)}
              style={{ ['--tc' as string]: t.color, background: t.on ? t.color : `color-mix(in srgb, ${t.color} 16%, transparent)`, color: t.on ? '#fff' : t.color, boxShadow: t.on ? `0 6px 18px color-mix(in srgb, ${t.color} 45%, transparent)` : undefined }}
              className={`shrink-0 rounded-full flex items-center justify-center transition-colors disabled:opacity-35 disabled:pointer-events-none ${phone ? 'h-10 w-10' : 'h-11 w-11'}`}
            >
              <Icon size={20} strokeWidth={1.75} />
            </button>
          );
        })}
        <i aria-hidden="true" className={`shrink-0 bg-white/12 ${phone ? 'w-px h-6 mx-1' : 'w-6 h-px my-0.5'}`} />
        <button type="button" aria-label="All tools" aria-haspopup="dialog" title="All tools" onClick={() => setGrid(true)} className={`shrink-0 rounded-full flex items-center justify-center bg-white/8 text-slate-300 hover:text-white ${phone ? 'h-10 w-10' : 'h-11 w-11'}`}>
          <LayoutGrid size={18} />
        </button>
      </nav>

      {grid && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm" onClick={() => setGrid(false)} role="presentation">
          <div role="dialog" aria-modal="true" aria-label="All tools" onClick={(e) => e.stopPropagation()} className={`w-full max-h-[86dvh] overflow-y-auto rounded-[1.5rem] bg-slate-900 border border-white/12 shadow-2xl ${phone ? 'max-w-[21rem] p-3' : 'max-w-[35rem] p-4'}`}>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-white">All tools</h3>
              <div className="flex-1" />
              {!phone && <button type="button" onClick={() => savePins(tools.filter((t) => t.desktop).map((t) => t.id))} className="text-xs text-slate-300 hover:text-white px-2 py-1 rounded-full hover:bg-white/8">Reset bar</button>}
              <button type="button" aria-label="Close" onClick={() => setGrid(false)} className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10"><X size={16} /></button>
            </div>
            <p className="mt-1 text-xs text-slate-400 min-h-[1.2em]">{toast ?? (phone ? 'Tap a tool to use it.' : `Pin the tools you use most to your bar. It has room for ${room} at this window size (${ids.length} pinned).`)}</p>
            {groups.map((g) => (
              <section key={g}>
                <h4 className="mt-3.5 mb-2 px-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-slate-500">{g}</h4>
                <div className={`grid gap-2 ${phone ? 'grid-cols-4' : 'grid-cols-5'}`}>
                  {tools.filter((t) => t.group === g).map((t) => {
                    const Icon = t.icon;
                    const pinned = ids.includes(t.id);
                    return (
                      <div key={t.id} className="relative">
                        <button
                          type="button"
                          disabled={t.disabled}
                          title={t.disabled && t.hint ? t.hint : undefined}
                          onClick={() => press(t)}
                          style={{ color: t.color, background: `color-mix(in srgb, ${t.color} ${t.on ? 30 : 16}%, transparent)` }}
                          className={`w-full flex flex-col items-center justify-center gap-1.5 px-1 text-center disabled:opacity-35 disabled:pointer-events-none rounded-2xl ${phone ? 'h-14 text-[10px]' : 'h-[4.5rem] text-[11.5px]'}`}
                        >
                          <Icon size={20} strokeWidth={1.75} />
                          <span className="text-slate-100 leading-tight">{t.label}</span>
                        </button>
                        {!phone && (
                          <button
                            type="button"
                            aria-pressed={pinned}
                            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${t.label} ${pinned ? 'from' : 'to'} the bar`}
                            onClick={() => {
                              if (pinned) savePins(pins.filter((p) => p !== t.id));
                              else if (ids.length >= room) setToast('The bar is full. Unpin a tool first.');
                              else savePins([...pins, t.id]);
                            }}
                            style={pinned ? { background: t.color } : undefined}
                            className={`absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center ${pinned ? 'text-white' : 'text-slate-500 hover:text-white'}`}
                          >
                            <Pin size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
