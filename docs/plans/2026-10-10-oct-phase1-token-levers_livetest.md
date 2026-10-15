# October Phase 1 token levers: pending live checks

**Status:** active live-test document, untracked. Only Step 1a has reached a worker checkpoint; the implementation plan
remains open and blocked on integration of its Phase 0 dependencies. No live check below is verified.

**Plan:** [2026-10-10-oct-phase1-token-levers_plan.md](2026-10-10-oct-phase1-token-levers_plan.md).

**Prerequisites:** the coordinator integrates the Step 1a code; rebuild and restart the Harness instance used for testing
from that code. Use Codex CLI 0.162.1 with its normal signed-in profile. Screen/browser work runs on the Windows worker
`windows-pc`, after Browser Gateway health/preflight. A Mac screen check requires James's explicit permission for that task.
Do not restart James's running app or deploy from this worker merely to perform this check.

**Remediation flow:** before the campaign, read [livetest-campaign-runbook.md](livetest-campaign-runbook.md). A reproduced
defect receives a new `LT-NNN` index row and acceptance entry in
[livetest-remediation-register.md](livetest-remediation-register.md), with a matching implementation-status section in
[2026-07-19-livetest-failure-remediation_plan.md](2026-07-19-livetest-failure-remediation_plan.md). Keep per-check evidence here.
Rename this document `_livetest_completed.md` only when every recorded check passes with evidence.

## Step 1a: new and resumed Codex chats

- [ ] **Fresh chat:** in the rebuilt Harness instance, select Codex 0.162.1 and create a scratch chat in a scratch folder.
  Send “Reply with the word ready.” Expected: the first reply arrives; no `protocol-invalid`, unsupported-parameter or
  thread-start error occurs. Record the build revision, CLI version, instance/thread identity, observed reply and relevant
  redacted app-log lines. No extra Phase 1 settings are required; Step 1c is not implemented at this checkpoint.
- [ ] **Native resume:** after the fresh chat has finished its turn, hibernate it and wake/resume the same conversation
  through Harness. Send “Reply with the word resumed.” Expected: the same provider conversation resumes and the first
  follow-up reply arrives; there is no metadata-only-resume validation error or unexpected fresh-thread fallback. Record
  the before/after provider thread identity, reply and redacted app-log evidence.

**Why deferred:** unit tests verify the generated request contract and both production builds pass, but no running Harness
instance has been rebuilt/restarted from this queue worktree. The provider lifecycle and first real reply must be checked
in that rebuilt app. This deferral covers Step 1a only; it does not defer any unimplemented code or agent-runnable check.
