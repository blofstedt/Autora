import { useCallback, useState } from "react";
import { ToolRail, RailTray } from "../ToolRail";
import { VERB, type RailTool } from "../../lib/toolrail";
import {
  IconCode, IconCopy, IconCube, IconDownload, IconEye, IconFolder, IconGear, IconImage, IconList, IconMinus, IconPlay,
  IconPlus, IconRepeat, IconRotateCcw, IconRotateCw, IconSearch, IconSlides, IconSliders, IconTable, IconTrash, IconZap,
} from "../Icons";

/** What the editor says its tools look like now (gdevelop-editor/overlay/.../Autora/rail.js, `stateOf`). */
export type GameRailState = {
  /** Which editor shows: the scene, its rules, or something else. */
  on: "scene" | "events" | "other";
  scene: string | null;
  scenes: string[];
  playing: boolean;
  mode: "2d" | "3d";
  grid: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** The name of the object picked, if one is. */
  picked: string | null;
  /** How many things on the scene are selected. */
  instances: number;
  panels: { objects: boolean; properties: boolean; layers: boolean; instances: boolean; groups: boolean };
  projectManager: boolean;
};

/** Things the person can ask for when they want something the bar cannot do: the rules and wiring are the agent's. */
const ASKS = [
  "Make my player jump",
  "Add an enemy that chases the player",
  "Add a score that goes up when I collect something",
  "Check my game for mistakes",
];

/**
 * Autora Games' tool bar: the same round, coloured bar every Autora app wears (docs/TOOL-RAIL.md), in place of GDevelop's
 * tab strip, toolbar and project button. Each tool is one thing GDevelop's editor did, run by the editor itself
 * (gdevelop-editor/overlay/.../Autora/rail.js); this only draws them and says which are lit or dimmed.
 *
 * Built for someone making their first game: Play first, then the few things that make one (add an object, see what is
 * there, give it abilities), and everything else under All tools. The rules sheet (GDevelop's events) is there too, in an
 * Advanced group, and is mostly the agent's to write.
 */
export function GameRail({ phone, rail, run, ask, asked }: {
  phone: boolean;
  /** Null until the editor has said; every tool that needs the game is dimmed until then. */
  rail: GameRailState | null;
  run: (id: string) => void;
  ask: (text: string) => void;
  asked: string | null;
}) {
  const [tray, setTray] = useState<"scenes" | "zoom" | null>(null);
  const ready = rail !== null;
  const scene = rail?.on === "scene";
  const toggleTray = useCallback((id: "scenes" | "zoom") => setTray((cur) => (cur === id ? null : id)), []);
  const need = ready ? undefined : "The editor is starting";

  const tools: RailTool[] = [
    { id: "play", label: "Play", group: "Play", icon: <IconPlay size={20} />, color: VERB.text, phone: true, desktop: true, on: !!rail?.playing, disabled: !ready, about: rail?.playing ? "Stop playing" : "Play your game right here", run: () => run("play") },
    { id: "restart", label: "Restart", group: "Play", icon: <IconRepeat size={20} />, color: VERB.text, disabled: !ready || !rail?.playing, about: "Start the game again from the beginning", run: () => run("restart") },

    { id: "addObject", label: "Add object", group: "Build", icon: <IconPlus size={20} />, color: VERB.insert, phone: true, desktop: true, disabled: !ready, about: need ?? "A player, an enemy, a coin, some text, a platform...", run: () => run("addObject") },
    { id: "objects", label: "Objects", group: "Build", icon: <IconCube size={20} />, color: VERB.select, phone: true, desktop: true, on: !!rail?.panels.objects, disabled: !ready, about: "Everything in your game, to pick and drag onto the scene", run: () => run("objects") },
    { id: "properties", label: "Properties", group: "Build", icon: <IconSliders size={20} />, color: VERB.select, phone: true, desktop: true, on: !!rail?.panels.properties, disabled: !ready, about: "Size, position and settings of what you picked", run: () => run("properties") },
    { id: "layers", label: "Layers", group: "Build", icon: <IconList size={20} />, color: VERB.note, desktop: true, on: !!rail?.panels.layers, disabled: !ready, about: "Front and back: a background, the action, the score on top", run: () => run("layers") },
    { id: "instances", label: "On the scene", group: "Build", icon: <IconTable size={20} />, color: VERB.note, on: !!rail?.panels.instances, disabled: !ready, about: "Every copy of an object placed on this scene", run: () => run("instances") },
    { id: "groups", label: "Object groups", group: "Build", icon: <IconCopy size={20} />, color: VERB.note, on: !!rail?.panels.groups, disabled: !ready, about: "Name a few objects together, such as all the enemies", run: () => run("groups") },

    { id: "abilities", label: "Abilities", group: "Make it do things", icon: <IconZap size={20} />, color: VERB.shape, phone: true, desktop: true, disabled: !ready || !rail?.picked, about: rail?.picked ? `What ${rail.picked} can do: jump, move, collide, be dragged...` : "Pick an object first (on the scene or in Objects)", run: () => run("abilities") },

    { id: "scenes", label: "Scenes", group: "Scenes", icon: <IconSlides size={20} />, color: VERB.note, desktop: true, on: tray === "scenes", disabled: !ready, about: "Levels and screens of your game", run: () => toggleTray("scenes") },
    { id: "sceneSettings", label: "Scene settings", group: "Scenes", icon: <IconGear size={20} />, color: VERB.select, disabled: !ready, about: "Background colour and the scene's own options", run: () => run("sceneSettings") },
    { id: "sceneVariables", label: "Scene variables", group: "Scenes", icon: <IconCode size={20} />, color: VERB.select, disabled: !ready, about: "Numbers and words this scene remembers", run: () => run("sceneVariables") },

    { id: "mode", label: rail?.mode === "3d" ? "3D view" : "2D view", group: "View", icon: <IconEye size={20} />, color: VERB.note, desktop: true, on: rail?.mode === "3d", disabled: !ready, about: "Look at the scene in 2D or in 3D", run: () => run("mode") },
    { id: "grid", label: "Grid", group: "View", icon: <IconTable size={20} />, color: VERB.note, desktop: true, on: !!rail?.grid, disabled: !ready, about: "Snap things to a grid while you place them", run: () => run("grid") },
    { id: "zoom", label: "Zoom", group: "View", icon: <IconSearch size={20} />, color: VERB.note, desktop: true, on: tray === "zoom", disabled: !ready, about: "Closer, further, or everything in view", run: () => toggleTray("zoom") },

    { id: "undo", label: "Undo", group: "Edit", icon: <IconRotateCcw size={20} />, color: VERB.shape, phone: true, desktop: true, disabled: !ready || (scene && !rail?.canUndo), about: "Take back the last change (Ctrl+Z)", run: () => run("undo") },
    { id: "redo", label: "Redo", group: "Edit", icon: <IconRotateCw size={20} />, color: VERB.shape, desktop: true, disabled: !ready || (scene && !rail?.canRedo), about: "Put it back (Ctrl+Y)", run: () => run("redo") },
    { id: "delete", label: "Delete", group: "Edit", icon: <IconTrash size={20} />, color: VERB.remove, phone: true, desktop: true, disabled: !ready || !rail?.instances, about: "Delete what is picked on the scene (Delete)", run: () => run("delete") },

    { id: "pictures", label: "Pictures & sounds", group: "Game", icon: <IconImage size={20} />, color: VERB.draw, desktop: true, disabled: !ready, about: "The files your game uses: add your own", run: () => run("pictures") },
    { id: "project", label: "Game settings", group: "Game", icon: <IconFolder size={20} />, color: VERB.select, on: !!rail?.projectManager, disabled: !ready, about: "Name, screen size, scenes and everything else in the game", run: () => run("project") },

    { id: "export", label: "Export web game", group: "Share", icon: <IconDownload size={20} />, color: VERB.insert, desktop: true, disabled: !ready, about: "A web game you can put anywhere, as a .zip", run: () => run("export") },

    { id: "rules", label: rail?.on === "events" ? "Back to the scene" : "Rules", group: "Advanced", icon: <IconCode size={20} />, color: VERB.highlight, on: rail?.on === "events", disabled: !ready, about: "The game's rules as events. Autora writes these when you ask; here is the sheet itself", run: () => run("rules") },
  ];

  const trayTool = tray ? tools.find((t) => t.id === tray) ?? null : null;

  return (
    <>
      {trayTool && (
        <RailTray tool={trayTool} onClose={() => setTray(null)}>
          {tray === "scenes" && (
            <>
              {(rail?.scenes ?? []).map((name) => (
                <button key={name} type="button" className={`gm-chip${rail?.scene === name ? " is-on" : ""}`} onClick={() => run(`scene:${name}`)}>{name}</button>
              ))}
              <button type="button" className="gm-chip is-new" onClick={() => run("newScene")}><IconPlus size={12} /> New scene</button>
            </>
          )}
          {tray === "zoom" && (
            <span className="gm-chips">
              <button type="button" className="gm-chip" aria-label="Zoom out" onClick={() => run("zoomOut")}><IconMinus size={12} /> Out</button>
              <button type="button" className="gm-chip" aria-label="Zoom in" onClick={() => run("zoomIn")}><IconPlus size={12} /> In</button>
              <button type="button" className="gm-chip" aria-label="Fit everything in view" onClick={() => run("fit")}>Fit</button>
            </span>
          )}
        </RailTray>
      )}
      <ToolRail
        app="games" phone={phone} tools={tools}
        extra={(close) => (
          <section>
            <h4>Ask Autora</h4>
            {asked
              ? <p className="rail-grid-hint">Sent to Autora: “{asked.slice(0, 60)}{asked.length > 60 ? "…" : ""}”. Watch the game and the thread.</p>
              : <div className="rail-asks">{ASKS.map((a) => <button key={a} type="button" className="rail-ask" onClick={() => { close(); ask(a); }}>{a}</button>)}</div>}
          </section>
        )}
      />
    </>
  );
}
