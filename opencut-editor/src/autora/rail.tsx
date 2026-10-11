/**
 * The video window's tool bar: the one every Autora app wears (docs/TOOL-RAIL.md; the component is the app's own,
 * src/components/ToolRail.tsx, built in here). Round coloured tools down the right side of a desktop and along the bottom of
 * a phone, as many as fit and never scrolling, and an All tools grid for the rest.
 *
 * Nothing here is a second implementation. A tool runs one of OpenCut's own actions (`invokeAction`, the registry the
 * keyboard shortcuts use, so a shortcut and its tool can never disagree), opens one of the assets panel's tabs, or flips one
 * of the timeline's switches. What used to be a vertical strip of tabs at the left of the editor and most of the timeline's
 * toolbar are these tools and are gone from the page; the agent has every one of them from the chat whatever is shown.
 */
import type { ReactNode } from "react";
import {
  AlignLeftIcon, AlignRightIcon, Bookmark02Icon, Copy01Icon, Delete02Icon, Link02Icon, MagnetIcon, PauseIcon, PlayIcon, SearchAddIcon,
  SearchMinusIcon, ScissorIcon, Undo02Icon, Redo02Icon, ViewIcon, VolumeMute02Icon, ClipboardIcon, SquareIcon, ArrowLeft01Icon, ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ToolRail } from "../../../src/components/ToolRail";
import { VERB, type RailTool } from "../../../src/lib/toolrail";
import { getActionDefinition, invokeAction, type TAction, type TActionWithOptionalArgs } from "@/actions";
import { tabs, TAB_KEYS, useAssetsPanelStore, type Tab } from "@/components/editor/panels/assets/assets-panel-store";
import { useEditor } from "@/editor/use-editor";
import { OcRippleIcon } from "@/components/icons";
import { useTimelineStore } from "@/timeline/timeline-store";
import { zoomApi } from "@/timeline/components/timeline-toolbar";

const ico = (icon: Parameters<typeof HugeiconsIcon>[0]["icon"]): ReactNode => <HugeiconsIcon icon={icon} size={20} />;

/** The first shortcut an action has, written the way a tooltip says it. */
const keyOf = (action: TAction): string => {
  const first = getActionDefinition({ action }).defaultShortcuts?.[0];
  if (!first) return "";
  return String(first).split("+").map((k) => (k.length === 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1))).join("+");
};
const about = (text: string, action?: TAction) => (action && keyOf(action) ? `${text} (${keyOf(action)})` : text);

const PANEL_COLOUR: Record<Tab, string> = {
  media: VERB.select, sounds: VERB.draw, text: VERB.text, stickers: VERB.highlight, effects: VERB.shape, transitions: VERB.note,
  captions: VERB.insert, adjustment: VERB.stamp, settings: "#94a3b8",
};

export type Sheet = "media" | "edit" | null;

/** A tool as this editor builds it: the icon is a ReactNode of this editor's own React types. */
type Tool = Omit<RailTool, "icon"> & { icon: ReactNode };

export function VideoRail({ phone, sheet, setSheet }: { phone: boolean; sheet: Sheet; setSheet: (next: Sheet | ((now: Sheet) => Sheet)) => void }) {
  const { activeTab, setActiveTab } = useAssetsPanelStore();
  const snapping = useTimelineStore((s) => s.snappingEnabled);
  const ripple = useTimelineStore((s) => s.rippleEditingEnabled);
  const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
  const toggleRipple = useTimelineStore((s) => s.toggleRippleEditing);
  const playing = useEditor((e) => e.playback.getIsPlaying());
  const bookmarked = useEditor((e) => e.scenes.isBookmarked({ time: e.playback.getCurrentTime() }));
  const act = (action: TActionWithOptionalArgs) => () => invokeAction(action);

  const panelTools: Tool[] = TAB_KEYS.map((key) => {
    const Icon = tabs[key].icon;
    const phoneSheet = phone && key === "media";
    return {
      id: key, label: tabs[key].label, group: "Add to the video", icon: <Icon className="size-5" />, color: PANEL_COLOUR[key],
      phone: phoneSheet, desktop: ["media", "text", "effects", "captions"].includes(key),
      on: phoneSheet ? sheet === "media" : !phone && activeTab === key,
      about: phone ? "Open the media" : `Show ${tabs[key].label.toLowerCase()} on the left`,
      run: () => (phone ? (key === "media" ? setSheet((now) => (now === "media" ? null : "media")) : (setActiveTab(key), setSheet("media"))) : setActiveTab(key)),
    };
  });

  const tools: Tool[] = [
    ...panelTools,
    ...(phone ? [{ id: "edit", label: "Edit", group: "Add to the video", icon: ico(Copy01Icon), color: VERB.select, phone: true, on: sheet === "edit", about: "The picked clip's properties", run: () => setSheet((now: Sheet) => (now === "edit" ? null : "edit")) } as Tool] : []),
    { id: "play", label: playing ? "Pause" : "Play", group: "Playback", icon: ico(playing ? PauseIcon : PlayIcon), color: VERB.text, phone: true, desktop: true, on: playing, about: about("Play or pause", "toggle-play"), run: act("toggle-play") },
    { id: "start", label: "To the start", group: "Playback", icon: ico(ArrowLeft01Icon), color: VERB.text, about: about("Go to the start", "goto-start"), run: act("goto-start") },
    { id: "end", label: "To the end", group: "Playback", icon: ico(ArrowRight01Icon), color: VERB.text, about: about("Go to the end", "goto-end"), run: act("goto-end") },
    { id: "split", label: "Split", group: "Edit clips", icon: ico(ScissorIcon), color: VERB.shape, phone: true, desktop: true, about: about("Cut the clip at the playhead", "split"), run: act("split") },
    { id: "splitleft", label: "Cut left", group: "Edit clips", icon: ico(AlignLeftIcon), color: VERB.shape, about: about("Split and remove everything before the playhead", "split-left"), run: act("split-left") },
    { id: "splitright", label: "Cut right", group: "Edit clips", icon: ico(AlignRightIcon), color: VERB.shape, about: about("Split and remove everything after the playhead", "split-right"), run: act("split-right") },
    { id: "duplicate", label: "Duplicate", group: "Edit clips", icon: ico(Copy01Icon), color: VERB.text, phone: true, desktop: true, about: about("Copy the clip straight after itself", "duplicate-selected"), run: act("duplicate-selected") },
    { id: "copy", label: "Copy", group: "Edit clips", icon: ico(Copy01Icon), color: "#94a3b8", about: about("Copy the picked clips", "copy-selected"), run: act("copy-selected") },
    { id: "paste", label: "Paste", group: "Edit clips", icon: ico(ClipboardIcon), color: "#94a3b8", about: about("Paste at the playhead", "paste-copied"), run: act("paste-copied") },
    { id: "audio", label: "Extract audio", group: "Edit clips", icon: ico(Link02Icon), color: VERB.insert, about: "Separate a clip's sound, or put it back", run: act("toggle-source-audio") },
    { id: "mute", label: "Mute", group: "Edit clips", icon: ico(VolumeMute02Icon), color: VERB.highlight, about: about("Mute or unmute the picked clips", "toggle-elements-muted-selected"), run: act("toggle-elements-muted-selected") },
    { id: "hide", label: "Show / hide", group: "Edit clips", icon: ico(ViewIcon), color: VERB.highlight, about: about("Show or hide the picked clips", "toggle-elements-visibility-selected"), run: act("toggle-elements-visibility-selected") },
    { id: "selectall", label: "Select all", group: "Edit clips", icon: ico(SquareIcon), color: VERB.select, about: about("Pick every clip", "select-all"), run: act("select-all") },
    { id: "delete", label: "Delete", group: "Edit clips", icon: ico(Delete02Icon), color: VERB.remove, phone: true, desktop: true, about: about("Remove the picked clips", "delete-selected"), run: act("delete-selected") },
    { id: "snapping", label: "Snapping", group: "Timeline", icon: ico(MagnetIcon), color: VERB.note, desktop: true, on: snapping, about: about("Clips snap to each other and the playhead", "toggle-snapping"), run: () => toggleSnapping() },
    { id: "ripple", label: "Ripple", group: "Timeline", icon: <OcRippleIcon size={20} />, color: VERB.note, on: ripple, about: "Closing a gap moves what follows", run: () => toggleRipple() },
    { id: "bookmark", label: "Bookmark", group: "Timeline", icon: ico(Bookmark02Icon), color: VERB.stamp, on: bookmarked, about: about("Mark this moment", "toggle-bookmark"), run: act("toggle-bookmark") },
    { id: "zoomout", label: "Zoom out", group: "Timeline", icon: ico(SearchMinusIcon), color: VERB.insert, phone: false, desktop: !phone, about: "Show more of the timeline", run: () => zoomApi.by?.("out") },
    { id: "zoomin", label: "Zoom in", group: "Timeline", icon: ico(SearchAddIcon), color: VERB.insert, phone: false, desktop: !phone, about: "Show less of the timeline", run: () => zoomApi.by?.("in") },
    { id: "undo", label: "Undo", group: "History", icon: ico(Undo02Icon), color: "#94a3b8", phone: true, desktop: true, about: about("Take back the last change", "undo"), run: act("undo") },
    { id: "redo", label: "Redo", group: "History", icon: ico(Redo02Icon), color: "#94a3b8", desktop: true, about: about("Put it back", "redo"), run: act("redo") },
    ...(phone ? [{ id: "export", label: "Export", group: "Project", icon: ico(PlayIcon), color: VERB.shape, about: "Render the video", run: () => document.querySelector<HTMLElement>("[data-autora-export] button")?.click() } as Tool] : []),
  ];
  // Panel tools beyond Media share the sheet on a phone, so a phone's bar leaves them to the grid.
  /* The app and this editor each have their own copy of React's types, which TypeScript sees as two different ReactNodes. */
  return <ToolRail app="video" tools={tools as unknown as RailTool[]} phone={phone} hint={phone ? "Tap a tool to use it." : undefined} />;
}
