# Page Modifier

Page Modifier is a browser-to-terminal-agent bridge for people who browse with
Codex, Claude Code, Cline, Cursor, or another terminal agent beside them. The
extension captures the page and applies verified patches; the terminal agent
drives the CLI/API/MCP loop that proposes, repairs, verifies, and re-runs those
patches.

## Pitch

Page Modifier lets terminal-agent users reshape websites while browsing. The
browser extension is a local actuator and status surface; the agent operates
through HTTP, CLI, or MCP. The result is a bi-directional loop: the browser gives
the agent page state and intent, then the agent writes back verified CSS/JS
patches the browser can apply.

The product promise:

- Browse to a slow, noisy, broken, or repetitive page.
- Capture the page and intent from the extension with `Send to agent`.
- The browser writes a queued job to the local bridge.
- A terminal agent claims the job through CLI/API/MCP.
- The agent proposes, applies, verifies, and repairs the patch.
- The extension shows live job state: queued -> working -> verified/failed.
- Keep using the original site or the customized version.
- Export verified modifications as shareable bundles.
- Re-run saved intents when the site changes.

Starter use case: while using a slow web app, tell your terminal agent to make
it feel less laggy by reducing animation, paint, scroll, and task-list jank
while preserving normal functionality.

## 30-Second Demo Flow

```bash
npm install
npm run bridge
```

Load `web-extension/` as an unpacked Chrome/Brave extension, open a page, write
an intent, and click `Send to agent`. In your terminal agent, claim and solve the
queued job:

```bash
node bin/page-modifier.mjs jobs
node bin/page-modifier.mjs claim
node bin/page-modifier.mjs solve --verify --backend cdp --cdp http://127.0.0.1:9333
node bin/page-modifier.mjs evidence --url "$URL"
```

The agent loop is just CLI/API/MCP:

```bash
node bin/page-modifier.mjs jobs --status queued
node bin/page-modifier.mjs claim
node bin/page-modifier.mjs propose --url "$URL" --intent "$INTENT"
node bin/page-modifier.mjs patch --url "$URL" --css "$CSS" --js "$JS" --notes "$NOTES"
node bin/page-modifier.mjs verify --url "$URL" --backend cdp --cdp http://127.0.0.1:9333
node bin/page-modifier.mjs evidence --url "$URL"
node bin/page-modifier.mjs export --url "$URL" --out page-modifier.bundle.json
```

No embedded model account required. Your terminal agent brings the model; Page
Modifier supplies the browser bridge, persistent patch registry, verifier, and
shareable bundle format.

It has four pieces:

- `bridge/server.mjs`: local loopback HTTP API and patch registry.
- `bin/page-modifier.mjs`: terminal-agent CLI.
- `mcp/server.mjs`: stdio MCP server for agents that prefer tools.
- `web-extension/`: Chrome/Brave MV3 extension that captures the current page,
  grants same-origin auth state, applies the latest patch bundle, queues
  terminal-agent jobs, shows live job status, and keeps copied handoff prompts as
  a fallback.

## Start

```bash
cd page-modifier
npm install
npm run bridge
```

Then load `web-extension/` as an unpacked extension in Brave/Chrome.

Default bridge URL: `http://127.0.0.1:18793`.

Run a local sanity check:

```bash
node bin/page-modifier.mjs doctor
```

In the extension popup, use `Send to agent` after writing an intent. It captures
the active page, creates a bridge job, and shows the job status while a terminal
agent works through CLI/API/MCP. `Copy handoff` remains as a fallback prompt.

## Terminal Agent Surfaces

### CLI

```bash
cd page-modifier

node bin/page-modifier.mjs health
node bin/page-modifier.mjs doctor
node bin/page-modifier.mjs jobs --status queued
node bin/page-modifier.mjs claim
node bin/page-modifier.mjs solve --verify --backend cdp --cdp http://127.0.0.1:9333
node bin/page-modifier.mjs complete --job-id "$JOB_ID" --status blocked --notes "$REASON"
node bin/page-modifier.mjs page --url "$URL"
node bin/page-modifier.mjs intent --url "$URL" --text "make this page feel less laggy"
node bin/page-modifier.mjs propose --url "$URL" --intent "make this page feel less laggy"
node bin/page-modifier.mjs patch --url "$URL" --css "..." --js "..." --notes "..."
node bin/page-modifier.mjs verify --url "$URL" --backend cdp --cdp http://127.0.0.1:9333
node bin/page-modifier.mjs evidence --url "$URL"
node bin/page-modifier.mjs export --url "$URL" --out bundle.json
node bin/page-modifier.mjs import --file bundle.json --url "$URL"
node bin/page-modifier.mjs goal --url "$URL" --intent "make this page feel less laggy" --enqueue
node bin/page-modifier.mjs goal --url "$URL" --intent "make this page feel less laggy" --enqueue --solve --verify
node bin/page-modifier.mjs mcp-config
```

Use `page` when an agent needs full tracked state. Use `evidence` when an agent
only needs the latest verification result, artifact paths, visual diff, timing
deltas, and pass/fail criteria.

All CLI page/session outputs summarize session grants without printing cookie or
storage values.

### MCP

The bundled `.mcp.json` exposes a stdio server:

```json
{
  "mcpServers": {
    "pageModifier": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "env": {
        "OPENCLAW_PAGE_MODIFIER_BRIDGE": "http://127.0.0.1:18793"
      }
    }
  }
}
```

MCP tool catalog:

- `page_modifier_status`: inspect bridge health and sanitized page state.
- `page_modifier_jobs`: list queued, working, verified, failed, blocked, or all
  browser-submitted jobs.
- `page_modifier_create_job`: enqueue a page customization job.
- `page_modifier_claim_job`: claim the next queued job for a terminal agent.
- `page_modifier_solve_job`: claim, patch, optionally verify, and write status
  back for the browser.
- `page_modifier_complete_job`: mark a job verified, failed, or blocked when an
  agent has external evidence.
- `page_modifier_evidence`: inspect compact verification evidence and artifacts.
- `page_modifier_export_bundle`: export a shareable patch bundle without auth
  state.
- `page_modifier_import_bundle`: import a bundle to a target URL as unverified
  until rechecked.
- `page_modifier_apply_intent`: save a durable user intent and optional patch.
- `page_modifier_set_patch`: replace the active CSS/JS patch.
- `page_modifier_propose_patch`: build an LLM-ready patch-generation prompt from
  sanitized page state.
- `page_modifier_verify`: run isolated CDP/OpenClaw verification.
- `page_modifier_goal`: run the consolidated intent -> patch -> verify workflow.

Use fully qualified tool names in MCP-aware prompts, for example
`pageModifier:page_modifier_goal`.

### HTTP API

The bridge remains useful for raw agent calls:

- `GET /health`
- `GET /page?url=...`
- `GET /jobs?status=queued|working|verified|failed|blocked|all&url=...`
- `GET /job?id=...` or `GET /job?url=...`
- `POST /jobs`
- `POST /jobs/claim`
- `POST /jobs/complete`
- `POST /jobs/fail`
- `POST /capture`
- `POST /intent`
- `POST /patch`
- `POST /toggle`
- `POST /session/grant`
- `GET /session/latest?url=...`
- `GET /bundle/export?url=...`
- `POST /bundle/import`
- `POST /verify`
- `POST /verify/result`

## Agent Skills

This repo ships two repo-local skills that terminal agents can read or install
into their own skill system:

- `skills/page-modifier-goal/SKILL.md`: capture intent, propose/apply patch,
  verify with CDP, and return evidence.
- `skills/page-modifier-repair/SKILL.md`: use failed verifier evidence to narrow
  and repair a patch until it passes or is honestly blocked.

## Current Scope

Implemented:

- Per-page intent history.
- Active patch bundle with CSS, JavaScript, blocked URL patterns, and notes.
- Popup buttons for capture, add/update intent, terminal-agent handoff, apply
  custom, restore original, reapply latest, verify, grant current session
  context, and send the current page intent to the terminal-agent queue.
- Browser-visible job status polling for queued, working, verified, failed, and
  blocked jobs.
- Content script applies patches on every load while the bridge is reachable.
- Local persistence in `~/.openclaw/page-modifier/registry.json`.
- Todoist starter demo and verifier: `scripts/todoist-speedup-demo.mjs`.

Implemented for auth-state carryover:

- Explicit same-origin session grant from the current tab.
- Cookies available to the extension for the current URL.
- Local/session storage values for the current page origin.
- 30 minute TTL for session grants.
- `/session/latest?url=...` for the verifier to fetch the newest live grant.

Not implemented as raw credential scraping:

- Password extraction from pages.
- Silent credential replay across unrelated browsers.

Use the explicit session grant path or test accounts instead. The bridge stores
same-origin auth state locally so OpenClaw can carry it into an isolated test
profile.

## Patch Shape

```json
{
  "css": "body { font-size: 14px; }",
  "js": "document.querySelectorAll('.ad').forEach((node) => node.remove())",
  "blockedPatterns": ["*/analytics/*"],
  "notes": "Hide analytics-heavy sidebars"
}
```

## Verification

`POST /verify` queues the acceptance checklist and records the active patch plus
the latest live session grant ID, when one exists.

`scripts/verify-page.mjs` is the agent-facing verifier. Its default backend is
CDP because it is fast, scriptable from a terminal agent, and avoids the current
`openclaw browser` profile hang. It:

- Fetches the active patch from the bridge.
- Fetches `/session/latest?url=...`.
- Imports same-origin cookies and local/session storage into an isolated CDP
  browser target without printing secret values.
- Captures before/after timing, frame-gap, console, request, visible-text, and
  task-node evidence.
- Captures before/after PNG screenshots to
  `~/.openclaw/page-modifier/artifacts/<verification-id>/`.
- Computes a sampled screenshot visual diff using the verifier browser canvas.
- Applies the active CSS/JS patch.
- Calls `POST /verify/result` with `verified` or `failed`.

Start a disposable verifier browser:

```bash
chromium \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/openclaw-page-modifier-verify \
  --no-first-run
```

Run generic verification:

```bash
node scripts/verify-page.mjs \
  --url "$URL" \
  --backend cdp \
  --cdp http://127.0.0.1:9333
```

Legacy fallback:

```bash
node scripts/verify-page.mjs \
  --url "$URL" \
  --backend openclaw \
  --profile openclaw
```

`POST /verify/result` records PASS/FAIL evidence and marks the active patch
verified when the verifier criteria pass.

## Bundles

Bundles are portable page modifications for terminal agents to share, inspect,
and re-verify.

```bash
node bin/page-modifier.mjs export --url "$URL" --out todoist-speedup.bundle.json
node bin/page-modifier.mjs import --file todoist-speedup.bundle.json --url "$URL"
node bin/page-modifier.mjs verify --url "$URL" --backend cdp --cdp http://127.0.0.1:9333
```

Exported bundles include intents, CSS/JS patch material, notes, and verification
summary. They intentionally exclude captures, cookies, local/session storage,
and session grants. Imported patches are marked unverified until the verifier
passes on the target page.

## Patch Generation

`page-modifier propose` and `page_modifier_propose_patch` intentionally do not
call a model by themselves. That is deliberate: terminal agents already bring
their own model/provider policy. This project should provide the actuator,
state, prompt contract, and verifier, not hide model choice behind another
adapter layer.

The proposal command produces a clean prompt contract for a terminal agent:

- current URL and user intent
- saved page intents
- active patch metadata
- latest verification status
- latest session-grant summary without secret values
- required JSON output shape: `css`, `js`, `blockedPatterns`, `notes`

The agent can pass that prompt to its model of choice, then call `patch` and
`verify`.

Todoist starter demo:

```bash
node scripts/todoist-speedup-demo.mjs
```

The demo:

- Finds the existing Todoist tab in the user Brave CDP session.
- Captures same-origin cookies and storage without printing secret values.
- Imports that state into an isolated Chrome CDP verifier.
- Applies a safe reduced-motion speedup patch.
- Compares frame-gap metrics before/after.
- Marks the bridge verification `verified` only when visible text/task counts
  stay stable and responsiveness metrics do not worsen.

## GitHub Project Shape

Positioning: browser-to-terminal-agent webpage customization for people who
want their agent to modify sites while they browse.

Repository primitives:

- MV3 extension for page capture, explicit same-origin session grants, patch
  application, original/custom mode switching, and saved page intents.
- Loopback bridge with a durable registry at
  `~/.openclaw/page-modifier/registry.json`.
- Agent CLI/MCP surfaces for status, intent, patch, toggle, verification, and
  goal-loop execution.
- Extension popup handoff that copies a terminal-agent task prompt instead of
  embedding provider/model calls.
- Agent scripts for session import, CDP verification, and site-specific demos.
- Repo-local skills that turn the workflow into repeatable agent loops.
- Import/export bundles for sharing verified modifications without auth state.

Starter example: `page speedup` intent. The Todoist demo uses a conservative
reduced-motion patch that aims to make the app feel less laggy without deleting
task rows or changing visible text.
