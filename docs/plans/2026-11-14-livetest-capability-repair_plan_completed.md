# Live-test capability repair implementation plan

## Status

On main: yes (this landing commit)
Round 26 November (verification round 1 fix). The checker prompt asked every plan about the repair feature for a runtime probe, but only an item the Queue linked to a repair can report one; it now asks only such items (`ownsRepair`). Tasks 1 and 2 are landed; the earlier re-run was on the Windows PC (independent review and the full suite are left to the verifier): 225 focused tests (recheck, capability service/store/evidence/launch, dev-app), 6,642 wider Plan Queue/shared/contract tests and all seven `npm run checks` gates pass. Remote-only launch (`--remote-only`) is also landed. The unfinished part is live: repair loop end to end, readiness recheck in the running app, the OpenCode, Codex, MiMo, expiry, pause and automation campaigns. These need real provider turns, a person or elapsed time, and are in [the live-test document](2026-11-14-livetest-capability-repair_livetest.md). James decided on 15 November not to test with the Community Tech OpenAI account; Codex uses only james@shutupandshave.com, and waits on the [device-login handoff](2026-11-15-codex-device-login-handoff_plan.md). Evidence: [working history](2026-11-14-livetest-capability-repair_plan_history_636904a90e68e85090176544d2baa7c713cfc39515e9e825d7e7faa290567b89_completed.md). Preserve unrelated changes. No branches/worktrees authorised.

**Spec:** [Capability repair](../specs/2026-11-14-livetest-capability-repair_spec_completed.md)

**Approval:** James approved all ten sections of review `dr_4581e84b-3c75-42cb-81a2-56d62fbf2dc1`, including the ten original requests and additional parked jobs. Proceed within the approved design and existing boundaries; acceptance still requires actual verification.

## Task 1: Re-investigate unanswered readiness questions

- [x] Reproduce cached unanswered question reuse in current focused tests before editing.
- [x] Add owner-authorised `recheck-readiness` item control through shared payload/tool schemas, coordinator and state transition. Only untouched waiting questions qualify; active/landed/branch-owned work is refused. Recheck clears the pending question and enters discovery, never inserts an answer, never starts a worker directly, and preserves human answer memory.
- [x] Stop reusing unanswered live-test readiness memory as current capability evidence in new runs; keep actual human answers. Reset relevant triage attempt bookkeeping for explicit recheck. Preserve pause/cancel and authorisation semantics.
- [x] Cover owner/foreign/queue-worker callers, invalid state, answer race, paused run, durable restart, old persisted records and schema/tool compatibility. Update discoverable tool documentation and focused tests.
- [ ] Verify focused tests and canonical project gates, then independent review.

Primary files: `packages/contracts/src/schemas/plan-queue.schemas.ts`, `src/main/mcp/plan-queue-tools.ts`, `src/main/plan-queue/plan-queue-coordinator.ts`, `plan-queue-state.ts`, `plan-queue-triage.ts`, `plan-queue-triage-memory.ts`, relevant specs and CLI docs. Trace all consumers before choosing exact edits.

## Task 2: Structured capability investigation and repair

- [x] Extend existing durable worker reports with bounded structured capability evidence, originating check and canonical repair-plan reference. Keep persisted old reports readable; update tool and remote-file producers together.
- [x] Require missing-ability reports to distinguish current attempts, safe alternatives, genuine permission/identity boundaries and expected observable repair success. Validate at runtime and make the evidence available to the checker and owner.
- [x] Implement canonical repair links using existing queue ownership. Deduplicate shared repairs, retain per-check verification, bound retries and detect cycles. A repair handoff is never shown as actively running until an actual job owns it.
- [x] Integrate readiness, worker, verifier and parent messages. In-scope repair is designed, planned, implemented and verified; out-of-scope work is a linked handoff. Never auto-answer authority questions or launch nested queues.
- [x] Re-triage linked origins only after independently verified repair; rerun original checks before closure. Test recovery, cancellation, missing plan, repeated reports, conflicting ownership and stale success.

Implemented interface: four capability tools cover authenticated gap reports, checker runtime receipts, per-check acceptance evidence and ordinary-owner authorisation. Migration 57 persists repairs and per-item/check origins independently of turn reports. One generated guarded plan becomes one ordinary derived queue run; unchanged routing, account/provider restrictions, normal plan gates and source pause/cancel/stop boundaries apply. Cross-project repairRepository metadata creates a linked owner handoff only. Landing (since 20 November, whatever else landed alongside it) triggers a fresh original retry, never an original PASS; a failed rerun holds the repair until its owner resumes the original job. Existing queue item details and targeted status expose actual repair state. Focused regression evidence and gate results are in the working history. The end-to-end live run of this path is deferred to the live-test document.

## Task 3: Existing blocked checks and remote fixtures

- Executing [the existing-blockers plan](2026-11-14-livetest-existing-blockers_plan.md) against real accounts is deferred: see [the live-test document](2026-11-14-livetest-capability-repair_livetest.md). Each of the ten source documents stays open until its own requirements pass.
- [x] Implement only gaps demonstrated by probes: the probes demonstrated `--packaged`, owned-profile and remote-only launch, all landed; Codex native sign-in is owned by its [own plan](2026-11-15-codex-device-login-handoff_plan.md).
- [x] Record precise genuine human boundaries separately from technical prerequisites: live-test document checks 6 (sign-out approval) and 8 (CAPTCHA, billing identity, ownership facts). No real account was signed out and no production session interrupted.

## Verification and review focus

Run the affected focused suites before and after changes, then `npm run checks` and `npm run test:quiet`. Use remote test app and Browser Gateway with preflight for runtime checks; no local GUI fallback. Independent reviewer uses `task-completion-gate`. Particular risks: recheck silently becoming permission, stale cached answers crossing scope, repair recursion, lost evidence after restart, and cleanup touching another test's resources. Active plans/specs remain untracked; close only fully implemented and verified deliveries.
