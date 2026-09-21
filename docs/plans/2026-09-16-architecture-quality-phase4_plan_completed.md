# Architecture quality Phase 4 — IPC/type-safety boundary

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Harden the renderer/main IPC boundary: one validated registration helper, shared schemas, typed error variants, and a preload ↔ channel contract test.

## Implementation notes

- 4.1 `registerValidatedIpcHandler` is the shared helper. Session, archive, recovery, admission, and queue handlers register through it.
- 4.3 `readIpcAuthToken` validates the `appReady` token shape instead of an unchecked cast.
- 4.4 Instance attachment/provider payloads are normalized from Zod (`toFileAttachments`, `toInstanceProvider`).
- 4.5 Codebase handlers register through `validatedHandler` with named schemas.
- 4.6 RTK payload schemas live in `@contracts/schemas/rtk`.
- 4.7 `ErrorInfo.candidates` is a first-class optional field; command-not-found no longer uses `as never`.
- 4.8 Bulk settings writes require `{ settings }` — the flat-object fallback is gone.
- 4.9 `serializeInstanceForIpc` returns `SerializedInstanceForIpc` and omits runtime handles from a named key list.
- 4.10 Preload `invoke(ch.NAME)` keys must exist on `IPC_CHANNELS`.
- 4.2 Supervision renderer forwards parse Zod envelopes (`passthrough` worker/health/tree events) and drop invalid payloads instead of spreading `any`.

## Remaining

None for the numbered Phase 4 items.

## Verification

Canonical gates green. Independent completion-gate `VERDICT: PASS`. Full `test:quiet` log `_scratch/test-run.pid-64433.log`: 24,881 passed; the one unrelated dirty-tree failure (`orchestrator-tools-mcp-config.spec.ts`) passes on isolated re-run.
