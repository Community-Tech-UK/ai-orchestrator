# Codex exec progress: installed-app confirmation

> **If a defect is reproduced:** read [the campaign runbook](livetest-campaign-runbook.md), record a new LT-NNN item in [the remediation register](livetest-remediation-register.md), and add matching implementation status in `2026-07-19-livetest-failure-remediation-followup_plan.md`. If that plan has already been closed, reopen it or create an active follow-up before adding content. Keep per-check evidence in this document.

Plan: [Codex exec progress repair](2026-10-15-codex-exec-progress_plan_completed.md)

Status: pending. These are installed-app checks, not gaps in the agent-runnable runtime verification.

## Prerequisites and reason for deferral

The installed `/Applications/Harness.app` was built before this source repair and still runs the old main process. Applying code to this checkout and compiling `dist/` does not hot-update that process. A normal authorised package build, installation and app restart must happen first. Do not interrupt active sessions to force this check. Harness itself is a prohibited desktop-control target, so the final installed-chat observation needs James or an authorised manual test session.

The real source and compiled exec pipelines have already been exercised with a local native child, including before-close output and exactly-once completion. Browser automation is not needed. Do not open a local Mac browser or attempt to automate Harness.

## Check 1: progress and command activity appear during work

1. After installing/restarting a build containing this repair, create a fresh local Codex session with hardened mode enabled, in a disposable local working directory.
2. Give it this benign prompt: `Say “Starting the progress check.”, run rtk proxy node -e 'setTimeout(() => console.log("Progress check complete"), 5000)', then say “Finished the progress check.” Do not edit files or contact any services.`
3. During the five-second command, observe the opening assistant update and command activity in the chat while the session remains active.
4. After completion, observe the command result and final assistant update. Neither opening nor final text should repeat as a second combined transcript.

Expected: progress is visible before completion; output remains in chronological order; the session becomes idle only after completion. The mode-selection log explains hardened subprocess isolation rather than claiming app-server is missing.

Evidence: pending.

## Check 2: an ordinary failed command stays visible and recoverable

1. In the same session, ask Codex to run `rtk proxy node -e 'process.exitCode = 2'`, explain the expected failed command, then run `rtk proxy node -e 'console.log("Recovery check complete")'`. Tell it not to edit files or contact services.
2. Observe the first command marked as failed, followed by the successful command and Codex's explanation.

Expected: a failed tool result is distinguishable from a session crash; later progress continues visibly and results are not duplicated at completion.

Evidence: pending.
