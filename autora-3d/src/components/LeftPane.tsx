/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { memo, useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Globe, LogIn, PanelLeftClose, Trash2 } from 'lucide-react';
import { Body3D, ShapeGroup } from '../types';
import { thumbnailDataUrl } from '../utils/thumbnail';
import { groupChain } from '../utils/groups';

/**
 * The parts of the model, as thumbnails down the left of a desktop: Shapes (each one, named and picked here), Objects
 * (groups of shapes, which can be opened to edit inside) and the Library (kept for every project; a tap adds an
 * independent copy). Both a shape and an object can be named, and both can be kept in the library.
 */

export type PaneTab = 'shapes' | 'objects' | 'library';

export interface LibraryEntry {
  id: string;
  name: string;
  shapes: number;
  shared: boolean;
  inProject: boolean;
  thumb: string;
}

export interface LeftPaneProps {
  tab: PaneTab;
  onTab: (tab: PaneTab) => void;
  onClose: () => void;
  bodies: Body3D[];
  groups: ShapeGroup[];
  selectedBodyIds: string[];
  /** The group being edited from the inside, if one is. */
  entered: string | null;
  onPickShapes: (ids: string[]) => void;
  onRename: (kind: 'shape' | 'object' | 'item', id: string, name: string) => void;
  onSave: (kind: 'shape' | 'object', id: string) => void;
  onEnter: (groupId: string) => void;
  library: LibraryEntry[];
  onPlaceItem: (id: string) => void;
  onShareItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
}

const sameBodies = (a: Body3D[], b: Body3D[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A small picture of some shapes, redrawn only when one of those shapes changes. */
const Thumb = memo(
  ({ bodies, name }: { bodies: Body3D[]; name: string }) => (
    <img src={thumbnailDataUrl(bodies, 96)} alt="" aria-hidden="true" title={name} className="w-full aspect-square rounded-xl bg-slate-950/70" draggable={false} />
  ),
  (a, b) => a.name === b.name && sameBodies(a.bodies, b.bodies)
);

/** A name that becomes a field when double-clicked (or when asked to by `editing`), and is kept on Enter or on leaving it. */
function Name({ value, label, onCommit }: { value: string; label: string; onCommit: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const keep = () => {
    setEditing(false);
    const next = text.trim();
    if (next && next !== value) onCommit(next);
    else setText(value);
  };
  if (!editing) {
    return (
      <span
        className="block truncate text-[12px] font-medium text-slate-100 cursor-text"
        title={`${value} (double-click to rename)`}
        onDoubleClick={() => { setText(value); setEditing(true); }}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      ref={input}
      value={text}
      aria-label={`Name of ${label}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={keep}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') keep();
        if (e.key === 'Escape') { setText(value); setEditing(false); }
      }}
      className="w-full h-6 rounded-md bg-white/10 border border-accent-400 px-1.5 text-[12px] text-white focus:outline-none"
    />
  );
}

const IconBtn = ({ label, onClick, children, danger, pressed }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; pressed?: boolean }) => (
  <button
    type="button"
    aria-pressed={pressed}
    aria-label={label}
    title={label}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    className={`w-7 h-7 rounded-full flex items-center justify-center text-slate-400 transition-colors ${danger ? 'hover:text-rose-300 hover:bg-rose-500/15' : 'hover:text-white hover:bg-white/10'}`}
  >
    {children}
  </button>
);

function Card({ selected, children, onPick, label }: { selected?: boolean; children: React.ReactNode; onPick: () => void; label: string }) {
  return (
    <div className={`rounded-2xl p-1.5 flex flex-col gap-1 border transition-colors ${selected ? 'bg-accent-500/20 border-accent-400/60' : 'bg-white/5 border-transparent hover:bg-white/8'}`}>
      <button type="button" aria-label={label} aria-pressed={!!selected} onClick={onPick} className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400">
        {(children as React.ReactNode[])[0]}
      </button>
      {(children as React.ReactNode[]).slice(1)}
    </div>
  );
}

export default function LeftPane(props: LeftPaneProps) {
  const { tab, bodies, groups, selectedBodyIds, entered } = props;
  const inJoined = (b: Body3D) => !!b.groupId && groupChain(props.groups, b.groupId).some((g) => g.joined);
  const joined = groups.filter((g) => g.joined && !groupChain(groups, g.parentId).some((x) => x.joined));
  // A joined shape is several pieces acting as one: it is listed once, as a shape.
  const shapes: { id: string; name: string; bodies: Body3D[]; ids: string[]; group?: string; where?: string }[] = [
    ...bodies
      .filter((b) => !b.repeatOf && !inJoined(b))
      .map((b) => ({ id: b.id, name: b.name, bodies: [b], ids: [b.id], where: groups.find((g) => g.id === b.groupId)?.name })),
    ...joined.map((g) => ({ id: g.id, name: g.name, bodies: bodies.filter((b) => g.bodyIds.includes(b.id)), ids: g.bodyIds, group: g.id })),
  ];
  const objects = groups.filter((g) => !g.joined && !g.instanceOf && !groupChain(groups, g.parentId).some((x) => x.joined));
  const picked = (ids: string[]) => ids.length > 0 && ids.length === selectedBodyIds.length && ids.every((i) => selectedBodyIds.includes(i));

  const tabs: { id: PaneTab; label: string; count: number }[] = [
    { id: 'shapes', label: 'Shapes', count: shapes.length },
    { id: 'objects', label: 'Objects', count: objects.length },
    { id: 'library', label: 'Library', count: props.library.length },
  ];

  return (
    <aside aria-label="Parts" className="w-64 shrink-0 min-h-0 flex flex-col bg-slate-900/70 border-r border-white/8">
      <div className="flex items-center gap-1 p-2">
        <div role="tablist" aria-label="Parts" className="flex-1 flex gap-1 p-0.5 rounded-full bg-white/6">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => props.onTab(t.id)}
              className={`flex-1 h-7 rounded-full text-[12px] font-medium transition-colors ${tab === t.id ? 'bg-accent-500 text-white' : 'text-slate-300 hover:text-white'}`}
            >
              {t.label} <span className="opacity-70">{t.count}</span>
            </button>
          ))}
        </div>
        <IconBtn label="Hide the parts pane" onClick={props.onClose}><PanelLeftClose size={15} /></IconBtn>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {tab === 'shapes' && (
          shapes.length === 0
            ? <p className="px-2 py-4 text-xs text-slate-400">No shapes yet. Add one from Shape.</p>
            : <div className="grid grid-cols-2 gap-2">
                {shapes.map((s) => (
                  <Card key={s.id} label={`Pick ${s.name}`} selected={picked(s.ids)} onPick={() => props.onPickShapes(s.ids)}>
                    <Thumb bodies={s.bodies} name={s.name} />
                    <Name value={s.name} label={s.name} onCommit={(n) => props.onRename(s.group ? 'object' : 'shape', s.group ?? s.id, n)} />
                    <div className="flex items-center justify-between">
                      <span className="truncate text-[10px] text-slate-500">{s.where ?? ''}</span>
                      <IconBtn label={`Save ${s.name} to the library`} onClick={() => props.onSave(s.group ? 'object' : 'shape', s.group ?? s.id)}><BookmarkPlus size={14} /></IconBtn>
                    </div>
                  </Card>
                ))}
              </div>
        )}

        {tab === 'objects' && (
          objects.length === 0
            ? <p className="px-2 py-4 text-xs text-slate-400">No objects yet. Select two or more shapes and press Group to make one.</p>
            : <div className="grid grid-cols-2 gap-2">
                {objects.map((g) => {
                  const inside = bodies.filter((b) => g.bodyIds.includes(b.id));
                  return (
                    <Card key={g.id} label={`Pick ${g.name}`} selected={picked(g.bodyIds)} onPick={() => props.onPickShapes(g.bodyIds)}>
                      <Thumb bodies={inside} name={g.name} />
                      <Name value={g.name} label={g.name} onCommit={(n) => props.onRename('object', g.id, n)} />
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-500">{inside.length} {inside.length === 1 ? 'shape' : 'shapes'}</span>
                        <span className="flex">
                          <IconBtn label={entered === g.id ? `Editing inside ${g.name}` : `Edit inside ${g.name}`} onClick={() => props.onEnter(g.id)}><LogIn size={14} /></IconBtn>
                          <IconBtn label={`Save ${g.name} to the library`} onClick={() => props.onSave('object', g.id)}><BookmarkPlus size={14} /></IconBtn>
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
        )}

        {tab === 'library' && (
          props.library.length === 0
            ? <p className="px-2 py-4 text-xs text-slate-400">Nothing saved yet. Use the bookmark on a shape or an object to keep it here for every project.</p>
            : <div className="grid grid-cols-2 gap-2">
                {props.library.map((item) => (
                  <Card key={item.id} label={`Add a copy of ${item.name}`} onPick={() => props.onPlaceItem(item.id)}>
                    <img src={item.thumb} alt="" aria-hidden="true" className="w-full aspect-square rounded-xl bg-slate-950/70" draggable={false} />
                    <Name value={item.name} label={item.name} onCommit={(n) => props.onRename('item', item.id, n)} />
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-500">{item.shapes} {item.shapes === 1 ? 'shape' : 'shapes'}</span>
                      <span className="flex">
                        {item.inProject
                          ? <IconBtn label={item.shared ? `${item.name} is in every project: keep it in this project only` : `Keep ${item.name} in every project`} pressed={item.shared} onClick={() => props.onShareItem(item.id)}><Globe size={14} className={item.shared ? 'text-accent-300' : ''} /></IconBtn>
                          : <span className="w-7 h-7 flex items-center justify-center text-accent-300" title="From the app-wide library"><Globe size={14} /></span>}
                        <IconBtn danger label={item.inProject ? `Remove ${item.name} from this project's library` : `Remove ${item.name} from every project`} onClick={() => props.onRemoveItem(item.id)}><Trash2 size={14} /></IconBtn>
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
        )}
      </div>
    </aside>
  );
}
