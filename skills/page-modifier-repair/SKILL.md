---
name: page-modifier-repair
description: Repair a failed Page Modifier patch using verifier evidence, screenshots, timing deltas, and a narrower repeat-until-verified patch loop.
---

# Page Modifier Repair

Use this skill when a Page Modifier patch fails verification, breaks page behavior, changes visible content unexpectedly, or needs a narrower follow-up patch.

## Workflow

1. Read compact evidence first:

```bash
node bin/page-modifier.mjs evidence --url "$URL"
```

2. Identify the first failing criterion:

- `visibleTextUnchanged`: patch removed or changed content.
- `taskCountUnchanged`: patch hid or duplicated task/list-like nodes.
- `p95NotMeaningfullyWorse` or `maxNotMeaningfullyWorse`: patch caused responsiveness regression.
- `noNewConsoleErrors`: JavaScript is too brittle.
- `noNewRequestFailures`: blocked patterns or runtime changes broke loading.

3. Generate a narrower repair prompt:

```bash
node bin/page-modifier.mjs propose --url "$URL" --intent "$REPAIR_INTENT"
```

4. Apply the smallest repair patch. Prefer:

- Scoping CSS under one data attribute.
- Feature-detecting before touching DOM nodes.
- Avoiding removal; use soft visual changes before hiding.
- Avoiding broad selectors such as `div`, `span`, `[class*=item]`, or global click handlers.

5. Re-run verification:

```bash
node bin/page-modifier.mjs verify --url "$URL" --backend cdp --cdp http://127.0.0.1:9333
node bin/page-modifier.mjs evidence --url "$URL"
```

## Stop Conditions

Stop and report blocked when:

- The page requires fresh auth and no live same-origin session grant exists.
- The verifier cannot load the original page reliably.
- The user intent requires destructive behavior or secret extraction.
- Three narrower repair attempts fail on the same criterion.
