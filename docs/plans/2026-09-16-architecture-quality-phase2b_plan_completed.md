# Architecture quality Phase 2b — overflow tracker + permission-request flow

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Second independently-landable Phase 2 extraction. No behavior change.

- 2.2 Extract context-overflow / last-sent retry maps from `InstanceCommunicationManager` into a dedicated tracker.
- 2.1 Extract the input-required permission request flow (pending map, auto-allow/deny, lifecycle events) from `InstanceManager` onto a host-injected collaborator.

## Non-goals

- Do not move overflow compact/retry *policy* (compaction, delegation guidance, status transitions).
- Do not bump Angular (5.4).
- Do not rewrite `handleInputRequired` decision rules.

## As-built

- `InstanceCommunicationOverflowTracker` owns last-sent turn, warning, retry, and seen flags. Compaction/retry control flow stays on `InstanceCommunicationManager`.
- `InstancePermissionRequestFlow` owns the pending-request map, `handleInputRequired` gating, user-decision recording, and `permission:lifecycle` events. `InstanceManager` remains the EventEmitter / send-resume host and keeps the public IPC methods as one-line delegates.
- LOC ceilings tightened: `instance-communication.ts` 2676 → 2666; `instance-manager.ts` 2720 → 2417.

## Verification

Targeted specs: overflow tracker, permission-request flow, `instance-communication.spec.ts`, `instance-communication-cancellation.spec.ts`, `instance-manager.send-input.spec.ts`.

Canonical gates: `tsc --noEmit` (app + spec), `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, `test:quiet` (2108 files / 24944 passed, 1 pre-existing skip). Independent `task-completion-gate`: `VERDICT: PASS` (agent `8b50e501-763b-434a-91f5-4afb75688501`).
