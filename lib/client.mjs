import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BRIDGE =
  process.env.OPENCLAW_PAGE_MODIFIER_BRIDGE ?? "http://127.0.0.1:18793";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT = resolve(__dirname, "..", "scripts", "verify-page.mjs");

export class PageModifierClient {
  constructor(options = {}) {
    this.bridge = options.bridge ?? DEFAULT_BRIDGE;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.bridge}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? data.error
          : `HTTP ${response.status}: ${text}`;
      throw new Error(
        `${message}. Check that the Page Modifier bridge is running at ${this.bridge}.`,
      );
    }
    return data;
  }

  async health() {
    return this.request("/health");
  }

  async page(url) {
    requireUrl(url);
    return sanitizePageResponse(
      await this.request(`/page?url=${encodeURIComponent(url)}`),
    );
  }

  async evidence(url) {
    const page = await this.page(url);
    return summarizeEvidence(page, url, this.bridge);
  }

  async latestSession(url) {
    requireUrl(url);
    return sanitizeSessionResponse(
      await this.request(`/session/latest?url=${encodeURIComponent(url)}`),
    );
  }

  async addIntent(params) {
    requireUrl(params.url);
    if (!params.intent?.trim()) {
      throw new Error("intent is required. Pass --intent or --text with the page goal.");
    }
    return sanitizePageResponse(
      await this.post("/intent", { url: params.url, intent: params.intent }),
    );
  }

  async setPatch(params) {
    requireUrl(params.url);
    return sanitizePageResponse(
      await this.post("/patch", {
        url: params.url,
        css: params.css ?? "",
        js: params.js ?? "",
        notes: params.notes ?? "",
        blockedPatterns: params.blockedPatterns ?? [],
        intentIds: params.intentIds,
      }),
    );
  }

  async toggle(params) {
    requireUrl(params.url);
    if (typeof params.enabled !== "boolean") {
      throw new Error("enabled must be a boolean.");
    }
    return sanitizePageResponse(
      await this.post("/toggle", { url: params.url, enabled: params.enabled }),
    );
  }

  async queueVerification(url) {
    requireUrl(url);
    return sanitizePageResponse(await this.post("/verify", { url }));
  }

  async proposePatch(params) {
    requireUrl(params.url);
    if (!params.intent?.trim()) {
      throw new Error("intent is required. Pass the desired page customization.");
    }
    const page = await this.page(params.url);
    const latestSession = await this.latestSession(params.url);
    const prompt = buildPatchProposalPrompt({
      url: params.url,
      intent: params.intent,
      page,
      latestSession,
    });
    return {
      ok: true,
      bridge: this.bridge,
      url: params.url,
      intent: params.intent,
      prompt,
      expectedPatchJsonShape: {
        css: "CSS string to inject",
        js: "JavaScript string to run after load",
        blockedPatterns: ["optional URL pattern strings"],
        notes: "Short explanation of why this patch should satisfy the intent safely",
      },
    };
  }

  async goal(params) {
    requireUrl(params.url);
    const steps = [];
    let latest = null;

    if (params.intent?.trim()) {
      latest = await this.addIntent({ url: params.url, intent: params.intent });
      steps.push({ action: "intent", ok: true, activePatchId: latest.activePatch?.id ?? null });
    }

    if (params.patch) {
      latest = await this.setPatch({ url: params.url, ...params.patch });
      steps.push({ action: "patch", ok: true, activePatchId: latest.activePatch?.id ?? null });
    }

    if (!latest) {
      latest = await this.page(params.url);
      steps.push({ action: "inspect", ok: true, activePatchId: latest.activePatch?.id ?? null });
    }

    let verification = null;
    if (params.verify === true) {
      verification = await runVerifier({
        url: params.url,
        bridge: this.bridge,
        backend: params.backend ?? "cdp",
        cdp: params.cdp,
        profile: params.profile,
        waitMs: params.waitMs,
        artifactsDir: params.artifactsDir,
      });
      steps.push({
        action: "verify",
        ok: verification.verifier?.pass === true,
        status: verification.verifier?.bridgeVerification?.status ?? null,
      });
      latest = await this.page(params.url);
    }

    return {
      ok: steps.every((step) => step.ok),
      bridge: this.bridge,
      url: params.url,
      steps,
      page: latest.page,
      activePatch: latest.activePatch,
      verification,
    };
  }

  async post(path, body) {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

export async function runVerifier(params) {
  requireUrl(params.url);
  const args = [VERIFY_SCRIPT, "--url", params.url, "--bridge", params.bridge ?? DEFAULT_BRIDGE];
  if (params.backend) {
    args.push("--backend", params.backend);
  }
  if (params.cdp) {
    args.push("--cdp", params.cdp);
  }
  if (params.profile) {
    args.push("--profile", params.profile);
  }
  if (params.waitMs) {
    args.push("--wait-ms", String(params.waitMs));
  }
  if (params.artifactsDir) {
    args.push("--artifacts-dir", params.artifactsDir);
  }

  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", resolvePromise);
  });
  const parsed = parseJson(stdout);
  if (code !== 0) {
    throw new Error(
      `verify-page failed with exit ${code}: ${stderr || stdout || "no output"}`,
    );
  }
  if (!parsed) {
    throw new Error(`verify-page returned non-JSON output: ${stdout.slice(0, 500)}`);
  }
  return sanitizeVerifierResult(parsed);
}

export function sanitizePageResponse(data) {
  return {
    ...data,
    page: data.page ? sanitizePage(data.page) : null,
    activePatch: data.activePatch ?? null,
  };
}

export function sanitizeSessionResponse(data) {
  return {
    ...data,
    sessionGrant: data.sessionGrant ? summarizeSessionGrant(data.sessionGrant) : null,
  };
}

export function sanitizeVerifierResult(data) {
  return data;
}

export function summarizeEvidence(data, url, bridge = DEFAULT_BRIDGE) {
  const page = data.page ?? null;
  const patch = data.activePatch ?? null;
  const verification = page?.verification ?? null;
  const evidence = verification?.evidence ?? {};
  const screenshots = evidence.screenshots ?? {};
  return {
    ok: true,
    bridge,
    url,
    tracked: Boolean(page),
    page: page
      ? {
          key: page.key,
          enabled: page.enabled,
          origin: page.origin,
          pathname: page.pathname,
          intentCount: page.intents?.length ?? 0,
          patchCount: page.patches?.length ?? 0,
          captureCount: page.captures?.length ?? 0,
          sessionGrantCount: page.sessionGrants?.length ?? 0,
          updatedAt: page.updatedAt,
        }
      : null,
    activePatch: patch
      ? {
          id: patch.id,
          source: patch.source,
          verified: patch.verified,
          verificationId: patch.verificationId ?? null,
          cssBytes: patch.css?.length ?? 0,
          jsBytes: patch.js?.length ?? 0,
          blockedPatternCount: patch.blockedPatterns?.length ?? 0,
          notes: patch.notes ?? "",
        }
      : null,
    verification: verification
      ? {
          id: verification.id,
          status: verification.status,
          activePatchId: verification.activePatchId,
          sessionGrantId: verification.sessionGrantId ?? null,
          createdAt: verification.createdAt,
          completedAt: verification.completedAt ?? null,
          backend: evidence.backend ?? null,
          pass: verification.status === "verified",
          criteria: evidence.criteria ?? null,
          delta: evidence.delta ?? null,
          visualDiff: evidence.visualDiff ?? null,
          screenshots: screenshots.artifactDir
            ? {
                artifactDir: screenshots.artifactDir,
                before: summarizeScreenshot(screenshots.before),
                after: summarizeScreenshot(screenshots.after),
              }
            : null,
        }
      : null,
  };
}

function summarizeScreenshot(screenshot) {
  if (!screenshot) {
    return null;
  }
  return {
    path: screenshot.path,
    bytes: screenshot.bytes,
    sha256: screenshot.sha256,
  };
}

export function sanitizePage(page) {
  return {
    ...page,
    sessionGrants: (page.sessionGrants ?? []).map(summarizeSessionGrant),
  };
}

export function summarizeSessionGrant(grant) {
  return {
    id: grant.id,
    kind: grant.kind,
    url: grant.url,
    origin: grant.origin,
    cookieCount: Array.isArray(grant.cookies) ? grant.cookies.length : 0,
    cookieNames: Array.isArray(grant.cookies)
      ? grant.cookies.map((cookie) => cookie.name).filter(Boolean)
      : [],
    storageSummary: grant.storageSummary ?? {
      localStorageKeys: Object.keys(grant.storageSnapshot?.localStorage ?? {}),
      sessionStorageKeys: Object.keys(grant.storageSnapshot?.sessionStorage ?? {}),
    },
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    note: grant.note,
  };
}

export function buildPatchProposalPrompt(params) {
  const activePatch = params.page.activePatch
    ? {
        id: params.page.activePatch.id,
        verified: params.page.activePatch.verified,
        notes: params.page.activePatch.notes,
        cssBytes: params.page.activePatch.css?.length ?? 0,
        jsBytes: params.page.activePatch.js?.length ?? 0,
        blockedPatterns: params.page.activePatch.blockedPatterns ?? [],
      }
    : null;
  const page = params.page.page;
  return [
    "You are generating a Page Modifier patch for a browser page.",
    "Return JSON only with keys: css, js, blockedPatterns, notes.",
    "Do not include markdown fences.",
    "Do not scrape password fields or exfiltrate secrets.",
    "Preserve core page functionality and visible content unless the user intent explicitly asks to remove it.",
    "Prefer reversible CSS and narrowly scoped JavaScript.",
    "The verifier will reject patches that add console errors, request failures, task-count changes, or meaningful responsiveness regressions.",
    "",
    `URL: ${params.url}`,
    `User intent: ${params.intent}`,
    "",
    "Tracked page state:",
    JSON.stringify(
      {
        pageKey: page?.key ?? null,
        origin: page?.origin ?? null,
        pathname: page?.pathname ?? null,
        savedIntents: page?.intents?.map((intent) => intent.text).slice(-10) ?? [],
        latestVerificationStatus: page?.verification?.status ?? null,
        activePatch,
        latestSessionGrant: params.latestSession.sessionGrant
          ? {
              id: params.latestSession.sessionGrant.id,
              cookieCount: params.latestSession.sessionGrant.cookieCount,
              storageSummary: params.latestSession.sessionGrant.storageSummary,
              expiresAt: params.latestSession.sessionGrant.expiresAt,
            }
          : null,
      },
      null,
      2,
    ),
  ].join("\n");
}

function requireUrl(url) {
  if (!url) {
    throw new Error("url is required.");
  }
  try {
    new URL(url);
  } catch {
    throw new Error(`url must be absolute, for example https://example.com/. Received: ${url}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
