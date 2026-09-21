# Architecture quality remaining items — overflow policy + Angular 5.4

Status: completed
Date: 2026-09-17
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan_completed.md`

## Scope

The two leftover parent items:

- 2.2 Extract overflow compact/retry *policy* from `InstanceCommunicationManager` onto a collaborator. Maps stay on `InstanceCommunicationOverflowTracker`. No behavior change.
- 5.4 Align Angular app packages onto the same 22.1.7 line as CLI / `@angular-devkit/build-angular`.

## Non-goals

- Did not move circuit-breaker empty-response compaction.
- Did not bump Angular to 22.2.
- Did not bump `angular-eslint` (only `22.1.0` is published on the 22.1 line).
- Did not create a branch or PR.

## As-built

- `InstanceCommunicationOverflowPolicy` owns compact → retry once → idle, plus silent-empty compact. Shared `OVERFLOW_DELEGATION_GUIDANCE` / `buildOverflowRetryMessage`.
- `InstanceCommunicationManager` classifies overflow and delegates; it remains the host.
- LOC ceiling: `instance-communication.ts` 2666 → 2496.
- Angular runtime + `compiler-cli` are `^22.1.7` (installed 22.1.7), matching CLI and build-angular 22.1.7.

## Verification

Targeted: overflow policy spec, `instance-communication.spec.ts`, cancellation spec.

Canonical gates: `tsc --noEmit` (app + spec), `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, `test:quiet` (2109 files / 24956 passed). Independent `task-completion-gate`: `VERDICT: PASS` (agent `06b6cd85-55f6-4429-a5a8-1ad7ba613a86`).
