const BRIDGE = "http://127.0.0.1:18793";

const els = {
  status: document.querySelector("#status"),
  intent: document.querySelector("#intent"),
  cssPatch: document.querySelector("#cssPatch"),
  jsPatch: document.querySelector("#jsPatch"),
  summary: document.querySelector("#summary"),
  capture: document.querySelector("#capture"),
  addIntent: document.querySelector("#addIntent"),
  apply: document.querySelector("#apply"),
  original: document.querySelector("#original"),
  reapply: document.querySelector("#reapply"),
  verify: document.querySelector("#verify"),
  session: document.querySelector("#session"),
  reloadExtension: document.querySelector("#reloadExtension"),
  savePatch: document.querySelector("#savePatch"),
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab");
  }
  return tab;
}

async function bridge(path, options = {}) {
  const response = await fetch(`${BRIDGE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `Bridge request failed: ${response.status}`);
  }
  return data;
}

async function post(path, body) {
  return bridge(path, { method: "POST", body: JSON.stringify(body) });
}

async function sendToContent(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function currentOriginCookies(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    session: cookie.session,
    expirationDate: cookie.expirationDate,
    storeId: cookie.storeId,
  }));
}

function render(data) {
  const page = data.page ?? data;
  const activePatch = data.activePatch ?? null;
  els.cssPatch.value = activePatch?.css ?? els.cssPatch.value;
  els.jsPatch.value = activePatch?.js ?? els.jsPatch.value;
  els.summary.textContent = JSON.stringify(
    {
      key: page?.key,
      enabled: page?.enabled,
      intents: page?.intents?.map((intent) => intent.text) ?? [],
      activePatchId: page?.activePatchId,
      notes: activePatch?.notes,
      verification: page?.verification?.status,
    },
    null,
    2,
  );
}

async function capturePage(tab) {
  const result = await sendToContent(tab.id, { type: "OPENCLAW_CAPTURE" });
  return post("/capture", {
    url: tab.url,
    title: tab.title,
    ...result,
  });
}

async function refresh() {
  try {
    await bridge("/health");
    els.status.textContent = "Bridge online";
    const tab = await activeTab();
    const data = await bridge(`/page?url=${encodeURIComponent(tab.url)}`);
    render(data);
  } catch (error) {
    els.status.textContent = "Bridge offline";
    els.summary.textContent = error.message;
  }
}

els.capture.addEventListener("click", async () => {
  try {
    render(await capturePage(await activeTab()));
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.addIntent.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    await capturePage(tab);
    const data = await post("/intent", { url: tab.url, intent: els.intent.value });
    await sendToContent(tab.id, { type: "OPENCLAW_APPLY_PATCH", patch: data.activePatch });
    render(data);
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.apply.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const data = await bridge(`/page?url=${encodeURIComponent(tab.url)}`);
    await sendToContent(tab.id, { type: "OPENCLAW_APPLY_PATCH", patch: data.activePatch });
    render(data);
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.original.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    await sendToContent(tab.id, { type: "OPENCLAW_RESTORE_ORIGINAL" });
    render(await post("/toggle", { url: tab.url, enabled: false }));
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.reapply.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const toggle = await post("/toggle", { url: tab.url, enabled: true });
    await sendToContent(tab.id, { type: "OPENCLAW_APPLY_PATCH", patch: toggle.activePatch });
    render(toggle);
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.verify.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    render(await post("/verify", { url: tab.url }));
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.session.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const session = await sendToContent(tab.id, { type: "OPENCLAW_SESSION_GRANT" });
    const cookies = await currentOriginCookies(tab.url);
    render(await post("/session/grant", { url: tab.url, cookies, ...session }));
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

els.reloadExtension.addEventListener("click", () => {
  chrome.runtime.reload();
});

els.savePatch.addEventListener("click", async () => {
  try {
    const tab = await activeTab();
    const data = await post("/patch", {
      url: tab.url,
      css: els.cssPatch.value,
      js: els.jsPatch.value,
      notes: "Manual popup patch",
    });
    await sendToContent(tab.id, { type: "OPENCLAW_APPLY_PATCH", patch: data.activePatch });
    render(data);
  } catch (error) {
    els.summary.textContent = error.message;
  }
});

refresh();
