"""Browser control with a live video feed.

The naive way to show a browser agent's work is to screenshot after each action.
That produces a slideshow: you see the before and after, never the actual
navigation, and you cannot tell a slow page from a stuck agent.

Instead this uses Chrome DevTools Protocol `Page.startScreencast`, which is what
Chrome's own remote debugging uses -- Chrome pushes a JPEG every time it paints,
so the feed is genuinely live and costs nothing when the page is static. Frames
go to the blob store; the event log carries hashes. A 10 minute session stays a
readable text file.

The second half of legibility is showing *where* the agent acted. A click event
in a log tells you a selector; it does not tell you that the selector matched a
cookie banner instead of the button. So before every click Autora paints a
marker at the target coordinates into the page itself, which means it appears in
the screencast and therefore in the recording. You watch the agent miss.

Persistent auth: when a profile_dir is given, the browser uses
`launch_persistent_context` so cookies, localStorage, and login state survive
restarts. One profile can hold Gmail, Google Calendar, and anything else the user
has signed into -- no re-auth required.

Cursor visibility: a tiny red dot injected via `add_init_script` follows every
`mousemove` event, so the CDP screencast shows where the agent's pointer is
even though the OS cursor is not captured by the screencaster.
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator

from ..events import Kind
from .base import ToolResult

#: Injected into every page via add_init_script: a red dot that tracks the
#: mouse pointer. The OS cursor is not captured by CDP screencast, so this is
#: the only way to show "where" the agent is looking without a second overlay
#: that would be absent from recordings.
_CURSOR_JS = """\
(() => {
  function _install() {
    if (!document.body || document.getElementById('__autora_cur__')) return;
    const c = document.createElement('div');
    c.id = '__autora_cur__';
    c.style.cssText =
      'position:fixed;left:-999px;top:-999px;width:14px;height:14px;' +
      'pointer-events:none;z-index:2147483646;background:rgba(255,59,107,.9);' +
      'border-radius:50%;border:2px solid rgba(255,255,255,.85);' +
      'box-shadow:0 1px 4px rgba(0,0,0,.55);transition:left .04s,top .04s;';
    document.body.appendChild(c);
    document.addEventListener('mousemove', e => {
      c.style.left = (e.clientX - 7) + 'px';
      c.style.top  = (e.clientY - 7) + 'px';
    }, {passive: true});
  }
  if (document.body) _install(); else window.addEventListener('DOMContentLoaded', _install);
})()
"""

#: What is under this point, and what could be edited about it.
#:
#: The numbered snapshot answers "what can I click". This answers "what *is*
#: that" -- which element, from which component, styled with what. The second
#: question is the one you have when you are looking at a thing you want
#: changed, and pointing at it is a far more precise way to ask than describing
#: it in prose and hoping the agent finds the same element.
#:
#: Three things make it precise rather than approximate: it retargets from the
#: label you hit to the control you meant, it reports only the styles this
#: element sets rather than the whole inherited cascade, and where the
#: framework left a trail (React's dev fiber, a data-source attribute) it
#: resolves back to the file that rendered it.
_PICK_JS = r"""
((x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, reason: 'nothing at that point' };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // --- where did this come from in the source? ---------------------------
  // The difference between "edit that element" and "guess which component
  // rendered it". React's dev build carries the JSX source on the fiber; Vue
  // and Svelte expose their own hooks. Nothing here works in a production
  // build, which is the honest limitation -- so a fingerprint is always
  // returned too, and that is greppable.
  function source(node) {
    for (let cur = node; cur; cur = cur.parentElement) {
      const explicit = cur.getAttribute && (cur.getAttribute('data-source')
        || cur.getAttribute('data-sourcefile'));
      if (explicit) return { file: explicit, via: 'data-attribute',
                             exact: cur === node };

      const key = Object.keys(cur).find((k) => k.startsWith('__reactFiber$')
        || k.startsWith('__reactInternalInstance$'));
      if (key) {
        let fiber = cur[key], hops = 0, component = null;
        while (fiber && hops++ < 30) {
          const t = fiber.elementType || fiber.type;
          if (!component && typeof t === 'function' && t.name) component = t.name;
          const src = fiber._debugSource;
          if (src && src.fileName) {
            return { file: src.fileName, line: src.lineNumber,
                     column: src.columnNumber, component: component,
                     via: 'react', exact: cur === node };
          }
          fiber = fiber._debugOwner || fiber.return;
        }
        if (component) return { component: component, via: 'react', exact: cur === node };
      }

      const vue = cur.__vueParentComponent;
      if (vue && vue.type) {
        return { component: vue.type.__name || vue.type.name,
                 file: vue.type.__file, via: 'vue', exact: cur === node };
      }
    }
    return null;
  }

  // --- a fingerprint that survives a production build --------------------
  // Classes and text are what someone would grep for, so they are what we
  // hand back when the framework tells us nothing.
  function fingerprint(node) {
    const classes = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      classes: classes.slice(0, 8),
      text: clean(node.innerText).slice(0, 80) || null,
      testid: node.getAttribute('data-testid') || null,
    };
  }

  // A selector that is stable enough to act on, preferring the things a human
  // would have written deliberately over generated class soup.
  function selectorFor(node) {
    if (node.id) return '#' + CSS.escape(node.id);
    const testid = node.getAttribute('data-testid');
    if (testid) return '[data-testid="' + testid + '"]';
    const parts = [];
    for (let cur = node; cur && cur.nodeType === 1 && parts.length < 5;
         cur = cur.parentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      const siblings = cur.parentElement
        ? [].filter.call(cur.parentElement.children, (c) => c.tagName === cur.tagName)
        : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  // --- the parameters worth editing --------------------------------------
  // Computed style has ~340 properties and almost all of them are noise. These
  // are the ones someone actually means when they say "make it bigger" or
  // "soften that corner", grouped the way they would say them.
  const GROUPS = {
    layout: ['display', 'position', 'flex-direction', 'justify-content',
             'align-items', 'gap', 'grid-template-columns'],
    spacing: ['margin', 'padding'],
    size: ['width', 'height', 'min-height', 'max-width'],
    text: ['font-family', 'font-size', 'font-weight', 'line-height',
           'letter-spacing', 'text-align', 'color', 'text-transform'],
    surface: ['background-color', 'background-image', 'border', 'border-radius',
              'box-shadow', 'opacity', 'backdrop-filter'],
  };
  //: Always worth stating outright, even when inherited -- "what colour is it"
  //: is a question about the pixels, not about which rule won.
  const ALWAYS = ['color', 'background-color', 'font-size', 'font-family'];

  function params(node) {
    const cs = getComputedStyle(node);
    // A fresh element of the same tag, in the same parent, inherits everything
    // this one inherits. Anything that still differs is this element's own
    // doing -- which is what someone means when they ask what it is styled
    // with. Comparing against a global default instead would report the whole
    // inherited cascade as though the element had set it.
    const probe = document.createElement(node.tagName);
    probe.style.cssText = 'position:absolute!important;left:-99999px!important';
    (node.parentElement || document.body).appendChild(probe);
    const base = getComputedStyle(probe);

    const out = {};
    try {
      for (const group of Object.keys(GROUPS)) {
        const bag = {};
        for (const prop of GROUPS[group]) {
          const v = clean(cs.getPropertyValue(prop));
          if (!v) continue;
          const isDefault = v === clean(base.getPropertyValue(prop));
          if (isDefault && ALWAYS.indexOf(prop) < 0) continue;
          // Values that are 'unset' wearing a costume.
          if (v === 'none' || v === 'normal' || v === 'auto'
              || v === 'rgba(0, 0, 0, 0)' || v === '0px' || v === 'static'
              || /^0px none/.test(v)) continue;
          bag[prop] = v.length > 90 ? v.slice(0, 90) + '…' : v;
        }
        if (Object.keys(bag).length) out[group] = bag;
      }
    } finally {
      probe.remove();
    }
    return out;
  }

  // --- which element did they actually mean? -----------------------------
  // You click the label and you mean the button. So the target is the nearest
  // ancestor that someone would name: one the snapshot already numbered, one
  // the author gave an id or a test id, or one that draws a box of its own.
  // The literal hit and the chain above it come back too, so stepping up or
  // down costs no second round trip.
  function meaningful(node) {
    const refs = window.__autora_refs || [];
    let best = node;
    for (let cur = node, hops = 0; cur && cur !== document.body && hops < 6;
         cur = cur.parentElement, hops++) {
      if (refs.indexOf(cur) >= 0) return cur;
      if (cur.id || cur.getAttribute('data-testid')) return cur;
      if (best === node && cur !== node) {
        const cs = getComputedStyle(cur);
        const boxy = cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
          || cs.borderTopWidth !== '0px' || cs.boxShadow !== 'none';
        if (boxy) best = cur;
      }
    }
    return best;
  }

  function outline(node) {
    const r = node.getBoundingClientRect();
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      testid: node.getAttribute('data-testid') || null,
      classes: (node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4),
      ref: (window.__autora_refs || []).indexOf(node),
      box: { x: Math.round(r.x), y: Math.round(r.y),
             w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  const target = meaningful(el);
  const rect = target.getBoundingClientRect();
  const refs = window.__autora_refs || [];

  const chain = [];
  for (let cur = target.parentElement, hops = 0;
       cur && cur !== document.documentElement && hops < 4;
       cur = cur.parentElement, hops++) {
    chain.push(outline(cur));
  }

  const isCanvas = target.tagName.toLowerCase() === 'canvas';
  return {
    ok: true,
    kind: isCanvas ? 'canvas' : 'dom',
    ref: refs.indexOf(target) >= 0 ? refs.indexOf(target) : null,
    retargeted: target !== el ? outline(el) : null,
    selector: selectorFor(target),
    fingerprint: fingerprint(target),
    source: source(target),
    params: params(target),
    box: { x: Math.round(rect.x), y: Math.round(rect.y),
           w: Math.round(rect.width), h: Math.round(rect.height) },
    ancestors: chain,
    canvas: isCanvas ? { w: target.width, h: target.height,
                         dpr: window.devicePixelRatio || 1 } : null,
  };
})
"""

#: The same question, asked of a <canvas>, where the DOM has nothing to say.
#:
#: A 3D app has an accessibility tree too -- it is just called a scene graph,
#: and only the engine can read it. Where the engine is reachable, a click
#: becomes a raycast and comes back as a named object. Where it is not, the
#: caller falls back to a cropped screenshot of the click, which is far cheaper
#: than a whole frame and unambiguous about what is being asked about.
_SCENE_JS = r"""
((nx, ny) => {
  // --- which engine is driving this canvas? ------------------------------
  // There is no DOM under a <canvas>, so the only way to name what is on
  // screen is to ask the engine that drew it. Each exposes a scene graph --
  // which is the accessibility tree of a 3D app: named objects in a
  // hierarchy, addressable as text instead of pixels.
  const w = window;
  const kind = w.BABYLON ? 'babylon'
    : (w.THREE || w.__THREE__ || w.__THREE_DEVTOOLS__) ? 'three'
    : w.Phaser ? 'phaser' : w.PIXI ? 'pixi' : null;
  if (!kind) return { engine: null, reason: 'no known 3D engine on window' };

  // Apps rarely hand their scene to the global namespace on purpose, so look
  // in the places they conventionally end up before giving up.
  function findBy(test) {
    const roots = [w, w.app, w.game, w.viewer, w.experience, w.__app];
    for (const root of roots) {
      if (!root) continue;
      for (const key of Object.keys(root)) {
        try {
          const value = root[key];
          if (value && test(value)) return value;
        } catch (e) { /* cross-origin or throwing getter */ }
      }
    }
    return null;
  }

  function walk(node, depth, out, max) {
    if (!node || out.length >= max) return out;
    const name = node.name || (node.type || node.constructor && node.constructor.name);
    const p = node.position;
    out.push({
      depth: depth,
      name: name || '(unnamed)',
      type: node.type || (node.constructor && node.constructor.name) || '?',
      visible: node.visible !== false,
      position: p ? [round(p.x), round(p.y), round(p.z)] : null,
    });
    const kids = node.children || [];
    for (let i = 0; i < kids.length && out.length < max; i++) {
      walk(kids[i], depth + 1, out, max);
    }
    return out;
  }
  const round = (n) => Math.round(n * 100) / 100;

  if (kind === 'babylon') {
    const scene = findBy((v) => v && v.getEngine && v.meshes);
    if (!scene) return { engine: kind, reason: 'scene not reachable from window' };
    const rect = scene.getEngine().getRenderingCanvas().getBoundingClientRect();
    const hit = scene.pick(nx * rect.width, ny * rect.height);
    return {
      engine: kind,
      picked: hit && hit.hit && hit.pickedMesh ? {
        name: hit.pickedMesh.name,
        type: hit.pickedMesh.getClassName && hit.pickedMesh.getClassName(),
        point: hit.pickedPoint
          ? [round(hit.pickedPoint.x), round(hit.pickedPoint.y), round(hit.pickedPoint.z)]
          : null,
        material: hit.pickedMesh.material && hit.pickedMesh.material.name,
      } : null,
      graph: walk(scene.rootNodes ? { children: scene.rootNodes } : scene, 0, [], 60),
    };
  }

  const scene = findBy((v) => v && v.isScene);
  const camera = findBy((v) => v && v.isCamera);
  if (!scene) return { engine: kind, reason: 'scene not reachable from window' };

  let picked = null;
  const THREE = w.THREE;
  if (camera && THREE && THREE.Raycaster) {
    // Normalised device coordinates: the click, expressed the way a camera
    // thinks about the screen.
    const ray = new THREE.Raycaster();
    ray.setFromCamera({ x: nx * 2 - 1, y: -(ny * 2 - 1) }, camera);
    const hits = ray.intersectObjects(scene.children, true);
    if (hits.length) {
      const h = hits[0];
      picked = {
        name: h.object.name || '(unnamed)',
        type: h.object.type,
        distance: round(h.distance),
        point: [round(h.point.x), round(h.point.y), round(h.point.z)],
        material: h.object.material && (h.object.material.name || h.object.material.type),
      };
    }
  }
  return {
    engine: kind,
    picked: picked,
    reason: picked ? null : (camera ? 'ray hit nothing' : 'camera not reachable'),
    graph: walk(scene, 0, [], 60),
  };
})
"""

#: The guidance overlay: a spotlight, a breathing ring, a label.
#:
#: Painted into the page rather than drawn over the video feed in the UI, for
#: the same reason the click marker is -- an overlay drawn in the UI would be
#: absent from the recording, so the person being guided and the person
#: reviewing the session later would not see the same thing.
_GUIDE_JS = r"""
(() => {
  const ID = '__autora_guide__';
  const NS = 'http://www.w3.org/2000/svg';

  function ensure() {
    let host = document.getElementById(ID);
    if (host) return host;
    host = document.createElement('div');
    host.id = ID;
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483600;pointer-events:none;' +
      'opacity:0;transition:opacity .28s cubic-bezier(.32,.72,0,1)';
    // A shadow root, so the overlay is genuinely outside the page rather than
    // merely on top of it. Without one its label lands in the page's own
    // innerText -- a `read` would return "Sign in selected" -- and the page's
    // CSS can restyle the guidance. Neither is acceptable for something the
    // harness paints over someone else's document.
    host.__root = host.attachShadow({ mode: 'open' });
    // Painted into the page rather than drawn over the video in the UI, so it
    // survives into the screencast and therefore into the recording -- the
    // person being guided and the person reviewing the session see the same
    // thing.
    host.__root.innerHTML =
      '<div data-dim style="position:absolute;border-radius:10px;' +
        'box-shadow:0 0 0 9999px rgba(6,7,10,.58);' +
        'transition:all .42s cubic-bezier(.32,.72,0,1)"></div>' +
      '<div data-ring style="position:absolute;border:2px solid #6e5bff;' +
        'border-radius:12px;box-shadow:0 0 0 4px rgba(110,91,255,.22),' +
        '0 8px 30px -6px rgba(110,91,255,.5);' +
        'transition:all .42s cubic-bezier(.32,.72,0,1)"></div>' +
      '<div data-chip style="position:absolute;padding:6px 11px;border-radius:8px;' +
        'background:#6e5bff;color:#fff;font:600 12.5px/1.35 ui-sans-serif,system-ui,' +
        'sans-serif;box-shadow:0 6px 20px -4px rgba(0,0,0,.6);max-width:320px;' +
        'transition:all .42s cubic-bezier(.32,.72,0,1)"></div>';
    document.documentElement.appendChild(host);

    const style = document.createElement('style');
    // A slow breath, not a strobe. This sits on screen while someone reads.
    style.textContent =
      '@keyframes breathe{0%,100%{box-shadow:0 0 0 4px rgba(110,91,255,.22),' +
      '0 8px 30px -6px rgba(110,91,255,.5)}50%{box-shadow:0 0 0 10px rgba(110,91,255,0),' +
      '0 8px 30px -6px rgba(110,91,255,.28)}}' +
      '@media (prefers-reduced-motion:reduce){*{animation:none!important;' +
      'transition:none!important}}';
    host.__root.appendChild(style);
    return host;
  }

  const api = {
    show(spec) {
      const host = ensure();
      const box = spec.box;
      const pad = spec.pad == null ? 6 : spec.pad;
      const root = host.__root;
      const dim = root.querySelector('[data-dim]');
      const ring = root.querySelector('[data-ring]');
      const chip = root.querySelector('[data-chip]');

      const x = box.x - pad, y = box.y - pad;
      const w = box.w + pad * 2, h = box.h + pad * 2;
      for (const el of [dim, ring]) {
        el.style.left = x + 'px'; el.style.top = y + 'px';
        el.style.width = w + 'px'; el.style.height = h + 'px';
      }
      dim.style.display = spec.dim === false ? 'none' : 'block';
      ring.style.animation = 'breathe 2.6s ease-in-out infinite';

      if (spec.label) {
        chip.textContent = spec.label;
        chip.style.display = 'block';
        // Above the target, unless that would fall off the top of the window.
        const below = y < 52;
        chip.style.left = Math.max(8, Math.min(x, innerWidth - 340)) + 'px';
        chip.style.top = (below ? y + h + 10 : y - 40) + 'px';
      } else {
        chip.style.display = 'none';
      }

      requestAnimationFrame(() => { host.style.opacity = '1'; });
      if (spec.ms) {
        clearTimeout(api._t);
        api._t = setTimeout(() => api.hide(), spec.ms);
      }
      return true;
    },

    hide() {
      const host = document.getElementById(ID);
      if (!host) return false;
      host.style.opacity = '0';
      clearTimeout(api._t);
      return true;
    },
  };

  window.__autora_guide = api;
  return true;
})
"""

#: The page as the model reads it: every interactive element, with the role and
#: accessible name a screen reader would announce, plus a numeric ref to act on.
#:
#: This is the accessibility tree rather than the DOM on purpose. The DOM is
#: wrapper soup -- a button is six nested divs, and the text around it says
#: nothing about what can be clicked. The a11y layer is the one the platform
#: already computes for exactly this problem: perceiving an interface without
#: looking at it. Roles and names come out of it for free, form fields and their
#: current values are in it (they are invisible to `innerText`), and the whole
#: page collapses to a few hundred tokens.
#:
#: Refs are held in `window.__autora_refs` rather than stamped onto elements as
#: attributes: reading a page must not modify it, and a data attribute is still
#: a modification that a MutationObserver or an attribute selector can see.
_SNAPSHOT_JS = r"""
((maxEls) => {
  const refs = [];
  window.__autora_refs = refs;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vw = window.innerWidth, vh = window.innerHeight;

  function visible(el) {
    if (el.closest('[aria-hidden="true"]')) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') return false;
    return true;
  }

  function roleOf(el) {
    const explicit = clean(el.getAttribute('role'));
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'expander';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      if (['button', 'submit', 'reset', 'image'].indexOf(t) >= 0) return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return null;
  }

  // Accessible name, in roughly the order the accname spec resolves it. This is
  // what a screen reader would announce, which is also the handle a human would
  // describe the control by -- "the Sign in button", not "button.btn-primary".
  function nameOf(el, role) {
    let n = clean(el.getAttribute('aria-label'));
    if (n) return n;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      n = clean(lb.split(/\s+/).map((id) => {
        const t = document.getElementById(id);
        return t ? t.innerText || t.getAttribute('aria-label') : '';
      }).join(' '));
      if (n) return n;
    }
    if (el.labels && el.labels.length) {
      n = clean([].map.call(el.labels, (l) => l.innerText).join(' '));
      if (n) return n;
    }
    n = clean(el.getAttribute('placeholder')) || clean(el.getAttribute('alt'))
      || clean(el.getAttribute('title'));
    if (n) return n;
    if (role === 'button' && el.tagName.toLowerCase() === 'input') {
      n = clean(el.getAttribute('value'));
      if (n) return n;
    }
    // Not for fields: a <select>'s innerText is its option list, and a
    // textbox's is whatever the user has typed -- neither is a name.
    if (role !== 'textbox' && role !== 'combobox') {
      n = clean(el.innerText);
      if (n) return n;
    }
    // Last resort: the developer's own handle. Ugly, but a nameless field is
    // worse than one identified by its form name.
    return clean(el.getAttribute('name') || el.getAttribute('id'));
  }

  function stateOf(el, role) {
    const bits = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (role === 'checkbox' || role === 'radio') {
      const on = el.checked !== undefined ? el.checked
        : el.getAttribute('aria-checked') === 'true';
      bits.push(on ? 'checked' : 'unchecked');
    } else if (role === 'textbox') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      const v = el.isContentEditable ? clean(el.innerText) : (el.value || '');
      // Never echo a credential back into the transcript, even as a "value".
      if (t === 'password') bits.push(v ? 'password set' : 'password empty');
      else if (v) bits.push('value=' + JSON.stringify(v.slice(0, 60)));
      else bits.push('empty');
    } else if (role === 'combobox' && el.selectedOptions) {
      const sel = clean([].map.call(el.selectedOptions, (o) => o.text).join(', '));
      bits.push('value=' + JSON.stringify(sel.slice(0, 60)));
    }
    const exp = el.getAttribute('aria-expanded');
    if (exp) bits.push(exp === 'true' ? 'expanded' : 'collapsed');
    return bits;
  }

  const SEL = 'a[href],button,input,select,textarea,summary,[role],[onclick],' +
    '[contenteditable=""],[contenteditable="true"]';
  const seen = new Set();
  const found = [];

  const all = document.querySelectorAll(SEL);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (seen.has(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    // Presentational roles carry no affordance; listing them is pure noise.
    if (role === 'presentation' || role === 'none' || role === 'generic') continue;
    if (!visible(el)) continue;
    seen.add(el);

    const name = nameOf(el, role).slice(0, 80);
    const bits = stateOf(el, role);
    // A nameless, stateless control is something the model cannot ask for and
    // should not guess at -- skip it rather than emit "[7] link".
    if (!name && !bits.length) continue;

    const r = el.getBoundingClientRect();
    const off = r.top > vh || r.bottom < 0 || r.left > vw || r.right < 0;
    found.push({ el: el, role: role, name: name, bits: bits, off: off });
  }

  // Over budget, off-screen elements go first. What is on screen is what the
  // model can act on this instant; a link 1400px down is a reason to scroll,
  // not a reason to spend the budget. Document order is preserved either way --
  // it is the reading order, and shuffling it costs comprehension.
  let keep = found;
  let dropped = 0;
  if (found.length > maxEls) {
    const onscreen = found.filter((f) => !f.off);
    const budget = Math.max(maxEls - onscreen.length, 0);
    const offKeep = new Set(found.filter((f) => f.off).slice(0, budget));
    keep = found.filter((f) => !f.off || offKeep.has(f));
    if (keep.length > maxEls) keep = keep.slice(0, maxEls);
    dropped = found.length - keep.length;
  }

  const lines = keep.map((f) => {
    const ref = refs.length;
    refs.push(f.el);
    let line = '[' + ref + '] ' + f.role;
    if (f.name) line += ' ' + JSON.stringify(f.name);
    if (f.bits.length) line += ' ' + f.bits.join(' ');
    if (f.role === 'link') {
      const href = f.el.getAttribute('href') || '';
      if (href && href.indexOf('javascript:') !== 0) line += ' -> ' + href.slice(0, 70);
    }
    if (f.off) line += ' (off-screen)';
    return line;
  });

  return {
    lines: lines,
    total: lines.length,
    dropped: dropped,
    offscreen: keep.filter((f) => f.off).length,
    title: document.title,
    url: location.href,
  };
})
"""

#: JS injected before a click: a ring that fades over ~600ms at the click point.
#: Painted into the page so the screencast captures it -- an overlay drawn in the
#: UI instead would be absent from the recording and from any shared clip.
_MARKER_JS = """
(([x, y, label]) => {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;
    height:44px;border:3px solid #ff3b6b;border-radius:50%;z-index:2147483647;
    pointer-events:none;box-shadow:0 0 0 3px rgba(255,59,107,.28);
    transition:opacity .55s ease-out,transform .55s ease-out;`;
  if (label) {
    const t = document.createElement('div');
    t.textContent = label;
    t.style.cssText = `position:absolute;left:52px;top:10px;white-space:nowrap;
      font:600 12px ui-monospace,monospace;color:#fff;background:#ff3b6b;
      padding:3px 7px;border-radius:5px;`;
    d.appendChild(t);
  }
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'scale(1.7)'; });
  setTimeout(() => d.remove(), 700);
})
"""


_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)


class BrowserSession:
    """Owns one Chromium instance and pipes its screencast into the event log."""

    def __init__(
        self,
        session,
        headless: bool = True,
        width: int = 1280,
        height: int = 800,
        executable_path: str | None = None,
        profile_dir: str | None = None,
    ):
        self.session = session
        self.headless = headless
        self.width, self.height = width, height
        self.executable_path = executable_path or os.environ.get("AUTORA_CHROME_PATH")
        self.profile_dir = profile_dir or os.environ.get("AUTORA_BROWSER_PROFILE")
        self._playwright = None
        self._browser = None
        self._context = None
        self.page = None
        self._cdp = None
        self._frames = 0
        self._started = 0.0

    async def ensure_started(self) -> None:
        if self.page is not None:
            return
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:  # pragma: no cover - depends on install
            raise RuntimeError(
                "Playwright is not installed. Run: uv pip install playwright "
                "&& playwright install chromium. If you already have a Chromium, "
                "set AUTORA_CHROME_PATH to its binary instead."
            ) from exc

        self._playwright = await async_playwright().start()
        common_kwargs: dict[str, Any] = {
            "headless": self.headless,
            "args": ["--disable-blink-features=AutomationControlled"],
        }
        if self.executable_path:
            common_kwargs["executable_path"] = self.executable_path

        if self.profile_dir:
            # Persistent context: cookies/localStorage survive across restarts.
            # The user signs in once to Gmail/Google Calendar/etc and the auth
            # persists until they explicitly clear the profile.
            Path(self.profile_dir).mkdir(parents=True, exist_ok=True)
            context = await self._playwright.chromium.launch_persistent_context(
                str(self.profile_dir),
                viewport={"width": self.width, "height": self.height},
                user_agent=_UA,
                **common_kwargs,
            )
            self._context = context
            # Persistent context may already have open pages from a previous run.
            self.page = context.pages[0] if context.pages else await context.new_page()
        else:
            # Ephemeral context: clean slate every time -- fine for stateless tasks.
            self._browser = await self._playwright.chromium.launch(**common_kwargs)
            context = await self._browser.new_context(
                viewport={"width": self.width, "height": self.height},
                # A real UA: many sites serve a degraded page to obvious automation,
                # and debugging that is a waste of an afternoon.
                user_agent=_UA,
            )
            self._context = context
            self.page = await context.new_page()

        # Inject cursor tracker so the screencast shows where the pointer is.
        await context.add_init_script(_CURSOR_JS)
        # Dormant until something calls it; costs nothing to have ready.
        await context.add_init_script(f"({_GUIDE_JS})()")
        self._started = time.monotonic()
        await self._start_screencast()
        self.page.on("framenavigated", self._on_navigate)

    def _on_navigate(self, frame: Any) -> None:
        # Only top-level navigations; iframe churn would flood the timeline.
        if self.page and frame == self.page.main_frame:
            self.session.emit(Kind.BROWSER_NAV, {"url": frame.url}, actor="tool:browser")

    async def _start_screencast(self) -> None:
        self._cdp = await self.page.context.new_cdp_session(self.page)

        def on_frame(params: dict[str, Any]) -> None:
            data = base64.b64decode(params["data"])
            meta = params.get("metadata", {})
            self._frames += 1
            self.session.emit_frame(
                Kind.BROWSER_FRAME, data, stream="browser",
                t=round(time.monotonic() - self._started, 3),
                w=meta.get("deviceWidth"), h=meta.get("deviceHeight"),
                scroll_y=meta.get("scrollOffsetY", 0),
            )
            # Chrome throttles the screencast until each frame is acknowledged.
            # Miss this and the feed delivers one frame and stops.
            asyncio.create_task(self._ack(params["sessionId"]))

        self._cdp.on("Page.screencastFrame", on_frame)
        await self._cdp.send("Page.startScreencast", {
            "format": "jpeg",
            # 60 is the point where text is still crisp but frames stay ~30-60KB.
            "quality": 60,
            "maxWidth": self.width, "maxHeight": self.height,
            # Chrome only pushes on paint, so this is a ceiling, not a poll rate:
            # a static page costs nothing.
            "everyNthFrame": 1,
        })

    async def _ack(self, session_id: int) -> None:
        try:
            await self._cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:
            # The page can navigate or close between frame and ack; that is
            # normal and must not surface as an error in the timeline.
            pass

    async def mark(self, x: float, y: float, label: str = "") -> None:
        """Paint a click marker into the page so the recording shows the target."""
        try:
            await self.page.evaluate(_MARKER_JS, [x, y, label])
            # One frame's worth of time so the marker is actually painted and
            # captured before the click navigates away.
            await asyncio.sleep(0.05)
        except Exception:
            pass

    async def guide(self, box: dict[str, Any], label: str = "",
                    ms: float | None = None) -> None:
        """Spotlight a region of the page for whoever is watching."""
        if self.page is None:
            return
        try:
            await self.page.evaluate(
                "(spec) => window.__autora_guide && window.__autora_guide.show(spec)",
                {"box": box, "label": label, "ms": ms},
            )
        except Exception:
            # Guidance is decoration. A page that navigated mid-call must not
            # take the turn down with it.
            pass

    async def close(self) -> None:
        for closer in (
            lambda: self._cdp.send("Page.stopScreencast") if self._cdp else None,
            lambda: self._context.close() if self._context else None,
            lambda: self._browser.close() if self._browser else None,
            lambda: self._playwright.stop() if self._playwright else None,
        ):
            try:
                result = closer()
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass
        self.page = self._context = self._browser = self._playwright = self._cdp = None


#: How many elements a refreshed snapshot carries after an action, versus an
#: explicit `read`. Post-action snapshots are the common case and want to be
#: cheap; a `read` is a deliberate "show me this page" and can afford more.
SNAPSHOT_AFTER_ACTION = 35
SNAPSHOT_ON_READ = 90


async def _snapshot(page, limit: int) -> dict[str, Any]:
    return await page.evaluate(f"({_SNAPSHOT_JS})({int(limit)})")


def _render(snap: dict[str, Any]) -> str:
    """The interactive map, as the model reads it."""
    if not snap["lines"]:
        return "No interactive elements found."
    out = "\n".join(snap["lines"])
    notes = []
    if snap.get("dropped"):
        notes.append(f"{snap['dropped']} more not shown")
    if snap.get("offscreen"):
        notes.append(f"{snap['offscreen']} off-screen — scroll to reach them")
    if notes:
        out += f"\n({'; '.join(notes)})"
    return out


async def _target(page, args: dict[str, Any], key: str = "ref"):
    """Resolve a ref or a selector to one element handle.

    Both paths end at an ElementHandle so every action has a single code path.
    Refs come from the last snapshot; a stale one fails loudly rather than
    clicking whatever now occupies that index, because a ref that silently
    points somewhere else is how an agent ends up buying something.
    """
    ref = args.get(key)
    if ref is not None:
        handle = await page.evaluate_handle(
            "(i) => (window.__autora_refs || [])[i] || null", int(ref))
        element = handle.as_element()
        if element is None:
            raise LookupError(
                f"ref {ref} is stale or out of range — the page changed since the "
                f"last snapshot. Use `read` to get fresh refs.")
        # A ref for an element that has since been detached is just as stale.
        if not await element.evaluate("(e) => e.isConnected"):
            raise LookupError(
                f"ref {ref} points at an element no longer in the page. "
                f"Use `read` to get fresh refs.")
        await element.scroll_into_view_if_needed(timeout=5000)
        return element
    selector = args.get("selector")
    if not selector:
        raise LookupError("Give either a ref (from the last snapshot) or a selector.")
    element = await page.wait_for_selector(selector, state="visible", timeout=10000)
    if element is None:
        raise LookupError(f"No visible element matched {selector!r}.")
    return element


async def _describe(element) -> str:
    """A short human label for the log and the click marker.

    Same order the snapshot names elements by, so the label in the recording
    matches the one the model was shown. A checkbox labelled by a sibling
    `<label for=...>` is the common case that a naive version renders as
    "INPUT" -- which tells whoever is reviewing the session nothing.
    """
    return (await element.evaluate("""(e) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const byId = clean((e.getAttribute('aria-labelledby') || '').split(/\s+/)
            .map((i) => (document.getElementById(i) || {}).innerText).join(' '));
        const byLabel = e.labels && e.labels.length
            ? clean([].map.call(e.labels, (l) => l.innerText).join(' ')) : '';
        return clean(e.getAttribute('aria-label')) || byId || byLabel
            || clean(e.innerText) || clean(e.getAttribute('placeholder'))
            || clean(e.getAttribute('value')) || clean(e.getAttribute('name'))
            || e.tagName.toLowerCase();
    }"""))[:40]


async def _is_sensitive(element, override: bool) -> bool:
    """Decide from the DOM whether a value must never reach the record.

    The model does not reliably know it is filling a password, and a leaked
    credential in a shareable recording is not a mistake you get to take back.
    """
    if override:
        return True
    field_type = (await element.get_attribute("type") or "").lower()
    if field_type == "password":
        return True
    name = ((await element.get_attribute("name") or "") + " "
            + (await element.get_attribute("id") or "")
            + " " + (await element.get_attribute("autocomplete") or "")).lower()
    return any(w in name for w in
               ("password", "passwd", "secret", "token", "cvv", "card", "ssn"))


def _render_pick(hit: dict[str, Any]) -> str:
    """The descriptor, as the model reads it."""
    fp = hit.get("fingerprint") or {}
    head = f"<{fp.get('tag', '?')}>"
    if fp.get("id"):
        head += f" #{fp['id']}"
    if fp.get("classes"):
        head += " ." + ".".join(fp["classes"])
    lines = [f"Picked {head}"]
    if hit.get("ref") is not None:
        lines.append(f"Snapshot ref: [{hit['ref']}] — act on it with click(ref=…)")
    if hit.get("retargeted"):
        r = hit["retargeted"]
        lines.append(f"(you pointed at a <{r['tag']}> inside it)")
    if fp.get("text"):
        lines.append(f"Text: {fp['text']!r}")
    lines.append(f"Selector: {hit.get('selector')}")

    source = hit.get("source")
    if source:
        where = source.get("file") or "(unknown file)"
        if source.get("line"):
            where += f":{source['line']}"
        component = f" in <{source['component']}>" if source.get("component") else ""
        lines.append(f"Source: {where}{component}  (via {source.get('via')})")
    else:
        # Say so plainly. A production build strips this, and an agent that
        # assumes a file it cannot see will edit the wrong one.
        lines.append("Source: not exposed by this build — search for the classes "
                     "or text above to find where it is defined.")

    box = hit.get("box") or {}
    lines.append(f"Box: {box.get('w')}×{box.get('h')} at ({box.get('x')}, {box.get('y')})")

    params = hit.get("params") or {}
    if params:
        lines.append("\nStyled with (only what this element sets):")
        for group, values in params.items():
            pairs = ", ".join(f"{k}: {v}" for k, v in values.items())
            lines.append(f"  {group}: {pairs}")

    ancestors = hit.get("ancestors") or []
    if ancestors:
        crumbs = " < ".join(
            (a["tag"] + (f"#{a['id']}" if a.get("id") else "")
             + (f"[{a['testid']}]" if a.get("testid") else ""))
            for a in ancestors)
        lines.append(f"\nInside: {crumbs}")
    return "\n".join(lines)


def _render_scene(graph: dict[str, Any]) -> str:
    lines = [f"3D engine: {graph.get('engine')}"]
    picked = graph.get("picked")
    if picked:
        lines.append(f"Hit: {picked.get('name')} ({picked.get('type')})"
                     + (f" at {picked.get('point')}" if picked.get("point") else "")
                     + (f", material {picked['material']}" if picked.get("material") else ""))
    elif graph.get("reason"):
        lines.append(f"No object picked: {graph['reason']}")
    nodes = graph.get("graph") or []
    if nodes:
        lines.append("\nScene graph:")
        for node in nodes:
            lines.append("  " + "  " * node["depth"]
                         + f"{node['name']}  {node['type']}"
                         + ("" if node.get("visible", True) else "  (hidden)"))
    return "\n".join(lines)


#: How much of the canvas to crop around a click. Big enough to carry context,
#: small enough that it is not just a screenshot with extra steps.
CROP = 320


async def _describe_canvas(page, session, span, hit, x: float, y: float) -> ToolResult:
    """What is at this point on a <canvas>.

    Two answers, best first. If the engine is reachable the click becomes a
    raycast and comes back as a named object, which is text and can be reasoned
    about. If it is not -- the usual case, since apps rarely publish their scene
    -- a tight crop of the click is the honest fallback: far cheaper than a
    whole frame, and unambiguous about what is being asked about.
    """
    box = hit.get("canvas") or {}
    rect = hit.get("box") or {}
    width = rect.get("w") or box.get("w") or 1
    height = rect.get("h") or box.get("h") or 1
    nx = (x - rect.get("x", 0)) / max(width, 1)
    ny = (y - rect.get("y", 0)) / max(height, 1)

    parts = [f"That point is on a <canvas> ({box.get('w')}×{box.get('h')}), "
             f"at {nx:.3f}, {ny:.3f} of it."]
    graph = await page.evaluate(f"({_SCENE_JS})({nx}, {ny})")
    if graph.get("engine"):
        parts.append(_render_scene(graph))
    else:
        parts.append("No 3D engine is reachable, so there is nothing to name. "
                     "Cropped the click instead — it is in the recording.")

    half = CROP // 2
    clip = {
        "x": max(x - half, 0), "y": max(y - half, 0),
        "width": min(CROP, page.viewport_size["width"] - max(x - half, 0)),
        "height": min(CROP, page.viewport_size["height"] - max(y - half, 0)),
    }
    shot = await page.screenshot(type="jpeg", quality=80, clip=clip)
    session.emit_frame(Kind.BROWSER_FRAME, shot, stream="browser",
                       explicit=True, crop=clip)
    parts.append(f"Crop is {int(clip['width'])}×{int(clip['height'])} rather than the "
                 f"full viewport.")
    return ToolResult("\n\n".join(parts), display={"pick": hit, "clip": clip})


class BrowserTool:
    name = "browser"
    description = (
        "Drive a real Chromium browser. The page is streamed live to the UI and "
        "recorded.\n"
        "Work from refs, not screenshots: `read` returns the page as numbered "
        "interactive elements ([4] button \"Sign in\"), and click/type/fill take "
        "that number. Every action returns a fresh numbered list, so you rarely "
        "need a second `read`.\n"
        "Use `fill` to complete a whole form in one call rather than typing "
        "field by field.\n"
        "`pick` answers what is at a point and how it is styled — use it when "
        "the human points at something. On a <canvas> it asks the 3D engine "
        "instead and returns the object it hit, plus a cropped image.\n"
        "`highlight` draws a spotlight on the page to show someone where to "
        "look. `scene` dumps the 3D scene graph.\n"
        "`screenshot` is a fallback for when a page is visual (a chart, a "
        "canvas, a layout question) — it costs far more than `read` and cannot "
        "be acted on."
    )
    schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["goto", "read", "click", "type", "fill", "scroll",
                         "pick", "highlight", "scene", "screenshot", "back", "wait"],
            },
            "url": {"type": "string", "description": "For goto."},
            "ref": {
                "type": "integer",
                "description": "Element number from the last snapshot. Preferred "
                               "over selector.",
            },
            "selector": {
                "type": "string",
                "description": "CSS or Playwright selector. Use when you have no "
                               "ref, or the element is not in the snapshot.",
            },
            "text": {"type": "string", "description": "For type."},
            "fields": {
                "type": "array",
                "description": "For fill: several fields in one round trip, e.g. "
                               "[{\"ref\": 2, \"text\": \"ada@example.com\"}, "
                               "{\"ref\": 3, \"text\": \"...\"}].",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "integer"},
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                        "sensitive": {"type": "boolean"},
                    },
                },
            },
            "submit": {"type": "boolean", "description": "Press Enter when done."},
            "sensitive": {
                "type": "boolean",
                "description": "Force redaction of the typed value in the log. "
                               "Password fields are detected and redacted anyway.",
            },
            "amount": {"type": "integer", "description": "Pixels to scroll. Negative is up."},
            "seconds": {"type": "number", "description": "For wait."},
            "x": {"type": "number", "description": "Viewport x, for pick."},
            "y": {"type": "number", "description": "Viewport y, for pick."},
            "label": {"type": "string",
                      "description": "For highlight: the caption shown beside the ring."},
            "ms": {"type": "number",
                   "description": "For highlight: fade out after this many milliseconds. "
                                  "Omit to leave it up until the next highlight."},
            "full_text": {
                "type": "boolean",
                "description": "For read: also return the page's prose. Default true. "
                               "Set false when you only need something to click.",
            },
        },
        "required": ["action"],
    }

    def __init__(
        self,
        headless: bool = True,
        executable_path: str | None = None,
        profile_dir: str | None = None,
    ):
        self.headless = headless
        self.executable_path = executable_path
        self.profile_dir = profile_dir
        self._browser: BrowserSession | None = None

    async def _session_for(self, session) -> BrowserSession:
        if self._browser is None:
            self._browser = BrowserSession(
                session,
                headless=self.headless,
                executable_path=self.executable_path,
                profile_dir=self.profile_dir,
            )
        await self._browser.ensure_started()
        return self._browser

    async def run(self, session, args: dict[str, Any], span: str) -> AsyncIterator[ToolResult]:
        action = args["action"]
        try:
            browser = await self._session_for(session)
        except RuntimeError as exc:
            yield ToolResult(str(exc), ok=False)
            return
        page = browser.page

        async def after(note: str) -> ToolResult:
            """Confirm the action, then hand back a fresh numbered page.

            The expensive part of browser work is not the click, it is the round
            trip: act, then read, then act. Refreshing the snapshot in the
            action's own result collapses that to one call, and keeps refs from
            going stale under an SPA that re-rendered. Old snapshots are trimmed
            out of context by the compactor, so the cost does not accumulate.
            """
            snap = await _snapshot(page, SNAPSHOT_AFTER_ACTION)
            return ToolResult(
                f"{note}\n\n# {snap['title']}\n{snap['url']}\n{_render(snap)}",
                display={"url": page.url},
            )

        try:
            if action == "goto":
                url = args["url"]
                if not url.startswith(("http://", "https://", "file://")):
                    url = "https://" + url
                # `domcontentloaded` rather than `load`: waiting for every
                # tracking pixel makes the agent look hung on most real sites.
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                session.emit(Kind.BROWSER_ACTION, {"action": "goto", "url": url},
                             actor="tool:browser", span=span)
                yield await after(f"Loaded {page.url}")

            elif action == "read":
                snap = await _snapshot(page, SNAPSHOT_ON_READ)
                parts = [f"# {snap['title']}\n{snap['url']}"]
                if args.get("full_text", True):
                    # Hand the model text, not a screenshot. It is an order of
                    # magnitude cheaper, more reliable to act on, and the human
                    # gets the visual channel from the screencast anyway.
                    # Read from a detached clone: stripping elements from the
                    # live document would mean reading a page silently damages
                    # it, and a later click could hit a page whose scripts and
                    # iframes the read had already deleted.
                    parts.append(await page.evaluate("""() => {
                        const src = document.querySelector('main,article,[role=main]')
                            || document.body;
                        const copy = src.cloneNode(true);
                        copy.querySelectorAll('script,style,noscript,svg,iframe')
                            .forEach(e => e.remove());
                        // innerText respects block boundaries but needs layout,
                        // which a detached node lacks. So attach the clone
                        // offscreen -- but not display:none or visibility:hidden,
                        // for which innerText deliberately returns ''.
                        const host = document.createElement('div');
                        host.style.cssText =
                            'position:absolute;left:-99999px;top:0;width:1200px;height:auto';
                        host.appendChild(copy);
                        document.body.appendChild(host);
                        let text = '';
                        try { text = copy.innerText; } finally { host.remove(); }
                        return text.replace(/[ \\t]+/g, ' ')
                            .replace(/\\n\\s*\\n\\s*\\n+/g, '\\n\\n').trim().slice(0, 20000);
                    }"""))
                parts.append("## Interactive\n" + _render(snap))
                session.emit(Kind.BROWSER_ACTION, {
                    "action": "read", "url": page.url, "elements": snap["total"],
                }, actor="tool:browser", span=span)
                yield ToolResult("\n\n".join(parts), display={"url": page.url})

            elif action == "click":
                element = await _target(page, args)
                label = await _describe(element)
                box = await element.bounding_box()
                if box:
                    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                    await browser.mark(cx, cy, label)
                    session.emit(Kind.BROWSER_ACTION, {
                        "action": "click", "ref": args.get("ref"),
                        "selector": args.get("selector"), "label": label,
                        "x": cx, "y": cy,
                    }, actor="tool:browser", span=span)
                await element.click(timeout=10000)
                yield await after(f"Clicked {label!r}.")

            elif action in ("type", "fill"):
                if action == "type":
                    fields = [{k: args.get(k) for k in ("ref", "selector", "text", "sensitive")}]
                else:
                    fields = args.get("fields") or []
                    if not fields:
                        yield ToolResult(
                            "fill needs `fields`, e.g. "
                            "[{\"ref\": 2, \"text\": \"ada@example.com\"}].", ok=False)
                        return

                done: list[str] = []
                for field in fields:
                    element = await _target(page, field)
                    label = await _describe(element)
                    box = await element.bounding_box()
                    if box:
                        await browser.mark(box["x"] + box["width"] / 2,
                                           box["y"] + box["height"] / 2, label)
                    value = field.get("text") or ""
                    sensitive = await _is_sensitive(element, bool(field.get("sensitive")))
                    if sensitive:
                        # Fast fill for credentials: no delay, nothing to see here.
                        await element.fill(value)
                    else:
                        # Visible typing: the screencast shows what is being
                        # written, not just the settled value. One field at a
                        # time is still one round trip for the whole form.
                        await element.click()
                        await element.fill("")
                        await page.keyboard.type(value, delay=18)
                    session.emit(Kind.BROWSER_ACTION, {
                        "action": "type", "ref": field.get("ref"),
                        "selector": field.get("selector"), "label": label,
                        "length": len(value), "sensitive": sensitive,
                        # Record the value only for non-credential fields, where
                        # seeing what went into a search box is the point of a replay.
                        "text": None if sensitive else value[:200],
                    }, actor="tool:browser", span=span)
                    done.append(f"{label!r}" + (" (redacted)" if sensitive else ""))

                if args.get("submit"):
                    await page.keyboard.press("Enter")
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception:
                        # A form that updates in place never fires a navigation.
                        # That is not a failure, and the snapshot below shows it.
                        pass
                note = f"Filled {', '.join(done)}"
                yield await after(note + (" and submitted." if args.get("submit") else "."))

            elif action == "scroll":
                amount = int(args.get("amount") or 600)
                await page.mouse.wheel(0, amount)
                await asyncio.sleep(0.25)
                session.emit(Kind.BROWSER_ACTION, {"action": "scroll", "amount": amount},
                             actor="tool:browser", span=span)
                yield await after(f"Scrolled {amount}px.")

            elif action == "pick":
                x, y = float(args.get("x") or 0), float(args.get("y") or 0)
                # The snapshot first, so the descriptor can carry a ref the
                # agent can already act on rather than a selector it must trust.
                await _snapshot(page, SNAPSHOT_ON_READ)
                hit = await page.evaluate(f"({_PICK_JS})({x}, {y})")
                if not hit.get("ok"):
                    yield ToolResult(f"Nothing at ({x:.0f}, {y:.0f}).", ok=False)
                    return

                session.emit(Kind.BROWSER_PICK, {
                    "x": x, "y": y, "kind": hit["kind"], "ref": hit.get("ref"),
                    "selector": hit.get("selector"), "source": hit.get("source"),
                    "box": hit.get("box"),
                }, actor="tool:browser", span=span)

                if hit["kind"] == "canvas":
                    yield await _describe_canvas(page, session, span, hit, x, y)
                    return

                await browser.guide(hit["box"], args.get("label") or "selected", ms=2500)
                yield ToolResult(_render_pick(hit), display={"pick": hit})

            elif action == "scene":
                graph = await page.evaluate(f"({_SCENE_JS})(0.5, 0.5)")
                if not graph.get("engine"):
                    yield ToolResult(
                        "No 3D engine found on this page. If the app keeps its scene "
                        "private, expose it as window.scene to make objects nameable.",
                        ok=False)
                    return
                yield ToolResult(_render_scene(graph))

            elif action == "highlight":
                box = args.get("box")
                if box is None and (args.get("ref") is not None or args.get("selector")):
                    element = await _target(page, args)
                    box = await element.bounding_box()
                if not box:
                    yield ToolResult(
                        "highlight needs a ref, a selector, or a box.", ok=False)
                    return
                spec = {"x": box.get("x", 0), "y": box.get("y", 0),
                        "w": box.get("width", box.get("w", 0)),
                        "h": box.get("height", box.get("h", 0))}
                await browser.guide(spec, args.get("label") or "", ms=args.get("ms"))
                session.emit(Kind.BROWSER_HIGHLIGHT, {
                    "box": spec, "label": args.get("label") or "",
                }, actor="tool:browser", span=span)
                yield ToolResult(
                    f"Highlighted {args.get('label') or 'the area'} on the page. "
                    f"It is visible to whoever is watching, and in the recording.")

            elif action == "screenshot":
                # The fallback, not the default. An image costs far more than a
                # snapshot and cannot be clicked -- it is for questions about how
                # a page *looks* (a chart, a canvas, a broken layout).
                shot = await page.screenshot(type="jpeg", quality=70)
                session.emit_frame(Kind.BROWSER_FRAME, shot, stream="browser",
                                   explicit=True)
                yield ToolResult(f"Captured {page.url} to the recording.",
                                 display={"url": page.url})

            elif action == "back":
                await page.go_back(wait_until="domcontentloaded")
                yield await after(f"Back to {page.url}")

            elif action == "wait":
                await asyncio.sleep(min(float(args.get("seconds") or 1.0), 30.0))
                yield ToolResult("Waited.")

            else:
                yield ToolResult(f"Unknown action {action!r}.", ok=False)

        except LookupError as exc:
            # A stale ref is the one failure the model can always fix itself.
            yield ToolResult(str(exc), ok=False)

        except Exception as exc:
            # Return the failure to the model as text rather than raising: a
            # timed-out selector is information it can act on, not a crash.
            name = type(exc).__name__
            session.emit(Kind.TOOL_ERROR, {"error": f"{name}: {exc}", "action": action},
                         actor="tool:browser", span=span)
            yield ToolResult(f"Browser {action} failed: {name}: {str(exc)[:400]}", ok=False)

    async def cleanup(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
