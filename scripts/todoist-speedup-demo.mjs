#!/usr/bin/env node
const BRAVE_CDP = process.env.OPENCLAW_PAGE_MODIFIER_BRAVE_CDP ?? "http://127.0.0.1:9222";
const VERIFY_CDP = process.env.OPENCLAW_PAGE_MODIFIER_VERIFY_CDP ?? "http://127.0.0.1:9333";
const BRIDGE = process.env.OPENCLAW_PAGE_MODIFIER_BRIDGE ?? "http://127.0.0.1:18793";
const TODOIST_URL = process.env.OPENCLAW_PAGE_MODIFIER_TODOIST_URL ?? "https://app.todoist.com/app/inbox?locale=en";

const TODOIST_SPEEDUP_PATCH = {
  css: [
    "html[data-openclaw-page-modifier='todoist-speedup'] *,",
    "html[data-openclaw-page-modifier='todoist-speedup'] *::before,",
    "html[data-openclaw-page-modifier='todoist-speedup'] *::after {",
    "  animation-duration: 0.001ms !important;",
    "  animation-delay: 0ms !important;",
    "  transition-duration: 0.001ms !important;",
    "  transition-delay: 0ms !important;",
    "  scroll-behavior: auto !important;",
    "}",
    "html[data-openclaw-page-modifier='todoist-speedup'] [style*='backdrop-filter'],",
    "html[data-openclaw-page-modifier='todoist-speedup'] [class*='shadow'] {",
    "  backdrop-filter: none !important;",
    "  box-shadow: none !important;",
    "}",
  ].join("\n"),
  js: [
    "(() => {",
    "  document.documentElement.setAttribute('data-openclaw-page-modifier', 'todoist-speedup');",
    "  document.documentElement.style.scrollBehavior = 'auto';",
    "  window.__openclawTodoistSpeedup = { appliedAt: new Date().toISOString(), mode: 'safe-reduced-motion' };",
    "})();",
  ].join("\n"),
  blockedPatterns: [],
  notes:
    "Todoist starter speedup: safe reduced-motion profile that disables animations/transitions, reduces smooth-scroll jank, and removes expensive visual effects where detectable without culling task rows.",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${text}`);
  }
  return data;
}

async function postBridge(path, body) {
  return httpJson(`${BRIDGE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function findTodoistTarget() {
  const targets = await httpJson(`${BRAVE_CDP}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.url.includes("app.todoist.com"));
  if (!page) {
    throw new Error("No Todoist tab found in Brave CDP on port 9222.");
  }
  return page;
}

async function createVerifierTarget(url = "about:blank") {
  let response = await fetch(`${VERIFY_CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${VERIFY_CDP}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not create verifier target: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.ws.send(payload);
    });
  }

  async eval(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...options,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate exception");
    }
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

async function connectTarget(target) {
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Page.enable");
  return page;
}

async function getAuthState(page, url) {
  const cookiesResult = await page.send("Network.getCookies", { urls: [url] });
  const storageSnapshot = await page.eval(`(() => {
    const copy = (storage) => Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index);
      return [key, storage.getItem(key)];
    }).filter(([key]) => key));
    return { localStorage: copy(localStorage), sessionStorage: copy(sessionStorage) };
  })()`);
  return {
    cookies: cookiesResult.cookies ?? [],
    storageSnapshot,
    storageSummary: {
      localStorageKeys: Object.keys(storageSnapshot.localStorage ?? {}),
      sessionStorageKeys: Object.keys(storageSnapshot.sessionStorage ?? {}),
    },
    cookieSummary: {
      visibleCookieNames: (cookiesResult.cookies ?? []).map((cookie) => cookie.name),
    },
  };
}

async function setAuthState(page, authState, url) {
  const cookies = (authState.cookies ?? []).map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
    expires: cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
  }));
  if (cookies.length > 0) {
    await page.send("Network.setCookies", { cookies });
  }
  await page.send("Page.navigate", { url });
  await sleep(8000);
  const storage = authState.storageSnapshot ?? {};
  await page.eval(`(() => {
    const localValues = ${JSON.stringify(storage.localStorage ?? {})};
    const sessionValues = ${JSON.stringify(storage.sessionStorage ?? {})};
    for (const [key, value] of Object.entries(localValues)) localStorage.setItem(key, String(value));
    for (const [key, value] of Object.entries(sessionValues)) sessionStorage.setItem(key, String(value));
    return true;
  })()`);
  await page.send("Page.reload", { ignoreCache: false });
  await sleep(8000);
}

async function capturePageState(page, label) {
  const metrics = await page.eval(`(async () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint').map((paint) => ({
      name: paint.name,
      startTime: Math.round(paint.startTime),
    }));
    const sampleFrames = await new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      let count = 0;
      function tick() {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        count += 1;
        if (count >= 120) resolve(gaps);
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const sorted = [...sampleFrames].sort((a, b) => a - b);
    const sum = sampleFrames.reduce((acc, value) => acc + value, 0);
    return {
      url: location.href,
      title: document.title,
      bodyTextLength: document.body?.innerText?.length ?? 0,
      taskLikeNodes: document.querySelectorAll("[role='listitem'], li, [data-testid*='task'], [class*='task']").length,
      nav: nav ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadEventMs: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize,
      } : null,
      paints,
      frameGapAvgMs: Math.round((sum / sampleFrames.length) * 10) / 10,
      frameGapP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
      frameGapMaxMs: Math.round(Math.max(...sampleFrames) * 10) / 10,
      frameGapsOver50ms: sampleFrames.filter((value) => value > 50).length,
    };
  })()`);
  return { label, ...metrics };
}

async function applyPatch(page, patch) {
  await page.eval(`(() => {
    const existing = document.querySelector('#openclaw-page-modifier-style');
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = 'openclaw-page-modifier-style';
    style.textContent = ${JSON.stringify(patch.css)};
    document.documentElement.append(style);
    try { ${patch.js} } catch (error) { console.error(error); }
    return true;
  })()`);
  await sleep(1000);
}

async function main() {
  await httpJson(`${BRIDGE}/health`);
  const todoistTarget = await findTodoistTarget();
  const source = await connectTarget(todoistTarget);
  const authState = await getAuthState(source, TODOIST_URL);

  await postBridge("/capture", {
    url: TODOIST_URL,
    title: todoistTarget.title,
    selectedText: "",
    domSummary: "Captured from existing Brave Todoist tab via CDP for page-modifier demo.",
    metrics: { source: "brave-cdp" },
  });
  await postBridge("/session/grant", {
    url: TODOIST_URL,
    ...authState,
  });
  await postBridge("/intent", {
    url: TODOIST_URL,
    intent: "Make Todoist feel less laggy: reduce animation, scrolling, paint, and task-list jank while preserving normal functionality.",
  });
  await postBridge("/patch", {
    url: TODOIST_URL,
    ...TODOIST_SPEEDUP_PATCH,
  });

  const verifierTarget = await createVerifierTarget("about:blank");
  const verifier = await connectTarget(verifierTarget);
  await setAuthState(verifier, authState, TODOIST_URL);
  const before = await capturePageState(verifier, "before_patch");
  await applyPatch(verifier, TODOIST_SPEEDUP_PATCH);
  const after = await capturePageState(verifier, "after_patch");
  const bridgeVerification = await postBridge("/verify", { url: TODOIST_URL });
  const delta = {
    frameGapAvgMs: Math.round((after.frameGapAvgMs - before.frameGapAvgMs) * 10) / 10,
    frameGapP95Ms: Math.round((after.frameGapP95Ms - before.frameGapP95Ms) * 10) / 10,
    frameGapMaxMs: Math.round((after.frameGapMaxMs - before.frameGapMaxMs) * 10) / 10,
    frameGapsOver50ms: after.frameGapsOver50ms - before.frameGapsOver50ms,
  };
  const pass =
    after.bodyTextLength === before.bodyTextLength &&
    after.taskLikeNodes === before.taskLikeNodes &&
    delta.frameGapP95Ms <= 0 &&
    delta.frameGapMaxMs <= 0 &&
    delta.frameGapsOver50ms <= 0;
  const verificationResult = await postBridge("/verify/result", {
    url: TODOIST_URL,
    verificationId: bridgeVerification.verification.id,
    status: pass ? "verified" : "failed",
    evidence: {
      before,
      after,
      delta,
      criteria: {
        visibleTextUnchanged: after.bodyTextLength === before.bodyTextLength,
        taskCountUnchanged: after.taskLikeNodes === before.taskLikeNodes,
        p95NotWorse: delta.frameGapP95Ms <= 0,
        maxNotWorse: delta.frameGapMaxMs <= 0,
        noNewOver50msFrames: delta.frameGapsOver50ms <= 0,
      },
    },
  });

  source.close();
  verifier.close();

  const result = {
    ok: true,
    todoistTarget: {
      id: todoistTarget.id,
      title: todoistTarget.title,
      url: todoistTarget.url,
    },
    authState: {
      cookieCount: authState.cookies.length,
      localStorageKeys: authState.storageSummary.localStorageKeys.length,
      sessionStorageKeys: authState.storageSummary.sessionStorageKeys.length,
    },
    patch: {
      notes: TODOIST_SPEEDUP_PATCH.notes,
      cssBytes: TODOIST_SPEEDUP_PATCH.css.length,
      jsBytes: TODOIST_SPEEDUP_PATCH.js.length,
    },
    metrics: {
      before,
      after,
      delta,
    },
    bridgeVerification: verificationResult.verification,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
