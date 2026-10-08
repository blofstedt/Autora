import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import App from './App.tsx';
import {initManifold} from './utils/manifoldBoolean';
import './index.css';

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
