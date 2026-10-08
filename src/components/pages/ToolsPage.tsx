import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconCode, IconCube, IconFile, IconGame, IconGlobe, IconMusic, IconSlides, IconSparkle, IconTable, IconTerminal, IconVideo } from "../Icons";

type WindowKey = "widgets" | "browser" | "app" | "pdf" | "video" | "studio" | "pages" | "sheets" | "slides" | "cad" | "game" | "terminal";

type ToolsState = {
  config: Record<WindowKey, { enabled: boolean }>;
  groups: { group: string; available: boolean; enabled: boolean; detail: string }[];
};

const WINDOWS: { key: WindowKey; name: string; icon: ReactNode; what: string; tools: string }[] = [
  {
    key: "widgets",
    name: "Widget window",
    icon: <IconSparkle size={18} />,
    what: "Interactive explainers the agent builds in the thread — a mechanism you can turn, a graph you can drag.",
    tools: "widget_show",
  },
  {
    key: "browser",
    name: "Browser window",
    icon: <IconGlobe size={18} />,
    what: "A real Chromium the agent drives and you can watch or take over: reading pages, filling forms, taking screenshots.",
    tools: "browser_*",
  },
  {
    key: "app",
    name: "Creator",
    icon: <IconCode size={18} />,
    what: "Where the agent builds things that run: websites and apps — food apps, tools, dashboards — live beside the chat, for you to click through, comment on and review.",
    tools: "app_preview",
  },
  {
    key: "pdf",
    name: "Autora PDF",
    icon: <IconFile size={18} />,
    what: "Writing reports as PDFs, reading, filling, signing, marking up, changing the words in, redacting, merging, splitting and shrinking PDFs, in a window beside the chat where you can move what it placed and add your own.",
    tools: "pdf_read, pdf_look, pdf_edit, pdf_compose, pdf_pages, pdf_redact, pdf_replace_text, pdf_compress",
  },
  {
    key: "video",
    name: "Autora Video",
    icon: <IconVideo size={18} />,
    what: "Editing video in OpenCut's editor, in a window beside the chat: the agent imports your footage and builds the cut (clips, trims, splits, titles, subtitles) while you watch the timeline change, and you can take the editor over at any moment.",
    tools: "video_open, video_look, video_import, video_edit, video_style, video_project, video_ui, video_catalog, video_frame, video_export",
  },
  {
    key: "studio",
    name: "Autora Music",
    icon: <IconMusic size={18} />,
    what: "Making music in a window beside the chat: tracks of instruments and drums, a piano roll, a mixer and a WAV export. Ask for chords, a bass line that follows them or a drum beat and watch the clips appear; write the tune yourself, or have the agent suggest, fix timing and balance the mix. The agent guides, and the music stays yours.",
    tools: "studio_open, studio_look, studio_song, studio_track, studio_clip, studio_notes, studio_make, studio_play, studio_export",
  },
  {
    key: "pages",
    name: "Autora Pages",
    icon: <IconFile size={18} />,
    what: "Documents (.docx): the agent writes, reads, edits, checks and converts them, and they open in a window beside the chat where you can type in them too (on a phone, as pictures of the pages you can point at).",
    tools: "office_* on .docx files",
  },
  {
    key: "sheets",
    name: "Autora Sheets",
    icon: <IconTable size={18} />,
    what: "Spreadsheets (.xlsx): tables, formulas and charts the agent builds and changes, open in a window beside the chat where you can edit the cells yourself.",
    tools: "office_* on .xlsx files",
  },
  {
    key: "slides",
    name: "Autora Slides",
    icon: <IconSlides size={18} />,
    what: "Presentations (.pptx): decks the agent designs and edits, open in a window beside the chat where you can change any slide.",
    tools: "office_* on .pptx files",
  },
  {
    key: "terminal",
    name: "Terminal",
    icon: <IconTerminal size={18} />,
    what: "A shell beside the chat that you and the agent share: type commands with completion for commands, files, git and npm scripts, and watch the agent's commands appear in the same place. The folder you cd into is where the agent's next command starts, and it is told what you ran. Switching this off also takes the agent's terminal tool away.",
    tools: "terminal, run_background",
  },
  {
    key: "cad",
    name: "Autora 3D",
    icon: <IconCube size={18} />,
    what: "3D models you build from simple shapes: the agent sketches, extrudes, bevels, cuts and repeats them and checks they will print, in a window beside the chat where you can push, pull and move the same model by hand. Exports STL for printing and GLB for games.",
    tools: "cad_*",
  },
  {
    key: "game",
    name: "Autora Games",
    icon: <IconGame size={18} />,
    what: "Games, made in GDevelop's editor beside the chat: scenes, objects, behaviors, events, pictures and sound. The agent does the technical work (wiring, physics, the events that make it run) from the engine's own list of what exists; the idea, the story, the look and the feel stay yours, and you can change anything by hand while it works. GDevelop's own AI and online services are not part of it.",
    tools: "game_*",
  },
];

/**
 * Tools: the built-in windows, each switched on or off. Off takes its tools
 * away from the agent from the next turn and tells it so.
 */
export function ToolsPage() {
  const [state, setState] = useState<ToolsState | null>(null);
  const [busy, setBusy] = useState<WindowKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((body: any) => {
    if (body?.tools?.config) setState(body.tools as ToolsState);
  }, []);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(adopt).catch(() => setError("Could not load the tools."));
  }, [adopt]);

  const toggle = async (key: WindowKey, enabled: boolean) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools: { [key]: { enabled } } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.detail ?? "Could not change that.");
      else adopt(body);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <p className="jf-hint art-lede">
          The windows built into Autora. All are on to start with; switch one off and the agent
          stops using it from its next step, and is told it is off rather than left to guess.
        </p>
        {error && <p className="set-warn">{error}</p>}
        {state === null && !error && <p className="jf-hint">Loading…</p>}
        {state && (
          <div className="tw-grid">
            {WINDOWS.map((w) => {
              const on = state.config[w.key]?.enabled !== false;
              const group = w.key === "browser" ? state.groups.find((g) => g.group === "browser") : null;
              const trouble = on && group && !group.available ? group.detail : null;
              return (
                <section key={w.key} className={`tw-card${on ? " on" : ""}`}>
                  <div className="tw-head">
                    <span className="tw-icon">{w.icon}</span>
                    <b>{w.name}</b>
                    <span className={`tool-state ${on ? (trouble ? "warn" : "ok") : ""}`}>
                      {on ? (trouble ? "not usable" : "on") : "off"}
                    </span>
                    <div className="spacer" />
                    <button
                      className={`job-switch ${on ? "on" : ""}`}
                      role="switch"
                      aria-checked={on}
                      aria-label={`${w.name}: ${on ? "on" : "off"}`}
                      disabled={busy !== null}
                      onClick={() => void toggle(w.key, !on)}
                    >
                      <span className="job-knob" />
                    </button>
                  </div>
                  <p className="jf-hint">{w.what}</p>
                  {trouble && <p className="set-warn">{trouble}</p>}
                  <p className="tool-names"><code>{w.tools}</code></p>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
