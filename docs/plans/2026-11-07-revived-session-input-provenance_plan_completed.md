# Revived-session input provenance and provider-swap evidence mode (LT-728)

**Status:** source fix completed and verified 2026-11-07; installed-app checks deferred to
[the live-test document](2026-11-07-revived-session-input-provenance_livetest_completed.md). Fixes
[LT-728](livetest-remediation-register.md#lt-728).

## Problem

1. A session revived by crash recovery (`metadata.reason === 'crash-recovery'`) never saves James's typed
   messages to its conversation. `InstanceContinuityRecovery.redactProviderEnvelope` removes `raw` (and
   `sessionId`) from every envelope of a revived session so recovery identity cannot leak. The transcript bridge
   (`ChatTranscriptBridge.messageFromEnvelope`) keeps a `user` output only when `raw.source === 'instance-output'`,
   which is how it tells Harness's own published input from a provider echo. With `raw` gone, every user message
   of a revived session is dropped, while assistant, system and tool rows are kept. Under the `enforce` evidence
   mode every Harness MCP tool call then fails with `SOURCE_MESSAGE_MISSING`.
2. A provider change (`RuntimeReconciler.applyRuntimeChangeLocked`) swaps `instance.provider` but never re-runs
   `initializeInstanceEvidenceOwnership`, so the session keeps the old provider's evidence mode. Codex (`enforce`)
   to Claude (`off`) kept enforcing; Claude to Codex would never capture. Only create, wake and fresh restart
   re-read it.

## Change

1. Add an optional envelope field `harnessPublished: true`, set only by `InstanceManager.publishOutput` when it
   publishes Harness-originated output (no adapter `raw`). It is not forensic data, so redaction keeps it. The
   bridge keeps a `user` output only when `harnessPublished === true`; provider echoes and adapter-emitted user
   text still never become user rows. Contract type and Zod schema gain the field.
2. On a provider swap, re-run `initializeInstanceEvidenceOwnership` for the new provider right after
   `instance.provider` changes; restore the previous `contextEvidence` on rollback.

## Verification

- Bridge specs: a redacted (no `raw`) Harness-published user message persists; an echo without the marker does not.
- Lifecycle spec: a revived session's published user output carries `harnessPublished` and no `raw`.
- Reconciler spec: a swap re-reads the target provider's mode; a failed swap restores the old state.
- Canonical gates. Fresh independent review.
- Installed checks after rebuild: moved to [the live-test document](2026-11-07-revived-session-input-provenance_livetest_completed.md).

## As built

- Implemented exactly as described above. Files: `packages/contracts/src/types/provider-runtime-events.ts`,
  `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`, `src/main/providers/provider-runtime-event-bus.ts`,
  `src/main/instance/instance-provider-event-ingress.ts`, `src/main/instance/instance-manager.ts`,
  `src/main/chats/chat-transcript-bridge.ts`, `src/main/instance/lifecycle/runtime-reconciler.ts`.
- A bare `raw.source: 'instance-output'` label is no longer trusted on its own; only the marker counts.
- Tests: bridge standalone spec (echo, label-only, Harness, redacted Harness cases); tool-server evidence spec (a
  redacted Harness send anchors `list_remote_nodes`, an echo alone is refused with `SOURCE_MESSAGE_MISSING`);
  lifecycle spec (a revived session's send carries the marker with no `raw`, `sessionId` or raw-event capture, and
  adapter-relayed user text does not); reconciler swap spec (Codex `enforce` to Claude `off`, rollback restores).
  The bridge, tool-server and reconciler tests were confirmed to fail with the old code restored.
- All eight canonical gates passed; full suite 3,111 files, 39,614 tests, run on the Windows PC
  (`_scratch/lt728-gates/summary.txt`). Fresh independent review: `VERDICT: PASS`, no actionable findings.
