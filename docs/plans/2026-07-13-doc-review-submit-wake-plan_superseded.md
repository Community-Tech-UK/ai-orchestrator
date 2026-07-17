# Doc-review: Submit must wake the agent

**Status:** Superseded — 2026-07-13. The standalone capture-server behavior described here
landed with the artifact runtime, and the in-app delivery ladder was reconciled and completed
in [`2026-07-13-doc-review-delivery-reconciliation-plan_completed.md`](2026-07-13-doc-review-delivery-reconciliation-plan_completed.md).
This historical draft must not be executed as a separate plan.
**Date:** 2026-07-13
**Historical scope:** It was originally a companion to
[`2026-07-13-doc-review-choice-controls-plan_completed.md`](2026-07-13-doc-review-choice-controls-plan_completed.md).

## Problem

Submitting a review captures the decisions but wakes nobody. The reviewer becomes the messenger: James clicks Submit, then has to go tell an agent that he clicked Submit. Both pipelines should treat a submitted review as a **wake event** that resumes (or starts) the agent that's waiting on it.

## Current state (verified 2026-07-13)

- **Skill path** (`.claude/skills/doc-review-artifact/references/serve-review.mjs`, synchronized copy at `src/main/doc-review/assets/serve-review.mjs`, specs at `src/main/doc-review/serve-review.spec.ts`): on POST `/decisions` the server validates, writes `<artifact>.decisions.json`, prints the canonical block + `AIO_REVIEW_CAPTURED <path>` to stdout — **and keeps running until `--timeout-min`** (empirically confirmed in the 2026-07-13 fable review: the process had to be killed manually after capture). A Claude Code session that launched it via a background Bash task is only re-invoked when the process *exits*, so capture alone never wakes it.
- **In-app path** (`src/main/doc-review/doc-review-service.ts`): `submitDecision` (:246-284) records decisions and "push[es] the canonical feedback block into the requesting instance"; sessions are created per requesting instance (:150-176, `status: 'pending'`); there is a loop-oriented review path ("Phase 3 loop auto-review", :193). MCP surface: `request_doc_review` + `get_doc_review_result` (`src/main/mcp/doc-review-tools.ts:42,88`). What is NOT verified to exist: any wake/resume when the requesting instance is no longer running, busy, or parked — read the push implementation first (Task 1) and record what it actually does in each instance state.

### Implementation re-check (2026-07-13)

The original line references have drifted. The executing path is now
`DocReviewService.submitDecision()` → injected `DocReviewInstanceSink.sendInput()` →
`InstanceManager.sendInput()`, wired in `src/main/app/orchestrator-tools-step.ts`.

- **Live/idle:** the canonical block is sent through the normal input path.
- **Busy:** `sendInput()` is not a next-turn queue. Depending on status it may run the
  normal input pipeline concurrently or fail after the existing interrupt/respawn checks;
  doc review adds no queueing or notification.
- **Hibernated/parked:** no wake is attempted. The normal input path reaches an absent
  adapter and fails.
- **Terminated:** no resume is attempted. The instance is no longer available to the
  direct sender. `SessionContinuityManager` persists recoverable state, but exposes no
  public operation that restores a terminated instance by its former instance id; the
  existing `HistoryRestoreCoordinator` restores from a *history entry id*, which a
  doc-review session does not record.
- **Loop-owned:** `maybeCreateDocReviewForCompletedLoop()` stores only the loop chat id;
  `DocReviewSession` has no `loopRunId`, so submit cannot route a decision to the loop
  coordinator rather than to a chat input.
- **Notifications/delivery history:** no notification dependency or session delivery-outcome
  field exists in the current doc-review contracts.

The standalone capture-server half is already implemented and tested: POST writes the
decisions file before emitting the canonical block, invokes an optional absolute-executable
hook without a shell, returns 200, and exits after a short grace unless `--stay-alive` is
supplied. The two portable/in-app copies are byte-identical.

## Design

**A. Skill path — exit-on-capture is the hook.** After a successful capture, `serve-review.mjs` responds 200, flushes, then shuts the server down and exits 0 (short grace, ~750 ms, so the browser paints "✓ Decisions sent"). The launching session's background-task completion notification then re-invokes the agent, which reads the log/decisions file and proceeds — zero human relay. Additions:
- `--stay-alive` flag preserves today's behaviour (multi-submit iteration sessions).
- `--on-capture <command>` optional hook: after writing the decisions file, `execFile` the command with the decisions path appended as the final argv (no shell, inherit-nothing env, 60 s cap, failures logged to stderr but never block the capture). This is the detached story: e.g. `--on-capture "$AIO_MCP doc-review-captured"` or a `claude --print` one-shot that ingests the decisions when no session is waiting. SKILL.md documents both patterns and changes its serve instructions to: launch in background, rely on exit-notification as the wake.
- Both copies of `serve-review.mjs` change identically; extend `serve-review.spec.ts` (exit-on-capture, stay-alive, on-capture exec, response-before-exit ordering) and add/extend the copy-sync check alongside the template one from the choice-controls plan.

**B. In-app path — deliver or wake, never drop.** `submitDecision` gains a delivery ladder for the requesting instance:
1. **Live + idle:** push the canonical block as instance input (existing behaviour — verify it actually sends, not just stores).
2. **Live + busy:** queue as a pending steer/next-turn input via the instance's existing input queueing, plus a notification.
3. **Parked/hibernated:** wake through the existing lifecycle wake path, then deliver as (1).
4. **Terminated:** setting-gated `docReviewResumeOnSubmit` (default ON — this is the whole point): resume/respawn the session via the existing resume machinery (`writeThroughIdentityLocked` identity, fresh-fallback if native resume fails) with the canonical block as the first prompt, prefixed "You requested doc review <id>; James has decided:". If resume is disabled or fails: keep today's stored-result behaviour (pollable via `get_doc_review_result`) + a critical-path notification so the decisions are never silently parked.
5. **Loop-owned reviews:** route through the existing Phase-3 loop review path so a loop parked on review resumes its iteration rather than getting a chat message.
Every rung emits a notification (through WS10's service once it lands; plain until then) and appends the delivery outcome to the review session record.

## Tasks

1. Read `doc-review-service.ts` in full, plus the push-to-instance implementation it calls, `doc-review-tools.ts`, both `serve-review.mjs` copies, `serve-review.spec.ts`, and the instance wake/resume seams (`instance-lifecycle.ts` orbit). Record in this plan what today's push does for busy/parked/terminated instances before changing anything.
2. Implement A in `src/main/doc-review/assets/serve-review.mjs`; mirror byte-identically to the skill copy; extend specs (+ copy-sync check).
3. Update `SKILL.md` serve instructions (background launch + exit-notification wake; `--stay-alive` for iterating; `--on-capture` for detached use).
4. Implement B's delivery ladder in `doc-review-service.ts` + setting + Zod + specs per rung (live-idle send, busy queue, parked wake, terminated resume with seeded prompt, loop route, resume-failure fallback). Reuse existing lifecycle APIs — no new resume machinery.
5. Wire notifications + session-record delivery outcomes; specs.
6. Canonical verification checklist; livetest doc for one real end-to-end: request review from a live instance, quit the instance, submit in the browser, watch it resume with the decisions.

## Acceptance

- Skill path: spec proves POST → 200 → decisions file → process exit 0, and that the printed block precedes exit; `--stay-alive` preserves old behaviour; `--on-capture` executes with the path argv and cannot block/deadlock capture.
- In-app: spec matrix covers all five rungs incl. resume-with-prompt on a terminated requester and the fail-safe (stored + notified, never lost).
- Both serve-review copies identical (sync check); canonical checklist green; livetest written.

## Guardrails

- Capture durability first: the decisions file write always precedes any wake/exec/exit step; a wake failure must never lose or corrupt the capture.
- `--on-capture` runs via `execFile` with no shell and no secret env passthrough; it receives only the decisions path.
- Resume-on-submit must respect existing spawn caps and the pause coordinator (a VPN-paused app must queue, not spawn).
