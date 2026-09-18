import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url).pathname;

async function startBridge(port) {
  const dataDir = await mkdtemp(join(tmpdir(), "page-modifier-test-"));
  const child = spawn(process.execPath, [join(root, "bridge/server.mjs")], {
    env: { ...process.env, PAGE_MODIFIER_PORT: String(port), PAGE_MODIFIER_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  while (!output.includes("bridge listening")) await once(child.stdout, "data");
  return {
    child, dataDir, base: `http://127.0.0.1:${port}`,
    async close() {
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function get(base, url) {
  const response = await fetch(`${base}/page?url=${encodeURIComponent(url)}`);
  assert.equal(response.status, 200);
  return response.json();
}

test("site-wide patch applies to ChatGPT conversation paths only", async () => {
  const server = await startBridge(18873);
  try {
    await post(server.base, "/patch", { url: "https://chatgpt.com/", siteWide: true, css: "root", notes: "owned" });
    const conversation = await get(server.base, "https://chatgpt.com/c/abc");
    assert.equal(conversation.resolution, "site-wide");
    assert.equal(conversation.matchedPageKey, "https://chatgpt.com/");
    assert.equal(conversation.activePatch.notes, "owned");
    const unrelated = await get(server.base, "https://example.com/c/abc");
    assert.equal(unrelated.resolution, "none");
    assert.equal(unrelated.activePatch, null);
  } finally { await server.close(); }
});

test("exact disabled page overrides site-wide and can be re-enabled", async () => {
  const server = await startBridge(18874);
  try {
    await post(server.base, "/patch", { url: "https://chatgpt.com/", siteWide: true, css: "root", notes: "owned" });
    await post(server.base, "/toggle", { url: "https://chatgpt.com/c/abc", enabled: false });
    assert.equal((await get(server.base, "https://chatgpt.com/c/abc")).resolution, "exact-disabled");
    const enabled = await post(server.base, "/toggle", { url: "https://chatgpt.com/c/abc", enabled: true });
    assert.equal(enabled.resolution, "site-wide");
    assert.equal(enabled.activePatch.notes, "owned");
  } finally { await server.close(); }
});

test("exact patch wins over site-wide fallback", async () => {
  const server = await startBridge(18875);
  try {
    await post(server.base, "/patch", { url: "https://chatgpt.com/", siteWide: true, css: "root", notes: "root" });
    await post(server.base, "/patch", { url: "https://chatgpt.com/c/abc", css: "exact", notes: "exact" });
    const data = await get(server.base, "https://chatgpt.com/c/abc");
    assert.equal(data.resolution, "exact");
    assert.equal(data.activePatch.notes, "exact");
  } finally { await server.close(); }
});
