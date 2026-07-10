#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PageModifierClient, DEFAULT_BRIDGE, runVerifier } from "../lib/client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DEFAULT_CDP = process.env.OPENCLAW_PAGE_MODIFIER_VERIFY_CDP ?? "http://127.0.0.1:9333";

function usage() {
  return [
    "Usage: page-modifier <command> [options]",
    "",
    "Agent-facing commands:",
    "  health                         Check bridge health",
    "  doctor                         Check bridge, package files, extension files, and optional CDP",
    "  page --url <url>               Inspect saved intents, active patch, and verification state",
    "  evidence --url <url>           Print compact latest verification/artifact summary",
    "  export --url <url> [--out f]   Export active patch bundle without auth/session state",
    "  import --file f [--url <url>]  Import a patch bundle and mark it unverified",
    "  jobs [--status queued|working|verified|failed|all] [--url <url>]",
    "                                 List browser-submitted agent jobs",
    "  job --job-id <id>              Inspect one agent job",
    "  claim [--job-id <id>]          Claim the next queued job for this terminal agent",
    "  solve [--job-id <id>] [--verify] Claim, patch, optionally verify, and update job status",
    "  complete --job-id <id> --status verified|failed|blocked",
    "                                 Mark a job complete when an agent has external evidence",
    "  fail --job-id <id> --notes <s> Mark a job failed/blocked with a reason",
    "  session --url <url>            Inspect latest live session grant summary without values",
    "  intent --url <url> --text <t>  Save a durable page intent",
    "  patch --url <url> [--css <s>] [--js <s>] [--notes <s>] [--blocked <p>]",
    "  toggle --url <url> --enabled <true|false>",
    "  verify --url <url> [--backend cdp] [--cdp http://127.0.0.1:9333]",
    "  goal --url <url> [--intent <t>] [--enqueue] [--solve] [--css <s>] [--js <s>] [--verify]",
    "  propose --url <url> --intent <t>  Print an LLM-ready patch prompt",
    "  mcp-config                     Print a stdio MCP config snippet",
    "",
    "Common options:",
    `  --bridge <url>                Bridge URL, default ${DEFAULT_BRIDGE}`,
    "  --json                         Always JSON output; currently the default",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { command, blocked: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      options.url = argv[++i];
    } else if (arg === "--bridge") {
      options.bridge = argv[++i];
    } else if (arg === "--text" || arg === "--intent") {
      options.intent = argv[++i];
    } else if (arg === "--css") {
      options.css = argv[++i];
    } else if (arg === "--js") {
      options.js = argv[++i];
    } else if (arg === "--notes") {
      options.notes = argv[++i];
    } else if (arg === "--blocked") {
      options.blocked.push(argv[++i]);
    } else if (arg === "--enabled") {
      options.enabled = parseBoolean(argv[++i], "--enabled");
    } else if (arg === "--backend") {
      options.backend = argv[++i];
    } else if (arg === "--cdp") {
      options.cdp = argv[++i];
    } else if (arg === "--profile") {
      options.profile = argv[++i];
    } else if (arg === "--job-id") {
      options.jobId = argv[++i];
    } else if (arg === "--agent-id") {
      options.agentId = argv[++i];
    } else if (arg === "--status") {
      options.status = argv[++i];
    } else if (arg === "--active-patch-id") {
      options.activePatchId = argv[++i];
    } else if (arg === "--verification-id") {
      options.verificationId = argv[++i];
    } else if (arg === "--wait-ms") {
      options.waitMs = Number.parseInt(argv[++i], 10);
    } else if (arg === "--artifacts-dir") {
      options.artifactsDir = argv[++i];
    } else if (arg === "--out") {
      options.out = argv[++i];
    } else if (arg === "--file") {
      options.file = argv[++i];
    } else if (arg === "--verify") {
      options.verify = true;
    } else if (arg === "--enqueue") {
      options.enqueue = true;
    } else if (arg === "--solve") {
      options.solve = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseBoolean(value, label) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${label} must be true or false.`);
}

function patchFromOptions(options) {
  if (
    options.css === undefined &&
    options.js === undefined &&
    options.notes === undefined &&
    options.blocked.length === 0
  ) {
    return null;
  }
  return {
    css: options.css ?? "",
    js: options.js ?? "",
    notes: options.notes ?? "",
    blockedPatterns: options.blocked,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function mcpConfig() {
  return {
    mcpServers: {
      pageModifier: {
        command: "node",
        args: [new URL("../mcp/server.mjs", import.meta.url).pathname],
        env: {
          OPENCLAW_PAGE_MODIFIER_BRIDGE: DEFAULT_BRIDGE,
        },
      },
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (options.command === "mcp-config") {
    emit(mcpConfig());
    return;
  }

  const client = new PageModifierClient({ bridge: options.bridge });

  if (options.command === "health") {
    emit(await client.health());
    return;
  }
  if (options.command === "doctor") {
    emit(await doctor({ bridge: options.bridge ?? DEFAULT_BRIDGE, cdp: options.cdp ?? DEFAULT_CDP }));
    return;
  }
  if (options.command === "page") {
    emit(await client.page(options.url));
    return;
  }
  if (options.command === "jobs") {
    emit(await client.listJobs({ status: options.status ?? "queued", url: options.url }));
    return;
  }
  if (options.command === "job") {
    emit(await client.job({ jobId: options.jobId, url: options.url }));
    return;
  }
  if (options.command === "claim") {
    emit(await client.claimJob({ jobId: options.jobId, agentId: options.agentId }));
    return;
  }
  if (options.command === "solve") {
    emit(
      await client.solveJob({
        jobId: options.jobId,
        agentId: options.agentId,
        verify: options.verify === true,
        backend: options.backend ?? "cdp",
        cdp: options.cdp,
        profile: options.profile,
        waitMs: options.waitMs,
        artifactsDir: options.artifactsDir,
      }),
    );
    return;
  }
  if (options.command === "complete") {
    emit(
      await client.completeJob({
        jobId: options.jobId,
        status: options.status,
        activePatchId: options.activePatchId,
        verificationId: options.verificationId,
        error: options.notes,
      }),
    );
    return;
  }
  if (options.command === "fail") {
    emit(await client.failJob({ jobId: options.jobId, error: options.notes }));
    return;
  }
  if (options.command === "evidence") {
    emit(await client.evidence(options.url));
    return;
  }
  if (options.command === "export") {
    emit(await client.exportBundle({ url: options.url, out: options.out }));
    return;
  }
  if (options.command === "import") {
    if (!options.file) {
      throw new Error("--file is required for import.");
    }
    emit(await client.importBundle({ file: options.file, url: options.url }));
    return;
  }
  if (options.command === "session") {
    emit(await client.latestSession(options.url));
    return;
  }
  if (options.command === "intent") {
    emit(await client.addIntent({ url: options.url, intent: options.intent }));
    return;
  }
  if (options.command === "patch") {
    emit(
      await client.setPatch({
        url: options.url,
        css: options.css,
        js: options.js,
        notes: options.notes,
        blockedPatterns: options.blocked,
        jobId: options.jobId,
      }),
    );
    return;
  }
  if (options.command === "toggle") {
    emit(await client.toggle({ url: options.url, enabled: options.enabled }));
    return;
  }
  if (options.command === "verify") {
    emit(
      await runVerifier({
        url: options.url,
        bridge: options.bridge ?? DEFAULT_BRIDGE,
        backend: options.backend ?? "cdp",
        cdp: options.cdp,
        profile: options.profile,
        waitMs: options.waitMs,
        artifactsDir: options.artifactsDir,
      }),
    );
    return;
  }
  if (options.command === "propose") {
    emit(await client.proposePatch({ url: options.url, intent: options.intent }));
    return;
  }
  if (options.command === "goal") {
    emit(
      await client.goal({
        url: options.url,
        intent: options.intent,
        patch: patchFromOptions(options),
        enqueue: options.enqueue === true,
        solve: options.solve === true,
        agentId: options.agentId,
        verify: options.verify === true,
        backend: options.backend ?? "cdp",
        cdp: options.cdp,
        profile: options.profile,
        waitMs: options.waitMs,
        artifactsDir: options.artifactsDir,
      }),
    );
    return;
  }

  throw new Error(`Unknown command: ${options.command}\n\n${usage()}`);
}

async function doctor({ bridge, cdp }) {
  const checks = [];
  checks.push(await checkBridge(bridge));
  checks.push(...(await checkFiles()));
  checks.push(await checkCdp(cdp));
  return {
    ok: checks.filter((check) => check.required !== false).every((check) => check.ok),
    bridge,
    cdp,
    checks,
    next:
      "Run `page-modifier evidence --url <url>` after verification to inspect artifact paths and pass/fail criteria.",
  };
}

async function checkBridge(bridge) {
  try {
    const response = await fetch(`${bridge}/health`);
    const data = await response.json();
    return {
      name: "bridge",
      ok: response.ok && data.ok === true,
      required: true,
      detail: response.ok ? { service: data.service, registryPath: data.registryPath } : data,
    };
  } catch (error) {
    return {
      name: "bridge",
      ok: false,
      required: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCdp(cdp) {
  try {
    const response = await fetch(`${cdp}/json/version`);
    const data = await response.json();
    return {
      name: "cdp",
      ok: response.ok,
      required: false,
      detail: response.ok
        ? { browser: data.Browser ?? null, protocolVersion: data["Protocol-Version"] ?? null }
        : data,
    };
  } catch (error) {
    return {
      name: "cdp",
      ok: false,
      required: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkFiles() {
  const paths = [
    "bridge/server.mjs",
    "bin/page-modifier.mjs",
    "mcp/server.mjs",
    "scripts/verify-page.mjs",
    "web-extension/manifest.json",
    "skills/page-modifier-goal/SKILL.md",
    "skills/page-modifier-repair/SKILL.md",
  ];
  return Promise.all(
    paths.map(async (relativePath) => {
      try {
        const info = await stat(resolve(PROJECT_ROOT, relativePath));
        return {
          name: `file:${relativePath}`,
          ok: info.isFile(),
          required: true,
        };
      } catch {
        return {
          name: `file:${relativePath}`,
          ok: false,
          required: true,
        };
      }
    }),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
