import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const contentScript = await readFile(
  new URL("../web-extension/content-script.js", import.meta.url),
  "utf8",
);
const serviceWorker = await readFile(
  new URL("../web-extension/service-worker.js", import.meta.url),
  "utf8",
);

assert.doesNotMatch(
  contentScript,
  /(?:127\.0\.0\.1|localhost|\bfetch\s*\()/,
  "content scripts must not make loopback requests from visited-page contexts",
);
assert.match(contentScript, /chrome\.runtime\.sendMessage/);
assert.match(contentScript, /OPENCLAW_GET_ACTIVE_PATCH/);
assert.match(serviceWorker, /http:\/\/127\.0\.0\.1:18793/);
assert.match(serviceWorker, /OPENCLAW_GET_ACTIVE_PATCH/);
assert.match(serviceWorker, /chrome\.runtime\.onMessage\.addListener/);

let messageListener;
const requestedUrls = [];
const context = vm.createContext({
  URL,
  chrome: {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener) {
          messageListener = listener;
        },
      },
    },
    storage: { local: { set() {} } },
  },
  fetch: async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      json: async () => ({
        page: { enabled: true },
        activePatch: { id: "patch-test" },
      }),
    };
  },
});
vm.runInContext(serviceWorker, context);
assert.equal(typeof messageListener, "function");

const activePatchResponse = await new Promise((resolve) => {
  const keepsChannelOpen = messageListener(
    { type: "OPENCLAW_GET_ACTIVE_PATCH", url: "https://example.com/page#fragment" },
    {},
    resolve,
  );
  assert.equal(keepsChannelOpen, true);
});
assert.equal(activePatchResponse.ok, true);
assert.equal(activePatchResponse.patch?.id, "patch-test");
assert.equal(requestedUrls.length, 1);
assert.match(requestedUrls[0], /^http:\/\/127\.0\.0\.1:18793\/page\?url=/);

let invalidResponse;
const closesInvalidChannel = messageListener(
  { type: "OPENCLAW_GET_ACTIVE_PATCH", url: "file:///private/file" },
  {},
  (value) => {
    invalidResponse = value;
  },
);
assert.equal(closesInvalidChannel, false);
assert.equal(invalidResponse.ok, false);
assert.equal(invalidResponse.patch, null);
assert.equal(requestedUrls.length, 1, "invalid page URLs must not reach the bridge");

console.log("PASS extension loopback traffic is confined to the service worker");
