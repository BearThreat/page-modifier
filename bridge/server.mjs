#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number.parseInt(process.env.OPENCLAW_PAGE_MODIFIER_PORT ?? "18793", 10);
const DATA_DIR =
  process.env.OPENCLAW_PAGE_MODIFIER_DATA_DIR ??
  join(homedir(), ".openclaw", "page-modifier");
const REGISTRY_PATH = join(DATA_DIR, "registry.json");
const MAX_BODY_BYTES = 2_000_000;
const SESSION_GRANT_TTL_MS = 30 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-openclaw-page-modifier-token",
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.hash = "";
  return parsed;
}

function pageKey(rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  return `${parsed.origin}${parsed.pathname}`;
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

async function loadRegistry() {
  try {
    const text = await readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.pages) {
      throw new Error("Invalid registry shape");
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[page-modifier] ignoring invalid registry: ${error.message}`);
    }
    return { version: 1, pages: {} };
  }
}

async function saveRegistry(registry) {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function ensurePage(registry, rawUrl) {
  const parsed = normalizeUrl(rawUrl);
  const key = pageKey(rawUrl);
  const existing = registry.pages[key];
  if (existing) {
    existing.updatedAt = nowIso();
    existing.urlSample = parsed.toString();
    return existing;
  }
  const page = {
    key,
    origin: parsed.origin,
    pathname: parsed.pathname,
    urlSample: parsed.toString(),
    enabled: true,
    intents: [],
    patches: [],
    activePatchId: null,
    captures: [],
    sessionGrants: [],
    verification: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  registry.pages[key] = page;
  return page;
}

function summarizeCapture(body) {
  return {
    id: makeId("cap"),
    url: body.url,
    title: String(body.title ?? "").slice(0, 200),
    metrics: body.metrics ?? null,
    selectedText: String(body.selectedText ?? "").slice(0, 2000),
    domSummary: String(body.domSummary ?? "").slice(0, 20000),
    createdAt: nowIso(),
  };
}

function heuristicPatchForIntent(intentText) {
  const lower = intentText.toLowerCase();
  const wantsSpeed =
    lower.includes("slow") ||
    lower.includes("speed") ||
    lower.includes("faster") ||
    lower.includes("performance") ||
    lower.includes("cache");
  if (!wantsSpeed) {
    return {
      css: "",
      js: "",
      blockedPatterns: [],
      notes:
        "Intent recorded. No automatic patch generated; add CSS/JS patch material or let an OpenClaw agent synthesize one.",
    };
  }
  return {
    css: [
      "[data-openclaw-hidden='true'] { display: none !important; }",
      "video[autoplay], iframe[src*='ads'], iframe[src*='doubleclick'] { display: none !important; }",
      "img[loading='lazy'] { content-visibility: auto; }",
      "* { scroll-behavior: auto !important; }",
    ].join("\n"),
    js: [
      "(() => {",
      "  const heavySelectors = [",
      "    '[data-ad]', '[class*=ad-]', '[id*=ad-]',",
      "    '[class*=sponsor]', '[id*=sponsor]',",
      "    'video[autoplay]', 'iframe[src*=doubleclick]', 'iframe[src*=googlesyndication]'",
      "  ];",
      "  for (const selector of heavySelectors) {",
      "    document.querySelectorAll(selector).forEach((node) => {",
      "      node.setAttribute('data-openclaw-hidden', 'true');",
      "    });",
      "  }",
      "  window.__openclawPageModifier = { appliedAt: new Date().toISOString(), mode: 'speed-heuristic' };",
      "})();",
    ].join("\n"),
    blockedPatterns: ["*doubleclick*", "*googlesyndication*", "*analytics*", "*segment*", "*hotjar*"],
    notes:
      "Generated conservative speed heuristic: hide obvious ad/sponsor/autoplay nodes and record network-block candidates for the extension/service-worker layer.",
  };
}

function activePatch(page) {
  if (!page.activePatchId) {
    return null;
  }
  return page.patches.find((patch) => patch.id === page.activePatchId) ?? null;
}

function sanitizeCookie(cookie) {
  return {
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain: String(cookie.domain ?? ""),
    hostOnly: Boolean(cookie.hostOnly),
    path: String(cookie.path ?? "/"),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite ? String(cookie.sameSite) : undefined,
    session: Boolean(cookie.session),
    expirationDate:
      typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)
        ? cookie.expirationDate
        : undefined,
    storeId: cookie.storeId ? String(cookie.storeId) : undefined,
  };
}

function sanitizeStorageRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(record).slice(0, 300)) {
    result[String(key).slice(0, 500)] =
      typeof value === "string" ? value.slice(0, 20000) : String(value).slice(0, 20000);
  }
  return result;
}

function latestLiveSessionGrant(page) {
  const now = Date.now();
  return (
    page.sessionGrants.find((grant) => {
      const expiresAt = Date.parse(grant.expiresAt ?? "");
      return Number.isFinite(expiresAt) && expiresAt > now;
    }) ?? null
  );
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const registry = await loadRegistry();

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    jsonResponse(res, 200, {
      ok: true,
      service: "openclaw-page-modifier",
      dataDir: DATA_DIR,
      registryPath: REGISTRY_PATH,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/page") {
    const rawUrl = requestUrl.searchParams.get("url");
    if (!rawUrl) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const key = pageKey(rawUrl);
    const page = registry.pages[key] ?? null;
    jsonResponse(res, 200, {
      page,
      activePatch: page ? activePatch(page) : null,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/session/latest") {
    const rawUrl = requestUrl.searchParams.get("url");
    if (!rawUrl) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = registry.pages[pageKey(rawUrl)] ?? null;
    jsonResponse(res, 200, {
      pageKey: page?.key ?? pageKey(rawUrl),
      sessionGrant: page ? latestLiveSessionGrant(page) : null,
    });
    return;
  }

  if (req.method !== "POST") {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }

  const body = await readJsonBody(req);

  if (requestUrl.pathname === "/capture") {
    if (!body.url) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    page.captures.unshift(summarizeCapture(body));
    page.captures = page.captures.slice(0, 20);
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, page });
    return;
  }

  if (requestUrl.pathname === "/intent") {
    if (!body.url || !body.intent) {
      jsonResponse(res, 400, { error: "url and intent are required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    const intent = {
      id: makeId("intent"),
      text: String(body.intent).trim(),
      createdAt: nowIso(),
    };
    page.intents.push(intent);
    const generated = heuristicPatchForIntent(intent.text);
    const patch = {
      id: makeId("patch"),
      source: "heuristic-or-agent",
      intentIds: page.intents.map((item) => item.id),
      css: generated.css,
      js: generated.js,
      blockedPatterns: generated.blockedPatterns,
      notes: generated.notes,
      verified: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    page.patches.unshift(patch);
    page.activePatchId = patch.id;
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, page, activePatch: patch });
    return;
  }

  if (requestUrl.pathname === "/patch") {
    if (!body.url) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    const patch = {
      id: makeId("patch"),
      source: "manual-or-agent",
      intentIds: Array.isArray(body.intentIds) ? body.intentIds : page.intents.map((item) => item.id),
      css: String(body.css ?? ""),
      js: String(body.js ?? ""),
      blockedPatterns: Array.isArray(body.blockedPatterns) ? body.blockedPatterns.map(String) : [],
      notes: String(body.notes ?? ""),
      verified: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    page.patches.unshift(patch);
    page.activePatchId = patch.id;
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, page, activePatch: patch });
    return;
  }

  if (requestUrl.pathname === "/toggle") {
    if (!body.url) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    page.enabled = Boolean(body.enabled);
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, page, activePatch: activePatch(page) });
    return;
  }

  if (requestUrl.pathname === "/session/grant") {
    if (!body.url) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    const createdAtMs = Date.now();
    const cookies = Array.isArray(body.cookies) ? body.cookies.map(sanitizeCookie) : [];
    const storageSnapshot =
      body.storageSnapshot && typeof body.storageSnapshot === "object"
        ? {
            localStorage: sanitizeStorageRecord(body.storageSnapshot.localStorage),
            sessionStorage: sanitizeStorageRecord(body.storageSnapshot.sessionStorage),
          }
        : null;
    const grant = {
      id: makeId("session"),
      kind: "same-origin-auth-state",
      url: body.url,
      origin: normalizeUrl(body.url).origin,
      cookies,
      storageSnapshot,
      storageSummary: body.storageSummary ?? null,
      cookieSummary: body.cookieSummary ?? null,
      note:
        "Explicit same-origin auth-state grant. Password fields are intentionally not collected.",
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + SESSION_GRANT_TTL_MS).toISOString(),
    };
    page.sessionGrants.unshift(grant);
    page.sessionGrants = page.sessionGrants.slice(0, 10);
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, grant, page });
    return;
  }

  if (requestUrl.pathname === "/verify") {
    if (!body.url) {
      jsonResponse(res, 400, { error: "url is required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    const patch = activePatch(page);
    const verification = {
      id: makeId("verify"),
      status: "queued",
      browserProfile: "openclaw",
      url: body.url,
      activePatchId: patch?.id ?? null,
      sessionGrantId: latestLiveSessionGrant(page)?.id ?? null,
      checklist: [
        "Open original page in isolated OpenClaw browser profile",
        "If a live session grant exists, import same-origin cookies and storage into the isolated profile",
        "Record console errors, request failures, load timing, and screenshot",
        "Apply active patch bundle",
        "Reload and re-run the same checks",
        "Exercise primary page workflow",
        "Compare before/after timing and visual diff",
        "Mark verified only if custom and original reload modes both work",
      ],
      createdAt: nowIso(),
    };
    page.verification = verification;
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, verification, page, activePatch: patch });
    return;
  }

  if (requestUrl.pathname === "/verify/result") {
    if (!body.url || !body.verificationId || !body.status) {
      jsonResponse(res, 400, { error: "url, verificationId, and status are required" });
      return;
    }
    const page = ensurePage(registry, body.url);
    if (!page.verification || page.verification.id !== body.verificationId) {
      jsonResponse(res, 404, { error: "verification not found for page" });
      return;
    }
    const status = body.status === "verified" ? "verified" : "failed";
    page.verification = {
      ...page.verification,
      status,
      evidence: body.evidence ?? null,
      completedAt: nowIso(),
    };
    const patch = activePatch(page);
    if (patch) {
      patch.verified = status === "verified";
      patch.updatedAt = nowIso();
      patch.verificationId = page.verification.id;
    }
    await saveRegistry(registry);
    jsonResponse(res, 200, { ok: true, verification: page.verification, page, activePatch: patch });
    return;
  }

  jsonResponse(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    jsonResponse(res, status, { error: error.message || String(error) });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[page-modifier] bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`[page-modifier] registry ${REGISTRY_PATH}`);
});
