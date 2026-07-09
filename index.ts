// Optional OpenClaw plugin entrypoint. The product works as a standalone
// API/CLI/MCP package; OpenClaw can also discover this object when installed
// as a plugin.
export default {
  id: "page-modifier",
  name: "Page Modifier",
  description:
    "Local browser extension bridge for durable per-page user intents and patch bundles.",
  register(api: { logger?: { info?: (message: string) => void } }) {
    api.logger?.info?.(
      "[page-modifier] install the unpacked web extension and run `npm run bridge` or `node bridge/server.mjs`",
    );
  },
};
