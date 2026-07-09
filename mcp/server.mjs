#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PageModifierClient, DEFAULT_BRIDGE, runVerifier } from "../lib/client.mjs";

function textResult(summary, payload) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: message },
  };
}

function clientFor(bridge) {
  return new PageModifierClient({ bridge: bridge ?? DEFAULT_BRIDGE });
}

const patchSchema = z
  .object({
    css: z.string().optional().describe("CSS to inject into the page."),
    js: z.string().optional().describe("JavaScript to run after page load."),
    notes: z.string().optional().describe("Agent-readable notes explaining the patch."),
    blocked_patterns: z
      .array(z.string())
      .optional()
      .describe("Network URL patterns the extension should block when implemented."),
  })
  .optional();

const verifierSchema = {
  bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
  backend: z.enum(["cdp", "openclaw"]).optional().describe("Verifier backend. Default: cdp."),
  cdp: z
    .string()
    .url()
    .optional()
    .describe("CDP endpoint for the isolated verifier browser, e.g. http://127.0.0.1:9333."),
  profile: z.string().optional().describe("OpenClaw browser profile for backend=openclaw."),
  wait_ms: z.number().int().min(250).max(60000).optional(),
  artifacts_dir: z.string().optional().describe("Directory where verifier screenshots and evidence artifacts are written."),
};

const server = new McpServer({ name: "openclaw-page-modifier", version: "0.1.0" });

server.tool(
  "page_modifier_status",
  "Inspect Page Modifier bridge health and, when url is provided, sanitized page state. Use before changing a page to see saved intents, active patch id, verification status, and session-grant summaries without cookie/storage values.",
  {
    bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
    url: z.string().url().optional().describe("Absolute page URL to inspect."),
  },
  async ({ bridge, url }) => {
    try {
      const client = clientFor(bridge);
      const health = await client.health();
      if (!url) {
        return textResult("page modifier bridge healthy", { health });
      }
      const page = await client.page(url);
      const latestSession = await client.latestSession(url);
      return textResult(
        `page modifier status: ${page.page ? "tracked" : "untracked"} ${url}`,
        { health, page, latestSession },
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_evidence",
  "Return a compact latest verification summary for a tracked page, including active patch metadata, pass/fail criteria, timing deltas, visual-diff stats, and screenshot artifact paths without full patch bodies.",
  {
    bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
    url: z.string().url().describe("Absolute page URL to inspect."),
  },
  async ({ bridge, url }) => {
    try {
      const client = clientFor(bridge);
      const result = await client.evidence(url);
      const status = result.verification?.status ?? "unverified";
      return textResult(`page modifier evidence: ${status} ${url}`, { result });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_apply_intent",
  "Save a durable natural-language intent for one page and optionally attach an explicit CSS/JS patch. Use when the user says what they want changed on a page. Returns sanitized page state and active patch metadata.",
  {
    bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
    url: z.string().url().describe("Absolute page URL the intent applies to."),
    intent: z.string().min(1).describe("Durable user intent, e.g. make this app feel less laggy."),
    patch: patchSchema,
  },
  async ({ bridge, url, intent, patch }) => {
    try {
      const client = clientFor(bridge);
      const intentResult = await client.addIntent({ url, intent });
      if (!patch) {
        return textResult(`saved intent for ${url}`, { result: intentResult });
      }
      const patchResult = await client.setPatch({
        url,
        css: patch.css,
        js: patch.js,
        notes: patch.notes,
        blockedPatterns: patch.blocked_patterns ?? [],
      });
      return textResult(`saved intent and patch for ${url}`, {
        intentResult,
        patchResult,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_set_patch",
  "Set or replace the active CSS/JS patch for one page. Use after an agent synthesizes or repairs a patch from captured page state or verifier failures. Returns sanitized page state.",
  {
    bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
    url: z.string().url().describe("Absolute page URL the patch applies to."),
    css: z.string().optional().describe("CSS to inject into the page."),
    js: z.string().optional().describe("JavaScript to run after page load."),
    notes: z.string().optional().describe("Agent-readable notes explaining the patch."),
    blocked_patterns: z.array(z.string()).optional(),
  },
  async ({ bridge, url, css, js, notes, blocked_patterns }) => {
    try {
      const client = clientFor(bridge);
      const result = await client.setPatch({
        url,
        css,
        js,
        notes,
        blockedPatterns: blocked_patterns ?? [],
      });
      return textResult(`saved active patch for ${url}`, { result });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_propose_patch",
  "Build an LLM-ready prompt for generating a safe Page Modifier CSS/JS patch from sanitized page state. Use when an agent needs to ask a model to synthesize or repair a patch before calling page_modifier_set_patch.",
  {
    bridge: z.string().url().optional().describe(`Bridge URL. Default: ${DEFAULT_BRIDGE}`),
    url: z.string().url().describe("Absolute page URL the patch applies to."),
    intent: z.string().min(1).describe("User intent the patch should satisfy."),
  },
  async ({ bridge, url, intent }) => {
    try {
      const client = clientFor(bridge);
      const result = await client.proposePatch({ url, intent });
      return textResult(`built patch proposal prompt for ${url}`, { result });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_verify",
  "Run isolated verification for one page's active patch. Use after setting a patch or when checking whether saved customizations still work. Default backend is CDP and expects a verifier browser such as Chrome on port 9333.",
  {
    ...verifierSchema,
    url: z.string().url().describe("Absolute page URL to verify."),
  },
  async ({ bridge, url, backend, cdp, profile, wait_ms, artifacts_dir }) => {
    try {
      const result = await runVerifier({
        url,
        bridge: bridge ?? DEFAULT_BRIDGE,
        backend: backend ?? "cdp",
        cdp,
        profile,
        waitMs: wait_ms,
        artifactsDir: artifacts_dir,
      });
      return textResult(
        `page modifier verification ${result.verifier?.pass ? "passed" : "failed"} for ${url}`,
        { result },
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.tool(
  "page_modifier_goal",
  "Run the consolidated agent workflow for a page: save intent, optionally set a patch, optionally verify in an isolated browser, and return sanitized final state. Use for terminal-agent end-to-end page customization loops.",
  {
    ...verifierSchema,
    url: z.string().url().describe("Absolute page URL to customize."),
    intent: z.string().optional().describe("Durable user intent to save before patching."),
    patch: patchSchema,
    verify: z.boolean().optional().describe("When true, run isolated verification after updates."),
  },
  async ({ bridge, url, intent, patch, verify, backend, cdp, profile, wait_ms, artifacts_dir }) => {
    try {
      const client = clientFor(bridge);
      const result = await client.goal({
        url,
        intent,
        patch: patch
          ? {
              css: patch.css,
              js: patch.js,
              notes: patch.notes,
              blockedPatterns: patch.blocked_patterns ?? [],
            }
          : null,
        verify: verify === true,
        backend: backend ?? "cdp",
        cdp,
        profile,
        waitMs: wait_ms,
        artifactsDir: artifacts_dir,
      });
      return textResult(`page modifier goal ${result.ok ? "completed" : "failed"} for ${url}`, {
        result,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

await server.connect(new StdioServerTransport());
