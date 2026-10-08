/**
 * The pinned stage, on a phone: the page, the plan and an explainer held above
 * the conversation instead of inside it. See lib/stage.ts for what is held.
 *
 * Every pane stays mounted and only the chosen one is shown, so switching
 * tabs never reloads the page's feed or restarts the explainer, and folding
 * the stage away costs nothing to bring back.
 */
import type { ReactNode } from "react";
import { APP_NAME } from "../lib/officedesk";
import type { Surface, SurfaceKind } from "../lib/stage";
import { IconChevron, IconCube, IconMaximize, IconMinimize, IconTerminal, IconFile, IconGlobe, IconList, IconMark, IconMonitor, IconMusic, IconVideo } from "./Icons";

const ICON: Record<SurfaceKind, ReactNode> = {
  app: <IconMonitor size={14} />,
  pdf: <IconFile size={14} />,
  video: <IconVideo size={14} />,
  cad: <IconCube size={14} />,
  term: <IconTerminal size={14} />,
  studio: <IconMusic size={14} />,
  docx: <IconFile size={14} />,
  pptx: <IconFile size={14} />,
  xlsx: <IconFile size={14} />,
  browser: <IconGlobe size={14} />,
  plan: <IconList size={14} />,
  widget: <IconMark size={14} />,
};

/** A tab is its name and nothing else: what is in it is what is below. The dot
    says the agent is at work in it. */
export const NAME: Record<SurfaceKind, string> = { app: "Creator", pdf: "PDF", video: "Video", cad: "3D", term: "Terminal", studio: "Music", docx: APP_NAME.docx, pptx: APP_NAME.pptx, xlsx: APP_NAME.xlsx, browser: "Browser", plan: "To do", widget: "Widget" };

const working = (surface: Surface): boolean => {
  const { cell } = surface;
  if (cell.kind === "screen") return cell.live;
  if (cell.kind === "todo") return cell.items.some((t) => t.status === "in-progress");
  return false;
};

export function Stage({
  surfaces, active, collapsed, expanded, following, onPick, onFollow, onToggle, onExpand, render,
}: {
  surfaces: readonly Surface[];
  active: SurfaceKind;
  collapsed: boolean;
  /** The stage fills the screen's height, the conversation shrunk to a strip. */
  expanded: boolean;
  /** The stage is showing whatever the agent touched last, by itself. */
  following: boolean;
  onPick: (kind: SurfaceKind) => void;
  onFollow: () => void;
  onToggle: () => void;
  onExpand: () => void;
  render: (surface: Surface) => ReactNode;
}) {
  const nameOf = (kind: SurfaceKind) => NAME[kind];
  return (
    <section
      className={`stage${collapsed ? " is-collapsed" : ""}${expanded && !collapsed ? " is-expanded" : ""}${surfaces.length > 2 ? " is-tight" : ""}`}
      aria-label="Pinned view"
    >
      <div className="stage-bar" role="tablist">
        {surfaces.map((surface) => {
          const on = surface.kind === active;
          return (
            <button
              key={surface.kind}
              type="button"
              role="tab"
              aria-selected={on}
              className={`stage-tab${on ? " is-on" : ""}`}
              onClick={() => onPick(surface.kind)}
            >
              {ICON[surface.kind]}
              <span className="stage-tab-name">{nameOf(surface.kind)}</span>
              {working(surface) && <span className="stage-live" aria-hidden="true" />}
            </button>
          );
        })}
        {surfaces.length > 1 && (
          <button
            type="button"
            className={`stage-follow${following ? " is-on" : ""}`}
            onClick={onFollow}
            aria-pressed={following}
            title={following ? "Following the agent — tap to stop" : "Switch to whatever the agent is working on"}
          >
            <span className="watch-dot" aria-hidden="true" />
            Follow
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className="stage-expand"
            onClick={onExpand}
            aria-pressed={expanded}
            aria-label={expanded ? "Shrink the tools area" : "Expand the tools area"}
            title={expanded ? "Shrink the tools area" : "Expand the tools area"}
          >
            {expanded ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
          </button>
        )}
        <button
          type="button"
          className="stage-fold"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show the pinned view" : "Fold the pinned view away"}
        >
          <IconChevron size={14} />
        </button>
      </div>
      <div className="stage-body" hidden={collapsed} data-active={active}>
        {surfaces.map((surface) => (
          <div
            key={surface.key}
            className="stage-pane"
            data-kind={surface.kind}
            role="tabpanel"
            hidden={surface.kind !== active}
          >
            {render(surface)}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What the thread keeps where a held card was: a line saying where it went, so
 * the conversation still reads in order. The words the agent said while it
 * worked the page stay under it, in the thread, where they can be scrolled.
 */
export function StageStub({
  kind, title, note, children,
}: { kind: SurfaceKind; title: string; note: string; children?: ReactNode }) {
  return (
    <>
      <div className="stage-stub">
        <span className="stage-stub-ico" aria-hidden="true">{ICON[kind]}</span>
        <b className="stage-stub-title">{title}</b>
        <span className="stage-stub-note">{note}</span>
      </div>
      {children}
    </>
  );
}
