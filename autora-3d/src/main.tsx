import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import App from './App.tsx';
import {initManifold} from './utils/manifoldBoolean';
import './index.css';

// Autora's phone window (components/CadWindow.tsx adds ?phone=1): the tool measurements every Autora window shares on a
// phone, see index.css.
try {
  if (new URLSearchParams(window.location.search).get('phone') === '1') document.documentElement.dataset.phone = '1';
} catch {
  /* no address to read: the desktop look */
}

// The geometry engine (WebAssembly) starts first, so the first shapes built are exact. If it cannot start,
// the app still works on its fallback.
initManifold(wasmUrl)
  .catch((e) => console.warn('Exact geometry engine did not start; using the fallback.', e))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
