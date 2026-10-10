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

/**
 * Whether Autora's window is a phone's (it adds ?phone=1). The editor then wears the `autora-phone` class (autora.css),
 * which pares it down to what a thumb does with a game: look at the scene, move things, change what is selected, press
 * Play. The rest of the IDE (events, extensions, sharing, the 3D view, history) is on a desktop, and the agent has all of it.
 */
export const isPhone = (): boolean => new URLSearchParams(window.location.search).get('phone') === '1';
if (isPhone()) document.documentElement.classList.add('autora-phone');
