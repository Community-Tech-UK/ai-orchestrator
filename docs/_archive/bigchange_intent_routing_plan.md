# Routing Coverage & Tool-Subsetting Plan

> **Status:** Draft for review (NOT approved; do not commit per AGENTS.md until implemented & verified, then rename `_completed`).
> **Origin:** Assessment of the "SingleLLM Agent" article (vivekmind.com). A first draft of this plan was wrong — it claimed cost-tiered model routing was missing. A fresh-eyes code review proved that false. This is the corrected plan.
> **Date:** 2026-05-30

## What Already Exists (verified — do NOT rebuild)

A complete, shipped, cost-tiered model router is already in the codebase and **on by default**:

- `src/main/routing/model-router.ts` — `ModelRouter`: keyword complexity analysis (`complexKeywords`/`simpleKeywords`), `TaskComplexity` (`simple|moderate|complex`), `ModelTier` (`fast|balanced|powerful`), `route(task, explicitModel)` → `RoutingDecision { model, complexity, tier, confidence, reason }`, `calculateSavings()`. `DEFAULT_ROUTING_CONFIG.enabled = true` (line 48). Singleton via `getModelRouter()` (line 509).
- **Wired into the child/agent spawn path:** `instance/instance-orchestration.ts:653 routeChildModel()` → `computeRoutingDecision()` (`:712`), handling explicit-model passthrough, explicit tier names, agent overrides, outcome-learning recommendations, user-preference store, and **cross-provider** tier mapping via `resolveModelForTier(tier, provider)` (`shared/types/provider.types.ts:639`).
- **IPC + UI:** `ipc/handlers/routing-handlers.ts` (config get/update/route), renderer `features/routing/routing-explanation.component.ts`.

Also already present and equivalent to the article's other ideas (out of scope — verify only, do not rebuild):

| Article idea | AIO implementation |
|---|---|
| Retryable vs non-retryable retry | `core/failover-error.ts` `RETRYABLE_REASONS`; `error-recovery.ts` `retryWithBackoff` |
| Token budget + trimming | `context/context-compactor.ts` (microcompact→collapse→prune→summarize); PTL retry |
| Tool-result dedup | `instance/instance-communication.ts` `seenToolResultIds` |
| Error reinjection | `orchestration/orchestration-handler.ts` `injectResponse` |
| Streaming→non-streaming fallback | cursor adapter; `llm-service.ts` |
| Provider-notice guard | `cli/provider-notice.ts` `isProviderNotice` |

### Architectural premise (verified TRUE)
The per-agent inner ReAct loop and tool-schema injection run **inside the provider CLI subprocess** (`cli/adapters/claude-cli-adapter.ts:727 buildArgs` → `--print --input-format stream-json`, tools passed only as comma-joined **names** via `--allowedTools` `:784,822`). `orchestration/loop-coordinator.ts` is a higher-level coordinator; one iteration = one CLI invocation. ⇒ The article's headline win (per-turn tool-schema token reduction) is largely **not ours to capture**; we only control the tool *name list*. This justifies gating tool-subsetting (Phase 3) behind measurement.

---

## The Actual Gaps (what this plan fixes)

The existing router covers **child/agent instance spawns**. It does **NOT** cover other model-selection sites, which each pick models independently. **Crucially, most of these are NOT a routing gap to "fix" — they intentionally use the strong default and must keep doing so.** The only genuine target is Loop Mode / workflow.

1. **Orchestration-invoker path** — `orchestration/default-invokers.ts:348` `invokeCliTextResponse` uses `resolveDefaultModel(cliType, payloadModel)` → `getDefaultModelForCli(cliType)` and **never consults the router**. This *one function* serves many distinct flows that must NOT be treated alike:
   - **Loop Mode** (call site `:1638`, passes real `prompt`, `payloadModel: undefined`) — the **only** intended routing target.
   - **Verify** (`:511`), **review** (`:560`), **debate** (`:632`), **workflow** (`:714`) — these pass `'default'`/unset deliberately to get Opus. **Do not route these.**
   - Persistent same-session loop adapter (`:812`, created at `:1617`) — see Phase 2 constraint: model is baked at adapter creation; **no per-call prompt exists there**, so per-iteration routing is impossible without a deeper refactor.
2. **Consensus** — `orchestration/consensus-coordinator.ts` is a **fully separate path** (creates its own adapter at `:235/:241`, never calls `invokeCliTextResponse`). Auto-fan-out builds specs with undefined model (`:461`). Routing consensus votes to cheap tiers would **defeat the "diverse strong models" purpose** — high risk. Separate, explicitly-scoped item; default: do not route.
3. **Auto-title** — `instance/auto-title-service.ts:257` calls `resolveModelForTier('fast', cliType)` directly (already tier-aware; bypasses router config/learning — cosmetic only, lowest priority).

Secondary correctness issue surfaced in review (optional to fix): `resolveModelForTier` returns the **first list entry** for a tier (ordered for capacity, `provider.types.ts:376–383`), **not the cheapest**; and `providers/model-capabilities.ts` `KNOWN_MODELS` is keyed by generic aliases (`claude:opus`), not the pinned IDs in `PROVIDER_MODEL_LIST` (`opus-4.7`, `_1M` variants). So any "cheapest-meeting-floor" logic is **new data-wiring**, not free.

---

## Guiding Principles (corrected)
- **Reuse, don't fork.** Extend the existing `routing/ModelRouter` + `RoutingDecision` + `ModelRoutingConfig`. Do **not** create `orchestration/model-router.ts`, a second `TaskClassification` taxonomy, or a competing enable/disable flag.
- **One routing brain.** Extract the cross-provider resolution logic so the invoker path and the spawn path share one implementation.
- **`'default'` means "strong house model", NOT "no preference".** Verified: unset/`'default'` → `getDefaultModelForCli('claude')` = `CLAUDE_MODELS.OPUS_1M` (`provider.types.ts:252`) — the *powerful* tier. Verification, review, and consensus deliberately pass `'default'` to get the strong model. Routing must **never** reinterpret `'default'` as routable on shared paths.
- **Routing on shared invoker paths is OPT-IN per call-site, never blanket.** Only Loop Mode / workflow opt in. Verify/review/debate/consensus keep `resolveDefaultModel` (Opus) behavior untouched. (See Phase 2 — this is the load-bearing safety constraint.)
- **Honor the existing `enabled` config** (`DEFAULT_ROUTING_CONFIG.enabled = true`); do not invent a parallel toggle. New coverage is governed by the same `ModelRoutingConfig`, plus the per-call-site opt-in flag.

---

## Phase 0 — Spike & baseline (½ day, no production code)

- [ ] **Baseline the existing router first** so we don't double-count savings: capture current routing decisions/savings on a few real child-spawn runs via the existing `calculateSavings()` / routing IPC.
- [ ] **Uncovered-path impact:** for representative **Loop Mode** runs only, record the model `invokeCliTextResponse` selects today vs. what the router *would* pick. Estimate token/cost delta. This sizes Phase 2's payoff. (Verify/review/debate/consensus are explicitly excluded — they must keep Opus.)
- [ ] **Confirm the blast radius:** grep every `invokeCliTextResponse` call site and every `model: ... || 'default'` site to confirm which flows pass `'default'`/unset, so the opt-in flag is added to *exactly* the Loop Mode path and nothing else. (Known today: verify `multi-verify-coordinator.ts:268`, consensus `:461`, loop `default-invokers.ts:1638`.)
- [ ] **Tool-subsetting value (gates Phase 3):** instrument `--allowedTools` count per spawn and provider-reported first-turn input tokens; manually compare full vs. hand-trimmed tool lists. Strong prior the delta is small (CLI owns schema injection). **If not material, Phase 3 is cut.**
- [ ] Record findings under a "Phase 0 Results" heading here; document go/no-go for Phases 2/3.

**Verify:** numbers recorded; decisions documented.

---

## Phase 1 — Shared routing helper (the real "core")

Goal: make routing reusable outside `instance-orchestration` without duplicating logic.

- [ ] Extract the provider-aware resolution currently in `instance-orchestration.ts:routeChildModel` (`:653–705`) into a standalone, dependency-light helper — e.g. `src/main/routing/route-task.ts` `resolveRoutedModel(task, { explicitModel, agentId, provider }): RoutingDecision` — that internally uses `getModelRouter().route()` + `resolveModelForTier()`.
- [ ] Refactor `routeChildModel` to call the shared helper (behavior-preserving; existing child-spawn tests must stay green).
- [ ] **No new taxonomy.** Reuse `RoutingDecision`/`TaskComplexity`/`ModelTier`. If classification needs improvement, improve `ModelRouter.analyzeTask` in place — do not add a parallel classifier.
- [ ] Unit tests for the extracted helper covering: explicit concrete model passthrough, explicit tier name, auto-route, cross-provider mapping, no-model-for-tier passthrough.

**Verify:** `npx tsc --noEmit`; spec tsc; `npm run lint`; new helper specs + existing `instance-orchestration` routing specs green.

---

## Phase 2 — Route Loop Mode ONLY, via an explicit opt-in flag (primary gap)

Integration point: `orchestration/default-invokers.ts` — `invokeCliTextResponse` (params `:298-339`, model resolution `:348`) and its Loop Mode caller (`:1638`).

**The safety constraint (load-bearing):** routing must be triggered by an **explicit per-call-site flag**, NOT by `payloadModel` being `'default'`/unset. Verified hazard: verify agents (`multi-verify-coordinator.ts:268`) and consensus fan-out (`consensus-coordinator.ts:461`) pass `'default'`, which today resolves to Opus; a blanket-on-`'default'` trigger would silently downgrade them to Haiku/Sonnet and gut verification/consensus quality.

- [ ] Add an opt-in param to `invokeCliTextResponse`, e.g. `routingIntent?: 'loop' | 'workflow'` (absent = current behavior). When present **and** `getModelRouter().enabled` **and** `payloadModel` is unset, derive the model from the Phase 1 helper using `params.prompt` as the task and `requestedProvider`/`cliType`. Otherwise call `resolveDefaultModel` exactly as today.
- [ ] Set `routingIntent: 'loop'` **only** at the Loop Mode call site (`:1638`, which has a real `p.prompt`). Do **not** set it at the verify (`:511`), review (`:560`), debate (`:632`), or workflow (`:714`) call sites unless/until separately justified.
- [ ] **`agentId` caveat (verified):** `invokeCliTextResponse` receives `instanceId` but **no `agentId`**, so the router's agent-override leg won't fire. Either (a) thread `agentId` through the params, or (b) derive it via `instance?.agentId` when `instanceId` is set, or (c) accept that fresh-child loops (no instance) skip agent override. Pick and document; do not silently assume parity with the spawn path.
- [ ] **Persistent same-session loop (`:812` / `createPersistentLoopAdapter` at `:1617`):** the adapter bakes `model` once at creation; there is **no per-call prompt** there. Options: (a) leave same-session loops on the Opus default in v1 (simplest, recommended); or (b) route once at creation using the first iteration's `p.prompt` (available at `:1617`) and accept the model is frozen for the whole session. **Do NOT** claim per-iteration routing here — it's architecturally impossible without swapping models mid-session. Document the chosen option.
- [ ] Emit a structured log per decision (intent, tier, chosen model, reason); reuse the existing routing-explanation shape so the UI can surface it.
- [ ] **Cross-provider:** reuse the existing safe spawn-path mapping (`resolveModelForTier`). No artificial within-provider restriction.

**Verify:** unit test that with no `routingIntent` (or an explicit model), output reproduces today's `resolveDefaultModel` byte-for-byte; **regression test asserting verify/review/debate/consensus models are unchanged** (Opus); test that `routingIntent: 'loop'` picks the expected tier for sample prompts; `tsc`/spec-tsc/lint; one real `npm run dev` Loop Mode run confirming the logged model matches the routed decision, that an explicit user model is honored, and (manual) that a verification run still uses Opus.

## Phase 2b — Consensus routing (separate path, separate risk — OPTIONAL)

Integration point: `orchestration/consensus-coordinator.ts` (own adapter at `:235/:241`; auto-fan-out specs at `:461`). This is **not** part of the invoker edit.

- [ ] Default: **do not route** — consensus relies on diverse *strong* models; routing votes to cheap tiers defeats its purpose.
- [ ] If pursued at all, route only specs that explicitly request a tier name, never undefined specs, and enforce a tier floor (never below `balanced`). Behind an explicit consensus-specific opt-in, default off.

**Verify:** test that default consensus model selection is unchanged; if routing added, that undefined specs still get the strong default.

---

## Phase 3 — Task-aware `--allowedTools` subsetting (CONDITIONAL on Phase 0)

Build **only if Phase 0 shows material benefit** (low prior).

Integration point: per-spawn tool resolution in `instance/instance-lifecycle.ts` feeding `tools/tool-list-filter.ts:filterForModel()`.

- [ ] Map complexity/category → tool groups; subsetting may only **narrow** the already permission-filtered set, never widen it; always retain a safe core (Read/Grep/Glob).
- [ ] Recovery path: if a needed tool was excluded, existing error-reinjection + next-iteration handling recovers — document this. Behind the existing routing config or a clearly-scoped sub-flag, default off.
- [ ] Tests: intersection never widens; safe-core always present.

**Verify:** tsc/spec-tsc/lint; real run comparing first-turn provider input tokens full vs. subset; no "tool not allowed" dead-ends on a normal implement task.

---

## Phase 4 — Optional, explicitly budgeted

- [ ] **Cheapest-meeting-floor selection** (only if Phase 0 shows tier-ordering leaves money on the table): this is NEW data-wiring, not free — `resolveModelForTier` is first-by-order and `model-capabilities` isn't keyed by pinned IDs. Would require joining `PROVIDER_MODEL_LIST` IDs ↔ capabilities ↔ `model-pricing` and changing tier resolution to cost-rank within a capability floor. Treat as a separate, sized effort; do not bundle into Phase 2.
- [ ] **Auto-summary fallback** for tool-only iterations — marginal given structural progress detection. Defer unless requested.

---

## Cross-Cutting Requirements
- Reuse existing singletons/config; any new singleton follows `getInstance()`/`getXxx()`/`_resetForTesting()`.
- New behavior governed by the **existing** `ModelRoutingConfig`, not a new competing flag; existing flows unchanged when routing is disabled or a concrete model is supplied.
- After every phase: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, relevant vitest specs.
- Integration audit per AGENTS.md: decisions logged, no orphaned/duplicate routing code, IPC/UI reflect new coverage if relevant.
- No new npm packages without confirming with James.

## Open Questions for James
1. Scope of v1: Phase 1 + Phase 2 (route **Loop Mode only**), deferring Phase 2b (consensus), Phase 3 (tool-subsetting), and Phase 4 (cheapest-meeting-floor)? (Recommended.)
2. Same-session loop adapter: leave on Opus default in v1 (option a), or route once at creation and freeze for the session (option b)? (Recommend a.)
3. `agentId` on the invoker path: thread it through, derive from `instance?.agentId`, or accept agent-override is skipped for fresh-child loops?
4. Consensus (Phase 2b): leave untouched (recommended) or pursue tier-floored routing later?
5. Should Phase 3 be budgeted at all, or fully gated behind a positive Phase 0 measurement?
