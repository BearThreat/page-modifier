const BRIDGE = "http://127.0.0.1:18793";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    openclawPageModifierInstalledAt: new Date().toISOString(),
  });
});

function isWebPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function activePatchForUrl(url) {
  const response = await fetch(`${BRIDGE}/page?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    return { ok: false, patch: null };
  }
  const data = await response.json();
  return {
    ok: true,
    patch: data.page?.enabled ? (data.activePatch ?? null) : null,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPENCLAW_GET_ACTIVE_PATCH") {
    return false;
  }
  if (!isWebPageUrl(message.url)) {
    sendResponse({ ok: false, patch: null });
    return false;
  }
  activePatchForUrl(message.url)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, patch: null }));
  return true;
});
