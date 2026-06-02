// Shared debug flag for the downloader extension's background modules.
//
// Pulled from BuildConfig.DEBUG via the native bridge on startup (the same
// "browser" native app name requests.js uses). Release builds resolve to
// false, so every guarded log short-circuits and the extension stays silent —
// see CLAUDE.md "Logging discipline". This is a live ES-module binding, so
// importers see the resolved value once the async reply lands (every call
// site that logs runs well after startup).
export let DEBUG = false;

browser.runtime.sendNativeMessage("browser", { kind: "get-debug-flag" })
    .then(r => { DEBUG = (r === true); }, () => {});
