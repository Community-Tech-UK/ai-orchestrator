# Provider swap account scope: live checks

Status: pending. Requires James to run Harness after loading the rebuilt main process, with a signed-in MiMo account and an eligible signed-in Codex account. Do not interrupt active sessions to restart the app.

Plan: [provider swap account scope](2026-10-14-provider-swap-account-scope_plan_completed.md).

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md). Record a reproduced defect in [remediation register](livetest-remediation-register.md), with a matching implementation-status section in `2026-07-19-livetest-failure-remediation_plan.md`. Keep per-check evidence here and rename this document `_livetest_completed.md` only when every check passes.

## 1. Switch the reported MiMo chat to Codex

1. After safely restarting Harness with the rebuilt code, reopen the affected chat or a MiMo chat with an existing user message.
2. In the composer model picker, choose a Codex model from the available list. Use the normal permission settings; no new flags are needed.
3. Check that the composer changes to Codex and displays a Codex account, the transcript reports the provider change, and the existing conversation remains visible.
4. Send a short continuation and check that Codex responds with access to the prior conversation.

Expected: no removed-Codex-account error caused by a MiMo profile; no stale MiMo account displayed for the Codex runtime. A genuinely missing or signed-out destination account still receives its normal routing error.

Why deferred: the running Harness holds pre-change main-process code. The Harness itself is a hard-denied desktop automation target; a production provider turn also needs real sign-ins and an app restart. Agent-runnable reconciler/routing/persistence checks run in the automated suite and are not deferred.

## 2. Confirm selection survives restart

1. Let the Codex turn finish, then safely restart Harness.
2. Resume the same conversation and send another short continuation.

Expected: the conversation resumes on its selected Codex account, with no reference to the former MiMo profile.

Why deferred: requires the restarted app and real provider sign-in. Automated coverage verifies the destination account stamp reaches the continuity update payload.

## 3. Confirm the existing OpenCode capacity correction is loaded

1. In the rebuilt Harness, with six idle OpenCode/MiMo sessions present and enough machine capacity, start another MiMo session.
2. Check that it starts without the earlier 60-second OpenCode concurrency-slot failure caused by a six-session ceiling.

Expected: the seventh session is admitted under the existing 20-session cap. This does not claim unlimited sessions; the remaining cap is intentional.

Why deferred: the recorded incident used limit 6; source and rebuilt output already contain the separate existing cap correction, but the currently running process cannot adopt it without restart. The focused limiter tests verify admission beyond six sessions locally without starting real provider processes.

## Evidence

Pending live confirmation. Never record credentials, provider keys, or conversation text here.
