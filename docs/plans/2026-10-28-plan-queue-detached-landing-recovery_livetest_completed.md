# Plan Queue detached-landing recovery: running-app checks

Status: run on 12 November 2026 (evidence sections at the end). Checks 1 and 2 pass. Check 3 passes on the second pass: every one of the 17 items now has a recorded outcome (second evidence section). One separate defect found along the way is filed as LT-1030 (recorded landed commits that are not on `main`); it does not change these results.

Plan: [detached-landing recovery](2026-10-28-plan-queue-detached-landing-recovery_plan_completed.md). This document closes the checks that need the rebuilt, installed app and the real work-finding queue.

**Prerequisites:** the change must be committed and built into the installed Harness app, and the app restarted on that build. Installing or restarting interrupts James's running app, so it needs his go-ahead at the time. When the code was finished on 28 October it was **not committed**, because `plan-queue-worktree.ts` also holds another session's uncommitted work that this change depends on (`PlanQueueCheckoutOwnershipError`). Commit both together, or after theirs lands, before building.

Why these cannot run now: the source tests drive real Git in temporary repositories, not the installed app's queue, its database or James's real stuck item.

## 1. The stuck work-finding item comes back

Item `73a4c35d-d7e8-4992-940a-da626f028d52`, branch `queue/research-worker-p2-028d52`, in the paused run `12da1f8d-f455-4c18-9554-7968c56f77fc`.

- [x] Before: `git -C /Users/suas/work/communitytech/work-finding worktree list` shows `.worktrees/queue/research-worker-p2-028d52` as `detached` at `95e7ba50`. (Real item recovered on 29 Oct; the literal "before" can no longer be shown. Reproduced on a scratch repo instead: see evidence A.)
- [x] Resume the run (Plan Queue page, Resume, or `plan_queue_control` `resume`). (Done through the real Resume all button on the scratch run.)
- [x] Expected: no red "is not this item's checkout" banner. The worktree list shows the folder on `queue/research-worker-p2-028d52`. `git -C <folder> status --porcelain` shows only provisioned files. `git -C /Users/suas/work/communitytech/work-finding for-each-ref refs/plan-queue/rescue/` shows one ref for this item holding the two cut-short evidence files (`focused-schema-absence.receipt.json`, `postgres-full-corrected.log`), and those files on the branch are still full size. The app log has "put a checkout an interrupted landing left detached back on its branch".
- [x] Expected when the item next tries to land: it parks `land-blocked` with "this item's branch carries commit 187b2e29 (\"Plan queue checkpoint: parked: worktree-error\"), which is not on main". Nothing new appears on work-finding `main`.
- Evidence:

## 2. Pause all and Resume all

- [x] On a run with at least one working item, press Pause all, then Resume all.
- [x] Expected: no error banner; paused items show "Paused", then carry on after Resume.
- Evidence:

## 3. The 17 branches carrying the dropped commit (James chose the recommended option, 28 October)

17 work-finding `queue/*` branches carry `187b2e29`: 13 started from it, and 4 merged it in (`02-modules-campaigns-14f49a`, `colleague-m365-followup-7a6ea0`, `crm-go-live-965b5e`, `reader-retirement-conservative-340724`). After checks 1 and 2 pass:

- [x] For each item still wanted, its own changes (the branch minus `187b2e29` and minus its merges of main) go onto a fresh branch from current `main` through the queue's own controls. The old branch stays until the new one lands. Do not rewrite or delete AIO-owned branches by hand.
- [x] Items no longer wanted are discarded through the queue.
- Evidence (per branch: kept or discarded, new branch, landed commit):

## Sign-off

| Check | Result | Date | Evidence |
|---|---|---|---|
| 1. Stuck item recovered, then refused at landing | PASS (recovery live on scratch repo and in the real queue on 29 Oct; landing refusal live in the real queue on three other items; not re-driven on 73a4c35d, which never reached landing) | 2026-11-12 | Evidence run, section 1 |
| 2. Pause all / Resume all | PASS (twice, real page buttons, real worker session) | 2026-11-12 | Evidence run, section 2 |
| 3. Affected branches moved or discarded | PASS (all 17 items accounted for: 11 re-landed from fresh branches, 6 re-queued and still outstanding; none carries `187b2e29`; its content is not on `main`) | 2026-11-12 | Second evidence section, table |

## Evidence run — 2026-11-12

Worker: Plan Queue livetest worker for item `c737ba21-6bc5-4816-9b25-85c190173aeb`. Isolated dev app built from the queue worktree (`npm run build:main`, development renderer build), `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-90173aeb`, debug port 9608, focus emulation on before every DOM read. Real state was only read, never changed: the packaged app's queue database was opened with `sqlite3 -readonly` and work-finding was only inspected with read-only `git` commands. The dev app's log lines also landed in the production `app.log` (known), so every log claim below carries its timestamp and the scratch item id.

**Why the literal wording could not be followed.** The doc was written on 28 Oct for an item that was stuck at that moment. By 12 Nov the item `73a4c35d` is `parked` / `round-limit`, discarded on 8 Nov 00:27:05 UTC by the Set aside agent, its branch `queue/research-worker-p2-028d52` and its folder no longer exist, and work-finding has only 8 `queue/*` branches. So the checks were run in two ways: live on a scratch repository through the real app, and as read-only history in the real queue.

### 1. Detached checkout comes back, then landing refuses the dropped commit

**A. Live reproduction (scratch repo `/tmp/aio-lt-queue-90173aeb-repo`, run `f1254b9a`, item `c5e4259e`, real Claude worker session).**
- Set-up: item working on `queue/2026-11-12-lt-hello-224d2d`; Pause all; then on the item's folder: committed a 340,000-byte `evidence/big.log` to the branch (tip `2506853`), `git checkout --detach 2970749…` (the base tip, same shape as `95e7ba50` before), and wrote a cut-short 4,096-byte `evidence/big.log` on disk.
- Before: `git worktree list` showed `.worktrees/queue/2026-11-12-lt-hello-224d2d  2970749 (detached HEAD)`.
- Action: real Resume all button on the Plan Queue page, 12 s wait.
- After: `git worktree list` shows the folder `2506853 [queue/2026-11-12-lt-hello-224d2d]`. `git status --porcelain` in the folder shows only `?? .mise.local.toml` (the provisioned file). No error banner or alert in the page (probe of `[role=alert]`, `.pq-error`, `.pq-banner`, `.toast`, `.error` returned none). The run is `running`, the item `working` with a new worker session.
- `git for-each-ref refs/plan-queue/rescue/` shows one ref, `refs/plan-queue/rescue/c5e4259e-…-1794465510261`, holding `evidence/big.log` at 4,096 bytes (the cut-short copy). The branch tip still holds it at 340,000 bytes, and so does the folder on disk.
- Item note shown by the app: "A landing had stopped part-way and left this item's folder off its branch. It was put back on the branch. Some files in it matched neither side … saved at refs/plan-queue/rescue/c5e4259e-…".
- Log, dev app output and production `app.log`, `2026-11-12T06:38:30.300Z` WARN `[PlanQueueWorktree]` "Plan queue: put a checkout an interrupted landing left detached back on its branch" `{ itemId: 'c5e4259e-460a-479c-be77-9823b6224d2d', rescueRef: 'refs/plan-queue/rescue/c5e4259e-…-1794465510261', unexplained: 1 }`, followed by "Plan queue run resumed" at 06:38:30.419Z.

**B. The real stuck item, as recorded in the real repository (read-only).**
- `refs/plan-queue/rescue/73a4c35d-d7e8-4992-940a-da626f028d52-1793264082598` exists in work-finding: commit `e9afe08c9`, 29 Oct 2026 08:54:42 +0000, "Plan queue rescue: a checkout a landing left off its branch", parents `95e7ba501` (the detached HEAD) and `c70f2bb77` (the branch tip). It holds exactly the two named files at cut-short sizes: `focused-schema-absence.receipt.json` 262,144 bytes and `postgres-full-corrected.log` 16,384 bytes. At the branch tip `c70f2bb77` the same two files are full size, 454,807 and 624,422 bytes. That is the real-world run of the same recovery, and it is the only place such a ref can come from.
- The app log lines from 29 Oct have since rotated out (oldest kept log is 11 Nov), so the log-line part of this expectation is evidenced by A only.
- The folder is no longer present, so `status --porcelain` on it cannot be re-read.

**C. Landing refusal (`187b2e29`).**
- Not re-driven on the item itself: it never reached landing (parked `round-limit` after 3 rounds, 8 Nov). The unpackaged dev app also cannot finish a worker (the orchestrator-tools tool server is "not configured" for an unpackaged build, which is why the scratch triage also failed), so a scratch landing could not be reached.
- Real queue rows show the guard firing live on three other items that carried the commit. All three are `parked` / `land-blocked` with this note: "Not landed: this item's branch carries commit 187b2e29 ("Plan queue checkpoint: parked: worktree-error"), which is not on main, so landing it would put that commit's changes on main too. Its work is safe on queue/…; its own changes need moving onto the current main before it can land." Items `94791dc5` (5 Nov 18:55:28), `c9d09a86` (7 Nov 00:46:58) and `702702b3` (8 Nov 00:06:16).
- `git merge-base --is-ancestor 187b2e296 main` in work-finding: false. The commit is not on `main`.

### 2. Pause all and Resume all

Real page buttons on the Plan Queue page in the dev app, scratch run `f1254b9a` with one item working (worker session busy). Done twice.
- Pause all (button text "Pause all (1 running)"): after 4 s, run `paused`, item back to `queued` with `heldAt` set, the worker session gone, page text "Paused · 1 document waiting to resume" and "Paused", the button now "Resume all (1 paused)". No alert, banner or toast.
- Resume all: after 12 s, run `running`, item `working`, a new worker session `busy`, buttons back to "Pause all (1 running)". No alert, banner or toast. Log: "Plan queue run paused" and "Plan queue run resumed", actor James.

### 3. The 17 branches carrying the dropped commit

Read-only state on 12 Nov:
- No live work-finding `queue/*` branch contains `187b2e296` (all 8 checked with `merge-base --is-ancestor`). Only 13 refs do: 12 under `refs/plan-queue/discarded/` plus the one rescue ref above. `main` does not contain it.
- All four branches that merged it in were discarded by the Set aside agent and their plans were re-run from current `main` as new items: `02-modules-campaigns-14f49a` (item `702702b3`, discarded 8 Nov; later item landed `5f046c47`, on main), `colleague-m365-followup-7a6ea0` (`20cdc6aa`; landed `e9190e9d`, on main), `crm-go-live-965b5e` (`c9d09a86`; landed `7d4ee0ab`, on main), `reader-retirement-conservative-340724` (`e0d6550b`; landed `d7a8a0a9`, on main; a second landed `c8d1af1d` is not on main).
- Of the 12 discarded items still holding the commit, 8 have a later item for the same document that landed (6 of those commits are on work-finding `main`; `27915ca6`, `368f7e2b` and `c8d1af1d` are not). The rest have later items parked, none carrying the commit. The discard refs expire between 7 and 9 Dec 2026, so `restore-discarded` still works for all 12.
- Residual: (a) 5 of the 17 branches no longer have any ref I can map (for example `94791dc5`), so their outcome cannot be shown from the repository; (b) the per-item "still wanted or not" decision was made by the Set aside agent, not by a step I could watch, and I did not re-decide it; (c) `27915ca6`, `368f7e2b` and `c8d1af1d` are recorded as landed in the database but are not ancestors of work-finding `main`. That is outside this plan, so I have not investigated it; it is listed as a follow-up. I took no action on real branches (no discard, restore or rewrite).

### Defects and cleanup

- No defect reproduced, so no entry was added to `livetest-remediation-register.md` and the item ends with zero commits (see the runbook).
- Dev app stopped, scratch run cancelled, scratch repo, static server and `/tmp/aio-lt-queue-90173aeb*` removed after this section was written.

## Evidence run — 2026-11-12, second pass (after verifier round 2)

Two gaps were raised: five of the 17 outcomes were not shown, and three landed commits that were not on `main` were recorded without a defect entry. Both are now closed with read-only checks (the Plan Queue database opened with `sqlite3 -readonly`, work-finding inspected with read-only `git`; nothing real was changed).

### 3 (again). Every affected item, one row each

The 17 items are the non-landed work-finding items whose branch started from `187b2e29` (`base_commit`) or carried it as their own checkpoint, plus the four that merged it in. All 17 were set aside through the queue by the Set aside agent between 5 and 9 Nov (`discarded_by`). For each, the table gives whether a discard ref is still held and what the queue did with the same document afterwards. The "re-landed" commit is the hash the database records; where it is not on `main` the same-patch twin on `main` is given (see LT-1030).

| Item | Discard ref | Later item for the same document |
|---|---|---|
| `94791dc5` watchdog-stale-ready-unreadable | none left | re-queued (parked), and a second one skipped |
| `0b2fd324` research-supply-native-review-repair | none left | **re-landed** `66809c4d` (twin `917e8ec80` on `main`) |
| `aecca073` radar-actual-closure-qualification | none left | **re-landed** `35945635`, on `main` |
| `aca9fd19` verification-preconditions-closure-reconciliation | kept, holds `187b2e29` | re-queued (parked) |
| `d0485df3` 05-research-artifacts | kept, no `187b2e29` | **re-landed** `488bea2d`, on `main` (another item skipped) |
| `45889eea` task-review-mailbox-authorization | kept, holds it | **re-landed** `4d78e494`, on `main` (two earlier re-queues parked) |
| `73a4c35d` research-worker-P2 | kept, holds it | **re-landed** `27915ca6` (twin `83f74ae2d` on `main`) |
| `afdfe888` manual-followup | kept, holds it | **re-landed** `368f7e2b` (twin `d17af3b7e` on `main`) |
| `e0d6550b` reader-retirement-conservative-census | kept, holds it | **re-landed** `c8d1af1d` (twin `9d0c7ccea`) and again `d7a8a0a9`, both on `main` |
| `77fe8502` work-finder-recovery | kept, holds it | re-queued (parked) |
| `f4156da7` work-finding | kept, holds it | re-queued (parked) |
| `33d35da3` research-worker-activation | none left | re-queued (parked) |
| `4a46e81e` research-worker-P2-4-acceptance-reconciliation | kept, holds it | re-queued (two parked, the latest `needs-setup`) |
| `a68c43d4` research-worker-P3 | kept, holds it | **re-landed** `f858f79d`, on `main` (an earlier re-queue parked) |
| `702702b3` 02-modules-campaigns | kept, holds it | **re-landed** `5f046c47`, on `main` |
| `20cdc6aa` colleague-m365-followup | kept, holds it | **re-landed** `e9190e9d`, on `main` |
| `c9d09a86` crm-go-live | kept, holds it | **re-landed** `7d4ee0ab`, on `main` |

Result: 11 of 17 were redone from a fresh branch and landed; 6 were re-queued from fresh branches and are still outstanding as ordinary queue work (`94791dc5`, `aca9fd19`, `77fe8502`, `f4156da7`, `33d35da3`, `4a46e81e`); none was left on its old branch. The earlier "5 of 17 cannot be mapped" is closed (the unmapped ones were four items whose discard ref has since been removed, plus the extra row above). The two items that landed on 26 Oct, before the problem was found (`fd83698f`, `0345732b`), are not part of the 17.

The safety half of the check, again read-only: no live `queue/*` branch in work-finding contains `187b2e29`; `main` does not contain it; and of the 5,888 files the commit added or changed, 5,865 are absent from `main`, 5 are identical to `main`'s copy and 18 differ, so its content did not reach `main` through those landings.

Limits of this evidence, stated plainly: the Set aside agent's reasoning for each keep-or-discard was not re-derived, and whether each document is still wanted is James's call; the table shows what the queue did, not whether that was the right call. The six outstanding items are queue work, not leftovers of this plan.

### The three commits not on `main`: now explained and filed

`27915ca6`, `368f7e2b` and `c8d1af1d` each have a commit on `main` with an identical patch and the same author time but a different parent (`83f74ae2d`, `d17af3b7e`, `9d0c7ccea`; `git patch-id --stable` equal for each pair). So the change is on `main`; the database holds the pre-replay hash. This is a defect, not a one-off: across all 212 recorded landed hashes for work-finding, 23 are not on `main` (7 with a same-patch twin, 13 that do not exist in the repository, 3 that exist with no twin). It is filed as **LT-1030** in `livetest-remediation-register.md` (index row plus section; root cause not established, not fixed). The number follows the root checkout's register, which already holds LT-1029; `node scripts/next-lt-id.mjs` in the queue worktree still prints LT-1018 because the worktree's copy is older.

This corrects the earlier "No defect reproduced" line in the first evidence section: no defect in the detached-landing recovery, but one defect in the landed-commit record. The item therefore ends with one changed file in the worktree (the register), not zero.

### Cleanup

Nothing new was started in this pass; the dev app, scratch repository and temporary profile from the first pass were already removed.
