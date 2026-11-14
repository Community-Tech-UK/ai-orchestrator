# Planning files never reach a landing commit (step 1.1): live checks

Status: pending. Deferred from [2026-11-04-pq-a2-planning-files_plan.md](2026-11-04-pq-a2-planning-files_plan.md); only the queue coordinator may close it.
Prerequisites: the integrated build of this change installed and restarted as the running Harness app (restarting is James's decision, never a worker's: live sessions would end), and a scratch git repository with a base branch, a `docs/plans` folder and a small plan to queue.
Remediation flow: [campaign runbook](livetest-campaign-runbook.md), [standing register](livetest-remediation-register.md). A reproduced defect becomes a new `LT-NNN` row in the register (`node scripts/next-lt-id.mjs`); per-check evidence stays here.

What the worker already proved in-loop (not deferred): real-git tests of every rule against temporary repositories and work folders (move at a checkpoint, never committed, a root file never replaced, even one the same item moved earlier (the newer version goes beside it), both copies kept on a collision, a new number for an existing `.from-queue` copy, paths that leave the root refused, the landing preflight parking before the squash, landing cleanup moving or copying first, the interrupted-landing recovery moving instead of removing), a whole coordinator run where a worker creates `scratch_history.md`, and a mutation check of each guard. These checks need the rebuilt app and real worker sessions.

## 1. A real worker's new planning file is moved, not committed

- [x] **PASSED 12 Nov 2026 after the LT-1120 fix (first run: file handling passed, note failed; see both evidence runs).** In the scratch repository, queue one small plan whose task tells the worker to write a note to `docs/plans/scratch-note_history.md` inside its own work folder.
- Expected: after the worker's first checkpoint the file exists at `docs/plans/scratch-note_history.md` in the scratch repository's main folder and not in the work folder; the item branch (`git ls-tree -r --name-only queue/<item>`) does not list it; the item's note on the Plan Queue page says planning files were moved to the main project folder. After landing, `git ls-tree -r --name-only main` does not list it and the main-folder copy is still there.
- Why deferred: needs the rebuilt, restarted app and a real worker session.

## 2. An existing root file is never overwritten

- [x] **PASSED 12 Nov 2026 after the LT-1120 fix (first run: file handling passed, note failed; see both evidence runs).** Before the worker starts, create `docs/plans/scratch-note_history.md` in the main folder with different content, then repeat check 1.
- Expected: the root file is unchanged; the worker's version sits beside it as `scratch-note_history.from-queue-<item>.md`; the item note says so in plain words. If the worker writes the file again later, the next version also goes beside it as `scratch-note_history.from-queue-<item>-2.md`; the root file is still unchanged.
- Why deferred: same as check 1.

## 3. A file that cannot be moved parks the item before landing

- [x] **PASSED 12 Nov 2026** (destination blocked with a read-only folder instead; see the evidence run). Make the main folder's `docs` a regular file (or otherwise block the destination) after the worker has written its planning file, then let the item reach landing.
- Expected: the item parks as "land blocked" naming the file and a rescue copy in Harness's data folder, at `<Harness user-data folder>/plan-queue/planning-rescue/<item>/<timestamp>/docs/plans/<file name>` (the item's note gives the exact path); `main` has not moved; the work folder still holds the file. Undo the block and press Try merging again: it lands.
- Why deferred: needs the rebuilt app and real timing across a landing.

## Evidence run — 12 November 2026 (Queue worker)

**How it was run.** The installed Harness was not touched. The dev app was built from this item's worktree (it holds the
planning-files change; the worktree base `36611bb65` is older than `main`, which has only unrelated later changes) and
launched in an isolated profile (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-15379884`, debug port 9834, its own tiny
static server for the renderer). It was driven over the debug port with focus emulation on. A parent Claude session in
the dev app started real Plan Queue runs with `planQueueStart` against a scratch git repository (`/tmp/aio-lt-queue-15379884-repo`,
base branch `main`); each run used a real Claude worker and a real independent checker, with the gate `npm test`.
Evidence files (kept): `_scratch/pq-a2-planning-files-livetest-20261112/` in the root checkout. Log lines cited are from
the production `app.log`, which the dev app writes to (runbook section 4); they are listed in `planning-files-log-lines.jsonl`.

**Deviations from the written steps, stated plainly.**
1. *The plan as written cannot make a real worker create the file.* Run 1 (plan `2026-11-12-scratch-note_plan.md`) told the
   worker to write `docs/plans/scratch-note_history.md` in its own work folder. The worker declined: its Plan Queue rules say
   `_history.md` files are written in the main folder, so it wrote `2026-11-12-scratch-note_history.md` there instead and said so in
   its notes (`attempt1-root-history-written-by-worker.md`). The checker then parked the item because the acceptance line
   required a file the worker had rightly not made. That is correct product behaviour, and it means the move only matters
   for a file that appears in a work folder without the worker choosing to put it there. Runs 2 to 4 therefore used a
   by-product: a script the plan has the worker add and run through `npm test`, which writes `docs/plans/scratch-note_history.md`
   relative to the folder it runs in, with an acceptance line that does not depend on the file being present.
2. *Check 3's block is a read-only `docs/plans`* (`chmod 555`, applied the moment the file appeared in the work folder),
   not "`docs` is a regular file", so the plan documents already in that folder stayed readable. The effect (a write into
   it fails with EACCES) is the same, and it is the "otherwise block the destination" case the step allows.
3. *The `-2` copy in check 2 came from the checks, not from the worker writing again.* The gate `npm test` runs in the work
   folder after the checkpoint and recreated the file, which the landing preflight then moved. The worker itself wrote the file once.

### Check 1 — a real worker's new planning file is moved, not committed: file handling PASSED, item note FAILED

Run 2: run `1077e970-049c-49cc-8611-e8153fbfe968`, item `5c422476-e3ee-4611-98ce-06d324bd2d9b`, branch `queue/2026-11-12-scratch-gen-bd2d9b`.
- 07:16:38Z the worker's `npm test` wrote `docs/plans/scratch-note_history.md` in its work folder; the root folder did not have it.
- 07:17:00Z (log: `planning files moved to the root checkout`, `moved:1, beside:0`) the first checkpoint ("Plan queue checkpoint: round 1 work", `56e684a`) ran.
  After it: the root folder had `docs/plans/scratch-note_history.md` (content from 07:16:38); the work folder's `git status` showed only
  untracked `.mise.local.toml` and `docs/` (the gate's `npm test` recreated the file in the work folder about 0.3 s after the move, which is where the second version in this run came from); `git ls-tree -r --name-only queue/2026-11-12-scratch-gen-bd2d9b` listed no file under `docs/` (README.md, package.json,
  scripts/write-report.mjs, src/greet.mjs, tests/greet.test.mjs). File: `check1-after-first-checkpoint.txt`.
- After landing (`48a665a`): `git ls-tree -r --name-only main` lists no `scratch-note` file; `git ls-files | grep -c scratch-note` is 0; the main-folder copy is still there.
  File: `check1-after-landing.txt`.
- **Not met: the item's note.** The expected "the item's note on the Plan Queue page says planning files were moved to the main project folder" never appeared.
  The item's `detail` was `null` at every poll from the first checkpoint on (`check1-run2-dto-after-checkpoint.json`, `check1-run2-dto-final.json`), and the
  state-changed events for run 3 show why (below). Filed as **LT-1120** in the register. The note was visible only briefly in the `landing` state of the later preflight.

### Check 2 — an existing root file is never overwritten: file handling PASSED, note in plain words FAILED

Run 3: run `5a6d6a4e-444e-4d0f-9311-9d5ff47b2f17`, item `9a488af6-4a49-4ca4-b47b-829e4d8adca5`.
- Before the worker started the root held `docs/plans/scratch-note_history.md` with different content; sha256 `01583e46248fd88c8b987f273185b6bcec53a5ee6eeae0502aa44c8fdf2993bb`.
- First checkpoint (07:21:2xZ, log `moved:0, beside:1`): the worker's version appeared as `docs/plans/scratch-note_history.from-queue-8adca5.md` (content stamped 07:21:02Z).
  Landing preflight (07:23:4xZ, log `moved:0, beside:1`): the later version appeared as `...from-queue-8adca5-2.md` (stamped 07:21:24Z). Neither file was on `main`.
- After landing the root file's sha256 is still `01583e46...2993bb`. Files: `check2-root-before.sha`, `check2-after-landing.txt`, `check2-timeline.txt`.
- **Not met:** the note said nothing at any poll between the first checkpoint and landing (`detail=null` throughout `check2-timeline.txt`). Same cause, LT-1120.
  (In run 2 the beside-copy note did show, for about a second, in the `landing` state: "docs/plans/scratch-note_history.md already exists in the main project folder
  with different content, so it was not overwritten; the worker's version was saved beside it as docs/plans/scratch-note_history.from-queue-bd2d9b.md." The wording is plain and correct; it just does not stay.)

### Check 3 — a file that cannot be moved parks the item before landing: PASSED

Run 4: run `7d19254d-0df2-4d6b-be24-559fe2df0b3a`, item `5c65a2f0-560c-4c71-9406-5d2d2fa2c57d`, branch `queue/2026-11-12-scratch-block-a2c57d`.
- 07:24:33Z the file appeared in the work folder and the main folder's `docs/plans` was made read-only. First checkpoint 07:25:04Z: the move failed (log `a planning file could not be moved`, `EACCES`),
  the file was left out of the commit (branch tree had no `scratch-note` file) and a rescue copy was made.
- 07:26:44Z the landing preflight tried again, failed, and the item parked as `land-blocked` before any landing: `main` stayed at `1cdbd34` throughout the block. Item note:
  "Nothing was landed. docs/plans/scratch-note_history.md could not be moved to the main project folder (EACCES: permission denied, open '/private/tmp/aio-lt-queue-15379884-repo/docs/plans/scratch-note_history.md'). It was left out of the saved work and a copy is kept at /tmp/aio-lt-queue-15379884/plan-queue/planning-rescue/5c65a2f0-560c-4c71-9406-5d2d2fa2c57d/2026-11-12T07-26-44-957Z/docs/plans/scratch-note_history.md."
  That is the expected path shape under the profile's user-data folder. The work folder still held the file (41 bytes). Files: `check3-parked-state.txt`, `check3-dto-and-events.json`, `check3-rescue-files.txt`.
- 07:27:02Z the block was removed and `retry-landing` (Try merging again) pressed: the file was moved to the main folder, the item landed (`4da6883`), `main` lists no `scratch-note` file, the root copy is there. File: `check3-after-retry.txt`.
- Side observation (not a defect against the check): each failed attempt made its own rescue copy, five copies of one 41-byte file by the time it parked (one per checkpoint or preflight attempt). Harmless here; unbounded for an item that keeps retrying.

### Defect reproduced: LT-1120

The `PLAN_QUEUE_STATE_CHANGED` events for run 4 (`check3-dto-and-events.json`) show the checkpoint's note set and then cleared in the same millisecond:
`07:25:04.937Z working detail="docs/plans/scratch-note_history.md could not be moved ..."` followed by `07:25:04.937Z awaiting-slot detail=null`. Cause: the round-work caller transitions
the item with an explicit `detail: null` (`src/main/plan-queue/plan-queue-item-flow.ts:428`) right after `checkpoint` set it (`plan-queue-worktree.ts:281`). Register entry: LT-1120 (index row and section, edited in the queue worktree).
Checks 1 and 2 stay open for a re-run on the rebuilt app once the note survives; the file handling in all three checks needs no re-run.

### Not covered
- The installed Harness app was not used (restarting it is James's decision), so this is the worktree's build, not the installed build.
- The Plan Queue page itself was not looked at: the note was read from the item data and the state events the page is built from. A visual check of the note belongs to the re-run after LT-1120 is fixed.
- A worker that writes the file twice on its own across two rounds was not produced; the second version in check 2 came from the checks (deviation 3).
- No `docs` regular-file block (deviation 2).

Cleanup: dev app and static server stopped (debug port 9834 and 4592 closed); `/tmp/aio-lt-queue-15379884*` profile, scratch repository and renderer build removed; the worktree's `dist/` removed. No branch or worktree was created by this run in the main repository.

## Evidence run — 12 November 2026 (fix re-run, LT-1120)

An independent verifier failed the first run because checks 1 and 2 were left open on LT-1120. The defect is fixed in the queue worktree and the two
checks were re-run live on a fresh dev app built from the fixed worktree (same method as the first run: isolated profile, debug port, real Claude workers
and checkers, scratch git repository; the by-product script is now committed in the scratch base so the plan only asks for a small function).
Evidence files (kept): `_scratch/pq-a2-planning-files-livetest-20261112/fix-rerun/` in the root checkout.

**The fix.** The note is no longer carried in `detail`, which the next state change clears (`plan-queue-item-flow.ts:428`). It has its own item field
`planningNote` (column `planning_note`, migration 55), appended at each checkpoint and at the landing preflight, and shown on the item row. Gates on
the fixed tree: `npm run checks` (typecheck, spec typecheck, lint, line limit, UI hints, main and renderer builds) all passed, and the full suite
passed (3687 files, 46,737 tests). New or changed tests fail without the fix (mutation: removing the note from `checkpoint` fails 4 tests).

### Check 1 — re-run: PASSED (file handling and item note)

Run `edd44cf5-bad5-422e-a220-4506f27ea8fe`, item `f17e1cdc-3109-4542-a475-b390caa0e88f`.
- 07:54:30Z the worker's `npm test` wrote `docs/plans/scratch-note_history.md` in its work folder; the main folder had none. After the first checkpoint it was in the main folder
  (content stamped 07:54:30Z). The item branch's tree and `main` list no `scratch-note` file (`fix-check1-after.txt`); the main-folder copy remains.
- The item's note, which failed in the first run, now stays: the state-changed events show `working` with no note, then `working` with the note set, and every later state
  (`awaiting-slot`, `verifying`, `landing`, `landed`) still carries it, while `detail` is null (`fix-check1-dto-events.json`). Poll at 07:54:54Z while `verifying`: "Planning files the worker created in its work folder were moved to the main project folder: docs/plans/scratch-note_history.md."
  (`fix-check1-timeline.txt`). After landing the note adds the line for the later version the checks re-created: "...already exists in the main project folder with different content, so it was not overwritten; the worker's version was saved beside it as docs/plans/scratch-note_history.from-queue-a0e88f.md."
- On the Plan Queue page (route `/plan-queue`, History fold open, focus emulation on) the item row contains a `.pq-item-planning-note` element with exactly that two-line text (`fix-check1-page-dom.json`).

### Check 2 — re-run: PASSED (file handling and note in plain words)

Run `68920978-9a49-461c-b553-620b068f81aa`, item `8edb8d64-1585-452e-8983-b148aaea659c`.
- Before the worker started the main folder held `docs/plans/scratch-note_history.md` with different content; sha256 `52f686b88abc6451d3dfa288e61da75d30bcaba4ac6f81d83199a2a0f120c646`; after landing it is unchanged (`fix-check2-after.txt`).
- The worker's version sat beside it as `scratch-note_history.from-queue-ea659c.md` (stamped 08:05:07Z) from the first checkpoint, and the later version as `...from-queue-ea659c-2.md` (08:05:26Z). Neither was on `main`.
- The note appeared at the first checkpoint and stayed through `verifying`, `landing` and `landed` (`fix-check2-timeline.txt`, `fix-check2-dto-events.json`): "docs/plans/scratch-note_history.md already exists in the main project folder with different content, so it was not overwritten; the worker's version was saved beside it as docs/plans/scratch-note_history.from-queue-ea659c.md." plus the same sentence for the `-2` copy after landing preflight.
- As in the first run, the `-2` copy comes from the checks re-creating the file (deviation 3 of the first run still applies), not from the worker writing twice.

### Not covered (this run)
- The installed Harness app was not used; this is the fixed worktree's build, and the new column only exists once the app is rebuilt and restarted (James's decision).
- A profile upgraded from an older database was checked by the migration specs only (`plan-queue-store.spec.ts`, `plan-queue-section-migration.spec.ts`), not live.

Cleanup: dev app and static server stopped (ports 9834 and 4592 closed); `/tmp/aio-lt-queue-15379884*` profile, scratch repository and renderer build removed; the worktree's `dist/` removed.

## Renumbering note (14 November 2026)

This defect was filed as LT-1030 during the runs above. While merging `main`, that number was found to belong to a different defect (Queue health wording), so this one is now **LT-1120** everywhere (register, code comment, this document). Evidence is unchanged.
