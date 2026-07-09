#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const DEFAULT_BRIDGE = process.env.OPENCLAW_PAGE_MODIFIER_BRIDGE ?? "http://127.0.0.1:18793";
const DEFAULT_CDP = process.env.OPENCLAW_PAGE_MODIFIER_VERIFY_CDP ?? "http://127.0.0.1:9333";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN ?? resolve(__dirname, "..", "..", "..", "openclaw.mjs");
const IMPORT_SCRIPT = resolve(__dirname, "import-session.mjs");
const CHILD_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCLAW_PAGE_MODIFIER_CHILD_TIMEOUT_MS ?? "20000",
  10,
);
const DEFAULT_ARTIFACTS_DIR =
  process.env.OPENCLAW_PAGE_MODIFIER_ARTIFACTS_DIR ??
  join(homedir(), ".openclaw", "page-modifier", "artifacts");

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function parseArgs(argv) {
  const args = {
    backend: "cdp",
    bridge: DEFAULT_BRIDGE,
    cdp: DEFAULT_CDP,
    profile: "openclaw",
    waitMs: 8000,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--url") {
      args.url = argv[++i];
    } else if (value === "--backend") {
      args.backend = argv[++i];
    } else if (value === "--cdp") {
      args.cdp = argv[++i];
    } else if (value === "--profile") {
      args.profile = argv[++i];
    } else if (value === "--bridge") {
      args.bridge = argv[++i];
    } else if (value === "--wait-ms") {
      args.waitMs = Number.parseInt(argv[++i], 10);
    } else if (value === "--artifacts-dir") {
      args.artifactsDir = argv[++i];
    } else if (value === "-h" || value === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node extensions/page-modifier/scripts/verify-page.mjs --url <url> [--backend cdp] [--cdp http://127.0.0.1:9333]",
    "",
    "Queues bridge verification, imports a live same-origin session grant when present,",
    "opens the page in an isolated verifier browser, applies the active patch,",
    "captures before/after evidence, and records PASS/FAIL back to the bridge.",
    "",
    "Backends:",
    "  cdp       Default. Uses a Chrome/Brave remote debugging endpoint.",
    "  openclaw  Legacy fallback. Uses `openclaw browser ...` commands.",
    "",
    "Evidence artifacts:",
    `  --artifacts-dir <dir>  Default: ${DEFAULT_ARTIFACTS_DIR}`,
    "",
    "Start a disposable verifier browser for CDP, for example:",
    "  chromium --remote-debugging-port=9333 --user-data-dir=/tmp/openclaw-page-modifier-verify --no-first-run",
  ].join("\n");
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: resolve(__dirname, "..", "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || options.allowFailure) {
        resolvePromise({ code, stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

function runOpenClaw(args, options) {
  return run(process.execPath, [OPENCLAW_BIN, ...args], options);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

function parseJsonOutput(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createCdpTarget(cdpBaseUrl, url = "about:blank") {
  let response = await fetch(`${cdpBaseUrl}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) {
    response = await fetch(`${cdpBaseUrl}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not create CDP verifier target: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

class CdpPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleMessages = [];
    this.requestFailures = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.handleEvent(message);
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
    await new Promise((resolvePromise, reject) => {
      this.ws.addEventListener("open", resolvePromise, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  handleEvent(message) {
    if (message.method === "Runtime.consoleAPICalled") {
      this.consoleMessages.push({
        type: message.params.type,
        text: (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "),
      });
    }
    if (message.method === "Network.loadingFailed") {
      this.requestFailures.push({
        url: message.params.requestId,
        errorText: message.params.errorText,
        canceled: Boolean(message.params.canceled),
      });
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
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
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return page;
}

function cookieForCdp(cookie) {
  return {
    name: cookie.name,
    value: cookie.value ?? "",
    domain: cookie.domain || undefined,
    path: cookie.path ?? "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
    expires:
      typeof cookie.expirationDate === "number" && cookie.expirationDate > 0
        ? cookie.expirationDate
        : undefined,
  };
}

async function importSessionViaCdp(page, grant, url, waitMs) {
  const result = {
    sessionGrantId: grant.id,
    cookiesAttempted: 0,
    cookiesImported: 0,
    localStorageImported: 0,
    sessionStorageImported: 0,
  };
  const cookies = (grant.cookies ?? []).filter((cookie) => cookie.name).map(cookieForCdp);
  result.cookiesAttempted = cookies.length;
  if (cookies.length > 0) {
    await page.send("Network.setCookies", { cookies });
    result.cookiesImported = cookies.length;
  }
  await page.send("Page.navigate", { url });
  await sleep(waitMs);
  const storage = grant.storageSnapshot ?? {};
  await page.eval(`(() => {
    const localValues = ${JSON.stringify(storage.localStorage ?? {})};
    const sessionValues = ${JSON.stringify(storage.sessionStorage ?? {})};
    for (const [key, value] of Object.entries(localValues)) localStorage.setItem(key, String(value));
    for (const [key, value] of Object.entries(sessionValues)) sessionStorage.setItem(key, String(value));
    return true;
  })()`);
  result.localStorageImported = Object.keys(storage.localStorage ?? {}).length;
  result.sessionStorageImported = Object.keys(storage.sessionStorage ?? {}).length;
  await page.send("Page.reload", { ignoreCache: false });
  await sleep(waitMs);
  return result;
}

async function capturePageState(page, label) {
  const metrics = await page.eval(`(async () => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint').map((paint) => ({
      name: paint.name,
      startTime: Math.round(paint.startTime),
    }));
    const frameCount = 120;
    const sampleFrames = await new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      let count = 0;
      function tick() {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        count += 1;
        if (count >= frameCount) resolve(gaps);
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
  return {
    label,
    ...metrics,
    consoleErrorCount: page.consoleMessages.filter((item) => item.type === "error").length,
    requestFailureCount: page.requestFailures.filter((item) => !item.canceled).length,
  };
}

async function captureScreenshotArtifact(page, artifactDir, label) {
  const capture = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const png = Buffer.from(capture.data, "base64");
  const sha256 = createHash("sha256").update(png).digest("hex");
  await mkdir(artifactDir, { recursive: true });
  const path = join(artifactDir, `${label}.png`);
  await writeFile(path, png);
  return {
    label,
    path,
    bytes: png.length,
    sha256,
    base64: capture.data,
  };
}

async function compareScreenshots(page, beforeBase64, afterBase64) {
  return page.eval(`(async () => {
    const beforeBase64 = ${JSON.stringify(beforeBase64)};
    const afterBase64 = ${JSON.stringify(afterBase64)};
    async function bitmapFromBase64(base64) {
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: 'image/png' });
      return createImageBitmap(blob);
    }
    const before = await bitmapFromBase64(beforeBase64);
    const after = await bitmapFromBase64(afterBase64);
    const width = Math.min(before.width, after.width);
    const height = Math.min(before.height, after.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(before, 0, 0);
    const beforeData = ctx.getImageData(0, 0, width, height).data;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(after, 0, 0);
    const afterData = ctx.getImageData(0, 0, width, height).data;
    let sampledPixels = 0;
    let changedPixels = 0;
    let absoluteChannelDelta = 0;
    const stride = 4;
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const index = (y * width + x) * 4;
        const dr = Math.abs(beforeData[index] - afterData[index]);
        const dg = Math.abs(beforeData[index + 1] - afterData[index + 1]);
        const db = Math.abs(beforeData[index + 2] - afterData[index + 2]);
        const da = Math.abs(beforeData[index + 3] - afterData[index + 3]);
        const delta = dr + dg + db + da;
        absoluteChannelDelta += delta;
        sampledPixels += 1;
        if (delta > 24) changedPixels += 1;
      }
    }
    return {
      width,
      height,
      sampledPixels,
      changedPixels,
      changedPixelRatio: Math.round((changedPixels / sampledPixels) * 100000) / 100000,
      meanChannelDelta: Math.round((absoluteChannelDelta / Math.max(1, sampledPixels * 4)) * 100) / 100,
      note: 'Sampled every 4 CSS pixels; changed threshold is RGBA channel sum > 24.',
    };
  })()`);
}

function publicScreenshotArtifact(artifact) {
  return {
    label: artifact.label,
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
  };
}

async function applyPatch(page, patch) {
  await page.eval(`(() => {
    const existing = document.querySelector('#openclaw-page-modifier-style');
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = 'openclaw-page-modifier-style';
    style.textContent = ${JSON.stringify(patch?.css ?? "")};
    document.documentElement.append(style);
    try { ${patch?.js ?? ""} } catch (error) { console.error(error); }
    return true;
  })()`);
  await sleep(1000);
}

function compareStates(before, after) {
  const delta = {
    frameGapAvgMs: Math.round((after.frameGapAvgMs - before.frameGapAvgMs) * 10) / 10,
    frameGapP95Ms: Math.round((after.frameGapP95Ms - before.frameGapP95Ms) * 10) / 10,
    frameGapMaxMs: Math.round((after.frameGapMaxMs - before.frameGapMaxMs) * 10) / 10,
    frameGapsOver50ms: after.frameGapsOver50ms - before.frameGapsOver50ms,
    consoleErrors: after.consoleErrorCount - before.consoleErrorCount,
    requestFailures: after.requestFailureCount - before.requestFailureCount,
  };
  const criteria = {
    visibleTextUnchanged: after.bodyTextLength === before.bodyTextLength,
    taskCountUnchanged: after.taskLikeNodes === before.taskLikeNodes,
    p95NotMeaningfullyWorse: delta.frameGapP95Ms <= 5,
    maxNotMeaningfullyWorse: delta.frameGapMaxMs <= 20,
    noNewOver50msFrames: delta.frameGapsOver50ms <= 0,
    noNewConsoleErrors: delta.consoleErrors <= 0,
    noNewRequestFailures: delta.requestFailures <= 0,
  };
  return {
    delta,
    criteria,
    pass: Object.values(criteria).every(Boolean),
  };
}

async function verifyWithCdp(params, verification, pageData, latest) {
  const target = await createCdpTarget(params.cdp, "about:blank");
  const page = await connectTarget(target);
  const artifactDir = join(params.artifactsDir, verification.id);
  try {
    const result = {
      backend: "cdp",
      cdp: params.cdp,
      targetId: target.id,
      sessionImport: null,
      before: null,
      after: null,
      delta: null,
      criteria: null,
      screenshots: null,
      visualDiff: null,
      pass: false,
    };
    if (latest.sessionGrant) {
      result.sessionImport = await importSessionViaCdp(page, latest.sessionGrant, params.url, params.waitMs);
    } else {
      await page.send("Page.navigate", { url: params.url });
      await sleep(params.waitMs);
    }

    result.before = await capturePageState(page, "before_patch");
    const beforeScreenshot = await captureScreenshotArtifact(page, artifactDir, "before_patch");
    await applyPatch(page, pageData.activePatch);
    result.after = await capturePageState(page, "after_patch");
    const afterScreenshot = await captureScreenshotArtifact(page, artifactDir, "after_patch");
    result.visualDiff = await compareScreenshots(
      page,
      beforeScreenshot.base64,
      afterScreenshot.base64,
    );
    result.screenshots = {
      artifactDir,
      before: publicScreenshotArtifact(beforeScreenshot),
      after: publicScreenshotArtifact(afterScreenshot),
    };
    const comparison = compareStates(result.before, result.after);
    result.delta = comparison.delta;
    result.criteria = comparison.criteria;
    result.pass = comparison.pass;

    const verificationResult = await postJson(`${params.bridge}/verify/result`, {
      url: params.url,
      verificationId: verification.id,
      status: result.pass ? "verified" : "failed",
      evidence: {
        backend: "cdp",
        before: result.before,
        after: result.after,
        screenshots: result.screenshots,
        visualDiff: result.visualDiff,
        delta: result.delta,
        criteria: result.criteria,
        activePatchId: pageData.activePatch?.id ?? null,
      },
    });
    result.bridgeVerification = verificationResult.verification;
    return result;
  } finally {
    page.close();
  }
}

async function verifyWithOpenClaw(params, verification, latest) {
  const result = {
    backend: "openclaw",
    profile: params.profile,
    sessionImport: null,
    browser: {},
    pass: false,
    failures: [],
  };

  if (latest.sessionGrant) {
    const imported = await run(process.execPath, [
      IMPORT_SCRIPT,
      "--url",
      params.url,
      "--profile",
      params.profile,
      "--bridge",
      params.bridge,
    ]);
    result.sessionImport = parseJsonOutput(imported.stdout) ?? {
      stdout: imported.stdout,
      stderr: imported.stderr,
    };
  }

  const opened = await runOpenClaw([
    "browser",
    "--browser-profile",
    params.profile,
    "open",
    params.url,
    "--json",
  ]);
  result.browser.open = parseJsonOutput(opened.stdout) ?? opened.stdout.trim();

  const snapshot = await runOpenClaw(
    ["browser", "--browser-profile", params.profile, "snapshot", "--interactive", "--json"],
    { allowFailure: true },
  );
  result.browser.snapshot = parseJsonOutput(snapshot.stdout) ?? snapshot.stdout.trim();
  if (snapshot.code !== 0) {
    result.failures.push(`snapshot failed: ${snapshot.stderr || snapshot.stdout}`);
  }

  const errors = await runOpenClaw(
    ["browser", "--browser-profile", params.profile, "errors", "--json"],
    { allowFailure: true },
  );
  result.browser.errors = parseJsonOutput(errors.stdout) ?? errors.stdout.trim();
  if (errors.code !== 0) {
    result.failures.push(`errors check failed: ${errors.stderr || errors.stdout}`);
  }

  result.pass = result.failures.length === 0;
  await postJson(`${params.bridge}/verify/result`, {
    url: params.url,
    verificationId: verification.id,
    status: result.pass ? "verified" : "failed",
    evidence: result,
  });
  return result;
}

async function verify(params) {
  const startedAt = new Date().toISOString();
  const verificationResponse = await postJson(`${params.bridge}/verify`, { url: params.url });
  const pageData = await getJson(`${params.bridge}/page?url=${encodeURIComponent(params.url)}`);
  const latest = await getJson(`${params.bridge}/session/latest?url=${encodeURIComponent(params.url)}`);
  if (!pageData.activePatch) {
    throw new Error("No active patch found. Add an intent or patch before verifying.");
  }
  const result = {
    url: params.url,
    startedAt,
    bridgeVerification: verificationResponse.verification,
    verifier: null,
    endedAt: null,
  };

  if (params.backend === "cdp") {
    result.verifier = await verifyWithCdp(
      params,
      verificationResponse.verification,
      pageData,
      latest,
    );
  } else if (params.backend === "openclaw") {
    result.verifier = await verifyWithOpenClaw(params, verificationResponse.verification, latest);
  } else {
    throw new Error(`Unsupported backend: ${params.backend}`);
  }

  result.endedAt = new Date().toISOString();
  console.log(JSON.stringify(result, null, 2));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.url) {
    throw new Error("--url is required");
  }
  await verify(args);
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
