/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion } from 'motion/react';
import {
  Boxes,
  Circle,
  Eye,
  EyeOff,
  Focus,
  Hexagon,
  Layers3,
  Combine,
  Ungroup,
  Move3d,
  Octagon,
  PenTool,
  Pentagon,
  Repeat,
  SquareMinus,
  Shapes,
  Square,
  SquareRoundCorner,
  Star,
  Trash2,
  Unlink,
  Triangle,
  TriangleRight,
  type LucideIcon,
  Globe,
} from 'lucide-react';
import { SHAPE_LABELS, ShapeKind } from '../utils/primitives';
import MenuButton from './Menu';
import { spring } from './controls';

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

interface BottomBarProps {
  openId: string | null;
  setOpenId: (id: string | null) => void;
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
  /** The selected shape has a live repeat, so Organize can let its copies go. */
  repeated: boolean;
  onBreakRepeat: () => void;
  onPattern: () => void;
  onDelete: () => void;
}

interface Tool {
  label: string;
  key: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
  active?: boolean;
  danger?: boolean;
}

/** The tools: one Shape tool that opens the shape list, then the commands. */
export default function BottomBar(props: BottomBarProps) {
  const { selectedCount, bodyCount } = props;
  const tools: Tool[] = [
    { label: 'Draw', key: 'D', icon: PenTool, onClick: props.onDraw, active: props.drawOn },
    { label: 'Move', key: 'M', icon: Move3d, onClick: props.onToggleMove, active: props.moveOn, disabled: selectedCount < 1, hint: 'Select a shape' },
    { label: props.grouped ? 'Ungroup' : 'Group', key: 'G', icon: props.grouped ? Ungroup : Boxes, onClick: props.onGroup, disabled: !props.grouped && selectedCount < 2, hint: 'Hold a shape to add it' },
    { label: 'Repeat', key: 'R', icon: Repeat, onClick: props.onPattern, active: props.repeatOn, disabled: !props.repeatOn && selectedCount < 1, hint: 'Select a shape' },
  ];
  const organize: Tool[] = [
    { label: 'Join', key: 'J', icon: Combine, onClick: props.onJoin, disabled: selectedCount < 2, hint: 'Hold a shape to add it' },
    { label: 'Subtract', key: 'S', icon: SquareMinus, onClick: props.onSubtract, disabled: selectedCount < 2, hint: 'Hold a shape to add it' },
    { label: props.isolated ? 'Show everything' : 'Isolate', key: 'I', icon: Focus, onClick: props.onIsolate, active: props.isolated, disabled: !props.isolated && selectedCount < 1, hint: 'Select a shape' },
    { label: 'Hide', key: 'H', icon: EyeOff, onClick: props.onHide, disabled: selectedCount < 1, hint: 'Select a shape' },
    ...(props.repeated ? [{ label: 'Make copies separate', key: '', icon: Unlink, onClick: props.onBreakRepeat } as Tool] : []),
    ...(props.hiddenCount > 0 ? [{ label: `Show hidden (${props.hiddenCount})`, key: '', icon: Eye, onClick: props.onShowHidden } as Tool] : []),
  ];
  const deleteTool: Tool = { label: 'Delete', key: 'Del', icon: Trash2, onClick: props.onDelete, disabled: selectedCount < 1, hint: 'Select a shape', danger: true };

  const renderTool = (t: Tool) => {
        const Icon = t.icon;
        return (
          <motion.button
            key={t.label}
            type="button"
            onClick={t.onClick}
            disabled={t.disabled}
            aria-label={t.label}
            aria-pressed={t.active || undefined}
            title={t.disabled && t.hint ? `${t.label} · ${t.hint}` : `${t.label} (${t.key})`}
            whileHover={t.disabled ? undefined : { scale: 1.05 }}
            whileTap={t.disabled ? undefined : { scale: 0.92 }}
            transition={spring}
            className={`shrink-0 h-[46px] w-[46px] sm:h-9 sm:w-auto sm:px-3.5 rounded-full flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 text-[9.5px] sm:text-[13px] leading-none font-medium transition-colors ${
              t.active
                ? 'bg-accent-500 text-white shadow-md shadow-accent-500/30'
                : t.danger
                  ? 'bg-white/6 text-slate-200 hover:bg-rose-500/20 hover:text-rose-300 disabled:bg-transparent'
                  : 'bg-white/6 text-slate-200 hover:bg-white/12 hover:text-white disabled:bg-transparent'
            } disabled:text-slate-600 disabled:pointer-events-none`}
          >
            <Icon size={17} strokeWidth={1.75} />
            <span>{t.label}</span>
          </motion.button>
        );
      };

  return (
    <nav aria-label="Tools" className="shrink-0 h-[calc(4rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] bg-slate-900 border-t border-white/8 z-40 flex items-center justify-evenly sm:justify-center sm:gap-1.5 px-2 sm:px-3">
      <MenuButton id="shapes" openId={props.openId} setOpenId={props.setOpenId} label="Shape" icon={Shapes} placement="up" title="Add a shape" stackedOnMobile>
        <div className="p-3 w-[min(19rem,calc(100vw-1.5rem))]">
          <p className="px-2 pb-2 text-xs text-slate-400">{props.addOnTop ? 'Adds on top of the selected face' : 'Add a shape'}</p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((kind, i) => {
              const Icon = SHAPE_ICONS[kind];
              return (
                <motion.button
                  key={kind}
                  type="button"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ ...spring, delay: i * 0.025 }}
                  whileHover={{ scale: 1.06 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => {
                    props.onAddShape(kind);
                    props.setOpenId(null);
                  }}
                  className="h-20 rounded-[1.4rem] bg-white/6 hover:bg-white/12 flex flex-col items-center justify-center gap-1.5 text-slate-200 hover:text-white transition-colors"
                >
                  <Icon size={24} strokeWidth={1.6} />
                  <span className="text-[11px]">{SHAPE_LABELS[kind]}</span>
                </motion.button>
              );
            })}
          </div>
          {props.library.length > 0 && (
            <div className="mt-3 pt-3 border-t border-white/8">
              <p className="px-2 pb-2 text-xs text-slate-400">Your objects · placed copies stay linked · globe = in every project</p>
              <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                {props.library.map((item) => (
                  <div key={item.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        props.onPlaceItem(item.id);
                        props.setOpenId(null);
                      }}
                      className="flex-1 min-w-0 h-14 pl-2 pr-4 rounded-full bg-white/6 hover:bg-white/12 text-left text-sm font-medium text-slate-100 flex items-center gap-2.5 transition-colors"
                    >
                      <img src={item.thumb} alt="" width={44} height={44} className="w-11 h-11 shrink-0 rounded-full bg-slate-950/60" draggable={false} />
                      <span className="truncate">{item.name}</span>
                      <span className="ml-auto text-[11px] text-slate-400">{item.shapes} {item.shapes === 1 ? 'shape' : 'shapes'}</span>
                    </button>
                    {item.inProject ? (
                      <button
                        type="button"
                        onClick={() => props.onShareItem(item.id)}
                        aria-pressed={item.shared}
                        aria-label={item.shared ? `${item.name} is in every project: tap to keep it in this project only` : `Keep ${item.name} in every project`}
                        title={item.shared ? 'In every project (tap to keep it only here)' : 'Keep in every project'}
                        className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center transition-colors ${item.shared ? 'bg-accent-500/25 text-accent-200' : 'text-slate-400 hover:text-white hover:bg-white/10'}`}
                      >
                        <Globe size={16} />
                      </button>
                    ) : (
                      <span className="w-11 h-11 shrink-0 flex items-center justify-center text-accent-200" title="From the app-wide library"><Globe size={16} /></span>
                    )}
                    <button
                      type="button"
                      onClick={() => props.onRemoveItem(item.id)}
                      aria-label={item.inProject ? `Remove ${item.name} from this project's library` : `Remove ${item.name} from every project`}
                      title={item.inProject ? 'Remove from this project (placed copies stay as shapes)' : 'Remove from every project'}
                      className="w-11 h-11 shrink-0 rounded-full text-slate-400 hover:text-rose-300 hover:bg-rose-500/15 flex items-center justify-center transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </MenuButton>

      <div className="hidden sm:block shrink-0 w-px h-6 bg-white/10 mx-1" />

      {tools.map(renderTool)}

      <MenuButton id="organize" openId={props.openId} setOpenId={props.setOpenId} label="Organize" icon={Layers3} placement="up" title="Join, isolate, hide" stackedOnMobile>
        <div className="p-2 flex flex-col gap-1 w-[min(15rem,calc(100vw-1.5rem))]">
          {organize.map((t, i) => {
            const Icon = t.icon;
            return (
              <motion.button
                key={t.label}
                type="button"
                disabled={t.disabled}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...spring, delay: i * 0.03 }}
                onClick={() => {
                  t.onClick();
                  props.setOpenId(null);
                }}
                className={`h-11 px-3 rounded-full flex items-center gap-3 text-sm font-medium transition-colors disabled:text-slate-600 disabled:pointer-events-none ${
                  t.active ? 'bg-accent-500 text-white' : 'text-slate-100 hover:bg-white/10'
                }`}
              >
                <Icon size={17} strokeWidth={1.75} />
                <span>{t.label}</span>
                {t.key && <kbd className="ml-auto text-[11px] text-slate-400 font-sans">{t.key}</kbd>}
              </motion.button>
            );
          })}
        </div>
      </MenuButton>

      {renderTool(deleteTool)}
    </nav>
  );
}
