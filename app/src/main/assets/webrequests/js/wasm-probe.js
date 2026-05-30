// wasm-probe.js — runs in the PAGE world. Injected by content-script.js as an
// EXTERNAL web_accessible_resource (moz-extension:) <script>, deliberately NOT
// inline: strict-CSP sites ship script-src with a nonce / strict-dynamic,
// which voids 'unsafe-inline' and blocks an injected inline <script> (x.com's
// login is exactly this). Extension-origin resource loads bypass the page CSP,
// so this runs everywhere.
//
// Lives in the page world so it can hook the page's own WebAssembly / console /
// error surfaces. Talks back to the isolated-world content script only through
// document CustomEvents (the one channel shared across the Xray boundary):
//   __firedown_probe_alive__       — "I executed" (CSP-block self-check)
//   __firedown_wasm_unavailable__  — "a page tried to use wasm while disabled"
(() => {
  const PATTERN = /WebAssembly|wasm\b/i;
  const NAME = '__firedown_wasm_unavailable__';
  let fired = false;

  // First act: tell the isolated world we executed (CSP-block detection).
  try { document.dispatchEvent(new CustomEvent('__firedown_probe_alive__')); } catch (_) {}

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

  // --- Error-surface hooks (catch sites that throw/log a wasm error) --------
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
  Promise.resolve().then(wrapConsoleError);
  document.addEventListener('DOMContentLoaded', wrapConsoleError, { once: true });

  // --- Proactive WASM trap --------------------------------------------------
  // The hooks above only catch wasm failures that reach the console / error
  // surfaces (kick.com throws uncaught). Sites that SWALLOW the failure never
  // surface one — x.com's login try/catches it and shows "Something went
  // wrong" — so also detect the wasm reference itself.
  try {
    if (window.__firedown_wasm_prearmed) {
      // The content script already installed the read-trap synchronously via
      // wrappedJSObject (earlier than this async script, and CSP-immune).
      // Don't re-install — and crucially don't read window.WebAssembly here,
      // which would trip that getter and self-report. Error hooks above still
      // run, so console/throw-based detection (kick.com) is unaffected.
    } else {
      var WA = window.WebAssembly;
      if (WA && typeof WA === 'object') {
      // Present but possibly disabled (some engines keep the global and throw
      // on use). Gate on an actual disabled-probe so we never fire when wasm
      // works, then fire on a real call.
      var wasmDisabled = false;
      try {
        // canonical empty-module header: succeeds when enabled, throws when disabled.
        new WA.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
      } catch (probeErr) { wasmDisabled = true; }
      if (wasmDisabled && !WA.__firedown_trap) {
        WA.__firedown_trap = true;
        ['instantiate', 'compile', 'instantiateStreaming', 'compileStreaming', 'Module', 'Instance'].forEach(function (name) {
          var orig = WA[name];
          WA[name] = function () {
            fire('WebAssembly.' + name);
            if (typeof orig !== 'function') {
              throw new TypeError('WebAssembly.' + name + ' is disabled');
            }
            return new.target ? Reflect.construct(orig, arguments) : orig.apply(this, arguments);
          };
        });
      }
    } else if (typeof WA === 'undefined') {
      // Gecko removes the WebAssembly global when wasm is disabled. Some sites
      // instantiate wasm inside a Web Worker (x.com's login uses a blob:
      // worker) — a scope this page-world probe can't reach — but the MAIN
      // thread first READS window.WebAssembly to feature-detect before going
      // down the wasm path. So treat any read of the (absent) global while
      // disabled as "this site wants wasm" and fire. Return undefined so
      // graceful-fallback sites keep seeing wasm as absent (we don't pretend
      // it exists) — the read itself is the signal. Firing on a read is
      // appropriate because wasm is enabled by default; disabling it is a
      // deliberate privacy opt-in where offering to re-enable on wasm-using
      // sites is the wanted behaviour.
      Object.defineProperty(window, 'WebAssembly', {
        configurable: true,
        get: function () {
          fire('WebAssembly accessed while disabled');
          return undefined;
        }
      });
    }
  } catch (_) { /* trap setup failed — nothing we can do, leave the page alone */ }
})();
