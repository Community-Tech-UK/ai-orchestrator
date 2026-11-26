# Implementation Plan — Periodic models.dev Refresh

**Status:** COMPLETED 2026-07-18 (one live check deferred — see livetest doc)
**Date:** 2026-07-18
**Spec:** [2026-07-18-model-catalog-periodic-refresh_spec_completed.md](./2026-07-18-model-catalog-periodic-refresh_spec_completed.md)
**Live test:** [2026-07-18-model-catalog-periodic-refresh_livetest.md](./2026-07-18-model-catalog-periodic-refresh_livetest.md)
**Decisions:** A = 6h interval · B = regenerate snapshot (in scope) · C = curation deferred

## As-built summary

All tasks implemented and verified in-loop. Gates: `tsc` (electron + spec), `ng lint`,
`check:ts-max-loc` all pass; full suite **15018 tests passed** (exit 0); targeted
`models-dev-service.spec.ts` **12/12**.

- **Task 1** — `start()`/`stop()` added to `ModelsDevService`
  (`src/main/providers/models-dev-service.ts`): immediate unforced refresh + `setInterval`
  (default 6h `DEFAULT_TTL_MS`), `unref`'d, idempotent, force-on-tick. `stop()` clears the
  timer; `_resetModelsDevServiceForTesting()` now stops it to avoid interval leaks.
- **Task 2** — `'Model pricing sync'` bootstrap module (`infrastructure-bootstrap.ts`)
  calls `modelsDev.start()` on init and `getModelsDevService().stop()` on teardown. The
  one-shot `refresh()` in `unified-model-catalog-initialization.ts:123` was left as-is
  (idempotent, TTL/in-flight-coalesced; `start()` idempotency guarantees one interval).
- **Task 3** — 3 new specs (immediate+periodic forced refresh; idempotency; stop halts).
- **Task 4** — `npm run sync:model-catalog` regenerated `models-dev-snapshot.generated.ts`;
  now includes `claude-sonnet-5` (input 2 / output 10, 1M context) and prunes models
  models.dev retired. No picker regression: static `PROVIDER_MODEL_LIST` + `MODEL_PRICING`
  remain the floor/fallback for any pruned id (e.g. Sonnet 4 / Opus 4).

---

## Goal

Make Claude (and every provider fed by models.dev) pick up newly-published models on a
running instance without a restart, by adding a periodic refresh to `ModelsDevService`,
and refresh the committed offline snapshot so Sonnet 5 is known offline too.

Root cause and full evidence are in the spec. Summary: `ModelsDevService.refresh()` is
startup-only; there is no `setInterval` re-fetching it, so a long-running app never sees
models published after launch.

---

## Task 1 — `start()`/`stop()` on `ModelsDevService`  (CORE)

**File:** `src/main/providers/models-dev-service.ts`

- Add a private `timer: ReturnType<typeof setInterval> | null = null`.
- Add `start(intervalMs = DEFAULT_TTL_MS): void`:
  - Idempotent: if `this.timer !== null`, return.
  - Fire an immediate `void this.refresh()` (TTL-guarded; coalesces with any other
    startup refresh via the existing in-flight guard).
  - `this.timer = setInterval(() => { void this.refresh(true); }, intervalMs)` — **force**
    on the tick so cadence is governed solely by the interval and a jittered tick landing
    a hair inside the TTL window is never silently skipped. The in-flight guard still
    prevents overlap.
  - `this.timer.unref?.()` so the interval never keeps the process alive (mirrors
    `codex-cli-discovery-service.ts:43`).
- Add `stop(): void`: clear + null the timer (mirror codex service `:46-51`).
- Reuse the existing `DEFAULT_TTL_MS` (already `6 * 60 * 60 * 1000`) as the default.

**Why force-on-tick:** `refresh()`'s TTL check is `now - lastFetchedAt < ttlMs`. With
interval == TTL, timer jitter can make an unforced tick return early and wait another full
interval. Forcing on the scheduled tick makes the interval the single source of cadence;
startup's immediate call stays unforced so it still coalesces with the other startup
callers and respects a warm TTL.

## Task 2 — Own the lifecycle in the bootstrap module

**File:** `src/main/bootstrap/infrastructure-bootstrap.ts` (`'Model pricing sync'` module,
~lines 67-82)

- `init`: keep `modelsDev.loadOfflineSnapshot()`, then replace
  `void modelsDev.refresh()` with `modelsDev.start()`.
- Add `teardown: () => { getModelsDevService().stop(); }` (module currently has no
  teardown). Use the same lazy `require` shape already used in `init`.

The startup `refresh()` in `unified-model-catalog-initialization.ts:123` is left as-is: it
is idempotent (TTL/in-flight-coalesced) and harmless, and that file's injected
`modelsDevService` test interface only needs `loadOfflineSnapshot`/`refresh`. `start()`
being idempotent means only one interval is ever created regardless of call order.

## Task 3 — Tests

**File:** `src/main/providers/models-dev-service.spec.ts`

Add a `describe('ModelsDevService.start/stop')` block using `vi.useFakeTimers()`:
- `start()` triggers an immediate refresh (spy on `refresh`), then one refresh per
  `intervalMs` advanced.
- Periodic ticks call `refresh(true)` (force) — assert the force arg.
- `start()` is idempotent (second call creates no second interval — advancing time still
  yields one refresh per interval).
- `stop()` clears the interval (no further refreshes after advancing time).
- Timer is `unref`'d (assert `unref` called, or that the test process is not held open —
  spy on the returned timer's `unref`).

Keep network out of it: inject/stub so `refresh` does not actually hit https (spy on the
instance method, or stub `fetchApiJson`). Follow the existing spec's no-network style.

## Task 4 — Regenerate the offline snapshot  (decision B)

- Run `npm run sync:model-catalog`.
- Confirm the regenerated `models-dev-snapshot.generated.ts` now includes
  `claude-sonnet-5` (and other current anthropic ids).
- Sanity-check the diff is snapshot-data-only (generated file), no unexpected churn.

---

## Verification (canonical gate)

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet -- src/main/providers/models-dev-service.spec.ts   # targeted first
npm run test:quiet                                                    # full gate
```

## Live test (deferred)

Moved to [2026-07-18-model-catalog-periodic-refresh_livetest.md](./2026-07-18-model-catalog-periodic-refresh_livetest.md):
confirm in the built, running app that Sonnet 5 appears and that a refresh cycle updates
the picker with no restart. Needs a rebuilt app, so it cannot run in-loop.

## Risks / notes

- Force-on-tick means one guaranteed network fetch every 6h. Intended; fail-soft (never
  throws), 6s timeout, ≤16 MB cap already enforced in `fetchApiJson`.
- No change to pricing/context-window overlay or catalog merge logic.
- Item 3 (curate discovered Claude entries into Sonnet/Opus/Haiku groups) is **deferred**
  per decision C; discovered Sonnet 5 will show with a humanised label until then.
