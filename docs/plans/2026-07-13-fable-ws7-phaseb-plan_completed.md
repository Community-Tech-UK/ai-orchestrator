# Fable WS7 Phase B — regular-session provider failover (implementation plan)

**Status:** COMPLETED (automatic path, code) 2026-07-17 — a regular session whose recovery
ladder exhausts on a provider-fault category now fails over to the next configured fallback
provider via a RuntimeReconciler cross-provider swap, instead of dying in `error`. Default
OFF (empty `sessionFailoverProviders`) ⇒ inert. 14 new tests; tsc ×2 / lint / LOC clean; full
suite as final gate (loop record). Live checks:
[`2026-07-13-fable-ws7-phaseb_livetest.md`](2026-07-13-fable-ws7-phaseb_livetest.md).
Both the automatic AND offered paths are complete (Task 5 landed same day, see below).
**Date:** 2026-07-17
**Parent:** `docs/plans/2026-07-13-fable-implementation-plan_completed.md` WS7 (Phase A COMPLETE; this is Phase B).

> Do not commit or push. Rename `_completed` only when code-complete + verified.

## Design decisions (as-built, verified 2026-07-17)

- **Consent surface = global operator setting, not per-instance UI.** No per-instance settings
  store exists. The plan's "per-instance `failoverProviders`" intent is met by a global
  `sessionFailoverProviders: string[]` (default `[]` = off; configuring it IS the explicit
  consent to send conversation context to those providers), seeded onto each new instance's
  `failoverProviders` field at create so a future per-instance override UI can diverge without
  a data-model change. The orchestrator reads `instance.failoverProviders`.
- **Swap mechanism = the RuntimeReconciler.** A regular-session failover is exactly a
  cross-provider swap of a dead session — which `applyRuntimeChange({provider})` already does
  (fresh session, cleared resume cursor, replay/handoff continuity preamble). No bespoke spawn:
  the failover recovers the instance from its terminal `error` state and calls the reconciler.
  Context carry-over (the plan's "handoff packet") is the reconciler's continuity preamble,
  which with `sessionHandoffStateEnabled` ON is the redacted handoff document (WS3/redaction).
- **Target selection = `FailoverManager.selectLoopFailoverTarget`.** Despite the name it is a
  provider-agnostic candidate picker (cooldown + circuit + caller veto); reused so failover
  telemetry stays single-sourced. Vetoes: WS2 provider-limit ledger park + CLI-not-installed.
- **Trigger (this slice) = automatic, at recovery-ladder exhaustion.** The interrupt-respawn
  handler's two error-terminal catches (`respawnAfterInterrupt`, `respawnAfterUnexpectedExit`)
  ARE ladder exhaustion. A new OPTIONAL, fail-soft `onRecoveryLadderExhausted(instance, error)`
  dep fires there; instance-lifecycle wires it to the orchestrator. Optional ⇒ existing handler
  specs unchanged. Guardrails honored: iteration/turn boundary (ladder fully exhausted before
  the callback), never on non-`shouldFailover` categories, budget-bounded.

## Tasks

- [x] Types: `Instance.failoverProviders?: string[]`, `Instance.failoverSwitches?: number`,
      `Instance.failedOverFrom?: string`; `InstanceCreateConfig.failoverProviders?`.
- [x] Settings: `sessionFailoverProviders: string[]` (default []), `sessionFailoverMaxSwitches`
      (default 1); defaults + control-policy (`open`) + metadata row + types.
- [x] Create seam: seed `instance.failoverProviders` from config ?? global default (builder).
- [x] `instance-failover.ts`: pure `decideInstanceFailover` (shouldFailover ∧ providers ∧ budget)
      + `attemptInstanceFailover(instance, error, deps)` (classify → decide → select w/ vetoes →
      swap closure → tag `failedOverFrom`/`failoverSwitches` → timeline + WS10 notify; never throws).
- [x] Handler: optional `onRecoveryLadderExhausted` dep, invoked fail-soft in both error catches.
- [x] instance-lifecycle: `failoverSwapProvider(instanceId, provider)` (recover error→idle, then
      reconciler swap) + wire the callback to `attemptInstanceFailover` with real deps.
- [x] Specs: pure decision matrix (auth→switch, validation→no-switch, budget exhausted, no
      providers, default-off inert); orchestration (switch, parked-skip veto, cli-not-installed
      veto, no-target, never-throws); handler fires the callback on exhaustion only.
- [x] Canonical checklist (tsc ×2, lint, LOC clean; targeted 975 green: failover 12/12, handler callback 2/2); full suite as final gate (loop record); livetest doc written.

## Offered slice (Task 5) — COMPLETED in the follow-up pass (2026-07-17)

- Park-offer: optional fail-soft `onParked` dep on the provider-limit handler (fired once per
  successful park), wired in instance-manager through the pure
  `buildParkFailoverOfferNotification` (fallbacks configured ∧ resume beyond
  `sessionFailoverOfferAfterMinutes`, default 30) → deduped WS10 notification.
- One-click switch: `INSTANCE_FAILOVER_NOW` IPC (+Zod +preload +renderer service) →
  `InstanceManager.failoverNow` → lifecycle `failoverNow` (FailoverManager selection with
  installed/parked vetoes, park `cancel()` first so auto-resume can't race, reconciler swap via
  `failoverSwapProvider`, `failedOverFrom` tag, transcript system message; user-initiated so it
  does NOT consume the automatic budget). Composer quota-park banner gains a "Switch provider"
  button, shown only when the instance has eligible fallbacks (`canOfferFailover`).
- Specs: onParked seam (fires with park facts + throwing hook never breaks the park), offer
  decision matrix (long park offers / short park + no-instance + no-fallbacks silent); the two
  input-panel spec harnesses gained an InstanceStore stub.

## Acceptance

- Default-off proven inert (no behavior change; existing lifecycle/handler specs unchanged).
- Exhaustion-switch spec proves: classify → select (vetoes applied) → reconciler swap →
  `failedOverFrom` tag + budget increment; validation category never switches.
- Canonical checklist green; livetest written.
