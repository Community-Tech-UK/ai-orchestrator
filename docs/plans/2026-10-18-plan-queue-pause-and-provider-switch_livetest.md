# Plan Queue pause and provider switch: live checks

Status: pending real provider sessions in a rebuilt, restarted app. Automated runtime/component tests cover the deterministic transitions, real Git checkpoint/revert/landing paths, provider routing and page controls; these checks do not claim live provider or spend evidence.

Plan: [2026-10-18-plan-queue-pause-and-provider-switch_plan_completed.md](2026-10-18-plan-queue-pause-and-provider-switch_plan_completed.md).

Prerequisites: use a rebuilt/restarted Harness containing this change and signed-in automation-allowed accounts on two installed providers. Never restart the active Harness with live sessions. Use an isolated dev instance or a restart James has authorised. Run against a disposable scratch repository, never the real backlog. Browser/UI work must start with Browser Gateway health/preflight targeting `windows-pc`; if it cannot do the job, report the failed check and ask whether to use the Mac, wait or skip. No local browser/desktop use is authorised by this document.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running. A reproduced defect goes in [livetest-remediation-register.md](livetest-remediation-register.md) as a new `LT-NNN` item, with matching implementation status in a remediation plan. The [existing remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is closed: reopen it by removing its `_completed` suffix, or create a dated follow-up, before adding status. Keep dated per-check evidence here; never add content to a closed `_completed` document.

## Scratch setup

Create a temporary Git repository on `main` with one committed source file and two untracked `*_plan.md` documents asking workers to make small distinct changes and record as-built notes. Configure worker slots to one initially so Pause can be observed. Keep normal safety/account settings; use accounts allowed for automatic work. On the Plan Queue page start a Plans run scoped to this repository. Record selected worker/checker providers and the initial spend label. Never use production plans for these checks.

## 1. Pause a live worker and Resume

- [ ] While its worker is producing output, press the run's Pause button. Expected within seconds: its queue worker/triage/checker sessions stop, status is Paused, held documents show Paused, the same branch and working folder remain. The working folder's `git status --porcelain` is clean and its log has the pause checkpoint if there were edits. An unresolved merge instead remains uncommitted on disk. No further spending is reported once in-flight provider usage has settled.
- [ ] Press Resume. Expected: a fresh worker on the same branch and working folder uses a resume prompt, continues from existing work and does not reinstall an already present dependency folder.

Why deferred: requires real running provider processes and final provider usage reporting, which scripted queue instances cannot establish.

## 2. Pause a checker

- [ ] Let a worker finish and a checker start; press Pause during checking. Expected: checker stops, its edits are discarded back to the checkpoint, document waits as Paused, and round/errored-round counters do not increase.
- [ ] Press Resume. Expected: a new checker judges the saved work again without a worker fix turn caused by the interrupted check.

Why deferred: confirms termination of a real checker process and its provider session; checkpoint/reset behavior is already exercised with real Git in automated tests.

## 3. Pause, Change, Resume

- [ ] Pause a worker, open Change beside the run's providers, choose another installed worker provider and an automation-allowed account; choose a checker allowed by the diversity rules. Save.
- [ ] Expected: current provider line updates, parent session receives the change notice, no session starts while paused. Resume starts worker/triage/checker sessions on the saved providers/accounts. Check both the session header and account chip.
- [ ] Change back to Same as the session that started the run. Expected: the original starting route is restored even after previous changes. Saved defaults for new runs stay unchanged.

Why deferred: needs signed-in provider accounts and live session account headers.

## 4. Move documents already in progress

- [ ] During a running worker session, open Change, select another worker/provider account and tick Move documents in progress now. Save.
- [ ] Expected: old sessions stop, saved work remains on their branches, fresh sessions start with the new route; a document already landing finishes its serial landing.
- [ ] Repeat with the box unticked. Expected: the current session continues on its original provider, and its next fresh session uses the changed route.

Why deferred: confirms real CLI lifecycle and account selection; both branches have scripted runtime coverage.

## 5. Restart with a paused run

- [ ] Pause a scratch run, record item/branch state, then restart only the isolated dev instance (or an otherwise authorised app instance).
- [ ] Expected: no queue session starts, no item parks as cancelled, branches and working folders remain, and Resume continues on the selected route.

Why deferred: needs process restart and persistence recovery in the rebuilt application; store migrations and recovery transitions are automated.

## 6. Pause all and Resume all

- [ ] Start two scratch runs. Pause just one: the other keeps running. Press Pause all and confirm every remaining running run pauses and the count changes.
- [ ] Press Resume all and confirm both runs restart their held work. Finished runs are unaffected.

Why deferred: visual confirmation across real provider sessions; page/component and multi-run coordinator behavior are automated.

## 7. Parent-session controls and refusals

- [ ] From the run's parent call `plan_queue_control` with pause, then set-routing and resume using the documented tool arguments. Expected: the same stop/save/resume behavior and current route shown on the page.
- [ ] In a protected work scope, a parent-supplied checker list is refused with a reason, while James's page edit is allowed. An unrelated session cannot set routing even when the original parent is gone; bulk pause/resume are page-only.
- [ ] Try an uninstalled CLI or an account restricted to manual use. Expected: plain refusal, stored route unchanged and editor draft retained. A relaxed run may choose an excluded provider but still cannot use a manual-only account.

Why deferred: checks the rebuilt app's actual tool connection and installed provider/account environment; contract, authority and resolver refusal tests already run automatically.
