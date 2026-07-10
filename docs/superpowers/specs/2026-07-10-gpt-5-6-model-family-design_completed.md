# GPT-5.6 Model Family Integration

**Date:** 2026-07-10
**Status:** Completed 2026-07-10 — all requirements implemented, tested, and live-probed (see Completion below).

## Completion (2026-07-10)

- Constants `gpt-5.6-{sol,terra,luna}`, official pricing (`$5/$30`, `$2.50/$15`, `$1/$6`), Sol first in `PROVIDER_MODEL_LIST.codex`, and `DEFAULT_MODELS.openai = Sol` are in `src/shared/types/provider.types.ts`. `openai-compatible`, Azure, and the GPT-5.5 Mini auxiliary fallback are unchanged.
- Live discovery prefers the static `known.name`/tier/family/pinning while retaining the CLI model ID (`src/main/cli/adapters/codex/model-list.ts`).
- Codex `max` reasoning passes through the spawn boundary; AIO-only `workflow` is still dropped (`src/main/cli/adapters/codex/app-server-types.ts`, `adapter-spawn-helpers.ts`).
- Capability registry rows for all three IDs use existing Codex fallback limits and `pricingFor` (`src/main/providers/model-capabilities.ts`).
- Focused specs pass (94 tests across the six spec files). Canonical gates pass: `tsc --noEmit`, `tsc --noEmit -p tsconfig.spec.json`, `lint`, `check:ts-max-loc`, and the full `test:quiet` suite (1250 files / 12,297 tests).
- **Live probe:** the installed Codex app-server `model/list`, invoked through the repository `discoverCodexModels()` discovery function, returns `gpt-5.6-sol` (name "GPT-5.6 Sol", powerful, pinned), `gpt-5.6-terra` ("GPT-5.6 Terra", balanced), and `gpt-5.6-luna` ("GPT-5.6 Luna", fast) with canonical enrichment — real entitlement confirmed, not fabricated.

## Goal

Add the full GPT-5.6 preview family to AIO and make GPT-5.6 Sol the default Codex model. The integration must work through both the static fallback catalog and live Codex app-server discovery.

## Model Definitions

| Display name | Model ID | AIO tier | Static price per 1M input/output tokens |
| --- | --- | --- | --- |
| GPT-5.6 Sol | `gpt-5.6-sol` | powerful | $5 / $30 |
| GPT-5.6 Terra | `gpt-5.6-terra` | balanced | $2.50 / $15 |
| GPT-5.6 Luna | `gpt-5.6-luna` | fast | $1 / $6 |

These IDs and prices come from OpenAI's GPT-5.6 preview documentation. AIO will not invent model-specific context-window or output-limit values that OpenAI has not published on the developer model pages. Existing Codex fallback limits remain in effect until live or models.dev metadata supplies more precise values.

## Default Behaviour

- Put GPT-5.6 Sol first in `PROVIDER_MODEL_LIST.codex`, making it the primary model returned by `getPrimaryModelForProvider('codex')`.
- Change the OpenAI/Codex orchestration default in `DEFAULT_MODELS.openai` to GPT-5.6 Sol.
- Leave OpenAI-compatible and Azure defaults on GPT-5.5 because those endpoints do not imply GPT-5.6 preview access.
- Preserve existing per-provider remembered selections. A user who explicitly selected GPT-5.5 remains on GPT-5.5 until they change it.
- Leave the GPT-5.5 Mini auxiliary/RLM fallback unchanged; this task changes the primary Codex default, not low-cost background model policy.

## Catalogue and Discovery

Add typed constants and static entries for Sol, Terra, and Luna. Their order and tiers make generic tier routing resolve `powerful` to Sol, `balanced` to Terra, and `fast` to Luna.

The installed Codex CLI already returns all three models from `model/list`, but without static metadata AIO currently classifies Sol and Luna incorrectly and formats their names with an extra hyphen. Live discovery will prefer the matching static display name, tier, family, and pinning metadata while retaining the CLI's runnable model ID and availability list.

When live Codex discovery succeeds, the unified catalogue continues to replace static fallback rows with the CLI-reported rows. This means entitlement remains provider-controlled: AIO enriches models the CLI exposes and uses the static family only when discovery is unavailable.

## Reasoning Support

GPT-5.6 introduces a `max` reasoning effort. AIO's shared schemas and picker already accept `max`, but the Codex adapter currently drops it at the spawn boundary. Extend the Codex app-server reasoning type and conversion helper so `max` is passed through. Continue dropping the AIO-only `workflow` value because it is not a Codex app-server reasoning effort.

## Pricing and Capabilities

Register the official prices in `MODEL_PRICING` so usage and cost tracking can price all three IDs. Add the family to the capability registry using AIO's existing Codex fallback limits and pricing lookup. Do not change historical GPT-5.5 prices or generated models.dev snapshots as part of this request.

## Error Handling and Compatibility

- Unknown or unavailable model errors remain handled by the existing Codex execution error classifier.
- Existing GPT-5.5 and older model IDs remain selectable.
- No persistence schema, IPC schema, preload bridge, or renderer component change is required; those surfaces derive their model rows from the shared and unified catalogues.
- No account entitlement is assumed. The live CLI list remains authoritative when available.

## Test Strategy

Use test-driven development:

1. Add failing shared-catalog tests for the constants, official prices, Sol default, model order, and tier routing.
2. Add failing Codex discovery tests proving live Sol/Terra/Luna rows receive canonical names and tiers.
3. Add a failing spawn-helper test proving `max` passes through while `workflow` is still omitted.
4. Add failing capability/catalog tests for GPT-5.6 pricing metadata.
5. Implement the smallest production changes needed to make those tests pass.
6. Probe the installed Codex app-server to confirm the real model IDs still resolve through AIO's discovery path.
7. Run targeted tests, then the canonical project gates: both TypeScript checks, lint, max-LOC check, and the full quiet test suite.

## Out of Scope

- Making GPT-5.6 the default for Azure or arbitrary OpenAI-compatible endpoints.
- Replacing low-cost auxiliary defaults with GPT-5.6 Luna.
- Adding or emulating Codex `ultra` multi-agent mode.
- Editing generated models.dev snapshots before upstream models.dev publishes the family.
- Committing or pushing changes.
