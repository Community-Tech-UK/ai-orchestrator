# Browser Approval Active-Turn Race Specification

**Status:** Completed and independently verified on 2026-08-27.

**Plan:** [2026-08-27-browser-approval-active-turn-race_plan_completed.md](../plans/2026-08-27-browser-approval-active-turn-race_plan_completed.md)

## Problem

Resolving a Browser Gateway approval currently sends a synthetic resume prompt even when the originating Codex app-server turn is still active. The second turn is rejected, the rejection publishes a false `idle` state, and renderer messages then retry repeatedly against the still-active runtime.

Live evidence from instance `xm5ijtsws` on 2026-08-27 showed four distinct browser approvals colliding with one Codex turn. A typed `continue` was attempted six times and restored to the composer after five retries.

## Required Behaviour

1. A Browser Gateway approval or denial resume prompt must not call `InstanceManager.sendInput()` until the instance has a ready lifecycle status and its provider runtime reports no active turn.
2. A deferred resume prompt must be delivered on the first genuine ready edge after both conditions become true.
3. Multiple Browser Gateway decisions resolved during the same turn must coalesce into one resume prompt per instance rather than refiring concurrently, while preserving each request ID and its approved/denied decision.
4. A second Codex app-server send rejected because another turn owns the runtime must not publish `idle` while that turn remains active.
5. A renderer send that receives the active-turn collision must remain queued in `busy` state until a genuine ready edge; it must not retry on a timer or exhaust the five-retry budget.
6. Existing automated writers that intentionally support mid-turn delivery must keep their current default admission behaviour. The stricter readiness requirement is opt-in for Browser Gateway resumptions.

## Verification

- A handler/admission regression test proves busy or runtime-active browser resumes are deferred, coalesced, and then delivered once.
- A Codex adapter regression test proves the collision emits no false `idle` before the owning turn completes.
- A renderer regression test proves the collision is parked without timed retries.
- Focused tests and the repository canonical verification checklist pass.
- A fresh independent completion-gate agent returns `VERDICT: PASS` with no actionable findings.

## As Built

All required behaviour is implemented. Strict Browser Gateway admission now checks lifecycle readiness and the provider runtime snapshot, keyed pending decisions coalesce without losing request-to-decision mappings, Codex preserves active-turn status ownership, and the renderer parks collisions until a real ready event. The focused and canonical suites pass, and the fresh completion gate returned `VERDICT: PASS` with no findings.
