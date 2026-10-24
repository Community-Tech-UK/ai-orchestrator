# Oct-2 housekeeping: deferred live checks

Status: pending; implementation/unit, integration, static and build evidence is in [history](2026-10-20-oct2-housekeeping_history.md).
Plan: [housekeeping](2026-10-20-oct2-housekeeping_plan.md).

Prerequisites: coordinator integration and a rebuilt/restarted Harness containing this work **and Phase A’s safety fixes**. Do not restart the running app merely to run these checks. Use the Windows PC through Browser Gateway, with worker/browser health preflight and explicit `computer: windows-pc`; never use the local Mac desktop. Browser transport failure requires gateway health/recovery, not a local fallback. No browser health claim is made by the separate filesystem symlink probe.

Remediation: read [campaign runbook](livetest-campaign-runbook.md) before execution. A reproduced defect gets a new LT-NNN index row and full observed/root-cause/required-behavior/acceptance entry in [remediation register](livetest-remediation-register.md), plus implementation status in [remediation plan](2026-07-19-livetest-failure-remediation-followup_plan.md). Keep per-check evidence here. Rename this document `_livetest_completed.md` only after every check passes.

## 1. Storage offers and actual freed bytes

- [ ] Open Settings → Storage in the rebuilt instance from Windows. Refresh; compare total bytes with the app-owned storage inventory. Confirm weekly change says unavailable until a 7–8-day-old measurement exists, then shows the measured signed change. Never manufacture a historical baseline in James’s data.
- [ ] With the ledger at least half free pages, confirm “Shrink now (frees about …)” opens a preview showing required/available disk, starts no work before confirmation, and Cancel/Escape preserve the file. Only James may approve the real operation. After approval, observe completion and compare actual disk bytes before/after with the result, retaining history.
- [ ] Review old learning database backups; confirm the newest is retained and July copies are listed with sizes. Cancel first. If James approves deletion in the dialog, record the selected files and actual freed bytes.
- [ ] Review saved states; confirm only >30-day records absent from History and outside live/hibernated/unsaved sessions appear. Cancel preserves files. Record any James-approved cleanup separately.

Why deferred: effects on James’s stores require the rebuilt instance and his click-time confirmation. Fixture tests already cover tickets, age/history/live checks, shrink threshold and filesystem changes. No scripts have mutated those stores.

## 2. Old work folders and Restore

- [ ] In Storage’s existing leftover-work-folders card, check age, bytes, clean/dirty status, unpushed count and process visibility. Active AIO owners and unknown process/push probes must block removal. Windows cannot currently prove process CWD, so removal is deliberately unavailable there; confirm its reason is visible.
- [ ] On a backend with reliable process-CWD inspection, use a disposable recorded retired folder with tracked/untracked/ignored fixture files. Review Archive and remove, cancel once, then confirm through the approval route. Confirm the private recovery entry survives restart and Restore reconstructs all fixture contents/permissions without overwriting any existing path. Recovery opens detached; original staging is not restored; archive stays.

Why deferred: the actual rebuilt UI and OS process checks differ by backend. Real archive integrity, restart recovery, races and corruption refusal already pass fixture integration tests. Never use an active queue folder or silently remove a pre-existing user folder.

## 3. Opted-in CLI auto-update

- [ ] With `cliUpdatePolicy=auto`, keep idle and hibernated sessions open. When a safely installable update is genuinely available, observe it apply while these sessions remain open. Do not install a downgrade solely to create a test.
- [ ] Keep one session mid-turn and one holding approval. Confirm the pill shows the number waiting; settle both and observe the update retry without the six-hour poll delay. Pending approvals must block, even if an instance otherwise appears idle.
- [ ] Open remote computer details; confirm plain-word Claude floors (resumed 2.1.300, side questions 2.1.299, tool-search stability 2.1.302) and Copilot 1.0.100 guidance. These are requirements, not claims that unreported remote versions passed.

Why deferred: applying a real external CLI update needs an available safe update and James’s existing opt-in on the rebuilt runtime. Unit tests exercise the exact guard, subscriptions and pill state.

## 4. Savings responsiveness

- [ ] Open Settings → Savings against the real large RTK store. First scope is seven days. Navigate elsewhere while refresh runs; the main process must remain responsive. Reopen: last successful result appears immediately with “Refreshing…” until replaced.
- [ ] Compare a sampled seven-day total with a read-only independent query, retaining source coverage and mix. Verify any project above 2,000 recorded commands in the rolling hour gets the refresh-driven notice. No burst is required to be manufactured in the real database.

Why deferred: large-store wall-clock responsiveness needs the restarted app. Native worker smoke and rollup/IPC/renderer fixtures already pass. Cached results survive tab reopen within a running renderer, not app restart.

## 5. Observation retirement and Wake

- [ ] After first start on the migrated build, observation memory is off, its navigation/route is hidden, and no observation prompt block appears. Existing expired-row cleanup runs despite capture being off. Confirm startup/daily counts in logs.
- [ ] Confirm queue, loop and scheduled sessions never capture observations, including descendants. If James explicitly enables observation memory again, verify prompts and worker retrieval enable together; then restore his chosen setting. Do not toggle his setting without that choice.
- [ ] Wake shows distinct/total/shown-this-week summary; legacy and duplicate rows appear under Hidden; counts say “shown”. Delete only a fixture note with confirmation and rerun its miner: it must stay deleted.

Why deferred: startup migration, actual prompts and interactive navigation require the restarted runtime. Migration, worker opt-in/off, machine exclusions, rendered Wake and SQLite tombstone/miner paths are tested in-loop.

## 6. Copilot first-message instructions

- [ ] After Phase A’s restart, start a permitted fixture Copilot session in this project. Inspect the actual first provider message via supported diagnostics: Harness instructions must be present, and the project AGENTS body should occur once. Do not expose tokens, credentials or unrelated prompt bodies in evidence.

Windows filesystem evidence: actual file symlinks work, but repository `core.symlinks=false`; use one-line `CLAUDE.md` importing AGENTS. Local `copilot instruction list --json` reports AGENTS plus the tiny literal import source, and inspection of the installed loader confirms it reads raw content and deduplicates equal bodies/real paths rather than expanding imports. This is not evidence of the rebuilt Harness first message.

Why deferred: the required startup-delivery check explicitly depends on Phase A’s restarted app. No restart or live first-message claim was made in this task.
