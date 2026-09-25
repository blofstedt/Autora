/**
 * Three.js for explainer widgets, as one file.
 *
 * A widget runs in a sandboxed frame with an opaque origin, so it cannot load
 * modules from this server (the request would go without the sign-in cookie
 * Umbrel's proxy wants) and should not need the internet to show a 3D model.
 * The thread fetches this bundle once and hands it to each frame as a data:
 * URL in an import map, under "three" and the addon paths the examples use.
 * Everything is exported from the one module so all of those names resolve to
 * the same copy of Three.js.
 *
 * Built by `npm run build` into dist/widget/three.js; served in development
 * by the route in server.ts that builds it on first request.
 */
export * from "three";
export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
