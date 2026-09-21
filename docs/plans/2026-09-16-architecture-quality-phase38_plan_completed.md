# Architecture quality Phase 3.8 — adapter parity tests

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Pin current adapter lifecycle/error behavior before Phase 3 refactors.

## Implementation notes

- Lifecycle parity now includes Copilot alongside Claude and Gemini.
- Codex stays on its dedicated app-server specs; it is not the same spawn/process model as the BaseCliAdapter fixtures.
- Shared output-message factory, argv redaction, NDJSON buffering, and stderr classification landed in `2026-09-16-architecture-quality-phase3_plan.md`.
- Copilot now has a one-shot stderr fixture that asserts failure text becomes `error` output without throwing.

## Verification

`src/main/cli/__tests__/adapter-parity.spec.ts` — 24 tests passed, including Copilot lifecycle fixtures and Copilot stderr output.
