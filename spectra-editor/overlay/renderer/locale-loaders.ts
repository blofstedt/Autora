// The translations other than English, as files fetched on demand (see
// loadLocale in i18n.ts). The metadata worker is built without them: its
// build swaps this module for an empty one (vite.config.ts), because a worker
// built as an iife cannot split code.
export const LOCALE_LOADERS: Record<string, () => Promise<{ default: Record<string, string> }>> =
  import.meta.glob<{ default: Record<string, string> }>([
    './locales/*/chrome.json',
    '!./locales/en/chrome.json',
  ]);
