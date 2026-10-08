import { createGdevelopTheme } from '../CreateTheme';

import styles from './DeepBlueThemeVariables.json';
import './DeepBlueThemeVariables.css';

/**
 * Autora's colours on GDevelop's dark theme. Autora's window passes its theme in the address
 * (?theme=<json of its --bg, --s1, ... custom properties>, src/components/GameWindow.tsx), and each
 * colour the Deep Blue theme is made of is swapped for the Autora token that plays the same part:
 * the page behind (--bg), the panels (--s1, --s2), the lines (--s4), the three greys of text and
 * the accent. Without it, or outside Autora, it is Deep Blue as GDevelop made it.
 */
const readTokens = () => {
  try {
    const raw = new URLSearchParams(window.location.search).get('theme');
    const tokens = raw ? JSON.parse(raw) : null;
    return tokens && typeof tokens === 'object' ? tokens : null;
  } catch (error) {
    return null;
  }
};

const ROLES = {
  '#0d1117': '--bg',
  '#161b22': '--s1',
  '#21262d': '--s2',
  '#30363d': '--s4',
  '#c9d1d9': '--text',
  '#8b949e': '--text-2',
  '#6e7681': '--text-3',
  '#58a6ff': '--accent',
  '#79c0ff': '--accent-light',
};

const tokens = readTokens();

const recolor = value => {
  if (typeof value !== 'string' || !tokens) return value;
  return value.replace(/#[0-9a-fA-F]{6}\b/g, hex => {
    const token = ROLES[hex.toLowerCase()];
    return (token && tokens[token]) || hex;
  });
};

const themed = {};
for (const key of Object.keys(styles)) themed[key] = recolor(styles[key]);

// The same values as custom properties, for the parts of the editor that are drawn with CSS (GDevelop names them in kebab-case).
if (tokens && typeof document !== 'undefined') {
  const kebab = key =>
    '--' + key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const style = document.createElement('style');
  style.textContent = `.DeepBlueTheme {\n${Object.keys(themed)
    .map(key => `  ${kebab(key)}: ${themed[key]};`)
    .join('\n')}\n}\n`;
  document.head.appendChild(style);
}

export default createGdevelopTheme({
  styles: themed,

  rootClassNameIdentifier: 'DeepBlueTheme',
  paletteType: 'dark',
  gdevelopIconsCSSFilter: 'hue-rotate(-10deg) saturate(50%)',
});
