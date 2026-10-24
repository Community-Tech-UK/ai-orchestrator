# Phase A live validation

Status: pending integrated build and safe restart by James. No live check below is claimed passed.

Plan: [Phase A safety and truth](2026-10-20-oct2-phaseA-safety-and-truth_plan.md)
Evidence: [implementation history](2026-10-20-oct2-phaseA-safety-and-truth_history.md)

## Remediation flow and prerequisites

Read `docs/plans/livetest-campaign-runbook.md` before running the campaign. A reproduced defect must have an LT-NNN entry in `docs/plans/livetest-remediation-register.md` and an implementation-status section in the active `2026-07-19-livetest-failure-remediation-followup_plan.md`. Per-check evidence belongs here. Rename this document `_livetest_completed.md` only after every check passes.

Prerequisites: queue independent verification, coordinator integration, packaged build from the root checkout (`npm run localbuild`, never this worktree), and James installing/restarting only when no live sessions would be lost. The worktree's main/renderer build checks do not update the installed app. Do not start a packaged app on the Mac or write real databases/settings from scripts. Browser/desktop inspection must use the Browser Gateway on `windows-pc`, with worker and browser-channel health checked first. If unavailable, report the exact failure and leave that check blocked; no Mac fallback. Project automated headless tests have already covered the agent-runnable paths.

## 1. Installed build and cost-history protection (Steps 1–2)

- [ ] Before the safe restart, take a read-only snapshot (`sqlite3 'file:<data-folder>/rlm/rlm.db?mode=ro'`) of `SELECT model,COUNT(*),SUM(cost) FROM cost_entries GROUP BY model;`, plus Claude alias rows since **1792222279000** (17 Oct 2026 08:31:19 BST = 07:31:19 UTC). Record the timestamp and aggregates here.
- [ ] On a previously un-repaired installation, after restart, no Claude alias row at/after that cutoff appears in `cost_entries_a0_backup`; the protected rows retain their original cost. Copilot and Cursor rows still use the migration-time cutoff and receive their repair.
- [ ] On James's current installation the old repair already ran. **LT-707 is open**: 913 protected backup rows, 338 changed, original $4,477.681085460001 versus current $3,801.4430545550003, a $676.2380309050008 reduction at the read-only audit. The cutoff fix intentionally does not rewrite an already-repaired database. Restore the affected rows only through a separately implemented and verified LT-707 remediation; confirm backup originals remain intact and no unrelated row changes. This acceptance requirement stays open until then.
- [ ] Settings > General > installed Harness/About card shows the running build commit and actual RLM/loop migration levels, matching the installed package's stamp and database state; missing/unavailable metadata says unknown rather than claiming a version.

Why live: the worker must not install/restart the app or mutate James's history. Existing-history restoration has a separate recorded code-remediation dependency, not a passed live test.

## 2. October accounting after one day (Step 2)

After the integrated restart, record its epoch as `<restart>` and wait one day:

- [ ] In the data folder's cost-attribution JSONL, `cross-model-review`/`fresh-eyes-review` purpose records appear for actually performed reviews.
- [ ] Read-only query `SELECT COUNT(*) FROM local_ai_routing_events WHERE created_at > <restart> AND actual_route='frontier' AND provider IS NULL;` returns 0.
- [ ] Consecutive Copilot rows represent individual turns (token deltas/cache occupancy correctly separated); compare the actual provider completion usage with the stored rows.
- [ ] The session header displays cost following Decision 15(a)'s one-time settings migration. Confirm the migration runs once and later explicit user preference changes persist.

Why live: requires actual reviews/helper calls/provider completions and elapsed one-day observation after installation.

## 3. Checker outcomes after one week (Step 4)

- [ ] Run queue work using Claude as checker for a week on the integrated build. From read-only loop-mode item/session records and attribution/log evidence, count checker sessions and those finishing without `plan_queue_report_verdict`. Record denominator, numerator, dates and query; rate must be under 5%.
- [ ] Observe a checker awaiting a real background helper: it remains tracked while an async inhibitor exists, resumes, and reports normally; foreground commands remain foreground. A first empty turn gets exactly one same-session verdict nudge before the next empty turn counts as errored.

Why live: unit tests cover state/nudge mechanics; the weekly production outcome rate requires elapsed real usage.

## 4. Parent-chat delivery after one day (Step 5)

- [ ] With `planQueueQuestionsDestination='queue-page'`, queue adoption/routing notices appear as system notes without starting a provider turn. Questions appear on the queue page. Switch to `parent-chat` and confirm questions reach that chat; restore the desired destination afterward.
- [ ] A run ends with exactly one model-visible summary. Its cost-attribution row carries purpose `plan-queue-parent` and `internalSource='plan-queue'`. A later ordinary user turn has its ordinary purpose.
- [ ] Read-only admission/log counts for children carrying `planQueueRole` show zero `child_completed` or `all_children_completed` deliveries to the parent. Visible completion notes and stored child results still exist. Record one-day count, denominator and evidence source.

Why live: production admission/cost rows and parent-provider wakeups require the rebuilt app and genuine queue work.

## 5. Codex usage and helper trial (Steps 6–7)

- [ ] Run ordinary queue/loop/scheduled Codex work plus an own chat. Check effective-window diagnostics: non-exempt machine work 272000, own chats native window, codex tuning no Harness override; large-plan exemption explicitly logged.
- [ ] Inspect the data-folder cost-attribution ephemeral usage log after threads end. Non-exempt machine threads must have no measured request input over 272000; report request-count-weighted mean input and compare with approximately 124K baseline. Exempt and unavailable-measurement cases must be distinguished, never treated as zero.
- [ ] Repeat the read-only finished-thread account/usage probe if the provider starts returning thread billing usage. The implementation-time 10-thread probe returned `threadUsage:null` for every thread, so no conclusion about plan-credit premium is supported.
- [ ] After Phase B lands the original helper-trial report, integrate/run the checked companion checker-pass-rate report for a further week. Include decided verdict counts and unknown outcomes per arm; unknowns must not inflate pass rates. Only if the off arm is no worse should a separately tested settings migration switch stored Harness-work trial settings off (Decision 13(a)); do not infer a week from a current snapshot.

Why live: provider billing endpoint returned unavailable data; request-size and trial comparisons need new real usage and elapsed observation. Phase B report integration is explicitly tracked in the active plan, not claimed complete here.

## 6. Close-session choices on Windows (Step 11)

- [ ] On `windows-pc`, open a parent with two running helpers and some conversation content. Its close tooltip carries helper count. Closing opens a dialog stating that it has two running helper sessions and offers both close-all and keep-helpers-running choices.
- [ ] Choose close-only: parent closes and helpers remain live as orphans. In a separate fixture choose close-with-helpers: parent and both helpers close. Confirm history remains accessible.
- [ ] A fresh idle session with a loaded empty transcript and no unsent draft closes without a dialog. An unsent draft, queued input, active loop/queue role, busy state or restored/unloaded transcript still requires confirmation.

Why live: headless store/dialog/runtime tests cover behavior; this last check requires the installed desktop UI and visible runtime tree after integration.
