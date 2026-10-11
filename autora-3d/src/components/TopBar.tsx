/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Link2, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { BevelStyle, Body3D, EdgeSel, FaceSel } from '../types';
import { describeEdges, edgesOfKind, isWholeGroup, type EdgeGroup } from '../utils/edges';
import { selectionBounds } from '../utils/transform';
import Sidebar from './Sidebar';
import { IconButton, NumberBox, StepButton, signed } from './controls';

type SidebarProps = React.ComponentProps<typeof Sidebar>;

export interface TopBarProps {
  openId: string | null;
  setOpenId: (id: string | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  selected: Body3D[];
  /** The selection is one joined shape made of several pieces. */
  joined: boolean;
  edges: EdgeSel[];
  face: FaceSel | null;
  onEdgeChange: (edges: EdgeSel[], patch: { size?: number; style?: BevelStyle }) => void;
  onClearEdges: () => void;
  onSelectEdges: (edges: EdgeSel[]) => void;
  onExtrudeFace: (face: FaceSel, delta: number) => void;
  onClearFace: () => void;
  onMove: (dx: number, dy: number, dz: number) => void;
  onResize: (width: number, depth: number) => void;
  onUpdateBody: (id: string, updates: Partial<Body3D>) => void;
  /** The selection is exactly one group: its name can be changed right here. */
  group?: { id: string; name: string };
  onRenameGroup: (id: string, name: string) => void;
  /** The selected group's relation to the library: a linked copy, open for editing, or neither. */
  object?: { state: 'linked' | 'editing'; item: string };
  /** The selection can be saved to the library (a group, or one ungrouped shape). */
  canSave: boolean;
  onSaveToLibrary: () => void;
  onEditObject: () => void;
  onSeparateObject: () => void;
  sidebar: Omit<SidebarProps, 'section'>;
}

const Chip = ({ children, sub }: { children: React.ReactNode; sub?: string }) => (
  <div className="shrink-0 px-1 leading-tight">
    <div className="text-sm font-semibold text-white whitespace-nowrap">{children}</div>
    {sub && <div className="text-[11px] text-slate-400 whitespace-nowrap">{sub}</div>}
  </div>
);

/** A group's name, changed by tapping it. Saves on Enter or when you tap away; Escape keeps the old one. */
function GroupName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const done = (keep: boolean) => {
    if (keep && draft !== null && draft.trim() && draft.trim() !== name) onRename(draft.trim());
    setDraft(null);
  };
  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft(name)} className="shrink-0 px-1 leading-tight text-left" title="Tap to rename">
        <div className="text-sm font-semibold text-white whitespace-nowrap">{name}</div>
        <div className="text-[11px] text-slate-400 whitespace-nowrap">Tap to rename · tap a shape again to pick one part</div>
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      }}
      className="h-8 w-40 px-2 rounded-lg bg-slate-800 text-sm text-white outline-none ring-1 ring-accent-500"
      aria-label="Group name"
    />
  );
}

/** Width, depth, height and where it is: all typed in one small menu. */
export function SizePositionPanel({ selected, onMove, onResize, onUpdateBody }: Pick<TopBarProps, 'selected' | 'onMove' | 'onResize' | 'onUpdateBody'>) {
  const b = selectionBounds(selected);
  if (!b) return null;
  const single = selected.length === 1 ? selected[0] : null;
  const width = b.maxX - b.minX;
  const depth = b.maxY - b.minY;
  // A shape on a wall is measured across the wall, up it, and out from it.
  const onWall = !!single?.frame;
  const walled = selected.some((x) => x.frame);
  return (
    <div className="p-4 flex flex-col gap-3 w-[min(19rem,calc(100vw-1.5rem))]">
      {single && (
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1.5">Size (mm)</p>
          <div className="flex gap-2">
            <NumberBox label={onWall ? 'Across' : 'Width'} value={width} min={1} onCommit={(v) => onResize(v, depth)} />
            <NumberBox label={onWall ? 'Up' : 'Depth'} value={depth} min={1} onCommit={(v) => onResize(width, v)} />
            <NumberBox
              label={onWall ? 'Out' : 'Height'}
              value={single.extrusionHeight}
              min={2}
              max={600}
              onCommit={(v) => onUpdateBody(single.id, { extrusionHeight: Math.max(2, Math.min(600, Math.round(v))) })}
            />
          </div>
        </div>
      )}
      {!walled && (
      <div>
        <p className="text-xs font-medium text-slate-400 mb-1.5">Position (mm)</p>
        <div className="flex gap-2">
          <NumberBox label="X" value={b.centerX} onCommit={(v) => onMove(v - b.centerX, 0, 0)} />
          <NumberBox label="Y" value={b.centerY} onCommit={(v) => onMove(0, v - b.centerY, 0)} />
          <NumberBox label="Z" value={b.minElevation} min={0} onCommit={(v) => onMove(0, 0, Math.max(0, v) - b.minElevation)} />
        </div>
      </div>
      )}
    </div>
  );
}

/** What the selection is, for the bar's title and for which panel the rail opens by itself. */
export function selectionMode(props: Pick<TopBarProps, 'selected' | 'edges' | 'face' | 'group'>): 'none' | 'edge' | 'face' | 'shape' | 'multi' {
  const { selected, edges, face } = props;
  const body = selected.length === 1 ? selected[0] : null;
  if (body && edges.length) return 'edge';
  if (body && face && face.bodyId === body.id) return 'face';
  if (body && !props.group) return 'shape';
  if (selected.length > 1 || props.group) return 'multi';
  return 'none';
}

/** Picking edges in bulk, and taking a bevel off. The bevel's size and profile are the model's own floating card, not repeated here. */
export function EdgePanel(props: TopBarProps) {
  const { selected, edges } = props;
  const body = selected[0];
  if (!body || !edges.length) return null;
  return (
    <div className="p-4 flex flex-col gap-3 w-[min(19rem,calc(100vw-1.5rem))]">
      <Chip sub={describeEdges(body, edges).sub}>{describeEdges(body, edges).title}</Chip>
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['top', 'Top'],
            ['bottom', 'Bottom'],
            ['corner', 'Corners'],
            ['all', 'All'],
          ] as [EdgeGroup, string][]
        ).map(([group, text]) => (
          <button
            key={group}
            type="button"
            onClick={() => props.onSelectEdges(edgesOfKind(body, group))}
            className={`h-8 px-3 rounded-full text-[13px] font-medium transition-colors ${isWholeGroup(body, edges, group) ? 'bg-accent-500 text-white' : 'bg-white/6 text-slate-100 hover:bg-white/12'}`}
          >
            {text}
          </button>
        ))}
        <button type="button" onClick={props.onClearEdges} className="h-8 px-3 rounded-full text-[13px] font-medium text-slate-400 hover:bg-white/10 hover:text-white transition-colors">Clear</button>
        <button type="button" onClick={() => props.onEdgeChange(edges, { size: 0 })} className="h-8 px-3 rounded-full text-[13px] font-medium text-rose-300 hover:bg-rose-500/15 transition-colors">Remove bevel</button>
      </div>
    </div>
  );
}

/** Pushing or pulling the picked face in set steps. The typed height is the model's own floating card, not repeated here. */
export function FacePanel(props: TopBarProps) {
  const { selected, face } = props;
  const body = selected[0];
  if (!body || !face) return null;
  return (
    <div className="p-4 flex flex-col gap-3 w-[min(19rem,calc(100vw-1.5rem))]">
      <Chip sub={body.name}>{face.kind === 'top' ? 'Top face' : face.kind === 'bottom' ? 'Bottom face' : `Wall ${(face.index ?? 0) + 1}`}</Chip>
      <div className="flex items-center gap-1.5">
        {[-10, -1, 1, 10].map((n) => (
          <StepButton key={n} onClick={() => props.onExtrudeFace(face, n)} title={`${n > 0 ? 'Pull out' : 'Push in'} ${Math.abs(n)} mm`}>
            {signed(n)}
          </StepButton>
        ))}
        <span className="text-xs text-slate-400 ml-1">mm</span>
      </div>
    </div>
  );
}

/**
 * The slim top bar: what the app is, undo and redo, and what is selected. Every tool is on the rail (Rail.tsx), none is
 * repeated here; a group's name stays a field because it is text, not a tool.
 */
export default function TopBar(props: TopBarProps) {
  const { selected } = props;
  const body = selected.length === 1 ? selected[0] : null;
  const mode = selectionMode(props);
  const title =
    mode === 'edge' ? <Chip sub={describeEdges(body!, props.edges).sub}>{describeEdges(body!, props.edges).title}</Chip>
    : mode === 'face' ? <Chip sub={body!.name}>{props.face!.kind === 'top' ? 'Top face' : props.face!.kind === 'bottom' ? 'Bottom face' : `Wall ${(props.face!.index ?? 0) + 1}`}</Chip>
    : mode === 'shape' ? <Chip>{body!.name}</Chip>
    : mode === 'multi' ? (
      props.group ? <GroupName key={props.group.id} name={props.group.name} onRename={(n) => props.onRenameGroup(props.group!.id, n)} />
      : <Chip sub={props.joined ? 'Joined · moves as one' : 'Drag one to move them all'}>{props.joined ? selected[0].name : `${selected.length} shapes`}</Chip>
    ) : null;
  return (
    <header className="h-12 shrink-0 px-3 flex items-center gap-2 bg-slate-900 border-b border-white/8 z-40">
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="w-8 h-8 rounded-full bg-accent-500 flex items-center justify-center text-white">
          <Box size={16} strokeWidth={2} />
        </div>
        <IconButton icon={Undo2} label="Undo (⌘Z)" onClick={props.onUndo} />
        <IconButton icon={Redo2} label="Redo (⇧⌘Z)" onClick={props.onRedo} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">{title}</div>
      {props.object?.state === 'linked' && (
        <span className="shrink-0 text-[11px] text-slate-400 hidden sm:flex items-center gap-1 whitespace-nowrap"><Link2 size={13} /> Linked to “{props.object.item}”</span>
      )}
      {mode !== 'none' && (
        <IconButton icon={X} label="Deselect (Esc)" onClick={() => { props.onClearEdges(); props.onClearFace(); }} />
      )}
    </header>
  );
}
