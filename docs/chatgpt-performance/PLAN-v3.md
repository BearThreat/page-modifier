# ChatGPT Page Modifier performance verification — plan v3

Supersedes PLAN-v2 only for the newly requested quantitative verification. The
current BearT3 Chat Agent MCP connector still does not expose native gauntlet_plan,
so this versioned project file is the explicit durable fallback.

1. Keep the deployed patch unchanged while measuring it.
2. Use a disposable headless Brave profile with the actual unpacked Page Modifier
   extension and production loopback bridge.
3. Benchmark on the real chatgpt.com origin, but inject deterministic synthetic
   long-conversation turns after page load so off/on runs have identical DOM and
   do not depend on account data, network response generation, or private chats.
4. Alternate patch OFF and ON runs to reduce drift. Test multiple conversation
   lengths and collect:
   - DOM construction + first layout wall time;
   - forced style/layout workload wall time;
   - scrolling frame gaps (median, p95, max, dropped/slow frames);
   - Chromium CDP LayoutDuration, RecalcStyleDuration, and TaskDuration deltas.
5. Verify the deployed style is actually present in ON runs and absent in OFF runs.
   Preserve the patch enabled when finished.
6. Summarize medians and percent changes. Do not generalize a synthetic benchmark
   into an exact promise for authenticated ChatGPT; distinguish measured browser
   rendering speedup from server/model latency.
7. Save raw JSON + summary in the project and commit/push only if the benchmark
   script/results are sound and the live patch remains verified.
