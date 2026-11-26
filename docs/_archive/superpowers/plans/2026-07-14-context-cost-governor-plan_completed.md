# Context Cost Governor Implementation Plan

> **For Codex:** Use the executing-plans workflow. Implement test-first, preserve the dirty checkout, and do not commit or push.

**Spec:** `docs/superpowers/specs/2026-07-14-context-cost-governor-spec_planned.md`

**Goal:** Bound Codex app-server turn cost and safely continue work through confirmed interrupt and observed compaction.

**Architecture:** A pure governor decides from provider usage data. The Codex adapter owns orchestration because it has the native turn ID, interrupt completion proof, thread compaction RPC, and same-thread continuation path. The generic compaction coordinator continues to call the adapter's public compaction API, which becomes observation-backed.

**Tech Stack:** TypeScript, Node EventEmitter, Codex app-server JSON-RPC, Vitest.

---

## Task 1: Add the pure cost governor

**Files:**
- Create: `src/main/cli/adapters/codex/turn-cost-governor.ts`
- Create: `src/main/cli/adapters/codex/turn-cost-governor.spec.ts`

1. Write failing tests for the 2x warning, 4x recovery, 8x urgent recovery, one-shot decisions per epoch, observed-compaction reset, malformed samples, and cumulative counter rollback.
2. Run `npm run test:quiet -- src/main/cli/adapters/codex/turn-cost-governor.spec.ts` and confirm the missing implementation fails.
3. Implement the smallest pure state machine and rerun the targeted test.

## Task 2: Make compaction success observation-backed

**Files:**
- Modify: `src/main/cli/adapters/codex/compaction-gate.ts`
- Modify: `src/main/cli/adapters/codex/compaction-gate.spec.ts`
- Modify: `src/main/cli/adapters/codex/input-cap-recovery.ts`
- Modify: `src/main/cli/adapters/codex/input-cap-recovery.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts`

1. Add failing tests that distinguish `observed` from `timed-out` and prohibit a post-compaction retry when observation is missing.
2. Run the focused gate and input-cap tests and confirm the expected failures.
3. Change `CompactionGate.wait()` to return an explicit outcome.
4. Install an idle app-server notification handler after thread initialization so `thread/compacted` remains observable outside turn capture.
5. Make `compactContext()` register its waiter before the RPC and return true only for an observed compaction.
6. Simplify input-cap recovery to consume the proof-backed boolean and rerun focused tests.

## Task 3: Add controlled interrupt, compact, and continue

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify: `src/main/cli/adapters/codex/context-pressure-diagnostics.ts`
- Modify: `src/main/cli/adapters/codex/context-pressure-diagnostics.spec.ts`

1. Add failing adapter tests for warning emission, ordered interrupt/observed-compaction/continuation, normal completion winning the race, failed proof pausing without replay, config kill switch, and the recovery ceiling.
2. Add diagnostic records for governor decisions and recovery outcomes without logging message bodies or thread IDs.
3. Observe cumulative usage in the existing token-usage handler and arm at most one pending recovery per governor epoch.
4. After turn capture proves `interrupted`, call proof-backed `compactContext()` and continue on the same thread with a fixed continuation instruction.
5. Treat recovery-pause errors as retryable so the instance returns idle with its native thread preserved.
6. Run the focused adapter and diagnostic tests.

## Task 4: Verify integration and document live validation

**Files:**
- Create: `docs/superpowers/plans/2026-07-14-context-cost-governor-plan_livetest.md`
- Rename after agent-runnable gates: `docs/superpowers/plans/2026-07-14-context-cost-governor-plan_completed.md`

1. Run targeted tests for all changed units.
2. Run `npx tsc --noEmit`.
3. Run `npx tsc --noEmit -p tsconfig.spec.json`.
4. Run `npm run lint`.
5. Run `npm run check:ts-max-loc`.
6. Run `npm run test:quiet`.
7. Record the rebuilt-app live procedure and expected evidence in the livetest document.
8. Review the final diff for unrelated changes and secrets, then rename this plan to `_completed` only if every agent-runnable gate passes.

## As-Built (2026-07-16)

Tasks 1 and 2 verified against code as written: `src/main/cli/adapters/codex/turn-cost-governor.ts`
implements the pure 2x/4x/8x state machine (epoch reset on observed compaction, malformed-sample
and counter-rollback handling); `compaction-gate.ts` returns an explicit
`'observed' | 'timed-out' | 'cancelled'` outcome and `codex-cli-adapter.ts` registers an idle
app-server handler for `thread/compacted` after thread init (`handleIdleAppServerNotification` →
`handleObservedThreadCompaction`).

Task 3's controlled interrupt→compact→continue flow is implemented, but not the way this plan
originally specified it. `CodexContextCostController` (`src/main/cli/adapters/codex/context-cost-controller.ts`)
is now explicitly an **executor**, not a decision-owner — its own doc comment says so
(`@deprecated Decisions are owned by ContextSafetyPolicy; retained for config compatibility`).
Decisions (2x warn / 4x recover / 8x urgent-recover, one action per epoch) are made by the
provider-neutral `ContextSafetyPolicy` (`src/main/context-evidence/context-safety-policy.ts`),
driven by `ContextPolicyRuntime.observe()` (`src/main/context/context-policy-runtime.ts:152`,
called from `compaction-coordinator.ts:217`), and dispatched through `ProviderContextActionExecutor`
(constructed in `src/main/app/compaction-runtime.ts:202` with handlers that call
`codex-cli-adapter.ts:711 executeContextAction`), which drives
`CodexContextCostController.requestRecovery()` / `.compactContext()`. This architecture was built
later as part of the provider-agnostic-context-evidence-plan (Task 12/13) and supersedes this
plan's adapter-internal design without losing any of the described guarantees (proof-gated
compaction, epoch-scoped recovery, retryable pause on unconfirmed interrupt/compaction,
fixed same-thread continuation instruction). Treated as satisfied by the superseding design.

Verification run 2026-07-16: 139 targeted tests across the 9 directly touched
spec files pass; `npx tsc --noEmit` exit 0; `npx tsc --noEmit -p tsconfig.spec.json` exit 0;
`npm run lint` — all files pass; `npm run check:ts-max-loc` — passes (11 pre-existing
allowlisted files within tolerance, none touched by this plan); `npm run test:quiet` —
1406 files / 13848 tests passed. Live validation procedures (explicit compaction proof,
controlled cost recovery, failure-safe pause, cost outcome measurement) remain in
`2026-07-14-context-cost-governor-plan_livetest.md`, unexecuted — they require a rebuilt app
and an installed Codex app-server build per that document's own "why live-only" notes.
