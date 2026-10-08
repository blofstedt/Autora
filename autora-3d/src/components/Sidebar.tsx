/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Box,
  Boxes,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Focus,
  Merge,
  RotateCcw,
  Sparkles,
  Trash2,
  Ungroup,
} from 'lucide-react';
import { Body3D, EdgeSel, MATERIAL_PRESETS, ShapeGroup, SWATCHES } from '../types';
import { listFeatures } from '../utils/edges';
import { getPolygonSignedArea } from '../utils/geometry';
import { exportGLB, exportJSON, exportOBJ, exportSTL } from '../utils/exporters';

interface SidebarProps {
  bodies: Body3D[];
  isolatedIds: string[] | null;
  selectedBodyId: string | null;
  selectedBodyIds: string[];
  onSelectBody: (id: string | null, isMultiSelect?: boolean) => void;
  onUpdateBody: (id: string, updates: Partial<Body3D>) => void;
  onDeleteBody: (id: string) => void;
  onCloneBody: (id: string) => void;
  onClearWorkspace: () => void;
  onLoadDemo: () => void;
  groups: ShapeGroup[];
  onGroupSelected: () => void;
  onUngroup: (groupId: string) => void;
  onMergeSelected: () => void;
  onApplyCornerRadius: (id: string, radius: number) => void;
  onEditEdge: (sel: EdgeSel) => void;
  onRemoveEdge: (sel: EdgeSel) => void;
  onIsolate: (id: string) => void;
  onShowAll: () => void;
  /** Show only this section, without the header and tabs (used inside the bar menus). */
  section?: Tab;
}

export type Tab = 'properties' | 'material' | 'export';

const TABS: { id: Tab; label: string }[] = [
  { id: 'properties', label: 'Properties' },
  { id: 'material', label: 'Material' },
  { id: 'export', label: 'Export' },
];

const fieldClass =
  'h-8 rounded-full bg-white/6 border border-white/8 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-accent-400 focus:bg-white/8 transition-colors';

const secondaryButton =
  'h-9 px-3 rounded-full bg-white/6 hover:bg-white/10 border border-white/8 text-sm font-medium text-slate-100 flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-400">{label}</label>
      {children}
    </div>
  );
}

interface NumberSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Values outside [min, max] are still accepted via the number field. */
  hardMax?: number;
  onChange: (value: number) => void;
}

function NumberSlider({ label, value, min, max, step = 1, hardMax = max, onChange }: NumberSliderProps) {
  const clampValue = (v: number) => Math.max(min, Math.min(hardMax, v));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={min}
            max={hardMax}
            step={step}
            value={value}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!Number.isNaN(v)) onChange(clampValue(v));
            }}
            aria-label={label}
            className={`${fieldClass} w-16 text-right tabular-nums`}
          />
          <span className="text-xs text-slate-500 w-5">mm</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={Math.max(max, value)}
        step={step}
        value={value}
        onChange={(e) => onChange(clampValue(parseFloat(e.target.value)))}
        aria-label={`${label} slider`}
        style={{ ["--fill" as string]: `${((value - min) / Math.max(1, Math.max(max, value) - min)) * 100}%` }}
        className="w-full h-1.5 cursor-pointer"
      />
    </div>
  );
}

function bodyStats(body: Body3D) {
  const area = (ring: { x: number; y: number }[]) => (ring.length < 3 ? 0 : Math.abs(getPolygonSignedArea(ring)));
  const footprint = Math.max(0, area(body.points) - (body.holes ?? []).reduce((sum, h) => sum + area(h), 0));
  const xs = body.points.map((p) => p.x);
  const ys = body.points.map((p) => p.y);
  return {
    width: Math.round(Math.max(...xs) - Math.min(...xs)),
    depth: Math.round(Math.max(...ys) - Math.min(...ys)),
    height: Math.round(body.extrusionHeight),
    area: Math.round(footprint),
    volume: Math.round(footprint * body.extrusionHeight),
  };
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-12 px-4">
      <div className="w-10 h-10 rounded-full bg-white/6 flex items-center justify-center text-slate-400">
        <Box size={20} strokeWidth={1.5} />
      </div>
      <p className="text-sm font-medium text-slate-200">{title}</p>
      <p className="text-xs text-slate-500 max-w-52 leading-relaxed">{text}</p>
    </div>
  );
}

export default function Sidebar({
  bodies,
  isolatedIds,
  selectedBodyId,
  selectedBodyIds,
  onSelectBody,
  onUpdateBody,
  onDeleteBody,
  onCloneBody,
  onClearWorkspace,
  onLoadDemo,
  groups,
  onGroupSelected,
  onUngroup,
  onMergeSelected,
  onApplyCornerRadius,
  onEditEdge,
  onRemoveEdge,
  onIsolate,
  onShowAll,
  section,
}: SidebarProps) {
  const [tabState, setTab] = useState<Tab>('properties');
  const tab = section ?? tabState;
  const [exportNote, setExportNote] = useState<string | null>(null);
  const body = bodies.find((b) => b.id === selectedBodyId) || null;
  const stats = body ? bodyStats(body) : null;
  const features = body ? listFeatures(body) : [];

  const runExport = (fn: (b: Body3D[]) => boolean | void) => {
    const ok = fn(bodies);
    setExportNote(ok === false ? 'Nothing visible to export.' : null);
  };

  return (
    <div className={`flex flex-col min-h-0 text-slate-100 ${section ? 'w-[min(20rem,calc(100vw-1.5rem))]' : 'h-full'}`}>
      {!section && (
      <div className="px-4 pt-3.5 pr-14 md:pr-4 shrink-0">
        <h2 className="text-sm font-semibold tracking-tight">Inspector</h2>
        <p className="text-xs text-slate-500">
          {bodies.length} {bodies.length === 1 ? 'body' : 'bodies'}
          {selectedBodyIds.length > 1 && ` · ${selectedBodyIds.length} selected`}
        </p>
      </div>
      )}

      {!section && (
      <div role="tablist" className="flex gap-1 px-3 mt-3 border-b border-white/8 shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`relative px-2.5 pb-2.5 pt-1 text-[13px] font-medium transition-colors ${
              tab === t.id ? 'text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
            {tab === t.id && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-accent-400" />}
          </button>
        ))}
      </div>
      )}

      <div className={`min-h-0 p-4 flex flex-col gap-5 ${section ? '' : 'flex-1 overflow-y-auto'}`}>
        {/* ---------------- Properties ---------------- */}
        {tab === 'properties' &&
          (body && stats ? (
            <>
              <Field label="Name">
                <input
                  type="text"
                  value={body.name}
                  onChange={(e) => onUpdateBody(body.id, { name: e.target.value })}
                  className={fieldClass}
                />
              </Field>

              <NumberSlider
                label="Height"
                value={body.extrusionHeight}
                min={2}
                max={250}
                hardMax={600}
                onChange={(v) => onUpdateBody(body.id, { extrusionHeight: v })}
              />

              {!body.frame && (
              <NumberSlider
                label="Elevation"
                value={body.elevation ?? 0}
                min={0}
                max={200}
                hardMax={1000}
                onChange={(v) => onUpdateBody(body.id, { elevation: v })}
              />
              )}

              <NumberSlider
                label="All corners"
                value={Math.round(Math.max(0, ...(body.cornerRadii ?? [0])))}
                min={0}
                max={30}
                onChange={(v) => onApplyCornerRadius(body.id, v)}
              />

              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-slate-400">Beveled edges</span>
                {features.length === 0 ? (
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Nothing is beveled. Click an edge in the 3D view to bevel just that edge.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {features.map((f) => (
                      <li key={`${f.sel.kind}:${f.sel.index}`} className="h-9 pl-3 pr-1 rounded-lg bg-white/4 flex items-center justify-between text-sm">
                        <button type="button" onClick={() => onEditEdge(f.sel)} className="flex-1 min-w-0 text-left flex items-baseline gap-2 hover:text-white" title="Show and edit this edge">
                          <span className="truncate">{f.label}</span>
                          <span className="text-xs text-slate-500 shrink-0">{f.detail}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemoveEdge(f.sel)}
                          aria-label={`Remove ${f.label}`}
                          className="w-7 h-7 rounded-full text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {body.holes && body.holes.length > 0 && (
                <div className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-xs">
                  <span className="text-slate-300">
                    {body.holes.length} {body.holes.length === 1 ? 'cutout' : 'cutouts'}
                  </span>
                  <button
                    type="button"
                    onClick={() => onUpdateBody(body.id, { holes: [] })}
                    className="text-accent-300 hover:text-accent-200 font-medium"
                  >
                    Fill in
                  </button>
                </div>
              )}

              <div className="rounded-xl bg-white/4 border border-white/6 p-3">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ['Width', stats.width],
                    ['Depth', stats.depth],
                    ['Height', stats.height],
                  ].map(([label, v]) => (
                    <div key={label}>
                      <div className="text-[11px] text-slate-500">{label}</div>
                      <div className="text-sm font-semibold tabular-nums">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2.5 pt-2.5 border-t border-white/6 flex justify-between text-xs text-slate-400">
                  <span>
                    Area <span className="text-slate-200 tabular-nums">{stats.area.toLocaleString()}</span> mm²
                  </span>
                  <span>
                    Volume <span className="text-slate-200 tabular-nums">{stats.volume.toLocaleString()}</span> mm³
                  </span>
                </div>
              </div>

              <div className="flex gap-2">
                <button type="button" onClick={() => onCloneBody(body.id)} className={`${secondaryButton} flex-1`}>
                  <Copy size={14} /> Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteBody(body.id)}
                  aria-label="Delete body"
                  className={`${secondaryButton} text-rose-300 hover:bg-rose-500/15 w-9 px-0`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </>
          ) : (
            <EmptyState title="Nothing selected" text="Click a body in the viewport or the Bodies list to edit its properties." />
          ))}

        {/* ---------------- Material ---------------- */}
        {tab === 'material' &&
          (body ? (
            <>
              <Field label="Finish">
                <div className="flex flex-col gap-1">
                  {MATERIAL_PRESETS.map((m) => {
                    const active = body.materialType === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onUpdateBody(body.id, { materialType: m.id })}
                        aria-pressed={active}
                        className={`h-9 px-3 rounded-full flex items-center justify-between text-sm transition-colors ${
                          active ? 'bg-accent-500/15 text-white ring-1 ring-accent-400/60' : 'bg-white/4 text-slate-300 hover:bg-white/8'
                        }`}
                      >
                        <span>{m.name}</span>
                        <span className="text-xs text-slate-500 tabular-nums">
                          {m.metalness > 0.5 ? 'Metallic' : `${Math.round(m.roughness * 100)}% rough`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label="Color">
                <div className="flex flex-wrap gap-2">
                  {SWATCHES.map((swatch) => {
                    const active = body.color.toLowerCase() === swatch.value.toLowerCase();
                    return (
                      <button
                        key={swatch.value}
                        type="button"
                        onClick={() => onUpdateBody(body.id, { color: swatch.value })}
                        title={swatch.name}
                        aria-label={swatch.name}
                        aria-pressed={active}
                        style={{ backgroundColor: swatch.value }}
                        className={`w-7 h-7 rounded-full border border-white/20 transition-transform hover:scale-110 ${
                          active ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-accent-400' : ''
                        }`}
                      />
                    );
                  })}
                  <label
                    title="Custom color"
                    className="relative w-7 h-7 rounded-full border border-dashed border-white/30 overflow-hidden cursor-pointer hover:scale-110 transition-transform"
                    style={{ background: 'conic-gradient(#f43f5e, #f59e0b, #10b981, #3b82f6, #a855f7, #f43f5e)' }}
                  >
                    <input
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#3b82f6'}
                      onChange={(e) => onUpdateBody(body.id, { color: e.target.value })}
                      aria-label="Custom color"
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                  </label>
                </div>
              </Field>
            </>
          ) : (
            <EmptyState title="Nothing selected" text="Select a body to change its material and color." />
          ))}

        {/* ---------------- Bodies ---------------- */}
        {tab === 'export' && (
          <>
            <p className="text-xs text-slate-400 leading-relaxed">
              Exports every visible body exactly as shown, including cutouts and bevels. STL is Z-up, ready for slicers; GLB is in metres with colours and materials, ready for game engines.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => runExport(exportSTL)}
                disabled={bodies.length === 0}
                className="h-9 rounded-full bg-accent-500 hover:bg-accent-400 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                <Download size={15} /> Export STL
              </button>
              <button type="button" onClick={() => runExport((b) => exportGLB(b, { groups }))} disabled={bodies.length === 0} className={secondaryButton}>
                <Download size={15} /> Export GLB (games)
              </button>
              <button type="button" onClick={() => runExport(exportOBJ)} disabled={bodies.length === 0} className={secondaryButton}>
                <Download size={15} /> Export OBJ
              </button>
              <button type="button" onClick={() => runExport(exportJSON)} disabled={bodies.length === 0} className={secondaryButton}>
                <FileJson size={15} /> Save as JSON
              </button>
            </div>
            {exportNote && <p className="text-xs text-amber-300">{exportNote}</p>}

            <div className="mt-2 pt-4 border-t border-white/8 flex flex-col gap-2">
              <button type="button" onClick={onLoadDemo} className={secondaryButton}>
                <Sparkles size={15} /> Load sample scene
              </button>
              <button
                type="button"
                onClick={onClearWorkspace}
                disabled={bodies.length === 0}
                className={`${secondaryButton} text-rose-300 hover:bg-rose-500/15`}
              >
                <RotateCcw size={15} /> Clear workspace
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
