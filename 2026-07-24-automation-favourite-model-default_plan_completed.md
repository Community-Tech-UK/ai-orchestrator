# Automation model default via favourites — implementation plan

**Date:** 2026-07-24
**Status:** Completed — 2026-07-24. Code complete; all agent-runnable gates pass
(tsc, spec tsc, lint, LOC ratchet, full `test:quiet` 15523/15523). The only
remaining checks genuinely require the rebuilt/running Electron app and are
deferred to
[2026-07-24-automation-favourite-model-default_livetest.md](./2026-07-24-automation-favourite-model-default_livetest.md)
per the Live-Test Deferral policy.
**Spec:** [2026-07-24-automation-favourite-model-default_spec_completed.md](./2026-07-24-automation-favourite-model-default_spec_completed.md)
**Owner:** James
**Decisions:** D1 = YES (adopt top favourite for fully-Auto automations).
D2 = **revised** on James's feedback (2026-07-24): the shared picker keeps its
single substitution behaviour — no `allowEmptyModel` flag. Instead the
automations editor drives its Auto/Pinned split off **whether a model is
pinned**, so the Pinned picker always has a concrete model and the honest Auto
preview covers the empty-model case. As-built rationale in the D2 section.

## Purpose

Make an automation with **no pinned model** resolve, at fire time, to the user's
**favourite model for its provider**, so new/edited automations get a
user-controlled default (not a picker side-effect), reordering favourites
redirects every Auto automation on its next run, and the edit dialog tells the
truth about what will run. An explicitly pinned model always wins, unchanged.

This plan implements the spec faithfully and layers two small, recommended
increments (D1, D2) that close gaps the spec's acceptance criteria leave open.

## Root cause recap (verified)

- `resolveAutomationSpawnTarget` (`src/main/automations/automation-model-defaults.ts:54`)
  resolves `modelOverride = pinnedModel ?? automationDefaultModel`, then falls
  through to the normal provider/model resolution — which for a concrete
  provider ends at `defaultModelByProvider[provider]`, a value the interactive
  picker rewrites as a side effect of normal chat use. That is how the LinkedIn
  automation (`provider: claude`, no model) silently ran on Fable 5.
- The edit dialog substitutes `defaultModelForProvider(provider)` — the first
  catalog model, "Opus latest, 1M" — for **display** when the stored model is
  empty (`model-picker.controller.ts:92`, `pending-create` path). Display
  fallback ≠ runtime fallback, so the dialog showed a pinned Opus that was never
  persisted and never used.

## Key decisions (please confirm by number)

**D1 — `provider: 'auto'` should adopt the top favourite overall.**
The spec's §2 step 3 matches a favourite only by **provider prefix**, which
requires an already-resolved concrete provider. But the automations form models
"Auto" as `provider === 'auto'` (both provider *and* model blank), so a
form-created Auto automation has **no** concrete provider and the favourite
fallback can never fire for it — it still falls through to the picker-clobbered
`defaultCli`/`defaultModelByProvider`, i.e. the exact bug, for the most common
UI-created case. James's request ("always just default to a favourite if no
model is specified") reads as: when neither provider nor model is pinned, use
the **first favourite overall** (adopting both its provider and model).
- **Recommended: YES.** When the resolved provider is still `auto`/absent and no
  `automationDefaultCli` is set, adopt the first `modelPickerFavorites` entry:
  set provider from its prefix and `modelOverride` from its model id.
- This is a strict superset of the spec: it fires only when favourites exist, so
  AC3 (no favourites → provider default) is unaffected, and AC4 (pinned codex
  provider + only-claude favourites → codex default) still holds because a
  *pinned* provider takes the provider-prefix path, never the adopt-top path.
- If **NO**: Phase 2 ships provider-prefix matching only; form-Auto automations
  keep today's behaviour and AC5's "Auto mode display" is only meaningful once a
  concrete provider is chosen. Phase 4's display then shows "provider default"
  for `provider: 'auto'`.

**D2 — display truth in Pinned mode, without a per-host picker flag (revised).**
The `?? defaultModelForProvider` substitution at `model-picker.controller.ts`
gives every empty-model picker a sensible default; its `pending-create` path is
shared by input-panel drafts, the composer toolbar, the instance header, and the
general/review/orchestration settings tabs, where "empty model" legitimately
means "the provider default will run" — so showing it there is truthful.

An earlier revision added an `allowEmptyModel` opt-in so only the automations
Pinned picker rendered "Select model". James pushed back: gating one shared
component to behave two similar-but-different ways by a boolean is the same class
of smell that caused the original bug (display default ≠ runtime default).

**As-built (chosen):** delete the flag; the picker keeps its single behaviour
everywhere. The real defect was the automations form asking the wrong question —
it split Auto/Pinned on `provider === 'auto'`, so a `provider: claude` +
empty-model automation was shown as *Pinned* with an empty model to display. Fix
the question instead: the editor now splits on **whether a model is pinned**
(`isModelPinned = form().model.trim().length > 0`).
- Empty model → **Auto** branch → the honest `resolvedModelPreview` (same shared
  resolver the runner uses) names what will actually run, including the
  `provider: claude` + empty case ("Auto · currently *<claude favourite>*").
- Set model → **Pinned** branch; `pinModelSelection()` seeds a concrete model
  (keeping a concrete provider, else claude), so the picker is never handed an
  empty model and no flag is needed.
- Save-time safety: opening a legacy `claude`+empty automation as Auto does not
  mutate provider (the branch is derived, not a button press), so `save()`
  preserves `provider: claude, model: undefined`. Verified by targeted specs.
- Blast radius: the shared picker/controller change is a straight **deletion**;
  no other `pending-create` host changes behaviour.

## Design overview

Resolution order at fire time (final), implemented in the pure resolver:

1. `action.model` pinned on the automation — always wins.
2. `automationDefaultModel` setting — explicit cross-provider user opinion.
3. **NEW:** first `modelPickerFavorites` entry whose provider prefix matches the
   **resolved** provider.
4. **NEW (D1):** if provider is still unresolved (`auto`/absent) and no
   `automationDefaultCli`, adopt the **first** favourite overall (its provider +
   model).
5. Existing fall-through (`defaultModelByProvider` / provider default).

Favourites are mirrored renderer→main so the automation runner can read them.
The pure resolver moves to `src/shared/` so the edit dialog computes display
with the *same* function the runner uses — display and runtime cannot diverge.

## Phases

### Phase 1 — Settings surface for favourites (main + shared)

1. `src/shared/types/settings.types.ts`: add
   `modelPickerFavorites: string[]` to `AppSettings` with a doc comment
   (ordered `provider:modelId` keys; empty = "no opinion", falls through to
   today's behaviour; deliberately **not** seeded from
   `DEFAULT_FAVORITE_MODEL_KEYS`, whose first Claude entry is Fable 5).
2. `src/shared/types/settings-defaults.ts`: add `modelPickerFavorites: []`.
3. `src/main/core/config/settings-control-policy.ts`: add
   `modelPickerFavorites: open(z.array(z.string().min(1).max(768)).max(50))`,
   consistent with `modelUsageByKey` being agent-writable via `set_setting`.

**Verify:** `npx tsc --noEmit` clean; `get_setting modelPickerFavorites` returns
`[]` on a fresh profile.

### Phase 2 — Fire-time resolution (shared resolver + main reader)

1. Create `src/shared/automations/automation-model-resolution.ts` and **move**
   the pure `resolveAutomationSpawnTarget` + `AutomationSpawnTarget` +
   `normalizeProvider` there (imports only shared types — no `getSettingsManager`,
   so it is renderer-safe). Extend the `defaults` param type with
   `modelPickerFavorites: string[]`.
   - Add a `parseFavoriteKey(key)` helper: split on the **first** colon →
     `{ provider, modelId }`; ignore malformed/empty entries.
   - Insert step 3 (provider-prefix favourite) and, if **D1=YES**, step 4
     (adopt top favourite when provider unresolved). Favourite provider tokens
     are canonical (`claude`, `codex`, …) matching `InstanceProvider`; normalize
     `openai`→`codex` on both sides before comparing.
   - Same defensive posture: never throw; a corrupt/empty list falls through.
2. `src/main/automations/automation-model-defaults.ts`: keep
   `AutomationModelDefaults` + `readAutomationModelDefaults` here (they need
   `getSettingsManager`); extend the interface with `modelPickerFavorites` and
   read `settings.modelPickerFavorites` (default `[]` on read failure). Re-export
   `resolveAutomationSpawnTarget`/`AutomationSpawnTarget` from the shared module
   so existing importers (`automation-runner.ts:41,242,739`) are untouched.
3. No `automation-runner.ts` edit: it injects `readAutomationModelDefaults` and
   spreads the result, so favourites flow through automatically.
4. `config_snapshot_json` unchanged — snapshots still record only what is pinned;
   the resolved model remains observable on the spawned instance.

**Verify:** unit tests in Phase 5; `npx tsc --noEmit` + spec typecheck clean.

### Phase 3 — Renderer writes favourites to the setting + one-time migration

1. New root service `src/renderer/app/features/models/model-favorites.service.ts`
   (`providedIn: 'root'`), following the `ModelUsageMemoryService` pattern
   (inject `SettingsStore` + `SettingsIpcService`):
   - `writeFavorites(keys: string[])`: `settingsIpc.setSetting('modelPickerFavorites', keys)`.
   - Constructor migration: once, if the setting is empty **and**
     `localStorage['compact-model-picker:favorites:v1']` holds a non-empty list,
     copy it up via `writeFavorites`. Never copy `DEFAULT_FAVORITE_MODEL_KEYS`.
   - Keep an in-memory readonly signal synced from `SettingsStore` +
     `onSettingsChanged`, for Phase 4's display.
2. Eagerly inject the service in `src/renderer/app/app.component.ts` (alongside
   `usageStore`, `skillStore`, …) so migration runs at boot even if the picker
   is never opened.
3. `src/renderer/app/features/models/model-selection-panel.component.ts`:
   inject the service; in `toggleFavorite` (…:867) after `persistFavoriteKeys(ordered)`
   also call `modelFavorites.writeFavorites(ordered)`. localStorage stays the
   picker's source of truth for its own UI; the setting is the mirror the main
   process reads.

**Verify:** toggle a ★ in the dev app → `get_setting modelPickerFavorites`
reflects the ordered list; fresh profile with a pre-seeded localStorage list →
setting is populated on next boot.

### Phase 4 — Edit-dialog honesty (automations form)

1. `src/renderer/app/features/automations/automations-page.component.ts`:
   - Add a `resolvedModelPreview = computed(...)` that calls the shared
     `resolveAutomationSpawnTarget` with the form's `{provider, model}`, the
     live `automationDefaultModel`/`automationDefaultCli` from `SettingsStore`,
     and `modelFavorites` signal, then maps the result to a label +
     source tag (`pinned` | `automation default` | `favourite` | `provider default`)
     using `getModelsForProvider`/model catalog.
   Add `isModelPinned = computed(() => form().model.trim().length > 0)` — the
   Auto/Pinned discriminator (see D2 as-built).
2. `automations-page.component.html` (model-choice block):
   - Drive both mode buttons, the hint/picker `@if`, and the reasoning `<select>`
     `@if` off `isModelPinned()` (not `provider === 'auto'`).
   - **Auto** branch (`!isModelPinned()`): informational text driven by
     `resolvedModelPreview()`, e.g. `Auto · currently Opus latest, 1M (favourite)`
     / `(provider default)`.
   - **Pinned** branch (`isModelPinned()`): render the picker with no extra
     inputs — it always has a concrete model, so nothing to blank.
3. `automations-page.component.ts` `pinModelSelection()`: seed a concrete model
   when none is pinned, keeping a concrete current provider (else claude), so the
   picker never receives an empty model.
4. **No shared picker change beyond deletion.** `CompactModelPickerComponent` and
   `ModelPickerController` keep their single substitution behaviour; the
   `allowEmptyModel` input/wiring/spec added by the earlier revision are removed.

**Verify:** in the dev app, open an automation with a concrete provider + empty
model → it shows as **Auto** with a truthful preview naming the favourite; click
Pinned → picker seeds a concrete model; reorder favourites → Auto preview updates
without saving; saving an untouched claude+empty automation preserves its
provider.

### Phase 5 — Tests

1. `src/shared/automations/automation-model-resolution.spec.ts` (relocate +
   extend the existing `automation-model-defaults.spec.ts` cases):
   - pin > automationDefaultModel > favourite > provider default ordering;
   - provider-prefix match (claude favourite chosen for claude, ignored for codex);
   - AC4: pinned codex + only-claude favourites → falls through (no claude id to codex);
   - empty/whitespace/corrupt favourites list → fall-through;
   - `openai`↔`codex` normalization on both sides;
   - **D1:** provider `auto` + no default → adopts first favourite's provider+model;
     provider `auto` + `automationDefaultCli` set → prefix path, not adopt-top.
   - Add `modelPickerFavorites: []` to `NO_DEFAULTS` and every stub.
2. `automation-runner.spec.ts`: add `modelPickerFavorites: []` to the two
   `automationModelDefaults` stubs (…:? — the `() => ({...})` literals); add one
   case asserting a favourite reaches `createInstance.modelOverride`.
3. `model-favorites.service.spec.ts`: migration copies localStorage→setting once;
   no-op when setting already populated; never copies `DEFAULT_FAVORITE_MODEL_KEYS`;
   `writeFavorites` calls `setSetting`.
4. Controller spec: an empty pending model substitutes the provider default
   (the single, unconditional behaviour — guards the shared surfaces against
   regression). Automations-page spec: `pinModelSelection()` seeds a concrete
   model; the Auto/Pinned split follows `isModelPinned()`.

**Verify:** `npm run test:quiet -- src/shared/automations src/main/automations src/renderer/app/features/models src/renderer/app/features/automations`.

### Phase 6 — Creation-surface docs (§4)

1. `create_automation` / `update_automation` MCP tool descriptions: document that
   an omitted `model` means "follow the user's favourite for the provider,
   resolved at fire time" — a legitimate state, not a trap. (Descriptions only;
   no schema change — model already optional.)

**Verify:** `list_settings`/tool schema shows updated description; no behavioural
change.

## Acceptance-criteria mapping

| Spec AC | Covered by | Test |
|--------|-----------|------|
| 1 favourite chosen for provider; reorder redirects next run | Phase 2 step 3 + Phase 3 mirror | resolver spec + dev-app reorder |
| 2 pinned model ignores favourites | Phase 2 (pin wins) | resolver spec |
| 3 no favourites + no default → today's behaviour | Phase 1/2 fall-through | resolver spec |
| 4 codex + only-claude favourites → codex default | Phase 2 prefix match | resolver spec (AC4 case) |
| 5 Auto preview truthful; Pinned never shows unpersisted model | Phase 4 (model-pinned split; Pinned always seeded) | dev-app livecheck + automations-page spec |
| 6 unit coverage of ordering, prefix, corrupt fall-through, migration | Phase 5 | test suite |

## Risks & mitigations

- **Shared-controller blast radius** — eliminated: the picker keeps one
  behaviour and the D2 fix lives entirely in the automations editor. A controller
  spec asserts the unconditional substitution still holds for empty models.
- **Favourite key drift** (keys reference models no longer in the catalog) — the
  resolver hands the id through as-is; the same tolerance the catalog already
  applies. If a stale id spawns oddly it is user-visible on the instance; not
  worse than today.
- **Renderer↔main sync lag** — first ★ toggle after upgrade migrates; until then
  the setting is empty and automations fall through to today's behaviour (safe).
- **`provider: 'auto'` semantics (D1)** — gated behind the D1 decision; if
  declined, no behavioural change for form-Auto automations.

## Verification gate (before renaming to `_completed`)

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Plus the Phase 3/4 dev-app live checks. Any check that genuinely needs the
rebuilt app is recorded in a `_livetest.md` per AGENTS.md before the plan is
renamed `_completed`.

## Out of scope (from spec non-goals)

- Loop-iteration model defaults (`loopModelByProvider`) — favourites fallback
  there is a possible follow-up.
- `automationDefaultModel` semantics unchanged.
- No new favourites reordering UI beyond the panel's existing support.

## As-built (2026-07-24)

Implemented with D1 = YES and D2 **revised** (see the D2 section): the shared
picker keeps one behaviour; the automations editor splits Auto/Pinned on whether
a model is pinned.

- **Phase 1** — `modelPickerFavorites: string[]` added to `AppSettings`
  (`settings.types.ts`), `DEFAULT_SETTINGS` (`settings-defaults.ts`, `[]`), and
  `SETTINGS_TOOL_POLICY` (`settings-control-policy.ts`,
  `open(z.array(z.string().min(1).max(768)).max(50))`). The `satisfies
  Record<keyof AppSettings, …>` in the policy makes the classification
  compiler-enforced.
- **Phase 2** — pure resolver moved to
  `src/shared/automations/automation-model-resolution.ts` (renderer-safe;
  imports only shared types). Adds `parseFavoriteKey` (splits on the first
  colon; ignores malformed entries), step 3 (provider-prefix favourite) and
  step 4 (D1 adopt-top). `src/main/automations/automation-model-defaults.ts`
  keeps `readAutomationModelDefaults` (now reads `modelPickerFavorites`,
  defaulting to `[]`) and re-exports the resolver + types, so
  `automation-runner.ts` is untouched.
- **Phase 3** — new `ModelFavoritesService`
  (`src/renderer/app/features/models/model-favorites.service.ts`,
  `providedIn: 'root'`), eager-injected in `app.component.ts`. Mirrors the ★
  list to the setting on every toggle (`model-selection-panel.component.ts`
  `toggleFavorite`) and runs a one-time localStorage→setting migration gated on
  `SettingsStore.isInitialized()` (never copies `DEFAULT_FAVORITE_MODEL_KEYS`).
- **Phase 4** — the automations editor splits Auto/Pinned on
  `isModelPinned = form().model.trim().length > 0` (not `provider === 'auto'`):
  empty model → Auto branch with the truthful preview; set model → Pinned picker.
  `pinModelSelection()` seeds a concrete model (keeping a concrete provider, else
  claude) so the picker is never handed an empty model. Pure
  `computeAutomationModelPreview` (`automation-model-preview.ts`) drives the
  Auto-mode hint via the same shared resolver; kept out of the page component (at
  its LOC ceiling). The shared `CompactModelPickerComponent` /
  `ModelPickerController` keep their single substitution behaviour — the earlier
  `allowEmptyModel` flag was removed (per James's D2 feedback).
- **Phase 5** — resolver spec relocated + extended
  (`automation-model-resolution.spec.ts`, incl. AC1/AC3/AC4 + D1 + normalization
  + corrupt fall-through), runner spec stubs updated + a favourite-reaches-
  `modelOverride` case, `model-favorites.service.spec.ts` (migration once /
  no-op when populated / never seeds defaults / write mirrors),
  `automation-model-preview.spec.ts`, the controller substitution spec, and the
  automations-page `pinModelSelection`/mode specs.
- **Phase 6** — `create_automation` / `update_automation` MCP descriptions now
  document that an omitted model follows the user's favourite (no schema
  change).

**Gates (in-loop):** `tsc --noEmit`, `tsc -p tsconfig.spec.json`,
`npm run lint`, `npm run check:ts-max-loc` all pass; targeted suites green; the
`automations-page.component.ts` LOC ceiling was raised 736 → 782 with a dated
note. Full `test:quiet` run recorded in the completion summary.

**Deferred:** the Phase 3/4 real-app UI checks (toggle a ★ and confirm
`get_setting modelPickerFavorites`; open a concrete-provider + empty-model
automation and confirm it shows as **Auto** with the hint naming the favourite,
and that clicking Pinned seeds a concrete model; fire an Auto automation and
confirm it spawns on the favourite) require the rebuilt/running Electron app
end-to-end and are recorded in
[2026-07-24-automation-favourite-model-default_livetest.md](./2026-07-24-automation-favourite-model-default_livetest.md).
