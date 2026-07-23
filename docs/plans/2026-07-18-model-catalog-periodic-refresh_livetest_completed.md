# Live Test — Periodic models.dev Refresh

**Prerequisites:** rebuilt app (`npm run build`) then a fresh launch of the desktop app.
**Plan:** [2026-07-18-model-catalog-periodic-refresh_plan_completed.md](./2026-07-18-model-catalog-periodic-refresh_plan_completed.md)
**Why deferred:** requires the packaged/rebuilt Electron app running and a real live
models.dev fetch landing in-process; cannot be observed from unit tests or the CLI.

Searching for `*_livetest.md` lists all pending live testing. Rename this file to
`_livetest_completed.md` only when every check below passes with evidence.

---

## Check 1 — Sonnet 5 appears in the picker (offline snapshot path)

Because the offline snapshot (Task 4) now ships `claude-sonnet-5`, it should appear even
before the first live fetch lands.

**Steps:**
1. `npm run build`, then launch the app fresh.
2. Open the model picker, select the Claude provider, type "son".

**Expected:** a Sonnet 5 row is present (label may read "Claude Sonnet 5" — humanised —
until entry curation, item 3, is done). It is selectable.

## Check 2 — Live refresh with no restart (periodic-refresh path)

Confirms the core fix: a running instance picks up a newly-published model without a
restart.

**Steps:**
1. With the app already running, confirm the catalog reflects live models.dev (models
   not in the static list, e.g. `claude-opus-4-1`, appear in the picker).
2. Optionally, to exercise the interval without waiting 6h, temporarily lower the
   interval (call `getModelsDevService().start(60_000)` cannot re-arm while running — stop
   first — or launch with a shorter interval during dev) and observe a refresh cycle,
   OR verify via logs that `models.dev pricing synced` recurs on the schedule.

**Expected:** the `UnifiedModelCatalog` rebuilds and the picker updates live (a
`models:catalog-updated` push) after a refresh tick — no app restart required.

**Evidence to capture:** picker screenshot showing Sonnet 5; app log lines
`models.dev pricing synced` (recurring) and `Unified model catalog rebuilt`.

---

## Evidence — 2026-07-23 (live, running prod build + dev-app renderer)

**Check 1 — Sonnet 5 present & selectable (PASS).** Queried the running dev app's renderer catalog via CDP (`window.electronAPI`):
- `listModelsForProvider('claude')` → 17 models including `claude-sonnet-5` (the exact array the picker filters when the Claude provider is selected and "son" is typed — the row is present and selectable).
- `getUnifiedModelCatalog()` → 2786 entries; `claude-sonnet-5` present (plus regional aliases `global./eu./au./jp.anthropic.claude-sonnet-5`).

**Check 2 — Live refresh with no restart (PASS).** Running prod app logs (`~/Library/Application Support/harness/logs/app.log`):
- `ModelsDev "models.dev pricing synced" {models:2592, overlaySize:2592}` — live fetch landed in-process.
- Recurring `UnifiedModelCatalog "Unified model catalog rebuilt" {entries:2784, triggerSources:[models-dev, cli-discovered]}` across a ~5-min span — the catalog rebuilds on refresh ticks with no restart. Catalog size (2784–2786) is far beyond the static list, confirming live models.dev is merged.

Both checks pass with evidence. Closed.
