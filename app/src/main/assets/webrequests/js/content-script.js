// content-script.js — runs in every page
// Scans the DOM for image URLs (including those served from service-worker
// cache, which webRequest cannot see) and forwards them to the background.
// Also exposes a "get-page-metadata" message endpoint that the background
// uses to enrich intercepted media downloads with a descriptive filename
// (page title + meta description). Lives in the page context so it sees
// JS-rendered titles that a server-side fetch wouldn't.

console.log('[cs] loaded', location.href);

// ---------------------------------------------------------------------------
// WebAssembly unavailability detector
// WASM is disabled by default in Firedown for privacy (javascript.options.wasm
// = false). Some sites (kick.com, codepen, figma) hard-require it and break.
//
// WebExtension content scripts run in an *isolated* JS world: wrapping
// `console.error` or `window.WebAssembly` here does NOT intercept the page's
// own console / globals — those live in the page world. Only window-level DOM
// events are shared. The first version of this detector ran the wrappers in
// the isolated world and missed every error from kick.com's player, even
// though `[cs] loaded` proved the script was injected.
//
// Fix: inject a <script> tag whose textContent runs in the page world. That
// script wraps the page's console.error, hooks window.error /
// unhandledrejection, and dispatches a CustomEvent on document when it spots
// a WASM-related message. The isolated-world listener below picks up the
// event and forwards it through the native messaging port to Java.
// ---------------------------------------------------------------------------
(() => {
  const SIGNAL_EVENT = '__firedown_wasm_unavailable__';

  // --- Isolated-world receiver: page → content script → native ----------
  let reported = false;
  document.addEventListener(SIGNAL_EVENT, (e) => {
    if (reported) return;
    reported = true;
    // CustomEvent.detail crosses the Xray boundary as a wrapped object; pull
    // the string fields defensively. location.href works because the content
    // script's window IS the page's window (just an isolated wrapper).
    const detail = (e && e.detail && (e.detail.detail || e.detail.wrappedJSObject?.detail)) || '';
    const payload = {
      kind: 'wasm-unavailable',
      listener: 'wasmUnavailable',
      url: location.href,
      detail: String(detail).slice(0, 200),
    };
    console.log('[cs] wasm-unavailable reporting', location.href, detail);
    try {
      const r = browser.runtime.sendNativeMessage('browser', payload);
      if (r && r.catch) r.catch(() => fallback(payload));
    } catch (_) { fallback(payload); }
  }, true);

  function fallback(payload) {
    try { browser.runtime.sendMessage(payload); } catch (_) {}
  }

  // --- Page-world probe: injected as a <script> so it runs with the same
  //     globals the site uses. Hooks every surface a WASM error might
  //     show up on. Dispatches the signal event on document so our
  //     isolated-world listener above can pick it up.
  const PROBE = `(() => {
    const PATTERN = /WebAssembly|wasm\\b/i;
    const NAME = ${JSON.stringify(SIGNAL_EVENT)};
    let fired = false;
    function fire(detail) {
      if (fired) return;
      fired = true;
      try {
        document.dispatchEvent(new CustomEvent(NAME, {
          detail: { detail: String(detail || '').slice(0, 200) }
        }));
      } catch (_) {}
    }
    function textOf(thing) {
      if (!thing) return '';
      if (typeof thing === 'string') return thing;
      try {
        if (thing.message) return String(thing.message);
        if (thing.toString) return thing.toString();
        return String(thing);
      } catch (_) { return ''; }
    }
    window.addEventListener('error', function (e) {
      const m = textOf(e && (e.message || e.error));
      if (PATTERN.test(m)) fire(m);
    }, true);
    // Older surface — sites that assign window.onerror skip addEventListener.
    const origOnError = window.onerror;
    window.onerror = function (msg, src, line, col, err) {
      try {
        const text = textOf(err) || textOf(msg);
        if (PATTERN.test(text)) fire(text);
      } catch (_) {}
      if (typeof origOnError === 'function') {
        return origOnError.apply(this, arguments);
      }
      return false;
    };
    window.addEventListener('unhandledrejection', function (e) {
      const m = textOf(e && e.reason);
      if (m && PATTERN.test(m)) fire(m);
    });
    // console.error wrap. Re-wrap if the page replaces console.error later
    // (some analytics SDKs do this on init) so we keep intercepting.
    function wrapConsoleError() {
      const orig = console.error;
      if (orig && orig.__firedown_wrapped) return;
      const wrapped = function () {
        try {
          const j = Array.prototype.map.call(arguments, textOf).join(' ');
          if (PATTERN.test(j)) fire(j);
        } catch (_) {}
        return orig.apply(console, arguments);
      };
      wrapped.__firedown_wrapped = true;
      try { console.error = wrapped; } catch (_) {}
    }
    wrapConsoleError();
    // Re-wrap if console.error gets reassigned later. Cheap: only runs once
    // after a microtask + once on DOMContentLoaded; that catches the common
    // "analytics replaces console" pattern.
    Promise.resolve().then(wrapConsoleError);
    document.addEventListener('DOMContentLoaded', wrapConsoleError, { once: true });
  })();`;

  try {
    const s = document.createElement('script');
    s.textContent = PROBE;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.remove();
  } catch (e) {
    console.log('[cs] wasm probe injection failed:', e && e.message);
  }
})();

// Top-frame metadata responder. We only answer in the top frame so the
// background's tabs.sendMessage (which broadcasts to all frames in a tab
// by default) doesn't return an iframe's title instead of the page's.
if (window === window.top) {
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.kind !== 'get-page-metadata') return;
    const meta = (selector, attr) => {
      const el = document.querySelector(selector);
      return el && el.getAttribute(attr) ? el.getAttribute(attr) : '';
    };
    return Promise.resolve({
      url: location.href,
      title: document.title || '',
      description: meta('meta[name="description"]', 'content'),
      ogTitle: meta('meta[property="og:title"]', 'content'),
      ogDescription: meta('meta[property="og:description"]', 'content'),
      twitterTitle: meta('meta[name="twitter:title"]', 'content'),
      twitterDescription: meta('meta[name="twitter:description"]', 'content'),
    });
  });
}

(() => {
  const seen = new Set();
  const BATCH_MS = 200;
  let pending = [];
  let flushTimer = null;

  function flush() {
    flushTimer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    console.log('[cs] sending batch of', batch.length);
    try {
      const p = browser.runtime.sendMessage({ kind: 'images-detected', urls: batch });
      if (p && p.catch) p.catch((e) => console.log('[cs] send rejected:', e?.message));
    } catch (e) {
      console.log('[cs] send threw:', e?.message);
    }
  }

  function queue(url) {
    if (!url || seen.has(url)) return;
    if (!/^https?:/i.test(url)) return;
    seen.add(url);
    pending.push(url);
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS);
  }

  function reportImg(img) {
    if (!img) return;
    queue(img.currentSrc || img.src);
  }

  function reportSource(source) {
    if (!source) return;
    const srcset = source.srcset || source.getAttribute('srcset');
    if (srcset) {
      srcset.split(',').forEach((part) => {
        const url = part.trim().split(/\s+/)[0];
        if (url) queue(url);
      });
    }
    if (source.src) queue(source.src);
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'IMG') reportImg(root);
    else if (root.tagName === 'SOURCE') reportSource(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('img').forEach(reportImg);
      root.querySelectorAll('source').forEach(reportSource);
    }
  }

  // Initial scan
  scan(document.documentElement);

  // Re-scan at key lifecycle events
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document.documentElement));
  }
  window.addEventListener('load', () => scan(document.documentElement));

  // Watch for DOM changes
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(scan);
      } else if (m.type === 'attributes') {
        const t = m.target;
        if (t.tagName === 'IMG') reportImg(t);
        else if (t.tagName === 'SOURCE') reportSource(t);
      }
    }
  });

  function startObserver() {
    const target = document.body || document.documentElement;
    if (!target) {
      setTimeout(startObserver, 50);
      return;
    }
    mo.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });
  }
  startObserver();

  // Catch images that finish loading after insertion (lazy load)
  document.addEventListener('load', (e) => {
    if (e.target && e.target.tagName === 'IMG') reportImg(e.target);
  }, true);

  console.log('[cs] setup complete');
})();