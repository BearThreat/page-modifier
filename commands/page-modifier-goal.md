---
name: page-modifier:goal
description: Run Page Modifier to final verified API/CLI/MCP-first page customization state
---

You are driving the OpenClaw Page Modifier project as a terminal-agent-operable
page customization system.

Project root:

The `page-modifier` repository root.

Product target:

- Primary surface is API/CLI/MCP for terminal agents.
- Browser extension is the page actuator: capture, explicit same-origin session
  grant, original/custom toggle, and patch application.
- Bridge is the local loopback state/API plane.
- CLI and MCP are the expected agent control surfaces.
- Verification is isolated CDP-first and writes screenshot/visual-diff evidence.
- Patch generation is agent-operable: build a sanitized prompt contract, have
  the terminal agent's own model produce JSON patch material, apply it, verify
  it, and repeat until verified or honestly blocked.

Non-negotiable safety:

- Do not scrape password fields.
- Do not print cookie/storage values.
- Treat `~/.openclaw/page-modifier/registry.json` as sensitive.
- Use session grant summaries in CLI/MCP output; raw grants are only for import.
- Public/demo artifacts must use sanitized registries or test accounts.

Default target for the current project pass:

`https://app.todoist.com/app/inbox?locale=en`

Loop:

1. Ensure bridge is running on `http://127.0.0.1:18793`.

   ```bash
   node bridge/server.mjs
   ```

   Verify:

   ```bash
   node bin/page-modifier.mjs health
   node bin/page-modifier.mjs doctor
   ```

2. Inspect page state:

   ```bash
   node bin/page-modifier.mjs page --url "$URL"
   ```

3. If there is no fresh live session grant and the user browser has a reachable
   logged-in target tab, refresh auth state through the proven CDP demo path or
   have the extension perform `Grant session`. Never print grant values.

4. Build or update the intent:

   ```bash
   node bin/page-modifier.mjs intent \
     --url "$URL" \
     --text "Make Todoist feel less laggy: reduce animation, scrolling, paint, and task-list jank while preserving normal functionality."
   ```

5. Generate a patch proposal prompt:

   ```bash
   node bin/page-modifier.mjs propose \
     --url "$URL" \
     --intent "Make Todoist feel less laggy: reduce animation, scrolling, paint, and task-list jank while preserving normal functionality."
   ```

   Feed the returned prompt to the active terminal agent/model. The model must
   return JSON only:

   ```json
   {
     "css": "...",
     "js": "...",
     "blockedPatterns": [],
     "notes": "..."
   }
   ```

6. Apply the patch with the CLI or MCP:

   ```bash
   node bin/page-modifier.mjs patch \
     --url "$URL" \
     --css "$CSS" \
     --js "$JS" \
     --notes "$NOTES"
   ```

7. Start or reuse an isolated CDP verifier browser:

   ```bash
   google-chrome \
     --headless=new \
     --remote-debugging-port=9333 \
     --user-data-dir=/tmp/openclaw-page-modifier-verify \
     --no-first-run \
     --disable-gpu \
     --disable-dev-shm-usage \
     about:blank
   ```

8. Verify:

   ```bash
   node bin/page-modifier.mjs verify \
     --url "$URL" \
     --backend cdp \
     --cdp http://127.0.0.1:9333 \
     --artifacts-dir ~/.openclaw/page-modifier/artifacts
   ```

9. If verification fails:

   - Read the sanitized verifier evidence.
   - Inspect console/request/frame/screenshot/visual-diff signals.
   - Generate a repair prompt with `propose`.
   - Apply a narrower patch.
   - Repeat verification.

Acceptance criteria:

- `npm run check` passes.
- `npx tsc --noEmit` passes when TypeScript is available.
- CLI `health`, `doctor`, `page`, `propose`, `verify`, and `evidence` work.
- MCP server lists these tools:
  - `page_modifier_status`
  - `page_modifier_evidence`
  - `page_modifier_apply_intent`
  - `page_modifier_set_patch`
  - `page_modifier_propose_patch`
  - `page_modifier_verify`
  - `page_modifier_goal`
- Verifier writes before/after screenshot files and visual-diff stats.
- Verified patch preserves visible text/task-like node counts unless the intent
  explicitly asks otherwise.
- No CLI/MCP output contains cookie/storage values.
- Bridge verification status is `verified` for the active patch.
