// @flow
/**
 * Which Autora chat this editor is open for, and where its game lives. Autora's game window
 * (src/components/GameWindow.tsx) puts the chat in the page's address: ?autora=<session>.
 * Everything the editor keeps for this game is kept by Autora's server (server/gamedesk.ts),
 * under /api/game/<session>/.
 */
export const getAutoraSession = (): string => {
  const params = new URLSearchParams(window.location.search);
  return params.get('autora') || '';
};

export const gameApi = (path: string): string =>
  `/api/game/${encodeURIComponent(getAutoraSession())}${path}`;

/** Whether this page was opened by Autora's window (it always is, in the app: the editor has no other home). */
export const isInAutora = (): boolean => !!getAutoraSession() && window.parent !== window;

/** Say something to the window around this frame. */
export const tellAutora = (message: { [string]: any }) => {
  if (window.parent === window) return;
  window.parent.postMessage({ autoraGame: true, ...message }, window.location.origin);
};
