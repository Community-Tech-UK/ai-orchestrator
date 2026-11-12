# Live tests — worktree clean-up gaps

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `2026-11-02-worktree-cleanup-gaps_plan_completed.md`

## Status — 2026-11-12

On main: yes (this landing commit)
Open: 0 · Closed: 2 · Failed: 0. Check 1 is closed on the real data. Check 2 is closed on its **revised** wording (below): the
original step, which named four real queue rows in their starting state, can no longer be run by anyone, because those rows were
discarded by other tools between 5 and 10 November. The revision is recorded in the check itself; the evidence is in
"Evidence run — 2026-11-12".

**Prerequisites:** the installed Harness rebuilt from a build containing this change and restarted by James
(never restart Harness while sessions are live). Each check needs that first start; unit tests cover the logic,
these confirm the startup steps run against real data. Read the database with `sqlite3 -readonly` only:
`~/Library/Application Support/harness/loop-mode/loop-mode.db`.

## 1. The loop parked on a usage limit since 17 September is closed and its folder removed

Why deferred: the closing and folder removal happen only in the startup steps of a rebuilt app.

Steps:
1. Before restarting, confirm the row is still parked and has no resume scheduled (no enabled automation named
   "Resume loop after … quota reset" for this loop in the Automations page):
   `select status, ended_at from loop_runs where id = 'loop-1789608176316-f9af53a7'` gives `provider-limit` and
   an empty `ended_at`, and `ai-orchestrator/.worktrees/task-please-work-through-all-the-li-mu4ui30h` exists.
2. Restart the rebuilt Harness.
3. Re-run the query and list the folder.

Expected: status `cancelled`, `end_reason` `closed: parked on a usage limit for over two weeks`,
`json_extract(worktree_lifecycle_json,'$.phase')` is `cleaned`, the folder is gone,
`git branch --list task-please-work-through-all-the-li-mu4ui30h` still lists the branch, and app.log has
"Loop store: closed loops parked on a usage limit for over two weeks".

## 2. Queue records of folders removed by hand are cleared on the first queue pass

Why deferred: needs the rebuilt app's scheduler running against the real queue database.

**Revised 2026-11-12.** The original steps named four real rows (`0a6372e3`, `f2706268`, `4a01a646`, `a0a07ba7`) and needed
them in their 2 November state (a folder recorded, folder removed by hand). The rebuilt Harness has run since, and the Set aside
agent or a session discarded all four (5, 7 and 10 November), which empties `branch_name` and `worktree_path` by a different
route. Their starting state cannot be recreated in the real database, and no log line from the first pass survives
(oldest retained log: 11 November). The check now asks for what it was meant to show: the real queue holds no stale folder
record, and the same queue pass, run in the built app, clears one when it finds it.

Steps:
1. Real database, read-only: for every `parked` or `landed` item in `plan_queue_items` with a non-empty `worktree_path`,
   test that the folder exists on disk. Expected: none is missing.
2. Seeded run: build the app, start it on an isolated profile (`AIO_DEV_USER_DATA_PATH`) whose queue database holds a finished
   run and four parked items: two whose recorded folder is absent (detail ends "Worktree kept at …"), one whose folder has a merge
   in progress, one clean checkout at its checkpoint commit. Wait for the first queue pass.

Expected: step 1 finds no missing folder. Step 2: the two absent-folder items have an empty `worktree_path` and no "Worktree kept …" note,
branches kept; the merge-in-progress item keeps its folder untouched with app.log line "Plan queue: a kept folder still cannot be
removed; trying again later"; the clean item has its folder removed, branch kept.

**Limit that stays:** step 2 runs the real code on seeded rows, so it does not prove what happened to the four named real rows
on 2 November. That is unobservable now and is recorded, not claimed.

## Evidence run — 2026-11-12

Run by a Plan Queue livetest worker. Build: `npm run build:main` from the queue worktree (exit 0). The real Harness had
already been restarted on a build containing this change (see check 1), so no restart of James's app was needed or done.
Read-only access to the real database (`sqlite3 -readonly`); no write to it.

### Unit tests behind the "unit tests cover the logic" claim — PASS

`npm run test:quiet -- src/main/orchestration/loop-store-close.spec.ts src/main/plan-queue/plan-queue-kept-folders.spec.ts`,
run 2026-11-12 in the queue worktree: exit 0, "2 files · 13 tests passed in 1.5s". These cover the loop-closing step and the
kept-folder retry; they do not replace the live checks below.

### Check 1 — PASS (real data)

Real database `~/Library/Application Support/harness/loop-mode/loop-mode.db`, read 2026-11-12:

- `select status, ended_at, end_reason, json_extract(worktree_lifecycle_json,'$.phase') from loop_runs where id='loop-1789608176316-f9af53a7'`
  gives `cancelled | 1789608178949 | closed: parked on a usage limit for over two weeks | cleaned`. The end reason is the exact
  text only `closeStaleProviderLimitParks` writes (`src/main/orchestration/loop-store-close.ts:31`). `ended_at` is the loop's last
  activity time by design (`closeParkedRun`), so it is not the closing time.
- The closing happened at startup on 2026-11-02 09:48:27 local: `loop_checkpoints.updated_at` for that loop is that time
  and its checkpoint status is `cancelled`; the lifecycle `updatedAt` is 1793612908613 (the same moment).
- `.worktrees/task-please-work-through-all-the-li-mu4ui30h` no longer exists; `git branch --list task-please-work-through-all-the-li-mu4ui30h` still lists it.
- Not recoverable: the app.log line "Loop store: closed loops parked on a usage limit for over two weeks". The oldest retained
  log (`app.log.4`) starts 2026-11-11 04:28, after the 2 November start. The "before" state (step 1) was likewise not captured.
  The database row, the folder and the branch above are the evidence instead.

### Check 2 (revised) — PASS on the revised wording; the original named-row run is unobservable

Step 1, real data (read-only, 2026-11-12 07:31): `select state, count(*) from plan_queue_items where worktree_path is not null and worktree_path<>'' group by state`
gives fixing 1, landing 4, parked 7, queued 25, verifying 1, working 3. For the 7 `parked` items (the only parked/landed
rows with a recorded folder) every recorded folder exists on disk; none is missing. So the real queue holds no stale record now.
(Side observation: `.worktrees/queue/2026-10-18-plan-queue-checkout-82a77c`, the old folder of discarded item `a0a07ba7`, is still on disk with only `_scratch` and
`node_modules`, no `.git`; the item no longer records it, so no queue pass will ever visit it.)

Step 2, seeded run. Why seeded:

The real rows cannot be re-observed in their starting state: `0a6372e3` and `f2706268` were discarded by the Set aside agent on
2026-11-05 19:45:30, `a0a07ba7` was discarded 2026-11-07 12:01:18 and `4a01a646` was discarded 2026-11-10 16:49:56. Their
`branch_name` and `worktree_path` are empty now, set by that discard path, and no log line for them survives. A real-data
confirmation of this check is therefore impossible. Instead the same startup path was run for real in the built dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-c7abf34c`, `--remote-debugging-port=9641`, no renderer needed: both steps are main-process)
against a seeded database in a throwaway git repository. This runs the real code (`PlanQueueKeptFolders.retryDue` from the pump,
`closeStaleProviderLimitParks` from the Loop store startup step); it does not prove the real queue database's rows.

Seeded before (all queue items `parked`, one finished queue run):

| Stand-in for | Folder recorded | State on disk |
| --- | --- | --- |
| `0a6372e3` | `.worktrees/queue/lt-a`, detail ends "Worktree kept at …" | folder absent, branch `queue/lt-a` present |
| `f2706268` | `.worktrees/queue/lt-b`, same | folder absent, branch present |
| `4a01a646` | `.worktrees/queue/lt-c` | merge in progress, `UU f.txt` |
| `a0a07ba7` | `.worktrees/queue/lt-d`, detail ends "Worktree kept at …" | clean checkout, HEAD = checkpoint commit |

Also seeded for check 1's path: loop `loop-lt-parked-old` (`provider-limit`, started 20 days ago, managed folder `.worktrees/task-lt-parked`,
no scheduled resume) and a control `loop-lt-parked-recent` (`provider-limit`, started 1 day ago).

After starting the app (log lines are from the app's stdout, 2026-11-12 07:07 UTC):

- `[AppInitialization] Loop store: closed loops parked on a usage limit for over two weeks { loopRunIds: [ 'loop-lt-parked-old' ] }`
- `[PlanQueueKeptFolders] Plan queue: a kept folder still cannot be removed; trying again later { itemId: '4a01a646-…0003', error: 'A merge is in progress with unresolved conflicts: f.txt' }`
- `[PlanQueueKeptFolders] Plan queue: removed a folder an earlier clean-up had to keep { itemId: 'a0a07ba7-…0004', worktreePath: '…/.worktrees/queue/lt-d' }`

Database and disk afterwards:

- `loop-lt-parked-old`: `cancelled`, `closed: parked on a usage limit for over two weeks`, lifecycle phase `cleaned`; folder `task-lt-parked` gone, branch `task-lt-parked` still listed.
  `loop-lt-parked-recent` is untouched (still `provider-limit`, no end reason).
- `0a6372e3` and `f2706268` stand-ins: `worktree_path` empty, `detail` is now just `Stopped.` (the "Worktree kept …" note removed); branches `queue/lt-a`, `queue/lt-b` still exist.
- `4a01a646` stand-in: `worktree_path` unchanged, folder still there with `UU f.txt` (merge untouched).
- `a0a07ba7` stand-in: folder removed, `worktree_path` empty, branch `queue/lt-d` still listed, note removed.

One incidental log line, not a defect for this change: `Plan queue plan diet failed … Plan diet requires regular directory ancestors` for the seeded
document, which sits under `/tmp`; the checkpoint continued as designed.

Cleanup: the dev app was closed over CDP and confirmed gone; the throwaway profile, repository and logs were deleted.
