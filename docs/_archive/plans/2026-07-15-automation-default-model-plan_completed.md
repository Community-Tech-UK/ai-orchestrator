# Automation Default Model — Plan

**Status:** implemented + agent-gates verified; one live UI validation deferred to the
`_livetest.md` beside this file. Untracked, not committed.
**Date:** 2026-07-15
**Owner:** James

## Problem

Automations whose Model is set to **Auto** silently inherit `defaultModelByProvider[provider]`
— the renderer's *last-used model per provider* — via `resolveInitialModel`
(`src/main/instance/lifecycle/resolve-initial-model.ts:30`). That map is rewritten every
time an interactive session picks a model, so when a Claude chat last used **Fable 5**,
every Auto automation spawns Fable.

Evidence (`~/Library/Application Support/harness/logs/app.log`):

```
"Resolved model for instance": { perProviderRemembered: "claude-fable-5",
                                  settingsDefault: "opus", resolved: "claude-fable-5" }   ← no configOverride ⇒ Auto
```

The existing General-Settings "Default provider and model" control does **not** fix this:
it persists to the same `defaultCli` / `defaultModel` / `defaultModelByProvider` keys that
interactive usage clobbers (`general-settings-tab.component.ts:141`).

## Decision

Add a **dedicated, stable automation default** (provider + model) in Settings that interactive
usage never touches. Auto automations resolve to it; Pinned automations keep their own model.
UI reuses the same `CompactModelPickerComponent` (pending-create mode) as a new session.

Precedence for an automation run:

**Pinned (per automation) → Automation default (settings) → last-used-per-provider model (today's leaky behaviour) → legacy global `defaultModel` → CLI built-in default**

Empty setting ⇒ unchanged behaviour (backwards compatible). Note the fallback is NOT the
provider's built-in default — it is `defaultModelByProvider[provider]` (the interactive
last-used model), which is exactly the leak this feature guards against once a default is set.

### As-built notes (verified 2026-07-15)
- **Provider-agnostic.** The drift and the fix apply to every provider, not just Claude:
  `provider-state.service.ts:136-150` writes `defaultModelByProvider[provider] = model` for
  whatever provider is selected, and `resolveInitialModel` reads `[resolvedCliType]`. Injecting
  the default as `configModelOverride` (top of the chain) covers all providers.
- **No migration needed.** DB check (`rlm.db`, read-only) shows no automation pinned to a fable
  model; the two Auto automations store no model (resolved per-run), so setting the default
  applies immediately. Pinned automations keep their explicit model by design.

## Changes

### 1. Settings keys (new, dedicated)
- `src/shared/types/settings.types.ts` — add to `AppSettings`:
  - `automationDefaultCli: CliType` (provider; `'auto'` = no override)
  - `automationDefaultModel: string` (model id; `''` = no override)
- `src/shared/types/settings-defaults.ts` — `automationDefaultCli: 'auto'`, `automationDefaultModel: ''`.
- `src/main/core/config/settings-control-policy.ts` — `open(cliSchema)` / `open(modelIdSchema)`.

### 2. Runner injection
- `src/main/automations/automation-runner.ts` — add a private helper
  `resolveSpawnTarget(action)` that reads `getSettingsManager().getAll()` and returns
  `{ provider, modelOverride }`:
  - `modelOverride`: `action.model` if set, else `automationDefaultModel || undefined`.
  - `provider`: `action.provider` if set & not `'auto'`, else
    (`automationDefaultCli !== 'auto' ? automationDefaultCli : action.provider`).
  - Only substitutes when the automation left the field on Auto — Pinned wins.
- Apply in **both** `createInstance` sites: first attempt (~line 212) and retry (~line 655).
- Because `modelOverride` lands as `configModelOverride` (highest precedence in
  `resolveInitialModel`), it beats the polluted `defaultModelByProvider`.

### 3. Settings UI
- `src/renderer/app/features/settings/general-settings-tab.component.ts` — new
  "Default automation model" section beneath the existing default-model card. Reuse
  `CompactModelPickerComponent` with Auto|Pin, persist to `automationDefaultCli` /
  `automationDefaultModel` (dedicated keys; NOT `defaultModelByProvider`).

### 4. Helper-text fix
- `src/renderer/app/features/automations/automations-page.component.html` — replace
  "The orchestrator picks the provider and model for each run." with text that reflects
  reality: Auto uses the default automation model from Settings, or the provider default if unset.

### 5. Tests
- Runner spec: Auto automation + configured default ⇒ createInstance called with default
  provider/model; Pinned automation ⇒ unchanged; empty default ⇒ unchanged.
- Settings-control-policy exhaustiveness spec (if it enumerates keys) updated.
- General-settings tab spec: picker persists to the new keys.

## Verification
Agent-runnable gates — all passing as of 2026-07-15:
- `npx tsc --noEmit` + `-p tsconfig.spec.json` — clean
- `npm run lint` — clean
- `npm run check:ts-max-loc` — passing
- `npm run test:quiet -- automation-model-defaults automation-runner general-settings-tab settings-control-policy`
  — includes: 6 resolver unit tests, first-attempt + retry runner injection tests, 3 UI-persistence
  tests (pin / picker-change persists only dedicated keys / Auto clears both).

The remaining live UI validation requires a rebuilt/restarted app and is recorded in
`2026-07-15-automation-default-model-plan_livetest.md`.
