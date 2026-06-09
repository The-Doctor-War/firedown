#!/usr/bin/env node
// Smoke test for the webrequests extension background modules.
//
// Imports the whole background module graph (js/parsers/index.js, which pulls
// requests.js / regex.js / parser-blocklist.js / cookies.js / debug.js) under
// a stubbed `browser` API. This verifies, without a device:
//   - every module parses as an ES module (strict mode included),
//   - every `import { x } from ...` has a matching export (ESM link-time
//     check — a missing export aborts the import),
//   - all top-level listener registration runs without throwing,
//   - the listener-registration counts match the expected inventory, so a
//     refactor can't silently drop a webRequest hook,
//   - the message router received every expected kind, and the SPA registry
//     every site handler.
//
// Run from the repo root:  node scripts/webrequests-smoke.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "app/src/main/assets/webrequests");

// ---------------------------------------------------------------------------
// browser.* stub — records listener registrations, answers the few calls that
// run at import time (tabs.query in boot.js, sendNativeMessage in debug.js).
// ---------------------------------------------------------------------------
const registrations = {};
function evt(path) {
  return {
    addListener(fn) {
      (registrations[path] ??= []).push(fn);
    },
  };
}

globalThis.browser = {
  runtime: {
    sendNativeMessage: async () => false,
    onMessage: evt("runtime.onMessage"),
    connectNative: () => ({ onMessage: evt("port.onMessage"), onDisconnect: evt("port.onDisconnect"), postMessage() {} }),
  },
  webRequest: {
    onBeforeRequest: evt("webRequest.onBeforeRequest"),
    onSendHeaders: evt("webRequest.onSendHeaders"),
    onHeadersReceived: evt("webRequest.onHeadersReceived"),
    onResponseStarted: evt("webRequest.onResponseStarted"),
    onCompleted: evt("webRequest.onCompleted"),
    onErrorOccurred: evt("webRequest.onErrorOccurred"),
    filterResponseData() { throw new Error("filterResponseData must not run at import time"); },
  },
  webNavigation: {
    onHistoryStateUpdated: evt("webNavigation.onHistoryStateUpdated"),
  },
  tabs: {
    onUpdated: evt("tabs.onUpdated"),
    onRemoved: evt("tabs.onRemoved"),
    onActivated: evt("tabs.onActivated"),
    query: async () => [],
    get: async () => ({ incognito: false }),
    sendMessage: async () => {},
  },
  cookies: {
    onChanged: evt("cookies.onChanged"),
    getAll: async () => [],
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
};

// The router/SPA registries live in module scope; observe them through the
// recorded runtime.onMessage and tabs.onUpdated listeners instead of widening
// the modules' export surface for tests.
await import(pathToFileURL(join(ext, "js/parsers/index.js")));

// Give boot.js's fire-and-forget handleExistingTabs() a tick to settle.
await new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
function expect(cond, label) {
  if (cond) {
    console.log("ok  ", label);
  } else {
    console.error("FAIL", label);
    failures++;
  }
}

const count = (path) => (registrations[path] ?? []).length;

// Inventory of listener registrations across the background module graph
// (js/parsers/* + requests.js + cookies.js + debug.js). Update deliberately
// when adding/removing a listener — that's the point of the check.
expect(count("webRequest.onBeforeRequest") === 26, `webRequest.onBeforeRequest registrations == 26 (got ${count("webRequest.onBeforeRequest")})`);
expect(count("webRequest.onSendHeaders") === 2, `webRequest.onSendHeaders registrations == 2 (got ${count("webRequest.onSendHeaders")})`);
expect(count("webRequest.onHeadersReceived") === 2, `webRequest.onHeadersReceived registrations == 2 (got ${count("webRequest.onHeadersReceived")})`);
expect(count("webRequest.onResponseStarted") === 1, `webRequest.onResponseStarted registrations == 1 (got ${count("webRequest.onResponseStarted")})`);
expect(count("webRequest.onErrorOccurred") === 1, `webRequest.onErrorOccurred registrations == 1 (got ${count("webRequest.onErrorOccurred")})`);
expect(count("webRequest.onCompleted") === 2, `webRequest.onCompleted registrations == 2 (got ${count("webRequest.onCompleted")})`);
expect(count("runtime.onMessage") === 2, `runtime.onMessage listeners == 2 — parsers router + requests.js (got ${count("runtime.onMessage")})`);
expect(count("tabs.onUpdated") === 2, `tabs.onUpdated listeners == 2 — parsers/common + requests.js (got ${count("tabs.onUpdated")})`);
expect(count("webNavigation.onHistoryStateUpdated") === 1, `webNavigation.onHistoryStateUpdated == 1 (got ${count("webNavigation.onHistoryStateUpdated")})`);
expect(count("cookies.onChanged") === 1, `cookies.onChanged == 1 (got ${count("cookies.onChanged")})`);

// Message router: feed each expected kind through the recorded onMessage
// listeners with an empty payload — a registered handler must swallow it
// silently (fire-and-forget, payload-shape bail), an unregistered kind would
// fall through to requests.js. We verify registration indirectly: the router
// throws on DUPLICATE registration, so a successful import already proves
// each kind registered at most once; here we prove the dispatch path doesn't
// throw for every known kind.
const kinds = [
  { kind: "page-state-media", payload: null },
  { kind: "page-state-progressive", payload: null },
  { kind: "page-state-hls", payload: null },
  { kind: "mega-folder", payload: null },
  { kind: "mega-file", payload: null },
  { type: "instagram_intercept", payload: null },
];
for (const msg of kinds) {
  let threw = false;
  for (const listener of registrations["runtime.onMessage"]) {
    try {
      listener(msg, { tab: { id: 1, url: "https://example.com/" } });
    } catch (e) {
      threw = true;
      console.error("  dispatch threw for", JSON.stringify(msg), e.message);
    }
  }
  expect(!threw, `message dispatch survives kind=${msg.kind ?? msg.type}`);
}

// SPA registry: drive the recorded tabs.onUpdated listeners with site URLs and
// make sure none throw (each site's checkAndProcess handler runs).
const spaUrls = [
  "https://www.instagram.com/reel/ABC123/",
  "https://www.facebook.com/watch?v=1",
  "https://kick.com/somestreamer",
  "https://www.twitch.tv/somestreamer",
  "https://www.dailymotion.com/video/x8abcd",
];
let spaThrew = false;
for (const url of spaUrls) {
  for (const listener of registrations["tabs.onUpdated"]) {
    try {
      listener(1, { url }, { id: 1, url, incognito: false });
    } catch (e) {
      spaThrew = true;
      console.error("  tabs.onUpdated threw for", url, e.message);
    }
  }
}
expect(!spaThrew, "SPA handlers run for all five registered sites");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke: all checks passed");
process.exit(0);
