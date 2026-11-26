# Bounded Session Recovery Implementation Plan

Status: Completed and independently verified on 2026-07-17

> **For agentic workers:** Execute this plan inline in the shared checkout. Do not dispatch subagents because the repository contains concurrent user work and the current task has not authorized delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session recovery prompts provably bounded and retain native-resume capability after an adapter is disposed.

**Architecture:** Preserve complete transcript bytes in durable storage, but project them into a bounded recovery packet and prompt envelope. Resolve runtime capabilities through a live-adapter-first, provider-registry-second lookup so lifecycle cleanup does not erase provider knowledge.

**Tech Stack:** TypeScript, Electron main process, Vitest, better-sqlite-backed persisted history fixtures.

## Global Constraints

- Do not truncate or mutate durable transcript/history data.
- The complete replay prompt must not exceed 200,000 characters.
- Token-budget enforcement must include packet headers and fallback notices.
- Unknown capability data must remain conservative.
- Preserve unrelated working-tree changes and do not commit active planning documents.

---

### Task 1: Bound recovery packets and the complete replay envelope

**Files:**
- Modify: `src/main/session/fallback-history.ts`
- Test after real archived-data verification: `src/main/session/fallback-history.spec.ts`

**Interfaces:**
- Consumes: `OutputMessage[]`, recovery reason, provider context-window tokens.
- Produces: `buildRecoveryPacket()` with bounded message previews and `buildFallbackHistoryMessage()` with a hard whole-envelope limit.

- [x] Reconstruct the current 1,285,743-character failure from archived entry `75670f84-0ced-4923-823b-9fe46d33c916`.
- [x] Add bounded packet preview metadata (`contentChars`, `contentTruncated`) while retaining `content` as the preview field.
- [x] Always summarize tool-use and tool-result prose in fallback history.
- [x] Apply token and 200,000-character checks to every complete candidate.
- [x] Provide a syntactically complete minimal fallback that also satisfies both budgets.
- [x] Run the archived-data reconstruction and confirm the real generated prompt is within limits.
- [x] Add the >1 MiB recent-tool-result regression and packet-metadata assertions.
- [x] Run `npm run test:quiet -- src/main/session/fallback-history.spec.ts` and confirm all cases pass.

### Task 2: Retain provider capabilities after adapter disposal

**Files:**
- Modify: `src/main/providers/provider-runtime-service.ts`
- Modify: `src/main/instance/instance-lifecycle.ts`
- Test after runtime-path verification: `src/main/providers/provider-runtime-service.spec.ts`
- Test after runtime-path verification: the focused restart lifecycle spec selected during implementation.

**Interfaces:**
- Consumes: optional live `CliAdapter` and optional `CliType` provider key.
- Produces: `ProviderRuntimeService.getCapabilities(adapter?, provider?)` with precedence live adapter → registry snapshot → conservative default.

- [x] Read the complete lifecycle manager and focused restart tests before editing.
- [x] Add registry fallback to `ProviderRuntimeService.getCapabilities()` without changing live-adapter precedence.
- [x] Resolve the CLI provider before restart planning and pass it to capability lookup.
- [x] Pass the resolved provider to the native-resume eligibility check as well.
- [x] Exercise the restart path with a disposed adapter and populated provider registry.
- [x] Add service and lifecycle regression coverage, including the no-snapshot conservative case.
- [x] Run the focused provider-runtime and lifecycle tests.

### Task 3: Correct overflow attribution

**Files:**
- Modify: `src/main/cli/adapters/codex/input-cap-recovery.ts`
- Test after behavior verification: `src/main/cli/adapters/codex/input-cap-recovery.spec.ts`

**Interfaces:**
- Produces: a terminal overflow error that attributes failure to the assembled turn and offers both input reduction and fresh-without-replay recovery.

- [x] Update the terminal error copy without changing the compaction → fresh-thread retry ladder.
- [x] Exercise the double-cap-error path and confirm the neutral, actionable message.
- [x] Update the focused assertion and run `npm run test:quiet -- src/main/cli/adapters/codex/input-cap-recovery.spec.ts`.

### Task 4: Canonical verification and lifecycle closure

**Files:**
- Completed: `docs/superpowers/specs/2026-07-17-bounded-session-recovery_spec_completed.md`
- Completed: `docs/superpowers/plans/2026-07-17-bounded-session-recovery_plan_completed.md`

- [x] Run targeted recovery and lifecycle tests together.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Record as-built behavior and verification evidence in the spec and plan.
- [x] Rename the plan to `_plan_completed.md` and the spec to `_spec_completed.md` only after every agent-runnable gate passes.

## As Built

- Recovery packets now retain only bounded previews while recording each message's original character count and truncation state. Tool invocations and results are summarized in replay prose regardless of recency.
- Every complete recovery candidate, including the structured packet and degradation notice, is checked against both the token budget and the 200,000-character hard ceiling. A final bounded minimal recovery message covers extremely tight budgets.
- Runtime capability lookup now follows live adapter → provider registry snapshot → conservative default. Restart planning resolves and supplies the provider even when the prior adapter has already been disposed.
- Terminal Codex overflow copy now attributes the failure to the assembled turn and preserves the existing compaction → fresh-thread retry ladder.

## Verification Evidence

- Exact archived entry `75670f84-0ced-4923-823b-9fe46d33c916`: 26 messages, 1,167,610 raw content characters, and a 1,046,524-character largest tool result. The patched production function generated a 7,409-character packet and a 12,013-character / 3,004-token complete recovery message; the oversized tool result was marked truncated. This is below the 200,000-character ceiling and the 77,520-token budget used for the 258,400-token context invocation.
- Independent focused gate: 5 files and 77 tests passed.
- Independent canonical gates: both TypeScript checks, Angular lint, and the TypeScript max-LOC ratchet exited 0.
- Independent decisive full suite: 1,501 files and 14,848 tests passed in 401.0 seconds. Earlier unrelated full-suite flakes passed in isolation and did not recur in the decisive run.
- Independent forensics: `git diff --check` and the task-diff secret scan passed; no test weakening, skips, suppressions, stubs, dependency/config changes, security sinks, async leaks, or performance regressions were found in the 10-file task diff.
- The mandated repository-health escalation found no task-specific blocker. Its unrelated findings are reported in the completion handoff rather than folded into this completed plan.
