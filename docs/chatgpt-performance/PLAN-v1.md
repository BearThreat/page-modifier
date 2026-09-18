# ChatGPT Page Modifier performance mode — plan v1

The current BearT3 Chat Agent MCP connector still does not expose the product-native
gauntlet_plan command. Per startup manifest revision 10, this versioned project
plan is the explicit durable fallback and is not represented as native-plan success.

Goal: use the already-installed Page Modifier extension to reduce ChatGPT rendering
work reliably, with no dependence on OpenAI internals beyond a stable conversation
turn test id and no recurring agent maintenance.

1. Reuse the installed unpacked Page Modifier extension and its existing bridge
   protocol; do not install another third-party extension or edit ChatGPT itself.
2. Establish the extension's existing loopback bridge as a durable user service if
   missing, preserving tailnet safety and avoiding per-origin local-network prompts.
3. Add a built-in ChatGPT performance bundle using reversible CSS only:
   - off-screen conversation turns use CSS content-visibility: auto and intrinsic
     size estimation, so long histories are not continuously rendered;
   - smooth scrolling is disabled;
   - backdrop-blur effects are removed only where ChatGPT marks them by class.
   No network blocking, monkey-patching, DOM deletion, or request interception.
4. Store the bundle in Page Modifier's existing registry for chatgpt.com so the
   already-installed content script applies it after an ordinary page reload.
5. Add focused tests and isolated headless-Brave verification for both the CSS
   behavior and non-application on unrelated origins. Preserve streaming controls,
   visible text, form controls, code blocks, and rollback.
6. Deploy, verify the exact live loopback bridge and stored bundle, then commit and
   push the canonical main branch through Blackbear. Record rollback and limits.
