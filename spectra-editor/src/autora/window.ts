/**
 * `@tauri-apps/api/window`, over Autora.
 *
 * Spectra's renderer uses this for window identity, close sequencing and the
 * backdrop. Autora's PDF window is a frame inside the app rather than an
 * operating-system window, so the calls that would move or close an OS window
 * are answered as far as Autora can honour them and no further.
 */
import { call } from "./transport";

interface PhysicalPosition { x: number; y: number }
interface PhysicalSize { width: number; height: number }

class AutoraWindow {
  /** Autora's window label. One PDF window per label, as in Spectra. */
  readonly label = "pdf-editor";

  async close(): Promise<void> {
    await call("close_window", { label: this.label });
  }

  async destroy(): Promise<void> {
    await call("close_window", { label: this.label, force: true });
  }

  async hide(): Promise<void> {
    await call("hide_window", { label: this.label });
  }

  async show(): Promise<void> {
    await call("show_window", { label: this.label });
  }

  async setFocus(): Promise<void> {
    await call("focus_app_window", { label: this.label });
  }

  async isMaximized(): Promise<boolean> {
    return false;
  }

  async isFullscreen(): Promise<boolean> {
    return Boolean(document.fullscreenElement);
  }

  async setFullscreen(fullscreen: boolean): Promise<void> {
    if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!fullscreen && document.fullscreenElement) await document.exitFullscreen();
  }

  async isVisible(): Promise<boolean> {
    return !document.hidden;
  }

  async theme(): Promise<"dark" | "light"> {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  /**
   * Tauri re-themes the OPERATING SYSTEM window so its title bar and borders
   * follow. There is no OS window here — the editor is a frame inside
   * Autora's — so the same call re-stamps the document's own theme, which is
   * what the shell CSS actually keys on. `null` means "follow the system".
   */
  async setTheme(theme: "light" | "dark" | "high-contrast" | null): Promise<void> {
    const root = document.documentElement;
    if (theme === null) {
      const light = window.matchMedia("(prefers-color-scheme: light)").matches;
      root.setAttribute("data-theme", light ? "light" : "dark");
    } else {
      root.setAttribute("data-theme", theme);
    }
  }

  /** The window is the frame here: its box is the frame's box. */
  async innerSize(): Promise<PhysicalSize> {
    return {
      width: Math.round(window.innerWidth * window.devicePixelRatio),
      height: Math.round(window.innerHeight * window.devicePixelRatio),
    };
  }

  async outerPosition(): Promise<PhysicalPosition> {
    return { x: 0, y: 0 };
  }

  async scaleFactor(): Promise<number> {
    return window.devicePixelRatio;
  }

  async onCloseRequested(_handler: (event: { preventDefault: () => void }) => void): Promise<() => void> {
    return () => {};
  }

  async onFocusChanged(_handler: (event: { payload: boolean }) => void): Promise<() => void> {
    return () => {};
  }

  async onResized(_handler: (event: { payload: PhysicalSize }) => void): Promise<() => void> {
    return () => {};
  }

  async onMoved(_handler: (event: { payload: PhysicalPosition }) => void): Promise<() => void> {
    return () => {};
  }

  async onScaleChanged(_handler: (event: { payload: number }) => void): Promise<() => void> {
    return () => {};
  }

  async onThemeChanged(_handler: (event: { payload: string }) => void): Promise<() => void> {
    return () => {};
  }

  async startDragging(): Promise<void> {}
  async setDecorations(_value: boolean): Promise<void> {}
  async setResizable(_value: boolean): Promise<void> {}
  async setTitle(_value: string): Promise<void> {}
  async setMinSize(_size: PhysicalSize | null): Promise<void> {}
  async setMaxSize(_size: PhysicalSize | null): Promise<void> {}
  async maximize(): Promise<void> {}
  async unmaximize(): Promise<void> {}
  async minimize(): Promise<void> {}
  async unminimize(): Promise<void> {}
}

const instance = new AutoraWindow();

/**
 * A window method this port does not implement is ignored, not fatal.
 *
 * Tauri's window object carries some fifty methods; this renderer touches a
 * handful. Without this, the first unimplemented one it happens to reach
 * throws out of a boot path and the whole page stays blank — which is exactly
 * how `setTheme` presented. Each is named once in the console so a real gap
 * is still visible rather than silently swallowed.
 */
const unknown = new Set<string>();

export function getCurrentWindow(): AutoraWindow {
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        if (!unknown.has(prop)) {
          unknown.add(prop);
          console.warn(`[autora-bridge] window.${prop} is not implemented here; ignoring`);
        }
        return async () => undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getAllWindows(): AutoraWindow[] {
  return [instance];
}

export function currentMonitor(): Promise<{ scaleFactor: number; size: PhysicalSize }> {
  return Promise.resolve({
    scaleFactor: window.devicePixelRatio,
    size: {
      width: Math.round(window.screen.width * window.devicePixelRatio),
      height: Math.round(window.screen.height * window.devicePixelRatio),
    },
  });
}

export const LogicalSize = class {
  constructor(public width: number, public height: number) {}
};

export const PhysicalSize = class {
  constructor(public width: number, public height: number) {}
};

export const LogicalPosition = class {
  constructor(public x: number, public y: number) {}
};

export const PhysicalPosition = class {
  constructor(public x: number, public y: number) {}
};
