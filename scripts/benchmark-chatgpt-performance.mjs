#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const productionBridge = "http://127.0.0.1:18793";
const pageUrl = "https://chatgpt.com/";
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const sizes = (args.get("--sizes") || "60,180,360").split(",").map(Number);
const pattern = (args.get("--pattern") || "off,on,on,off,off,on").split(",");
const outPath = args.get("--out") || join(project, "docs/chatgpt-performance/benchmark-raw.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 10000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(stepMs);
  }
  throw lastError || new Error("Timed out");
}

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}

async function post(base, path, body) {
  return jsonRequest(base, path, { method: "POST", body: JSON.stringify(body) });
}

async function cdpClient(endpoint) {
  const tabs = await (await fetch(endpoint + "/json/list")).json();
  const target = tabs.find((tab) => tab.type === "page");
  if (!target) throw new Error("No page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const waiters = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
    }
    const listeners = waiters.get(message.method);
    if (listeners) {
      waiters.delete(message.method);
      for (const resolve of listeners) resolve(message.params);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    close() { ws.close(); },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    event(method) {
      return new Promise((resolve) => {
        const listeners = waiters.get(method) || [];
        listeners.push(resolve);
        waiters.set(method, listeners);
      });
    },
  };
}

function metricsObject(result) {
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
}
function delta(before, after, name, scale = 1000) {
  return ((after[name] || 0) - (before[name] || 0)) * scale;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[i];
}
function summarizeFrames(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    over20ms: values.filter((v) => v > 20).length,
    over33ms: values.filter((v) => v > 33).length,
  };
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const production = await jsonRequest(productionBridge, "/page?url=" + encodeURIComponent(pageUrl));
if (!production.activePatch || production.activePatch.notes !== "bear3t-chatgpt-performance-v1") {
  throw new Error("Production ChatGPT performance patch is not active");
}
const patchCss = production.activePatch.css;
const patchSha256 = crypto.createHash("sha256").update(patchCss).digest("hex");

const temp = await mkdtemp(join(tmpdir(), "chatgpt-perf-benchmark-"));
const dataDir = join(temp, "data");
const extensionDir = join(temp, "extension");
const profileDir = join(temp, "profile");
await mkdir(dataDir, { recursive: true });
await cp(join(project, "web-extension"), extensionDir, { recursive: true });

const bridgePort = await freePort();
const serviceWorkerPath = join(extensionDir, "service-worker.js");
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
await writeFile(
  serviceWorkerPath,
  serviceWorker.replace(
    'const BRIDGE = "http://127.0.0.1:18793";',
    'const BRIDGE = "http://127.0.0.1:' + bridgePort + '";'
  )
);

const bridgeProcess = spawn(process.execPath, [join(project, "bridge/server.mjs")], {
  env: {
    ...process.env,
    PAGE_MODIFIER_PORT: String(bridgePort),
    PAGE_MODIFIER_DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeLog = "";
bridgeProcess.stdout.setEncoding("utf8");
bridgeProcess.stderr.setEncoding("utf8");
bridgeProcess.stdout.on("data", (chunk) => { bridgeLog += chunk; });
bridgeProcess.stderr.on("data", (chunk) => { bridgeLog += chunk; });
const testBridge = "http://127.0.0.1:" + bridgePort;
await waitFor(async () => (await fetch(testBridge + "/health")).ok);

const seeded = await post(testBridge, "/patch", {
  url: pageUrl,
  siteWide: true,
  css: patchCss,
  js: "",
  notes: "benchmark-copy-" + patchSha256.slice(0, 12),
});
await post(testBridge, "/toggle", { url: pageUrl, enabled: true });

const brave = spawn("/opt/brave.com/brave/brave", [
  "--headless=new",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "--user-data-dir=" + profileDir,
  "--disable-extensions-except=" + extensionDir,
  "--load-extension=" + extensionDir,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--window-size=1440,900",
  "--ozone-platform=headless",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let braveLog = "";
brave.stdout.setEncoding("utf8");
brave.stderr.setEncoding("utf8");
brave.stdout.on("data", (chunk) => { braveLog += chunk; });
brave.stderr.on("data", (chunk) => { braveLog += chunk; });

const activePortFile = join(profileDir, "DevToolsActivePort");
const devtoolsPort = await waitFor(async () => {
  try {
    const text = await readFile(activePortFile, "utf8");
    const port = Number(text.split(/\r?\n/)[0]);
    return Number.isFinite(port) ? port : false;
  } catch {
    return false;
  }
}, 15000);
const cdpEndpoint = "http://127.0.0.1:" + devtoolsPort;
await waitFor(async () => (await fetch(cdpEndpoint + "/json/version")).ok, 5000);
const client = await cdpClient(cdpEndpoint);
await client.call("Page.enable");
await client.call("Runtime.enable");
await client.call("Performance.enable");

async function navigate(url) {
  const loaded = Promise.race([
    client.event("Page.loadEventFired"),
    sleep(15000).then(() => { throw new Error("Page load timed out"); }),
  ]);
  await client.call("Page.navigate", { url });
  await loaded;
}

async function patchState(expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(client,
      '(() => { const style=document.querySelector("#openclaw-page-modifier-style"); return {present:Boolean(style),css:style?.textContent||""}; })()'
    );
    if (state.present === expected) return state;
    await sleep(50);
  }
  throw new Error("Timed out waiting for extension patch state=" + expected);
}

function syntheticDocumentExpression(turns, css) {
  const input = JSON.stringify({ turns, patchCss: css });
  return '(() => {' +
    'const input=' + input + ';' +
    'document.open();' +
    'document.write("<!doctype html><html><head><meta charset=\\"utf-8\\"><style id=\\"openclaw-page-modifier-style\\"></style><style id=\\"bench-style\\"></style></head><body><main id=\\"bench\\"></main></body></html>");' +
    'document.close();' +
    'document.querySelector("#openclaw-page-modifier-style").textContent=input.patchCss;' +
    'document.querySelector("#bench-style").textContent=' + JSON.stringify(
      'html,body{margin:0;padding:0;font:16px/1.45 system-ui,sans-serif}' +
      '#bench{width:min(900px,92vw);margin:0 auto}' +
      'article[data-testid^="conversation-turn-"]{padding:24px 8px 30px;border-bottom:1px solid #ddd}' +
      '.speaker{font-weight:700;margin-bottom:8px}p{margin:8px 0}.token{display:inline}' +
      'pre{white-space:pre-wrap;padding:12px;border:1px solid #ddd}' +
      'table{width:100%;border-collapse:collapse}td{border:1px solid #ddd;padding:4px}' +
      'html.bench-flip .token{letter-spacing:.06px}html:not(.bench-flip) .token{letter-spacing:0}'
    ) + ';' +
    'const paragraph=Array.from({length:18},(_,i)=>"<span class=\\"token\\">token-"+i+"-rendering-benchmark </span>").join("");' +
    'const rows=Array.from({length:4},(_,r)=>"<tr>"+Array.from({length:3},(_,c)=>"<td>cell "+r+":"+c+"</td>").join("")+"</tr>").join("");' +
    'const code=Array.from({length:10},(_,i)=>"const value"+i+" = "+i+";").join("\\\\n");' +
    'let html="";const buildStart=performance.now();' +
    'for(let i=0;i<input.turns;i++){html+="<article data-testid=\\"conversation-turn-"+i+"\\"><div class=\\"speaker\\">"+(i%2?"Assistant":"User")+" "+i+"</div>"+Array.from({length:4},()=>"<p>"+paragraph+"</p>").join("")+"<ul>"+Array.from({length:6},(_,j)=>"<li>item "+j+" "+paragraph.slice(0,140)+"</li>").join("")+"</ul><pre><code>"+code+"</code></pre><table><tbody>"+rows+"</tbody></table></article>";}' +
    'document.querySelector("#bench").innerHTML=html;' +
    'const height=document.body.offsetHeight;const buildLayoutMs=performance.now()-buildStart;' +
    'const first=document.querySelector("article");' +
    'return {turns:input.turns,buildLayoutMs,height,nodes:document.getElementsByTagName("*").length,contentVisibility:first?getComputedStyle(first).contentVisibility:null,intrinsicBlockSize:first?getComputedStyle(first).containIntrinsicBlockSize:null};' +
  '})()';
}

const workloadExpression =
  'new Promise(async(resolve)=>{' +
    'const longTasks=[];let observer;' +
    'try{observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push(entry.duration)});observer.observe({type:"longtask",buffered:false})}catch{}' +
    'await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));' +
    'const styleStart=performance.now();let heightAccumulator=0;' +
    'for(let i=0;i<4;i++){document.documentElement.classList.toggle("bench-flip");heightAccumulator+=document.body.offsetHeight}' +
    'const styleLoopMs=performance.now()-styleStart;' +
    'const frameGaps=[];const maxY=Math.max(0,document.documentElement.scrollHeight-innerHeight);const steps=36;' +
    'let previous=performance.now();const scrollStart=previous;' +
    'for(let i=0;i<steps;i++){const cycle=i/(steps-1);const triangle=cycle<=.5?cycle*2:(1-cycle)*2;scrollTo(0,Math.round(maxY*triangle));await new Promise(r=>requestAnimationFrame(r));const now=performance.now();frameGaps.push(now-previous);previous=now}' +
    'const scrollWallMs=performance.now()-scrollStart;observer?.disconnect();' +
    'resolve({styleLoopMs,scrollWallMs,frameGaps,longTasks,heightAccumulator,maxY});' +
  '})';

const runs = [];
try {
  await navigate(pageUrl);
  for (const turns of sizes) {
    for (let index = 0; index < pattern.length; index += 1) {
      const mode = pattern[index];
      const enabled = mode === "on";
      process.stderr.write("starting turns=" + turns + " mode=" + mode + " order=" + index + "\n");
      await post(testBridge, "/toggle", { url: pageUrl, enabled });
      await navigate(pageUrl);
      const extensionState = await patchState(enabled);
      if (enabled && extensionState.css !== patchCss) throw new Error("Extension CSS differs from production patch");

      const beforeSetup = metricsObject(await client.call("Performance.getMetrics"));
      const setup = await evaluate(client, syntheticDocumentExpression(turns, enabled ? patchCss : ""));
      const afterSetup = metricsObject(await client.call("Performance.getMetrics"));
      const workload = await evaluate(client, workloadExpression, true);
      const afterWorkload = metricsObject(await client.call("Performance.getMetrics"));

      const result = {
        turns,
        mode,
        order: index,
        extensionVerified: extensionState.present === enabled,
        setup,
        workload: {
          styleLoopMs: workload.styleLoopMs,
          scrollWallMs: workload.scrollWallMs,
          frames: summarizeFrames(workload.frameGaps),
          longTaskCount: workload.longTasks.length,
          longTaskTotalMs: workload.longTasks.reduce((a, b) => a + b, 0),
          longTaskMaxMs: workload.longTasks.length ? Math.max(...workload.longTasks) : 0,
        },
        cdp: {
          setupLayoutMs: delta(beforeSetup, afterSetup, "LayoutDuration"),
          setupRecalcStyleMs: delta(beforeSetup, afterSetup, "RecalcStyleDuration"),
          setupTaskMs: delta(beforeSetup, afterSetup, "TaskDuration"),
          workloadLayoutMs: delta(afterSetup, afterWorkload, "LayoutDuration"),
          workloadRecalcStyleMs: delta(afterSetup, afterWorkload, "RecalcStyleDuration"),
          workloadTaskMs: delta(afterSetup, afterWorkload, "TaskDuration"),
        },
      };
      runs.push(result);
      process.stderr.write(
        "turns=" + turns + " mode=" + mode +
        " build=" + setup.buildLayoutMs.toFixed(1) + "ms" +
        " style=" + workload.styleLoopMs.toFixed(1) + "ms" +
        " frameP95=" + result.workload.frames.p95Ms.toFixed(1) + "ms" +
        " task=" + result.cdp.workloadTaskMs.toFixed(1) + "ms\n"
      );
    }
  }
} finally {
  client.close();
  brave.kill("SIGTERM");
  bridgeProcess.kill("SIGTERM");
  await sleep(250);
}

const output = {
  generatedAt: new Date().toISOString(),
  host: "blackbear",
  browser: "Brave headless with actual Page Modifier extension",
  origin: pageUrl,
  productionPatch: {
    id: production.activePatch.id,
    verified: production.activePatch.verified,
    sha256: patchSha256,
    notes: production.activePatch.notes,
  },
  design: {
    sizes,
    pattern,
    synthetic: true,
    accountDataUsed: false,
    note: "Actual extension and ChatGPT origin; deterministic synthetic long-conversation DOM after extension state verification.",
  },
  seededPatchId: seeded.activePatch.id,
  runs,
  logs: {
    bridgeTail: bridgeLog.slice(-1000),
    braveTail: braveLog.slice(-1000),
  },
};
await mkdir(join(project, "docs/chatgpt-performance"), { recursive: true });
await writeFile(outPath, JSON.stringify(output, null, 2) + "\n");
await rm(temp, { recursive: true, force: true }).catch(() => {});
console.log(outPath);
