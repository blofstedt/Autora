/**
 * The heavy windows -- the app preview, the PDF editor's frame, the video
 * editor's and the Office windows -- loaded when one is first opened rather than with the app.
 * A conversation that never opens one never downloads them. Render each inside
 * a <Suspense> (a null fallback: the window's own frame is what is waited for).
 */
import { lazy } from "react";

export const AppPreview = lazy(() => import("./AppPreview").then((m) => ({ default: m.AppPreview })));
export const SpectraWindow = lazy(() => import("./SpectraWindow").then((m) => ({ default: m.SpectraWindow })));
export const OpenCutWindow = lazy(() => import("./OpenCutWindow").then((m) => ({ default: m.OpenCutWindow })));
export const OfficeWindow = lazy(() => import("./OfficeWindow").then((m) => ({ default: m.OfficeWindow })));
export const CadWindow = lazy(() => import("./CadWindow").then((m) => ({ default: m.CadWindow })));
export const PhotoWindow = lazy(() => import("./PhotoWindow").then((m) => ({ default: m.PhotoWindow })));
export const GameWindow = lazy(() => import("./GameWindow").then((m) => ({ default: m.GameWindow })));
export const TerminalWindow = lazy(() => import("./TerminalWindow").then((m) => ({ default: m.TerminalWindow })));
export const StudioWindow = lazy(() => import("./StudioWindow").then((m) => ({ default: m.StudioWindow })));
