# Automation model default via favourites (spec)

**Date:** 2026-07-24
**Status:** Completed — 2026-07-24. All ACs covered by code + unit/integration
tests (full `test:quiet` 15523/15523). Remaining dev-app live checks are deferred
to
[2026-07-24-automation-favourite-model-default_livetest.md](./2026-07-24-automation-favourite-model-default_livetest.md)
per the Live-Test Deferral policy.
**Implementation plan:** [2026-07-24-automation-favourite-model-default_plan_completed.md](./2026-07-24-automation-favourite-model-default_plan_completed.md)
**Requested by:** James ("maybe it should always just default to a favourite if no model is specified?")

## Problem

On 2026-07-24 the "Morning approved LinkedIn connections" automation ran on Fable 5 while its edit dialog showed "Pinned · Opus latest, 1M · High". Verified root cause, two compounding defects:

1. **Runtime fallback is invisible and wrong-by-surprise.** An automation with `provider: claude` and no `model` resolves via `resolveAutomationSpawnTarget` (`src/main/automations/automation-model-defaults.ts:54`): pinned model (absent) → `automationDefaultModel` setting (empty by default) → falls through to `defaultModelByProvider.claude`, which the interactive picker rewrites as a side effect of normal chat usage (it was `claude-fable-5`). Fable 5 draws more provider allowance than Opus, so the silent fallback was also the most expensive choice.
2. **The edit dialog lies about unpinned models.** `ModelPickerController` (`src/renderer/app/features/models/model-picker.controller.ts:92`) substitutes `defaultModelForProvider(provider)` — the first catalog model, "Opus latest, 1M" — for *display* when the stored model is empty. Display fallback and runtime fallback are two different defaults, so the dialog showed a pinned Opus that was never persisted and never used.

Interim mitigation applied 2026-07-24: all 12 existing automations were given explicit `provider` + `model` + `yoloMode: true` via `update_automation` (verified in `rlm.db`). This spec is the durable fix for automations created or edited from now on.

## Goal

When an automation has no pinned model, it should default to **the user's favourite model for its provider**, resolved **at fire time**, so:

- newly created automations without an explicit model get a sensible, user-controlled model, not a picker side-effect;
- changing/reordering favourites redirects every Auto automation from its next run without editing each one;
- the edit dialog always tells the truth about what will run.

An explicitly pinned model always wins, unchanged.

## Design

### 1. Mirror favourites into main-process settings

Favourites currently persist only in renderer localStorage (`compact-model-picker:favorites:v1`, written by `model-selection-panel.component.ts:993-1011`), which the main-process automation runner cannot read.

- Add a settings-manager key `modelPickerFavorites: string[]` (ordered `provider:modelId` keys, same shape as `DEFAULT_FAVORITE_MODEL_KEYS` in `src/renderer/app/features/models/default-favorites.ts`).
- The panel writes to BOTH localStorage (existing behaviour, keeps the picker UI unchanged) and the setting, on every ★ toggle/reorder.
- One-time migration: on first renderer boot after upgrade, if the setting is empty and localStorage has a saved list, copy it up. If neither exists, the setting stays empty and the resolver treats "no favourites" as "no opinion" (fall through to today's behaviour) — `DEFAULT_FAVORITE_MODEL_KEYS` is deliberately NOT copied into the setting, because its first Claude entry is Fable 5 and an uncustomised install should keep exactly today's fallback semantics rather than acquire a new implicit default.

### 2. Fire-time resolution order

Extend `resolveAutomationSpawnTarget` (`src/main/automations/automation-model-defaults.ts`) — resolution for an automation run becomes:

1. `action.model` pinned on the automation — always wins (unchanged).
2. `automationDefaultModel` setting — explicit user opinion, kept ahead of favourites (unchanged; note it is a single cross-provider string and remains sharp-edged — out of scope here).
3. **NEW:** first entry in `modelPickerFavorites` whose provider prefix matches the resolved provider.
4. Existing fall-through (provider default / `defaultModelByProvider`), unchanged.

Same defensive posture as the existing code: settings read failures log and fall through, never throw.

The run's `config_snapshot_json` continues to record only what is pinned; the resolved model is whatever the spawn used (observable on the instance), so snapshots stay an honest record of configuration vs. resolution.

### 3. Edit-dialog honesty

- **Auto mode:** show the fire-time resolution result as informational text, e.g. `Auto · currently Opus latest, 1M (favourite)` / `(provider default)` — computed with the same resolution order as §2 so display and runtime can never diverge again.
- **Pinned mode:** the picker must not display a model that is not persisted. Either render "Select model" when `action.model` is empty (change the `?? defaultModelForProvider(provider)` substitution in `model-picker.controller.ts` for the pending-create path), or have Save persist exactly what is displayed. Preferred: the former (display truth) plus keeping `pinModelSelection()`'s existing behaviour of immediately writing a concrete model into the form when the user flips Auto → Pinned.

### 4. Creation surfaces

`create_automation` / `update_automation` (MCP) and the UI form keep accepting an omitted model — that now means "follow favourites" and is a legitimate, documented state rather than a trap. Tool descriptions should say so.

## Non-goals

- Loop iterations (`resolveAutomationDefaultModel` in `src/main/orchestration/automation-model-defaults.ts`, backed by `loopModelByProvider`) keep their existing dedicated setting; favourites fallback there is a possible follow-up, not this change.
- No change to `automationDefaultModel` semantics.
- No reordering UI for favourites beyond what the panel already supports; list order is priority order.

## Acceptance criteria

1. Automation with `provider: claude`, no model, favourites `["claude:opus[1m]", ...]` → spawns with `opus[1m]`; after the user reorders favourites to put another Claude model first, the next run uses that model with no automation edit.
2. Automation with a pinned model ignores favourites entirely.
3. No favourites saved + no `automationDefaultModel` → behaviour identical to today (provider default).
4. Codex automation with no model and favourites containing only Claude entries → falls through to the codex default (provider-prefix match required; never hand a Claude id to codex).
5. Edit dialog in Auto mode displays the model that resolution would pick right now, labelled with its source; in Pinned mode it never displays a model that is not persisted.
6. Unit tests cover the resolver ordering (pin > automationDefaultModel > favourite > provider default), provider-prefix matching, empty/corrupt setting fall-through, and the localStorage → setting migration.

## As-built (2026-07-24)

All six acceptance criteria are implemented and verified in-loop:

- **AC1/AC2/AC3/AC4** — the shared resolver
  (`src/shared/automations/automation-model-resolution.ts`), covered by
  `automation-model-resolution.spec.ts` (ordering, prefix match, reorder,
  AC4 codex-falls-through, `openai↔codex` normalization, corrupt fall-through)
  and an end-to-end `automation-runner.spec.ts` case asserting a favourite
  reaches `createInstance.modelOverride`.
- **AC5** — the automations editor splits Auto/Pinned on **whether a model is
  pinned** (`isModelPinned = form().model.trim().length > 0`), not on the
  provider. Auto-mode preview is computed by `computeAutomationModelPreview`
  (`automation-model-preview.spec.ts`); the Pinned branch always holds a concrete
  model (`pinModelSelection()` seeds one), so the shared picker keeps its single
  substitution behaviour — no per-host display flag. `automations-page.component.spec.ts`
  covers the model-pinned split, the seeding, that a concrete-provider + empty
  automation renders as Auto (never a phantom pinned model), and that saving such
  an automation untouched preserves `provider` with the model left unpinned.
- **AC6** — resolver + migration unit coverage
  (`model-favorites.service.spec.ts`).

The favourites mirror + migration and the resolver are wired through
`ModelFavoritesService` (renderer) and `readAutomationModelDefaults` (main).
Beyond the spec, D1 (adopt the top favourite for a fully-Auto automation) was
implemented so form-created Auto automations — which have no concrete provider —
also honour favourites.

The real-UI end-to-end checks (live ★ toggle round-trip, live automation fire,
picker rendering) are deferred to the linked `_livetest.md`.
