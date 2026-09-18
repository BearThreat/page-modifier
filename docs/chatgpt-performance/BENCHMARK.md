# Quantitative ChatGPT performance benchmark

Date: 2026-09-18

## Method

I ran the actual Page Modifier extension in a disposable headless Brave on the
real chatgpt.com origin. For each A/B run the extension first had to prove
that the production CSS patch was present (ON) or absent (OFF). I then replaced
the unauthenticated document body with the same deterministic synthetic long-chat
DOM so account data, server response time, and network variation could not bias
the browser-rendering comparison.

Each conversation length used three OFF and three ON samples in counterbalanced
order (off,on,on,off,off,on). The measured production patch SHA-256 is
afad5940c65f0a7d1fd890cf453f993800bbd2797ac847dde724b32542e226a1 and the live production patch was already
marked verified before this benchmark.

The synthetic turns contain paragraphs, inline spans, lists, code, and tables.
Measurements cover first DOM construction/layout, a deliberately heavy global
style/layout invalidation stress workload, scroll frame gaps, and Chromium CDP
main-thread/layout/style-recalculation durations.

## Median results

| Turns | First build + layout | Stress style/layout wall time | Chromium workload task time | Chromium layout time | Recalc-style time | Scroll frame p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 147.9 → 26.4 ms (-82.1%) | 325.1 → 14.4 ms (-95.6%) | 802.6 → 563.9 ms (-29.7%) | 244.2 → 83.4 ms (-65.9%) | 76.3 → 30.0 ms (-60.7%) | 24.0 → 23.8 ms (-0.6%) |
| 150 | 259.9 → 42.7 ms (-83.6%) | 800.5 → 17.7 ms (-97.8%) | 1322.3 → 578.4 ms (-56.3%) | 614.9 → 150.2 ms (-75.6%) | 185.3 → 61.5 ms (-66.8%) | 29.1 → 21.7 ms (-25.5%) |
| 300 | 556.4 → 75.0 ms (-86.5%) | 1003.8 → 13.3 ms (-98.7%) | 1374.9 → 701.7 ms (-49.0%) | 756.4 → 232.8 ms (-69.2%) | 247.2 → 89.3 ms (-63.9%) | 25.4 → 24.9 ms (-1.9%) |

## Interpretation

- First render/layout improved consistently and increasingly with history size.
  Median build+first-layout time fell 82.1% at 50 turns, 83.6% at 150 turns,
  and 86.5% at 300 turns (about 5.6x, 6.1x, and 7.4x faster respectively).
- Browser layout work fell substantially. Chromium LayoutDuration during the
  workload fell 65.9%, 75.6%, and 69.2% at 50/150/300 turns.
- Main-thread task time also fell. The same workload used 29.7%, 56.3%, and
  49.0% less TaskDuration at 50/150/300 turns.
- The global relayout stress case improved dramatically (95.6-98.7% less
  wall time), which is expected because content-visibility:auto is specifically
  designed to skip rendering work for off-screen content. This stress result is
  not a claim that ordinary ChatGPT interactions are 20-75x faster.
- Scrolling FPS was not consistently improved. p95 frame gaps improved only
  0.6% at 50 turns, 25.5% at 150 turns, and 1.9% at 300 turns; >33 ms frame counts
  were 1→1, 2→1, and 1→2. The evidence supports a strong layout/main-thread
  speedup, not a blanket claim that every scroll frame is faster.

## What this proves

The deployed CSS materially reduces browser rendering/layout cost for long
ChatGPT-like histories on Blackbear. The effect grows as the number of old turns
grows. This verifies the mechanism we intended to improve.

It does not measure OpenAI model-generation latency, network latency, React
reconciliation inside the authenticated production app, or promise the exact
percentages above for every real conversation. No private account/chat data was
used. Raw per-run data is in benchmark-raw.json; machine-readable medians are
in benchmark-summary.json.
