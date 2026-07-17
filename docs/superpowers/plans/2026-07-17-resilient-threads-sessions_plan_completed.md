# Resilient Threads & Sessions — Implementation Plan

Status: **Completed — all four phases implemented and verified 2026-07-17; live checks deferred to the linked `_livetest.md`**
Spec: [`2026-07-17-resilient-threads-sessions_spec_completed.md`](./2026-07-17-resilient-threads-sessions_spec_completed.md)
Date: 2026-07-17
Decision: James — "whatever is best architecturally." → implement the full structural fix,
not just the cheap subset.

## Architectural thesis

The resume ladder destroys session state on **absence of proof** (a fixed 5 s health
timeout), not on **proof of unrecoverability**. `RuntimeReadinessCoordinator.getResumeProof`
already computes the right distinction (`false` = proven-dead: session-not-found / wrong
session / fresh-fallback; `true` = confirmed; `null` = pending) but `waitForResumeHealth`
collapses it to one boolean and the reconciler throws on `false`, destroying a possibly-fine
session. Under host load the 5 s window times out on recoverable sessions, and the
destructive fresh-spawn is exactly what loses in-process background agents (which only
native resume can preserve). Fix the gate, not the symptom.

## Phases

### Phase 1 — Load-scaled resume-health patience ✅ DONE + verified

- `runtime-readiness.ts`: scale the effective `waitForResumeHealth` timeout by
  `getSystemLoadMonitor().getMultiplier()` (1→4). Inject via optional dep
  `getResumeHealthLoadMultiplier?: () => number` (default `getSystemLoadMonitor().getMultiplier()`)
  for testability. Only ever scales **up**. Cap = multiplier × base.
- Test: quiet-but-alive adapter that becomes writable at t > base but < scaled → healthy.

### Phase 2 — Proven-dead vs inconclusive + retry-then-proceed ✅ DONE + verified

- `runtime-readiness.ts`: add `evaluateResumeHealth(): Promise<'healthy'|'unrecoverable'|'inconclusive'>`.
  `waitForResumeHealth` becomes a thin `=== 'healthy'` wrapper (legacy callers unchanged).
  - `unrecoverable`: proof === false, session-not-found error, or process dead.
  - `healthy`: proof true or quiet-writable.
  - `inconclusive`: timed out, process still alive, no definitive proof.
- `runtime-reconciler.ts applyRecoveryRespawn`: replace the single
  `!waitForResumeHealth → throw` with the verdict:
  - `healthy` → proceed (resumed).
  - `unrecoverable` → throw → destructive fresh fallback (unchanged for genuinely dead sessions).
  - `inconclusive` → **retry the health wait once**; if still inconclusive and process alive
    → **proceed with the resumed session** (never destroy on mere timeout). Only a dead
    process falls back.
- Net effect: "Session restarted automatically (resume failed)" fires only on
  proven-unrecoverable sessions. Slow-under-load sessions keep their live thread + agents.

### Phase 3 — Honest degradation preamble (fresh fallback only) ✅ DONE + verified

- `fallback-history.ts` / continuity builder: when a fresh fallback genuinely happens,
  append a short, explicit line that a new session was started and background/in-flight work
  from the prior session was not carried over — re-establish current state before
  continuing. Where AIO tracks orchestration children, list them by id/role.

### Phase 4 — Orphaned orchestration children on restart (gap C) ✅ DONE + verified

- On replay-fallback restart, reconcile the parent's `childrenIds`
  (`orchestration-handler.ts`): drop dead children, keep live ones, record the event.
  Isolated from the resume gate. Lower urgency; instance-spawns-instance only.

## As-built — Phases 3 & 4 (2026-07-17)

- `fallback-history.ts`: added `buildFreshFallbackDegradationNotice()` +
  `FreshFallbackChildRef`/`FreshFallbackDegradationInfo` — a pure builder for the
  `[SESSION DEGRADATION NOTICE]` block (new session started, background/in-flight work NOT
  carried over, re-establish state; lists live orchestration children by id/name/status and
  dropped ids).
- `restart-policy-helpers.ts buildFallbackHistory`: every fresh-fallback continuity path
  funnels through here (reconciler recovery + runtime-change fallbacks, lifecycle restore
  paths, interrupt-respawn), so the notice is appended to the recovery message here — on
  both the rich-history and the replay-preamble fallback branches. New optional dep
  `reconcileOrchestrationChildren` is invoked best-effort (a broken orchestration registry
  never blocks recovery).
- `orchestration-handler.ts`: added `reconcileChildrenAfterRestart(parentId, isChildAlive)` —
  drops dead children from `ctx.childrenIds` into the completed set (post-hoc summary
  queries keep resolving), keeps live ones, logs the event.
- `instance-orchestration.ts`: manager wrapper supplies liveness (instance present and not
  terminated/failed/error), mirrors the drop onto the parent `Instance.childrenIds`
  (spawn-limit checks + get-children stay consistent), and resolves live child refs
  (id/displayName/status) for the notice.
- Wiring: `LifecycleDependencies.reconcileOrchestrationChildren` (optional) →
  instance-manager → instance-lifecycle → `RestartPolicyHelpers` deps.
- Tests: 4 new notice-builder cases (`fallback-history.spec.ts`), 4 funnel cases
  (`restart-policy-helpers.fallback.spec.ts` — appended notice, child listing, replay-branch
  coverage, throwing-hook resilience), 4 handler cases (`orchestration-handler.spec.ts`),
  3 manager cases (`instance-orchestration.child-reconcile.spec.ts`).

## As-built — Phases 1 & 2 (2026-07-17)

- `runtime-readiness.ts`: added `ResumeHealthVerdict` + `evaluateResumeHealth()`
  (three-way), load-scaled the window via `getSystemLoadMonitor().getWatchdogMultiplier()`
  (injectable `getResumeHealthLoadMultiplier` dep, only scales up). `waitForResumeHealth`
  is now a `=== 'healthy'` wrapper — legacy boolean callers unchanged.
- `instance-lifecycle.ts`: `waitForResumeHealth` refactored into a verdict-returning
  `evaluateResumeHealth` that folds in the existing resume-attempt-result classification
  (attempted-but-unconfirmed → `unrecoverable`); boolean wrapper preserved. Wired
  `evaluateResumeHealth` into the reconciler deps.
- `runtime-reconciler.ts`: recovery path (`applyRecoveryRespawn`) now calls
  `resolveRecoveryResumeHealth` — keep on `healthy`, fresh-fallback only on
  `unrecoverable`, retry-once-then-proceed on `inconclusive`. The user-initiated
  model-swap path (line ~301) intentionally left on the boolean probe (present user,
  fallback acceptable) — candidate follow-up if desired.
- Tests: 7 new `evaluateResumeHealth` cases (verdicts + load scaling, deterministic via
  pinned multiplier) + 3 new recovery-policy cases (inconclusive-keeps, unrecoverable-falls-back,
  inconclusive→unrecoverable-falls-back).
- Verified: `tsc` (app + spec) clean, `lint` clean, `check:ts-max-loc` pass, full
  `test:quiet` = 14492 passed.

## Verification (per phase + final)

Targeted: `runtime-readiness.spec.ts`, `runtime-reconciler.recovery.spec.ts`,
`interrupt-respawn-handler.spec.ts`, orchestration-handler specs.
Final gate: `npx tsc --noEmit` ×2 (app + spec), `npm run lint`,
`npm run check:ts-max-loc`, `npm run test:quiet`.

Final gate results (2026-07-17, Phases 3–4): tsc app + spec clean, lint clean, full
`test:quiet` = 14548 passed (true exit 0). `check:ts-max-loc` fails only on
`packages/contracts/src/schemas/browser.schemas.ts` (707 > 700) — pushed over the limit by
a concurrent agent's unrelated uncommitted change, not this plan's work; this plan's files
are within tolerance.

## Live-test residual

Deferred live checks (resume-survival under load, real fresh-fallback degradation notice,
child reconcile on a real restart) are recorded in
[`2026-07-17-resilient-threads-sessions_plan_livetest.md`](./2026-07-17-resilient-threads-sessions_plan_livetest.md)
per AGENTS.md.
