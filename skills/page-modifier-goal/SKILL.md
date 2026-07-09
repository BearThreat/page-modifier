---
name: page-modifier-goal
description: Use Page Modifier to capture a browser page intent, propose or apply a CSS/JS patch, verify it through CDP, and return compact evidence.
---

# Page Modifier Goal

Use this skill when a user wants a terminal agent to change how a website behaves or feels while keeping the original site usable.

## Workflow

1. Start or confirm the bridge:

```bash
node bridge/server.mjs
node bin/page-modifier.mjs health
```

2. Inspect current state:

```bash
node bin/page-modifier.mjs page --url "$URL"
```

3. Save the user's intent:

```bash
node bin/page-modifier.mjs intent --url "$URL" --text "$INTENT"
```

4. Ask the active terminal agent/model for patch JSON:

```bash
node bin/page-modifier.mjs propose --url "$URL" --intent "$INTENT"
```

The model must return JSON only:

```json
{"css":"...","js":"...","blockedPatterns":[],"notes":"..."}
```

5. Apply the patch:

```bash
node bin/page-modifier.mjs patch --url "$URL" --css "$CSS" --js "$JS" --notes "$NOTES"
```

6. Verify with a disposable CDP browser:

```bash
google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/page-modifier-verify --no-first-run about:blank
node bin/page-modifier.mjs verify --url "$URL" --backend cdp --cdp http://127.0.0.1:9333
```

7. Return compact evidence:

```bash
node bin/page-modifier.mjs evidence --url "$URL"
```

## Rules

- Do not scrape password fields or print cookies/storage values.
- Prefer reversible CSS and small JavaScript.
- Preserve visible content and core workflows unless the user explicitly asks otherwise.
- Treat failed verification as a repair loop input, not as success.
- Use `page-modifier doctor --cdp http://127.0.0.1:9333` when the bridge or verifier path is unclear.
