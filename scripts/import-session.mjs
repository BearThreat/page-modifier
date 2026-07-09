#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const DEFAULT_BRIDGE = process.env.OPENCLAW_PAGE_MODIFIER_BRIDGE ?? "http://127.0.0.1:18793";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_BIN =
  process.env.OPENCLAW_BIN ?? resolve(__dirname, "..", "..", "..", "openclaw.mjs");
const CHILD_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCLAW_PAGE_MODIFIER_CHILD_TIMEOUT_MS ?? "20000",
  10,
);

function parseArgs(argv) {
  const args = { profile: "openclaw", bridge: DEFAULT_BRIDGE };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--url") {
      args.url = argv[++i];
    } else if (value === "--profile") {
      args.profile = argv[++i];
    } else if (value === "--bridge") {
      args.bridge = argv[++i];
    } else if (value === "--json") {
      args.json = true;
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
    "Usage: node extensions/page-modifier/scripts/import-session.mjs --url <url> [--profile openclaw]",
    "",
    "Imports the latest live Page Modifier same-origin session grant into an OpenClaw browser profile.",
  ].join("\n");
}

function runOpenClaw(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [OPENCLAW_BIN, ...args], {
      cwd: resolve(__dirname, "..", "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`openclaw ${args.join(" ")} timed out after ${CHILD_TIMEOUT_MS}ms`));
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
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`openclaw ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

async function importSession(params) {
  const latestUrl = `${params.bridge}/session/latest?url=${encodeURIComponent(params.url)}`;
  const latest = await fetchJson(latestUrl);
  const grant = latest.sessionGrant;
  if (!grant) {
    throw new Error("No live session grant found. Click Grant session in the extension first.");
  }

  const result = {
    url: params.url,
    profile: params.profile,
    sessionGrantId: grant.id,
    cookiesAttempted: 0,
    cookiesImported: 0,
    localStorageImported: 0,
    sessionStorageImported: 0,
    notes: [],
  };

  await runOpenClaw(["browser", "--browser-profile", params.profile, "open", params.url]);

  for (const cookie of grant.cookies ?? []) {
    if (!cookie.name) {
      continue;
    }
    result.cookiesAttempted += 1;
    await runOpenClaw([
      "browser",
      "--browser-profile",
      params.profile,
      "cookies",
      "set",
      cookie.name,
      cookie.value ?? "",
      "--url",
      params.url,
    ]);
    result.cookiesImported += 1;
  }

  for (const [key, value] of Object.entries(grant.storageSnapshot?.localStorage ?? {})) {
    await runOpenClaw([
      "browser",
      "--browser-profile",
      params.profile,
      "storage",
      "local",
      "set",
      key,
      String(value),
    ]);
    result.localStorageImported += 1;
  }

  for (const [key, value] of Object.entries(grant.storageSnapshot?.sessionStorage ?? {})) {
    await runOpenClaw([
      "browser",
      "--browser-profile",
      params.profile,
      "storage",
      "session",
      "set",
      key,
      String(value),
    ]);
    result.sessionStorageImported += 1;
  }

  result.notes.push(
    "Cookie name/value/url are imported through the current OpenClaw browser CLI; advanced cookie attributes are captured in the grant but not all are round-tripped by the CLI setter yet.",
  );
  return result;
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
  const result = await importSession(args);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
