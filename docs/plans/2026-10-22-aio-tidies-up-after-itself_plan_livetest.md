# AIO tidies up after itself: installed-app checks

Status: pending; not verified in the installed app.

Prerequisites: build and install a Harness containing the linked implementation, then let James restart it
(never restart Harness with live sessions). Checks run on the Mac's main Harness instance; no browser work is
needed. Read logs from `~/Library/Application Support/harness/logs/app.log`.

Implementation: [implementation plan](2026-10-22-aio-tidies-up-after-itself_plan.md).

Remediation flow: [campaign runbook](livetest-campaign-runbook.md). A reproduced new defect must be recorded in
[the remediation register](livetest-remediation-register.md) and the active remediation plan, following current
instructions. Do not edit a closed `_completed` document; reopen it or create a dated follow-up.

## Check 1: the code index gives its space back

- [ ] Before restart, record `ls -la ~/Library/Application\ Support/harness/codemem.sqlite*` and
  `sqlite3 -readonly …/codemem.sqlite "pragma freelist_count"` (2026-10-22: 97 GB file, 41 GB WAL,
  20.2M free pages).
- [ ] Within an hour of restart: `codemem.sqlite-wal` is at most a few hundred MB, and `app.log` (or the index
  worker's log) shows `Codemem space reclaim ran` or `Codemem maintenance … walTruncated` entries.
- [ ] Over the following day: `codemem.sqlite` shrinks steadily towards ~15 GB and `freelist_count` falls.
  If it does not shrink and `Codemem maintenance could not finish shrinking the database` repeats, a
  long-lived reader is holding the WAL: record which connection.

Why deferred: needs the rebuilt main process and index worker against the real 97 GB database. The test
SQLite driver cannot share a WAL between connections; the busy-reader case was reproduced with the
`sqlite3` CLI only.

## Check 2: chats started in the home folder are not indexed

- [ ] Start a chat with working folder `~`. Expected: log line `Codemem warm-up skipped broad filesystem root`;
  `sqlite3 -readonly …/codemem.sqlite "select abs_path from workspace_root"` gains no `~` row.

## Check 3: Codex backups are trimmed

- [ ] After restart, `ls ~/.ai-orchestrator/codex/backups | wc -l` drops from ~445 to the newest 5 plus any
  from the last 7 days; `app.log` shows `Pruned old Codex state backups`.

## Check 4: new agents get the disk hygiene guidance

- [ ] Start a new chat and open its context details. Expected: a `Disk hygiene guidance` entry marked supplied.

## Check 5: old scratch folders are swept

- [ ] Ten minutes after restart, `app.log` shows `Swept old scratch folders` with a removed count.
- [ ] Folders reported as kept for unsaved work in the 2026-10-22 dry run are still present:
  `~/work/communitytech/_scratch/move-backups-20260914`,
  `~/work/communitytech/work-finding/apps/radar/_scratch/radar-integrated-fresh-gate-20261008`,
  `~/work/orchestrat0r/ai-orchestrator/_scratch/local-review-fixture`. James sees one notification listing
  kept folders.
- [ ] `_scratch` entries changed in the last 14 days are untouched.

## Check 6: low-disk warning

- [ ] Observational: the next time free space on the Mac drops below 50 GB, a "Your disk is getting full"
  notification appears (critical below 10 GB). Not staged deliberately, because filling the drive is
  harmful; record the first natural occurrence.

## Evidence already run locally

Unit and real-git tests cover each behaviour (see the plan's Verification section). These source checks do not
replace the installed app's main process; every live checkbox above remains pending.
