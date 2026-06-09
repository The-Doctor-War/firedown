// wasm-watch.js — WebAssembly unavailability detector (settings/privacy
// support, NOT capture). Split out of content-script.js so the capture code
// and the settings-feature code live in separate files; runs as its own
// content script with the same matches/run_at (see manifest.json).
//
// WASM is disabled by default in Firedown for privacy (javascript.options.wasm
// = false). Some sites (kick.com, codepen, figma) hard-require it and break.
// This watcher detects "this page wants WASM while it's turned off" and
// reports it to Java (wasm-unavailable), which surfaces the
// "Enable for {host}?" snackbar. Its page-world half is js/wasm-probe.js
// (a web_accessible_resource), injected below only when WASM is disabled.

// Debug flag, resolved from BuildConfig.DEBUG via the native bridge — every
// log goes through clog() so release builds stay silent (CLAUDE.md "Logging
// discipline"). A handful of boot-time logs land before the async reply, which
// is fine: those simply don't print. Top-level names here share the isolated
// content-script world with content-script.js — keep them distinct (DEBUG/clog
// live there; this file uses WASM_DEBUG/wlog).
let WASM_DEBUG = false;
browser.runtime.sendNativeMessage('browser', { kind: 'get-debug-flag' })
    .then(r => { WASM_DEBUG = (r === true); }, () => {});
const wlog = (...args) => { if (WASM_DEBUG) console.log(...args); };

// ---------------------------------------------------------------------------
// WebAssembly unavailability detector
//
// WebExtension content scripts run in an *isolated* JS world: wrapping
// `console.error` or `window.WebAssembly` here does NOT intercept the page's
// own console / globals — those live in the page world. Only window-level DOM
// events are shared. The first version of this detector ran the wrappers in
// the isolated world and missed every error from kick.com's player, even
// though the load log proved the script was injected.
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
    wlog('[wasm] wasm-unavailable reporting', location.href, detail);
    try {
      const r = browser.runtime.sendNativeMessage('browser', payload);
      if (r && r.catch) r.catch(() => fallback(payload));
    } catch (_) { fallback(payload); }
  }, true);

  function fallback(payload) {
    try { browser.runtime.sendMessage(payload); } catch (_) {}
  }

  // The probe signals this the moment it runs; if we never hear it, the page
  // refused even the external moz-extension script (CSP) and wasm detection is
  // off on this page — surfaced by the timeout warning below.
  let probeRan = false;
  document.addEventListener('__firedown_probe_alive__', () => {
    probeRan = true;
  }, { capture: true, once: true });

  // Whether WASM is currently disabled for this page. The probe's only job is
  // to detect "this site wants WASM while it's turned off" so we can offer to
  // re-enable it; when WASM is ENABLED the probe has nothing to do. Worse,
  // injecting its moz-extension <script> into a cross-origin-isolated document
  // — e.g. x.com's login, which runs WASM in a COEP (require-corp) worker —
  // can make Gecko deny that worker's cross-origin chunk loads with
  // "Content at https://x.com/ may not load data from https://abs.twimg.com/…",
  // breaking login. So capture the state up front (before the pre-arm getter
  // below shadows the global) and only run the probe when WASM is disabled.
  let wasmDisabled = false;
  try {
    const pw = window.wrappedJSObject;
    wasmDisabled = pw ? (typeof pw.WebAssembly === 'undefined')
                      : (typeof WebAssembly === 'undefined');
  } catch (_) {
    wasmDisabled = (typeof WebAssembly === 'undefined');
  }

  // --- Synchronous pre-arm of the WebAssembly read-trap -------------------
  // The external probe below loads async, so a very early page script could
  // read WebAssembly before it arms. Content scripts run synchronously at
  // document_start, before any page script, so additionally install the
  // read-trap right now via Firefox's Xray wrappedJSObject — no <script>, so
  // it's also immune to the page CSP. Strictly additive and fully guarded:
  // only acts when wasm is disabled (the global is removed), and silently
  // falls back to the external probe if any Xray API is missing or throws.
  // Sets a flag so the external probe doesn't re-install (and doesn't trip
  // this getter by reading the global).
  try {
    if (typeof exportFunction === 'function') {
      const pageWin = window.wrappedJSObject;
      if (pageWin && typeof pageWin.WebAssembly === 'undefined' && !pageWin.__firedown_wasm_prearmed) {
        let prearmFired = false;
        const getter = exportFunction(function () {
          if (!prearmFired) {
            prearmFired = true;
            try {
              document.dispatchEvent(new CustomEvent('__firedown_wasm_unavailable__', {
                detail: { detail: 'WebAssembly read (pre-arm)' }
              }));
            } catch (_) {}
          }
          return undefined;
        }, pageWin);
        Object.defineProperty(pageWin, 'WebAssembly', { configurable: true, get: getter });
        pageWin.__firedown_wasm_prearmed = true;
      }
    }
  } catch (_) { /* Xray unavailable / refused — the external probe handles it */ }

  // --- Page-world probe injection -----------------------------------------
  // The probe must run in the PAGE world to hook the page's WebAssembly /
  // console / error surfaces. We load it as an EXTERNAL moz-extension:
  // web_accessible_resource <script>, NOT inline: strict-CSP sites (x.com
  // ships script-src with a nonce / strict-dynamic, which voids
  // 'unsafe-inline') refuse an injected inline <script>, so the old
  // textContent probe never executed there. Extension-origin resource loads
  // bypass the page CSP, so the external probe runs everywhere.
  // Only inject when WASM is disabled (see wasmDisabled note above). When it's
  // enabled the probe is a no-op anyway, and skipping the injection keeps us
  // from perturbing cross-origin-isolated pages like x.com's login worker.
  if (wasmDisabled) {
    try {
      const s = document.createElement('script');
      s.src = browser.runtime.getURL('js/wasm-probe.js');
      s.async = false; // execute ASAP, before the page's own scripts use wasm
      s.onload = () => s.remove();
      (document.documentElement || document.head || document.body).appendChild(s);
    } catch (e) {
      wlog('[wasm] probe injection failed:', e && e.message);
    }

    // CSP-block detector: if the probe never signals within 1.5s, even the
    // external moz-extension script was refused — we'd need a deeper hook.
    setTimeout(() => {
      if (!probeRan) {
        wlog('[wasm] WASM-DEBUG: page-world probe DID NOT RUN within 1.5s on '
          + location.href + ' — even the external web_accessible_resource script '
          + 'was blocked. Page CSP is rejecting moz-extension: scripts too.');
      }
    }, 1500);
  } else {
    wlog('[wasm] wasm enabled — skipping probe injection on', location.href);
  }
})();
