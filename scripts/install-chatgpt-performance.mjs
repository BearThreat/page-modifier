#!/usr/bin/env node

const bridge = process.env.PAGE_MODIFIER_BRIDGE ?? "http://127.0.0.1:18793";
const pageUrl = "https://chatgpt.com/";
const marker = "bear3t-chatgpt-performance-v1";

const css = `
:root {
  scroll-behavior: auto !important;
}

article[data-testid^="conversation-turn-"] {
  content-visibility: auto !important;
  contain-intrinsic-block-size: auto 560px !important;
}

:where([class*="backdrop-blur"]) {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
`.trim();

async function request(path, options = {}) {
  const response = await fetch(`${bridge}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `bridge request failed: ${response.status}`);
  }
  return data;
}

const rollback = process.argv.includes("--rollback");
if (rollback) {
  const data = await request("/toggle", {
    method: "POST",
    body: JSON.stringify({ url: pageUrl, enabled: false }),
  });
  console.log(JSON.stringify({ ok: true, action: "disabled", resolution: data.resolution }));
  process.exit(0);
}

const current = await request(`/page?url=${encodeURIComponent(pageUrl)}`);
const selectedPatch =
  current.page?.patches?.find((patch) => patch.id === current.page.activePatchId) ??
  current.activePatch ??
  null;
if (
  current.page?.siteWide === true &&
  selectedPatch?.notes === marker &&
  selectedPatch?.css === css &&
  !selectedPatch?.js
) {
  if (current.page.enabled === false) {
    await request("/toggle", {
      method: "POST",
      body: JSON.stringify({ url: pageUrl, enabled: true }),
    });
    console.log(JSON.stringify({ ok: true, action: "re-enabled", patchId: selectedPatch.id }));
  } else {
    console.log(JSON.stringify({ ok: true, action: "unchanged", patchId: selectedPatch.id }));
  }
  process.exit(0);
}

if (current.page && selectedPatch && selectedPatch.notes !== marker) {
  throw new Error("Refusing to replace an existing ChatGPT root patch that this installer does not own.");
}

const data = await request("/patch", {
  method: "POST",
  body: JSON.stringify({
    url: pageUrl,
    siteWide: true,
    css,
    js: "",
    blockedPatterns: [],
    notes: marker,
  }),
});
await request("/toggle", {
  method: "POST",
  body: JSON.stringify({ url: pageUrl, enabled: true }),
});
console.log(JSON.stringify({ ok: true, action: "installed", patchId: data.activePatch.id }));
