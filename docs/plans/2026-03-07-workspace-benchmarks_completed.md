# Workspace Performance Benchmarks

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** `StressFixturesService`, `PerfInstrumentationService` and `WorkspaceBenchService` (`__workspaceBench`) exist and the 2026-03-07 baseline below was captured. Nothing further to build.


**Date:** 2026-03-07
**Status:** Renderer harness baseline captured; Electron confirmation still recommended

---

## Purpose

This document tracks performance baselines and targets for the operator workspace redesign. All metrics should be measured in the actual Electron app, not in isolation.

## Target Budgets

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Thread switch to usable workspace | < 120ms (p95) | `PerfInstrumentationService.getSummary('thread-switch')` |
| Time to first visible transcript paint | < 200ms (p95) | `PerfInstrumentationService.getSummary('transcript-paint')` |
| Sustained scroll on large transcripts | No obvious jank (< 16ms/frame) | `PerfInstrumentationService.getSummary('scroll-frame')` |
| Composer latency during streaming | < 16ms | `PerfInstrumentationService.getSummary('composer-latency')` |
| Markdown render time | < 5ms per block | `PerfInstrumentationService.getSummary('markdown-render')` |
| Display items compute | < 10ms | `PerfInstrumentationService.getSummary('display-items-compute')` |

## Stress Fixtures

Available via `StressFixturesService.getPresets()`:

| Preset | Messages | Focus |
|--------|----------|-------|
| light | 50 | General mixed content |
| medium | 200 | Code blocks + tool calls |
| heavy-markdown | 500 | Long markdown, tables, code |
| heavy-tools | 500 | Mostly tool use/result pairs |
| extreme | 2000 | Everything combined |

## How to Run Benchmarks

### Enable instrumentation
In the app dev console:
```javascript
window.__perfService?.enable();
```

### Browser benchmark mode
For renderer-only profiling in the browser, open:
```text
http://localhost:4567/?bench=1
```

This enables a synthetic CLI fallback so the workspace shell mounts without Electron-backed CLI detection.

### Load a synthetic workspace preset
```javascript
await window.__workspaceBench?.loadPreset('heavy-markdown');
```

### Run the full baseline harness
```javascript
await window.__workspaceBench?.runWorkspaceBaseline('heavy-markdown', 12);
```

### View results
```javascript
window.__perfService?.printSummary();
window.__perfService?.checkBudgets();
```

### Export for comparison
```javascript
copy(window.__perfService?.exportJSON());
```

## Baseline Results

### Renderer harness baseline (`http://localhost:4567/?bench=1`)

Captured on 2026-03-07 using:
- Angular dev server
- Playwright-driven browser session
- `window.__workspaceBench.runWorkspaceBaseline('heavy-markdown', 12)`

Artifact:
- [`2026-03-07-workspace-benchmark-baseline.browser.json`](/Users/suas/work/orchestrat0r/claude-orchestrator/docs/plans/2026-03-07-workspace-benchmark-baseline.browser.json)

| Metric | Count | P50 | P95 | P99 | Notes |
|--------|-------|-----|-----|-----|-------|
| thread-switch | 25 | 102.6ms | 488.2ms | 523.7ms | Over budget in browser harness |
| transcript-paint | 25 | 102.3ms | 484.4ms | 523.5ms | Over budget in browser harness |
| scroll-frame | 48 | 78.7ms | 524.9ms | 537.2ms | Captured during synthetic thread switching |
| composer-latency | n/a | n/a | n/a | n/a | Harness does not simulate typing |
| markdown-render | 175 | 0.6ms | 6.7ms | 13.0ms | Slightly above 5ms target at p95 |
| display-items-compute | 25 | 0.1ms | 56.4ms | 245.7ms | Hot path still spikes on heavy switches |

### Electron confirmation run

Still recommended before closing F1 completely. The renderer harness gives a checked-in baseline and reproducible script, but the final acceptance pass should be repeated in the actual Electron shell using the same `window.__workspaceBench` API.

## Known Hot Paths

Identified from code review (to be confirmed with measurements):

1. **`OutputStreamComponent.displayItems` computed** — 4-pass processing over all messages on every change (instrumented with perf timing)
2. **`renderMarkdown()` calls** — synchronous marked + hljs + DOMPurify per message, LRU cache added (200 entries, 50K max)
3. ~~**`track $index`** in output-stream~~ — **Fixed (F4):** now uses stable `track item.id` with message-derived IDs
4. **Instance state signal updates** — `new Map()` copies on every state update (correct for signal immutability)
5. ~~**Scroll position management** — `setTimeout(0)` based~~ — **Fixed (F5):** now uses `requestAnimationFrame` with passive scroll listener

## Architecture Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Use Performance API marks/measures | Native browser API, zero overhead when disabled |
| 2026-03-07 | Bounded ring buffer (500 entries) | Prevents memory growth during long sessions |
| 2026-03-07 | Runtime toggle for instrumentation | No build-time cost, enable only when profiling |
