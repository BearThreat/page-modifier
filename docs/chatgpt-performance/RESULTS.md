# ChatGPT Page Modifier performance mode — Blackbear results

Date: 2026-09-18

## Deployed behavior

The already-installed Page Modifier extension now receives a site-wide ChatGPT
performance bundle from its local bridge. The bridge is managed by the enabled
page-modifier-bridge.service, binds to 127.0.0.1:18793, and uses
/home/blackbear/.local/share/page-modifier/registry.json.

The active ChatGPT patch is CSS-only. It sets content-visibility auto on
conversation-turn articles, an intrinsic block size of auto 560px, root scroll
behavior to auto, and disables backdrop-filter only on class names containing
backdrop-blur.

There is no request blocking, JavaScript monkey-patching, DOM deletion, cache
clearing, cookie handling, or ChatGPT application-state modification.

## Why this should help

The primary target is long conversations. content-visibility auto lets Chromium
skip rendering work for conversation turns outside the viewport while retaining
their DOM/content. This reduces layout and paint work as a conversation grows.
The other rules reduce optional scroll and blur paint work. This is browser-side
responsiveness work; it does not speed OpenAI model generation or network latency.

## Verification

- node --test scripts/chatgpt-performance.test.mjs: 3/3 passed.
- npm run check: passed, including the extension loopback-boundary check.
- Real isolated Brave loaded the actual unpacked extension and production bridge.
- Applied mode had contentVisibility auto, intrinsic block size auto 560px, root
  scroll behavior auto, backdrop blur none, and preserved button, textarea, code,
  and text content.
- Original mode had no patch style or document marker after reload.
- Reapply mode restored the same owned patch.
- Unrelated www.wikipedia.org had no Page Modifier style or patch marker.
- Applied and Original screenshot hashes are recorded in e2e.json and
  verification.json.
- The live Page Modifier verification record marks the deployed patch verified.

This verifies mechanics, isolation, reversibility, and content/control preservation.
It does not claim a measured percentage speedup on the authenticated live
conversation because that would require disturbing/instrumenting the visible
browser session.

## Persistence and rollback

The systemd source is systemd/page-modifier-bridge.service and the installed user
unit is enabled. scripts/install-user-bridge.sh waits for loopback health, so a
slow service start does not create a false install failure.

Disable only the ChatGPT performance bundle:

    cd /home/blackbear/Desktop/page-modifier
    node scripts/install-chatgpt-performance.mjs --rollback

Re-enable it idempotently:

    node scripts/install-chatgpt-performance.mjs

Disable the bridge entirely:

    systemctl --user disable --now page-modifier-bridge.service

No visible-browser restart is required for the bridge. An already-loaded ChatGPT
document needs one ordinary page reload to run the existing content script and
receive the newly stored bundle.
