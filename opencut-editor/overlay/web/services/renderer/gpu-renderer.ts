import {
	applyEffectPasses,
	applyMaskFeather as applyMaskFeatherWasm,
	initializeGpu,
} from "opencut-wasm";
import type { EffectPass, EffectUniformValue } from "@/effects/types";

let gpuAvailable = false;
let initPromise: Promise<void> | null = null;

/* Autora: the GPU is asked for, but not waited on for ever. On some browsers and machines the adapter request never
   answers, and the editor sat on "Loading project..." with the agent unable to use it. After a few seconds it goes on
   without the GPU (effects are drawn without it, as on a machine that has none); a GPU that answers later is used then. */
const GPU_WAIT_MS = 6000;
/* A machine that did not answer once (a mini PC with no graphics card) is remembered, in the preferences Autora keeps for
   the editor, and not waited on again: the GPU is still asked, in the background, and used if it ever answers. */
const NO_GPU = "autora-no-gpu";
const remembered = (): boolean => {
	try {
		return localStorage.getItem(NO_GPU) === "1";
	} catch {
		return false;
	}
};
const remember = (none: boolean) => {
	try {
		if (none) localStorage.setItem(NO_GPU, "1");
		else localStorage.removeItem(NO_GPU);
	} catch {
		/* not kept: it waits again next time */
	}
};

export function initializeGpuRenderer(): Promise<void> {
	if (!initPromise) {
		const wait = remembered() ? 0 : GPU_WAIT_MS;
		const late = new Promise<void>((resolve) =>
			setTimeout(() => {
				if (!gpuAvailable && wait) {
					console.warn(`GPU renderer: no answer after ${GPU_WAIT_MS / 1000}s, going on without it`);
					remember(true);
				}
				resolve();
			}, wait),
		);
		const asked = initializeGpu()
			.then(() => {
				gpuAvailable = true;
				remember(false);
			})
			.catch((error: unknown) => {
				gpuAvailable = false;
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`GPU renderer unavailable: ${message}`);
			});
		initPromise = Promise.race([asked, late]);
	}
	return initPromise;
}

export function isGpuAvailable(): boolean {
	return gpuAvailable;
}

export const gpuRenderer = {
	applyEffect({
		source,
		width,
		height,
		passes,
	}: {
		source: OffscreenCanvas;
		width: number;
		height: number;
		passes: EffectPass[];
	}): OffscreenCanvas {
		if (passes.length === 0 || !gpuAvailable) {
			return source;
		}

		return applyEffectPasses({
			source,
			width,
			height,
			passes: serializeEffectPasses(passes),
		});
	},

	applyMaskFeather({
		maskCanvas,
		width,
		height,
		feather,
	}: {
		maskCanvas: OffscreenCanvas;
		width: number;
		height: number;
		feather: number;
	}): OffscreenCanvas {
		if (!gpuAvailable) {
			return maskCanvas;
		}

		return applyMaskFeatherWasm({
			mask: maskCanvas,
			width,
			height,
			feather,
		});
	},
};

function serializeEffectPasses(passes: EffectPass[]) {
	return passes.map((pass) => ({
		shader: pass.shader,
		uniforms: Object.entries(pass.uniforms).map(([name, value]) => ({
			name,
			value: normalizeUniformValue(value),
		})),
	}));
}

function normalizeUniformValue(value: EffectUniformValue): number[] {
	return typeof value === "number" ? [value] : value;
}
