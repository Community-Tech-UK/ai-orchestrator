# Installed-app session creation after removing the hidden governor cap

> **Found a defect while running these checks?** Record reproduced defects in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row,
> observed behaviour, root cause, required behaviour, acceptance), and add a matching
> implementation-status section in `docs/plans/2026-07-19-livetest-failure-remediation-followup_plan.md`.
> Per-check evidence stays here. Read `docs/plans/livetest-campaign-runbook.md` before a campaign.

Prerequisites: rebuild the installed Harness app through the normal local build/install pipeline,
then restart that installed instance with the new code. Source `build:main` and `build:renderer`
have passed; those commands do not update the installed app or its loaded singleton.
Do not discard sessions or the failed draft to make this test pass.

Implementation plan: [hidden resource governor cap](2026-10-01-hidden-resource-governor-cap_plan_completed.md).

## 1. Retry a manual session in the installed app

- [ ] Confirm startup's `Resource governor started` event reports `maxTotalInstances: 0`.
- [ ] Keep the previously retained sessions. With the same session-count conditions that caused
  the reported failure, James clicks **Retry** on his preserved draft, or starts a new session
  with a harmless test message and attachment through the ordinary composer.
- [ ] Expected: a session is created, the composer exits its failed-send state, and the provider
  receives the message once. No `resource governor (instance-limit)` rejection appears.
- [ ] Expected: existing hibernated conversations remain available and unchanged.

Why deferred: this Codex chat lacks the supported authenticated AIO repair CLI environment.
The currently running installed app still holds the old governor singleton. Operating Harness
through Computer Use is explicitly prohibited by the supplied instructions. This installed-app
check requires the new installed build and James's interaction; it cannot be replaced by a test
that silently removes existing sessions or invokes unrelated instructions from his screenshot.

Automated evidence already exercises the actual source and compiled governor with a real
InstanceStateManager holding 60 hibernated sessions, and separately checks explicit caps.
That verifies admission logic, not an installed-app UI submission.

## Completion

Record build identity, restart time, retained-session conditions, and observable submission
result here. Rename this file `_livetest_completed.md` only after every checkbox above passes.

## Evidence run — 2026-10-04 (orchestrating session, packaged app)

Build identity: `/Applications/Harness.app` built 2026-10-04 19:06 from `3d05e250e`; restarted
2026-10-04 20:45:59 BST (not by this session).

- [x] **Startup event — PASS.** `app.log` 20:45:50 BST, `ResourceGovernor` →
  `Resource governor started` with `config.maxTotalInstances: 0` (copy:
  `_scratch/lt-2026-10-04/orch/governor-started.log`; later lines in that file at 23:19–23:21 are
  isolated dev apps writing into the same log, also 0).
- [ ] **Retry under the original conditions — not observed.** Between 20:45 and 23:19 the packaged
  app logged 17 `Creating instance` and 16 `CLI spawned successfully` with **zero** `instance-limit`
  or resource-governor rejections. But the app restored only 20 sessions at start
  (`session-continuity/last-stop.json`), so the published map was about 37 sessions at most — below
  the 50 that triggered the original failure. This is consistent with the fix, not proof of it
  under the reported conditions. James's preserved draft was not retried and no composer
  submission with an attachment was made (installed-app UI, hard-denied for Computer Use).
- [ ] Existing hibernated conversations unchanged — not separately checked.

Open: the UI retry under at least 50 retained sessions.
