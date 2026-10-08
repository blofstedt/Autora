/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookmarkPlus, Box, FileDown, Link2, Move, Pencil, Unlink, SquareDashed, Palette, Redo2, SlidersHorizontal, Trash2, Undo2, X } from 'lucide-react';
import { BevelStyle, Body3D, EdgeSel, FaceSel } from '../types';
import { describeEdges, edgeSize, edgesOfKind, edgeStyle, isWholeGroup, MAX_BEVEL_SIZE, maxBevelSize, primaryEdge, type EdgeGroup } from '../utils/edges';
import { selectionBounds } from '../utils/transform';
import MenuButton from './Menu';
import Sidebar from './Sidebar';
import { IconButton, NumberBox, Segmented, StepButton, signed, spring } from './controls';

type SidebarProps = React.ComponentProps<typeof Sidebar>;

interface TopBarProps {
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

/** A small labelled button for an action on the selected object. */
const PillButton = ({ icon: Icon, label, onClick, title }: { icon: React.ComponentType<{ size?: number; strokeWidth?: number }>; label: string; onClick: () => void; title: string }) => (
  <motion.button
    type="button"
    onClick={onClick}
    title={title}
    whileTap={{ scale: 0.92 }}
    transition={spring}
    className="shrink-0 h-8 px-3 rounded-full bg-white/8 hover:bg-white/14 text-[13px] font-medium text-slate-100 flex items-center gap-1.5 transition-colors"
  >
    <Icon size={15} strokeWidth={1.75} />
    {label}
  </motion.button>
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
function SizePositionPanel({ selected, onMove, onResize, onUpdateBody }: Pick<TopBarProps, 'selected' | 'onMove' | 'onResize' | 'onUpdateBody'>) {
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

export default function TopBar(props: TopBarProps) {
  const { selected, edges, face, openId, setOpenId } = props;
  const body = selected.length === 1 ? selected[0] : null;

  let mode = 'none';
  if (body && edges.length) mode = 'edge';
  else if (body && face && face.bodyId === body.id) mode = 'face';
  else if (body && !props.group) mode = 'shape';
  else if (selected.length > 1 || props.group) mode = 'multi';

  const dynamic = (() => {
    if (mode === 'edge' && body) {
      const onlyCorners = edges.every((e) => e.kind === 'corner');
      const size = edgeSize(body, primaryEdge(edges));
      const style = edgeStyle(body, edges.find((e) => e.kind !== 'corner') ?? edges[0]) ?? 'round';
      const most = onlyCorners ? MAX_BEVEL_SIZE : maxBevelSize(body, edges);
      const set = (v: number) => props.onEdgeChange(edges, { size: Math.max(0, Math.min(most, v)) });
      return (
        <>
          <Chip sub={describeEdges(body, edges).sub}>{describeEdges(body, edges).title}</Chip>
          <NumberBox label={onlyCorners ? 'Radius' : 'Size'} value={size} step={0.5} min={0} max={most} onCommit={set} />
          {!onlyCorners && (
            <Segmented
              id="bar-profile"
              label="Edge profile"
              // With no bevel yet neither profile is lit: nothing is chosen until one is.
              value={size > 0 ? style : ('' as typeof style)}
              onChange={(v) => props.onEdgeChange(edges, { style: v })}
              options={[
                { value: 'round', label: 'Curved' },
                { value: 'chamfer', label: 'Flat' },
              ]}
            />
          )}
          <MenuButton id="edge-select" openId={openId} setOpenId={setOpenId} label="Select" icon={SquareDashed} placement="down" title="Select edges in bulk">
            <div className="p-2 flex flex-col gap-1 w-[min(15rem,calc(100vw-1.5rem))]">
              {(
                [
                  ['top', 'Top edges'],
                  ['bottom', 'Bottom edges'],
                  ['corner', 'Vertical corners'],
                  ['all', 'All edges'],
                ] as [EdgeGroup, string][]
              ).map(([group, text]) => (
                <button
                  key={group}
                  type="button"
                  onClick={() => {
                    props.onSelectEdges(edgesOfKind(body, group));
                    setOpenId(null);
                  }}
                  className={`h-11 px-4 rounded-full text-left text-sm font-medium transition-colors ${
                    isWholeGroup(body, edges, group) ? 'bg-accent-500 text-white' : 'text-slate-100 hover:bg-white/10'
                  }`}
                >
                  {text}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  props.onClearEdges();
                  setOpenId(null);
                }}
                className="h-11 px-4 rounded-full text-left text-sm font-medium text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
              >
                Clear
              </button>
            </div>
          </MenuButton>
          <IconButton icon={Trash2} label="Remove bevel (Del)" onClick={() => props.onEdgeChange(edges, { size: 0 })} danger />
          <IconButton icon={X} label="Done (Esc)" onClick={props.onClearEdges} />
        </>
      );
    }
    if (mode === 'face' && body && face) {
      const elev = body.elevation ?? 0;
      return (
        <>
          <Chip sub={body.name}>{face.kind === 'top' ? 'Top face' : face.kind === 'bottom' ? 'Bottom face' : `Wall ${(face.index ?? 0) + 1}`}</Chip>
          {face.kind === 'top' && <NumberBox label="Height" value={body.extrusionHeight} min={2} max={600} onCommit={(v) => props.onExtrudeFace(face, v - body.extrusionHeight)} />}
          {face.kind === 'bottom' && <NumberBox label="Bottom at" value={elev} min={0} onCommit={(v) => props.onExtrudeFace(face, elev - Math.max(0, v))} />}
          <div className="flex items-center gap-1">
            {[-10, -1, 1, 10].map((n) => (
              <StepButton key={n} onClick={() => props.onExtrudeFace(face, n)} title={`${n > 0 ? 'Pull out' : 'Push in'} ${Math.abs(n)} mm`}>
                {signed(n)}
              </StepButton>
            ))}
          </div>
          <IconButton icon={X} label="Done (Esc)" onClick={props.onClearFace} />
          <MenuButton id="size" openId={openId} setOpenId={setOpenId} label="Size & position" icon={Move} placement="down">
            <SizePositionPanel {...props} />
          </MenuButton>
          <MenuButton id="material" openId={openId} setOpenId={setOpenId} label="Material" icon={Palette} placement="down">
            <Sidebar {...props.sidebar} section="material" />
          </MenuButton>
          {props.canSave && <PillButton icon={BookmarkPlus} label="Save to library" onClick={props.onSaveToLibrary} title="Keep this object in the project library so you can place linked copies" />}
        </>
      );
    }
    if (mode === 'shape' && body) {
      return (
        <>
          <MenuButton id="props" openId={openId} setOpenId={setOpenId} label={body.name} icon={SlidersHorizontal} placement="down" title="Shape properties">
            <Sidebar {...props.sidebar} section="properties" />
          </MenuButton>
          <MenuButton id="size" openId={openId} setOpenId={setOpenId} label="Size & position" icon={Move} placement="down">
            <SizePositionPanel {...props} />
          </MenuButton>
          <MenuButton id="material" openId={openId} setOpenId={setOpenId} label="Material" icon={Palette} placement="down">
            <Sidebar {...props.sidebar} section="material" />
          </MenuButton>
        </>
      );
    }
    if (mode === 'multi') {
      return (
        <>
          {props.group ? (
            <GroupName key={props.group.id} name={props.group.name} onRename={(n) => props.onRenameGroup(props.group!.id, n)} />
          ) : (
            <Chip sub={props.joined ? 'Joined · moves as one' : 'Drag one to move them all'}>{props.joined ? selected[0].name : `${selected.length} shapes`}</Chip>
          )}
          {props.object?.state === 'linked' && (
            <>
              <span className="shrink-0 text-[11px] text-slate-400 flex items-center gap-1 whitespace-nowrap">
                <Link2 size={13} /> Linked to “{props.object.item}”
              </span>
              <PillButton icon={Pencil} label="Edit" onClick={props.onEditObject} title="Open this object for editing: save it back and every copy follows" />
              <PillButton icon={Unlink} label="Separate" onClick={props.onSeparateObject} title="Make this copy independent of the library" />
            </>
          )}
          {props.object?.state === 'editing' && (
            <>
              <PillButton icon={BookmarkPlus} label={`Save to “${props.object.item}”`} onClick={props.onSaveToLibrary} title="Update the library object: every linked copy follows" />
              <PillButton icon={Unlink} label="Separate" onClick={props.onSeparateObject} title="Forget the library object: this stays as plain shapes" />
            </>
          )}
          {!props.object && props.canSave && <PillButton icon={BookmarkPlus} label="Save to library" onClick={props.onSaveToLibrary} title="Keep this object in the project library so you can place linked copies" />}
          <MenuButton id="size" openId={openId} setOpenId={setOpenId} label="Position" icon={Move} placement="down">
            <SizePositionPanel {...props} />
          </MenuButton>
        </>
      );
    }
    return <span className="text-[13px] text-slate-500 whitespace-nowrap">Tap a shape to see its properties</span>;
  })();

  return (
    <header className="h-14 shrink-0 px-3 flex items-center gap-2 bg-slate-900 border-b border-white/8 z-40">
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="w-8 h-8 rounded-full bg-accent-500 flex items-center justify-center text-white">
          <Box size={16} strokeWidth={2} />
        </div>
        <IconButton icon={Undo2} label="Undo (⌘Z)" onClick={props.onUndo} />
        <IconButton icon={Redo2} label="Redo (⇧⌘Z)" onClick={props.onRedo} />
      </div>

      <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.08 } }}
            transition={spring}
            className="flex items-center justify-start sm:justify-center gap-2 min-w-max sm:min-w-0 sm:px-2"
          >
            {dynamic}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <MenuButton id="file" openId={openId} setOpenId={setOpenId} icon={FileDown} placement="down" title="Export and file">
          <Sidebar {...props.sidebar} section="export" />
        </MenuButton>
      </div>
    </header>
  );
}
