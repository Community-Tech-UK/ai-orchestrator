# Continue the ten plans after the chosen Harness update

Status: deferred, never submitted for approval. The related Work Finder post-restart handover records James saying "No, we will restart in due time." Leave the shared app running; this document is saved context, not a renewed approval request. The independently reproduced cleanup failure has a test-only correction. All current normal checks pass on unchanged source; the new independent completion gate has passed with no unresolved repair findings. Do not submit another restart request while that recorded deferral stands. After James chooses a later update, verify the actual current candidate and running repair; do not reinstall an older saved package by assumption.

## 1. Restart Harness on this Mac

Installing the verified update and restarting Harness on this Mac would allow the ten existing Plan Queue entries to continue. Restarting would interrupt current Harness sessions, so that action remains deferred under the recorded decision.

Current recorded choice: **Wait**. **Restart now** would require James to explicitly change the timing; independent source acceptance alone does not grant that authority.

## What the repair changes

Creating or reattaching a working folder gets five minutes to finish. Ordinary Git commands retain their existing limit. A test that checked worker shutdown too early now waits for the actual shutdown call. Session-test cleanup now waits for an in-flight log write before deleting its temporary folder. Both retain their existing assertions and deadlines.

The update also contains the other local fixes already present in this checkout, including the separately reviewed recovery repair. Its independent acceptance and final installer contents must be checked before installation.

## Current verification

Both type checks, lint, the file-size check, both builds and the full uncached test suite pass for the current repair on unchanged source. The earlier independent run failed during temporary-folder cleanup; a traced real background write reproduced the race before the test cleanup was corrected. The identical delayed-write check, full session test file and adjacent persistence tests pass. The new independent completion review passed with no unresolved repair findings. The signed prepared update matches the final repair. This source acceptance does not verify the installed runtime or complete any original plan. No approval request has been issued yet.

## What happens afterward

I will confirm the repaired app is running, retry one stopped entry, then continue the existing ten plans through Plan Queue in dependency order. All ten remain open and none has been independently accepted as complete in this execution.

Technical handoff: [active repair plan](2026-10-18-plan-queue-checkout-timeout_plan.md), [completed running-app check](2026-10-18-plan-queue-checkout-timeout_livetest_completed.md), and `_scratch/changed-plans-queue-2026-10-18/` for exact command receipts and queue references. The live-check continuation verified an update already running and resumed the first item; this historical decision document grants no installation/restart authority.
