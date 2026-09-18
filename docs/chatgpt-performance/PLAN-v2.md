# ChatGPT Page Modifier performance mode — plan v2

Supersedes PLAN-v1 after implementation discoveries.

The current BearT3 Chat Agent MCP connector does not expose native gauntlet_plan.
This versioned plan is the explicit durable fallback and does not claim native
plan attribution.

## Final implementation

1. Reuse the already-installed Page Modifier unpacked extension; do not install
   another extension.
2. Run Page Modifier bridge as an enabled user service on 127.0.0.1:18793, using
   ~/.local/share/page-modifier as the installed source of truth. Preserve old
   Page Modifier state with a one-time copy only when the new registry is absent.
3. Extend bridge resolution with an explicit siteWide root-page mode. Exact page
   patches win; an exact disabled page suppresses the site-wide fallback.
4. Install the ChatGPT root bundle at https://chatgpt.com/ with no JavaScript and
   no network blocking. CSS uses content-visibility auto, intrinsic block size,
   auto scroll behavior, and removes only class-marked backdrop blur.
5. Make install/rollback idempotent. Re-enabling after rollback must reuse the
   existing owned patch rather than accumulate new patches.
6. Verify with focused bridge tests, extension boundary checks, a disposable
   headless Brave loading the actual extension, Applied/Original/reapplied modes,
   control/code preservation, an unrelated origin, screenshots, and a persisted
   verification receipt.
7. Keep the visible browser untouched during the active Chat agent turn. The
   currently loaded ChatGPT tab receives the bundle on its next ordinary reload.
8. Commit and push canonical main and verify the remote ref and live service.
