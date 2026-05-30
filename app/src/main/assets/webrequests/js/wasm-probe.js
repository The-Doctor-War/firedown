// wasm-probe.js — runs in the PAGE world. Injected by content-script.js as an
// EXTERNAL web_accessible_resource (moz-extension:) <script>, deliberately NOT
// inline: strict-CSP sites ship script-src with a nonce / strict-dynamic,
// which voids 'unsafe-inline' and blocks an injected inline <script> (x.com's
// login is exactly this — the inline probe never ran, so wasm detection never
// armed). Extension-origin resource loads bypass the page CSP, so this runs
// everywhere.
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
  try { console.log('[fd-probe] running on ' + location.href + ' | typeof WebAssembly=' + (typeof window.WebAssembly)); } catch (_) {}

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

  // --- DEBUG: Worker creation -----------------------------------------------
  // If x.com runs its challenge / transaction-id WASM inside a Web Worker, the
  // worker has its own WebAssembly global that this page-world probe cannot
  // reach — so log worker creation + script URL to spot that case.
  try {
    var OrigWorker = window.Worker;
    if (typeof OrigWorker === 'function' && !OrigWorker.__firedown_wrapped) {
      var WrappedWorker = function (url) {
        try { console.log('[fd-probe] Worker created: ' + String(url)); } catch (_) {}
        return Reflect.construct(OrigWorker, arguments, new.target || WrappedWorker);
      };
      WrappedWorker.__firedown_wrapped = true;
      WrappedWorker.prototype = OrigWorker.prototype;
      window.Worker = WrappedWorker;
    }
  } catch (_) {}

  // --- Proactive WASM-use trap ----------------------------------------------
  // The hooks above only catch wasm failures that reach the console / error
  // surfaces (kick.com throws uncaught). Sites that SWALLOW the failure never
  // surface one — x.com's login try/catches it and shows "Something went
  // wrong" — so also detect the wasm *use attempt* itself. Fires once (fire()
  // is latched) only on a real wasm call while wasm is disabled; never on mere
  // feature detection, never when wasm actually works.
  try {
    var WA = window.WebAssembly;
    var USE = ['instantiate', 'compile', 'instantiateStreaming', 'compileStreaming', 'Module', 'Instance'];
    if (WA && typeof WA === 'object') {
      var wasmDisabled = false;
      try {
        // canonical empty-module header: succeeds when enabled, throws (or
        // Module is absent) when disabled.
        new WA.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
      } catch (probeErr) { wasmDisabled = true; }
      try { console.log('[fd-probe] WASM present (object); disabledProbe=' + wasmDisabled); } catch (_) {}
      if (wasmDisabled && !WA.__firedown_trap) {
        WA.__firedown_trap = true;
        USE.forEach(function (name) {
          var orig = WA[name];
          WA[name] = function () {
            try { console.log('[fd-probe] WASM use attempt: ' + name); } catch (_) {}
            fire('WebAssembly.' + name);
            if (typeof orig !== 'function') {
              throw new TypeError('WebAssembly.' + name + ' is disabled');
            }
            return new.target ? Reflect.construct(orig, arguments) : orig.apply(this, arguments);
          };
        });
        try { console.log('[fd-probe] use-trap installed: ' + USE.join(',')); } catch (_) {}
      }
    } else if (typeof WA === 'undefined') {
      // Global removed entirely (Gecko removes it when wasm is disabled):
      // reaching for any wasm member is a use attempt. Return undefined for
      // members so callers fail exactly as with wasm disabled (graceful
      // fallbacks that test a method's truthiness still fall back).
      try { console.log('[fd-probe] WASM ABSENT (typeof undefined) -> installing proxy trap'); } catch (_) {}
      var trap = new Proxy(function () {}, {
        get: function (_t, prop) {
          if (prop === Symbol.toStringTag || prop === Symbol.toPrimitive) return undefined;
          try { console.log('[fd-probe] WASM member access: ' + String(prop)); } catch (_) {}
          fire('WebAssembly.' + String(prop));
          return undefined;
        },
        apply: function () { fire('WebAssembly()'); return undefined; },
        construct: function () { fire('new WebAssembly'); throw new TypeError('WebAssembly is disabled'); }
      });
      // DEBUG: log the first time the page reads window.WebAssembly at all.
      // If we see this but no "member access", the page only does a bare
      // typeof/existence check and bails (and may have cached it BEFORE our
      // async script installed the trap — a timing problem). If we never see
      // it, the page isn't touching the main-thread global (Worker?).
      var waReads = 0;
      Object.defineProperty(window, 'WebAssembly', {
        configurable: true,
        get: function () {
          if (waReads++ === 0) {
            try { console.log('[fd-probe] window.WebAssembly READ by page'); } catch (_) {}
          }
          return trap;
        }
      });
    } else {
      try { console.log('[fd-probe] WASM typeof=' + (typeof WA) + ' (unexpected)'); } catch (_) {}
    }
  } catch (trapSetupErr) {
    try { console.log('[fd-probe] trap setup error: ' + (trapSetupErr && trapSetupErr.message)); } catch (_) {}
  }
})();
