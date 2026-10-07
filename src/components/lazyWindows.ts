/**
 * The three heavy windows -- the app preview, the PDF editor's frame and the
 * Office windows -- loaded when one is first opened rather than with the app.
 * A conversation that never opens one never downloads them. Render each inside
 * a <Suspense> (a null fallback: the window's own frame is what is waited for).
 */
import { lazy } from "react";

export const AppPreview = lazy(() => import("./AppPreview").then((m) => ({ default: m.AppPreview })));
export const SpectraWindow = lazy(() => import("./SpectraWindow").then((m) => ({ default: m.SpectraWindow })));
export const OfficeWindow = lazy(() => import("./OfficeWindow").then((m) => ({ default: m.OfficeWindow })));
