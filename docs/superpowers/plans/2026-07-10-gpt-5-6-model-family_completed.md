# GPT-5.6 Model Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed 2026-07-10 — all 5 tasks implemented and verified. Focused specs (94 tests) and the full canonical gate (tsc, tsc-spec, lint, check:ts-max-loc, `test:quiet` 1250 files / 12,297 tests) pass. Live Codex app-server `model/list` probe via `discoverCodexModels()` returns all three IDs with canonical metadata.

**Goal:** Add GPT-5.6 Sol, Terra, and Luna to Codex catalogues and discovery, make Sol the Codex default, preserve `max` reasoning at the Codex spawn boundary, and register official pricing/capabilities.

**Architecture:** Extend the canonical shared model table so all derived static surfaces inherit the family. Enrich live `model/list` rows from that same table, widen the app-server effort type, and add explicit Codex capability-registry rows using existing fallback limits.

**Tech Stack:** TypeScript, Electron main process, shared TypeScript catalogues, Vitest.

## Global Constraints

- `gpt-5.6-sol`: powerful, `$5 / $30` per 1M input/output tokens.
- `gpt-5.6-terra`: balanced, `$2.50 / $15` per 1M input/output tokens.
- `gpt-5.6-luna`: fast, `$1 / $6` per 1M input/output tokens.
- GPT-5.6 Sol is first in `PROVIDER_MODEL_LIST.codex` and is `DEFAULT_MODELS.openai`.
- `openai-compatible`, Azure, and the GPT-5.5 Mini auxiliary fallback remain unchanged.
- Use existing Codex fallback context/output limits; do not edit generated models.dev snapshots.
- Live Codex discovery remains entitlement-authoritative and retains runnable CLI model IDs.
- `max` passes to Codex; AIO-only `workflow` is omitted.
- Do not commit or push.

---

### Task 1: Shared catalogue defaults, ordering, tiers, and pricing

**Files:**
- Modify: `src/shared/types/provider.types.spec.ts`
- Modify: `src/shared/data/model-pricing.spec.ts`
- Modify: `src/shared/types/provider.types.ts`

**Interfaces:**
- Produces: `OPENAI_MODELS.GPT56_SOL`, `OPENAI_MODELS.GPT56_TERRA`, and `OPENAI_MODELS.GPT56_LUNA` string constants.
- Produces: static Codex rows and `MODEL_PRICING` entries consumed by discovery and capability tasks.

- [x] Add failing tests asserting all three constant values, prices, Codex order, Sol primary/default, tier routing, and unchanged OpenAI-compatible/Azure defaults.
- [x] Run `npm run test:quiet -- src/shared/types/provider.types.spec.ts src/shared/data/model-pricing.spec.ts` and confirm failures are caused by missing GPT-5.6 definitions.
- [x] Add the three constants, prices, and ordered Codex rows; change only `DEFAULT_MODELS.openai` to Sol.
- [x] Re-run the focused tests and confirm they pass.

### Task 2: Live Codex discovery canonical metadata

**Files:**
- Modify: `src/main/cli/adapters/codex/model-list.spec.ts`
- Modify: `src/main/cli/adapters/codex/model-list.ts`

**Interfaces:**
- Consumes: the Task 1 static Codex entries.
- Produces: live rows whose IDs remain CLI-provided but whose matching name, tier, family, and pinning metadata come from the static catalogue.

- [x] Add a failing `model/list` test returning Sol, Terra, and Luna with slug-like display names and asserting exact canonical names/tiers/family/pinning.
- [x] Run `npm run test:quiet -- src/main/cli/adapters/codex/model-list.spec.ts` and confirm the failure is the non-canonical live display names/tiers.
- [x] Prefer `known.name` for matching IDs while retaining the discovered ID and existing fallback formatting/classification for unknown models.
- [x] Re-run the focused test and confirm it passes.

### Task 3: Codex `max` reasoning pass-through

**Files:**
- Modify: `src/main/cli/adapters/__tests__/adapter-factory-codex.spec.ts`
- Modify: `src/main/cli/adapters/codex/app-server-types.ts`
- Modify: `src/main/cli/adapters/adapter-spawn-helpers.ts`

**Interfaces:**
- Produces: `CodexReasoningEffort` including `'max'`.
- Produces: `toCodexReasoningEffort('max') === 'max'` and `toCodexReasoningEffort('workflow') === undefined`.

- [x] Add a failing factory test asserting `max` reaches `CodexCliConfig` and retain the existing `workflow` omission assertion.
- [x] Run `npm run test:quiet -- src/main/cli/adapters/__tests__/adapter-factory-codex.spec.ts` and confirm `max` is currently undefined.
- [x] Add `max` to the app-server type and change the conversion helper to filter only `workflow`.
- [x] Re-run the focused test and confirm it passes.

### Task 4: Static catalogue and runtime capability metadata

**Files:**
- Modify: `src/shared/data/models-catalog.spec.ts`
- Modify: `src/main/providers/__tests__/model-capabilities.spec.ts`
- Modify: `src/main/providers/model-capabilities.ts`

**Interfaces:**
- Consumes: Task 1 model constants and pricing.
- Produces: explicit `codex:<gpt-5.6-id>` registry entries with `CONTEXT_WINDOWS.CODEX_DEFAULT`, `CONTEXT_WINDOWS.MAX_OUTPUT_TOKENS`, and matching prices.

- [x] Add failing tests asserting derived static catalogue pricing/limits and explicit Codex capability registry pricing/limits for all three models.
- [x] Run `npm run test:quiet -- src/shared/data/models-catalog.spec.ts src/main/providers/__tests__/model-capabilities.spec.ts` and confirm the registry/static metadata is absent.
- [x] Add the three capability registry rows, using shared constants and `pricingFor`.
- [x] Re-run the focused tests and confirm they pass.

### Task 5: Integration verification and live probe

**Files:**
- No production file changes expected.
- Rename after verification: `docs/superpowers/specs/2026-07-10-gpt-5-6-model-family-design.md` to `docs/superpowers/specs/2026-07-10-gpt-5-6-model-family-design_completed.md`.

- [x] Run all changed focused specs together with `npm run test:quiet -- src/shared/types/provider.types.spec.ts src/shared/data/model-pricing.spec.ts src/main/cli/adapters/codex/model-list.spec.ts src/main/cli/adapters/__tests__/adapter-factory-codex.spec.ts src/shared/data/models-catalog.spec.ts src/main/providers/__tests__/model-capabilities.spec.ts`.
- [x] Probe the installed Codex app-server through the repository discovery function and verify the live list contains `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` with canonical metadata. If the installed CLI/account does not expose them, report the external limitation without fabricating entitlement.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Review `git diff` and `git diff --cached` to ensure user-staged changes remain intact and only the requested implementation is added.
- [x] Re-read the approved spec line by line, mark every requirement as satisfied or report the exact gap, then rename the design document `_completed` only if every requirement is verified.
