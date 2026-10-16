// @flow
import { displayBlackLoadingScreenOrThrow } from '../../../Utils/BrowserExternalWindowUtils';
import { tellAutora } from '../../../Autora/session';

let nextPreviewWindowId = 0;

/** The id of the box a game plays in, inside the editor's page (see Autora/autora.css). */
export const PLAY_ID = 'autora-play';

export const isPlaying = (): boolean => !!document.getElementById(PLAY_ID);

/** Put the game away: the box goes, and the window it was in is `closed`, which the editor already handles. */
export const stopPlaying = () => {
  const box = document.getElementById(PLAY_ID);
  if (box) box.remove();
  tellAutora({ playing: false });
};

/**
 * Where a preview plays. GDevelop opens a pop-up window for it; Autora plays the game in the window
 * the person is already in: a box over the scene (Stop, Restart, Full screen, and the game under them),
 * so building and play-testing are one place and nothing is blocked as a pop-up.
 *
 * The box holds an iframe, and the iframe's window is what the preview launcher gets back: it sets that
 * window's location to the game, focuses it, and watches whether it is `closed`, all of which an
 * iframe's window answers. The game itself is served by Autora in a sandbox of its own (no origin), so
 * it cannot reach the editor or Autora's API.
 *
 * This is called right after a click, as the pop-up was, and returns at once; the launcher fills it in.
 */
export const immediatelyOpenNewPreviewWindow = (
  project: gdProject
): WindowProxy => {
  stopPlaying();

  const box = document.createElement('div');
  box.id = PLAY_ID;
  box.className = 'autora-play';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Playing your game');

  const bar = document.createElement('div');
  bar.className = 'autora-play-bar';
  const title = document.createElement('span');
  title.className = 'autora-play-title';
  title.textContent = 'Playing';
  const spacer = document.createElement('span');
  spacer.className = 'autora-play-spacer';
  const button = (label: string, text: string, on: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'autora-play-btn';
    b.setAttribute('aria-label', label);
    b.textContent = text;
    b.addEventListener('click', on);
    return b;
  };

  const frame = document.createElement('iframe');
  frame.className = 'autora-play-frame';
  frame.name = 'GDevelopPreview' + nextPreviewWindowId++;
  frame.title = 'Your game';
  frame.setAttribute('allow', 'fullscreen; autoplay; gamepad');
  frame.setAttribute('allowfullscreen', '');
  // The game's own size is the shape of the box it is played in.
  frame.style.aspectRatio = `${project.getGameResolutionWidth()} / ${project.getGameResolutionHeight()}`;

  const restart = button('Restart', 'Restart', () => {
    const e = (window: any).__autoraEditor;
    stopPlaying();
    if (e && e.rail) e.rail.launchNewPreview();
  });
  const full = button('Full screen', 'Full screen', () => {
    if (frame.requestFullscreen) frame.requestFullscreen();
  });
  const stop = button('Stop', 'Stop', stopPlaying);
  stop.classList.add('is-stop');
  bar.append(title, spacer, restart, full, stop);

  const stage = document.createElement('div');
  stage.className = 'autora-play-stage';
  stage.append(frame);
  box.append(bar, stage);
  document.body.appendChild(box);

  const previewWindow = frame.contentWindow;
  if (!previewWindow) {
    box.remove();
    throw new Error("Can't show the game: the play box could not be made.");
  }
  displayBlackLoadingScreenOrThrow(previewWindow);
  // Keys go to the game as soon as it is there, and again when it is clicked.
  frame.addEventListener('load', () => frame.focus());
  stage.addEventListener('pointerdown', () => frame.focus());
  tellAutora({ playing: true });

  return previewWindow;
};
