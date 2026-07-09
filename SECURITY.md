# Security Notes

Page Modifier is intentionally local-first. The bridge binds to loopback, and
the default registry lives under `~/.openclaw/page-modifier/registry.json`.

## Sensitive Runtime State

The registry can contain explicit same-origin auth-state grants:

- cookie names and values
- localStorage snapshots
- sessionStorage snapshots

These grants exist so a terminal agent can verify a page customization in an
isolated browser profile. They are sensitive and should not be committed,
published, pasted into issues, or included in demo artifacts.

CLI and MCP status paths summarize session grants without values. Raw bridge
endpoints still return grant material because importers need it.

## Guardrails

- No password-field scraping.
- Same-origin auth-state grants expire after 30 minutes.
- The browser extension requires an explicit `Grant session` action.
- Verifier evidence stores screenshot paths and hashes, not base64 blobs.
- Public demos should use test accounts or sanitized registries.

## Pre-Publish Checklist

1. Remove or ignore `~/.openclaw/page-modifier/registry.json`.
2. Use a fresh demo registry with no personal auth grants.
3. Inspect screenshot artifacts before publishing.
4. Confirm CLI/MCP outputs do not contain cookie/storage values.
5. Keep `.mcp.json` loopback-only unless a reviewed auth layer is added.
