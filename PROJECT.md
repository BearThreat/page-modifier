# Page Modifier Project Brief

## One-liner

Page Modifier is a browser-to-terminal-agent bridge for users who browse with a
terminal agent beside them. It lets agents durably customize arbitrary websites
with saved natural-language intents, generated CSS/JS patches, original/custom
reload controls, and isolated end-to-end verification. The browser extension is
the actuator; the expected operator is the terminal agent.

## Who It Is For

- Terminal-agent users who want to auto-modify webpages while browsing instead
  of writing one-off snippets in DevTools.
- Codex, Claude Code, Cline, Cursor, OpenClaw, and similar agents that need
  API/CLI/MCP control over a durable browser-side actuator.
- Agent workflows that need to capture page state, carry same-origin auth into
  an isolated test browser, apply patches, and prove the result works.

## Core Workflow

1. User opens a page and clicks the extension.
2. Extension captures page summary, metrics, current URL, and saved intents.
3. User adds an intent such as `make this page feel less laggy`.
4. Extension copies a terminal-agent handoff prompt with the exact CLI loop.
5. Agent writes or updates the active CSS/JS patch bundle.
6. User can switch between original site mode and custom mode.
7. Agent verifies the patch in an isolated CDP browser target.
8. Bridge marks the patch verified only when evidence passes.

Agents can drive this through:

- HTTP: direct loopback API calls to `bridge/server.mjs`.
- CLI: `node bin/page-modifier.mjs goal --url "$URL" --intent "..." --verify`.
- MCP: `pageModifier:page_modifier_goal`.
- Skills: `skills/page-modifier-goal` and `skills/page-modifier-repair`.

## Why This Matters

Normal browser extensions ship fixed features. Page Modifier turns the extension
into a general browser actuator for terminal agents: the durable unit is the
user's intent for a page, and agents can keep re-solving that intent as the site
changes.

## Starter Demo

Todoist speedup intent:

```text
Make Todoist feel less laggy: reduce animation, scrolling, paint, and task-list
jank while preserving normal functionality.
```

Implemented starter patch:

- Disables expensive animations and transitions.
- Disables smooth-scroll behavior.
- Removes detectable backdrop-filter and shadow effects.
- Preserves visible text and task-like node counts.
- Uses frame-gap evidence to reject patches that make the page worse.
- Captures before/after screenshots and sampled visual-diff evidence.

## Agent API Surface

- `node bridge/server.mjs` starts the loopback registry and API.
- `node bin/page-modifier.mjs ...` exposes terminal-agent CLI commands.
- `node bin/page-modifier.mjs doctor` checks bridge/package/verifier readiness.
- `node bin/page-modifier.mjs evidence --url "$URL"` returns compact latest
  verification evidence without full patch bodies.
- `node mcp/server.mjs` exposes a stdio MCP server.
- `GET /page?url=...` returns saved intents, active patch, and verification.
- `POST /intent` records an intent and creates a starter heuristic patch.
- `POST /patch` writes an agent-generated CSS/JS patch bundle.
- `POST /session/grant` stores explicit same-origin cookies/storage for testing.
- `GET /session/latest?url=...` returns the latest live auth-state grant.
- `POST /verify` queues verification.
- `POST /verify/result` records evidence and marks the patch verified or failed.
- `node scripts/verify-page.mjs --backend cdp` runs the first-class verifier.

## MCP Tool Contract

- `page_modifier_status`: use before modifying a page. Returns bridge health,
  sanitized page state, active patch metadata, and session-grant summaries.
- `page_modifier_evidence`: use after verification. Returns compact pass/fail
  criteria, visual-diff stats, timing deltas, and screenshot artifact paths.
- `page_modifier_apply_intent`: use when the user states what they want changed.
  Saves durable intent and optional patch.
- `page_modifier_set_patch`: use after synthesizing or repairing CSS/JS.
- `page_modifier_propose_patch`: use to build the LLM prompt for synthesizing or
  repairing a patch from sanitized page state.
- `page_modifier_verify`: use after setting a patch or checking if a saved patch
  still works.
- `page_modifier_goal`: use for the whole terminal-agent loop: intent, optional
  patch, optional verification, final state.

## Guardrails

- No password-field scraping.
- Auth carryover is explicit and same-origin.
- Session grants expire after 30 minutes.
- Verifier output reports counts, screenshot paths/hashes, and evidence, not
  cookie/storage values or screenshot base64.
- Patches are not considered verified until isolated browser evidence is posted.
- Model/provider adapters are intentionally not core. The terminal agent brings
  its own model; Page Modifier owns state, actuation, prompt contracts, and
  verification evidence.

## Built-in Agent Skills

- `skills/page-modifier-goal/SKILL.md`: first-pass loop for intent -> proposal
  prompt -> patch -> CDP verification -> evidence.
- `skills/page-modifier-repair/SKILL.md`: repair loop driven by verifier
  failures, screenshots, visual diff, and timing deltas.

## Roadmap

- Add richer visual-diff thresholds and screenshot review UI.
- Add per-site patch version history and rollback.
- Add import/export bundles for sharing page customizations.
- Add browser-managed network blocking for `blockedPatterns`.
- Package install docs for Chrome, Brave, and OpenClaw plugin discovery.
