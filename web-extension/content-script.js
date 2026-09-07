const STYLE_ID = "openclaw-page-modifier-style";
const SCRIPT_MARK = "data-openclaw-page-modifier-script";

function currentUrl() {
  const url = new URL(window.location.href);
  url.hash = "";
  return url.toString();
}

function domSummary() {
  const interactive = [...document.querySelectorAll("a,button,input,select,textarea,[role=button]")]
    .slice(0, 80)
    .map((node) => {
      const text = (node.innerText || node.value || node.getAttribute("aria-label") || "").trim();
      const id = node.id ? `#${node.id}` : "";
      const cls = node.className && typeof node.className === "string"
        ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`
        : "";
      return `${node.tagName.toLowerCase()}${id}${cls} ${text}`.trim();
    });
  return [
    `title: ${document.title}`,
    `url: ${currentUrl()}`,
    `bodyText: ${(document.body?.innerText ?? "").slice(0, 4000)}`,
    `interactive:\n${interactive.join("\n")}`,
  ].join("\n\n");
}

function metrics() {
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = performance.getEntriesByType("paint");
  const longTasks = performance.getEntriesByType("longtask");
  return {
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
    transferSize: nav ? nav.transferSize : null,
    paints: paints.map((paint) => ({ name: paint.name, startTime: Math.round(paint.startTime) })),
    longTaskCount: longTasks.length,
    longTaskMs: Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
  };
}

function restoreOriginal() {
  document.querySelector(`#${STYLE_ID}`)?.remove();
  document.querySelectorAll(`[${SCRIPT_MARK}]`).forEach((node) => node.remove());
  document.documentElement.removeAttribute("data-openclaw-page-modifier");
}

function applyPatch(patch) {
  if (!patch) {
    return { ok: false, reason: "No active patch" };
  }
  restoreOriginal();
  if (patch.css) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = patch.css;
    document.documentElement.append(style);
  }
  if (patch.js) {
    const script = document.createElement("script");
    script.setAttribute(SCRIPT_MARK, "true");
    script.textContent = `try {\n${patch.js}\n} catch (error) { console.error("[OpenClaw Page Modifier]", error); }`;
    document.documentElement.append(script);
  }
  document.documentElement.setAttribute("data-openclaw-page-modifier", patch.id ?? "active");
  return { ok: true, patchId: patch.id ?? null };
}

async function fetchActivePatch() {
  // Keep loopback traffic in the extension service-worker context. Fetching the
  // bridge directly here attributes the request to every visited page, which
  // makes Chromium ask each site for access to apps and services on the device.
  const response = await chrome.runtime.sendMessage({
    type: "OPENCLAW_GET_ACTIVE_PATCH",
    url: currentUrl(),
  });
  if (!response?.ok) {
    return null;
  }
  return response.patch ?? null;
}

function storageSnapshotFor(storage) {
  const result = {};
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) {
      continue;
    }
    const value = storage.getItem(key);
    result[key] = typeof value === "string" ? value.slice(0, 20000) : value;
  }
  return result;
}

function storageSnapshot() {
  const localStorageValues = storageSnapshotFor(localStorage);
  const sessionStorageValues = storageSnapshotFor(sessionStorage);
  return {
    localStorage: localStorageValues,
    sessionStorage: sessionStorageValues,
    localStorageKeys: Object.keys(localStorageValues),
    sessionStorageKeys: Object.keys(sessionStorageValues),
  };
}

function storageSummary() {
  const localKeys = [];
  const sessionKeys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    localKeys.push(localStorage.key(i));
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    sessionKeys.push(sessionStorage.key(i));
  }
  return {
    localStorageKeys: localKeys.slice(0, 200),
    sessionStorageKeys: sessionKeys.slice(0, 200),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OPENCLAW_CAPTURE") {
    sendResponse({
      selectedText: window.getSelection()?.toString() ?? "",
      domSummary: domSummary(),
      metrics: metrics(),
    });
    return true;
  }
  if (message?.type === "OPENCLAW_APPLY_PATCH") {
    sendResponse(applyPatch(message.patch));
    return true;
  }
  if (message?.type === "OPENCLAW_RESTORE_ORIGINAL") {
    restoreOriginal();
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "OPENCLAW_SESSION_GRANT") {
    sendResponse({
      storageSummary: storageSummary(),
      storageSnapshot: storageSnapshot(),
      cookieSummary: {
        visibleCookieNames: document.cookie
          .split(";")
          .map((part) => part.split("=")[0]?.trim())
          .filter(Boolean)
          .slice(0, 100),
      },
    });
    return true;
  }
  return false;
});

fetchActivePatch()
  .then((patch) => {
    if (patch) {
      applyPatch(patch);
    }
  })
  .catch(() => {});
