# AIO tidies up after itself — plan

On main: no.

**Status:** READY FOR VERIFICATION (round-4 findings fixed 2026-10-23; previous round-3 findings fixed
2026-10-23; post-merge re-verified 2026-10-23). Written 2026-10-22 after James's Mac filled its 4 TB
drive (3.6 GB free).
James asked for "a prompt or something so that we're not getting nuked with all these worktrees or test
files … AIO really needs to tidy up after itself". No linked spec; this plan is the specification.

## What filled the disk (measured 2026-10-22)

| Where | Size | Cause |
|---|---|---|
| `work-finding/apps/desk/_scratch` | ~520 GB, ~2,500 folders | Agents running the completion gate made a full clone + `npm ci` per gate round and never deleted it. |
| `ai-orchestrator/_scratch` | 86 GB | Same pattern. |
| `$TMPDIR/watchdog-*` | 20 GB (22 × 1.2 GB) | Repo copies made by work-finding agents in the system temp dir. |
| `userData/codemem.sqlite` + `-wal` | 97 GB + 41 GB | Only ~13 GB is live data: `freelist_count` = 20.2M pages × 4 KB ≈ 83 GB free. Spawn-time warm-up indexes broad roots such as `~` (no guard on that path; 9 warm-ups of `~` in 5 days of logs). The WAL is never truncated: no `journal_size_limit`, and one unbounded `incremental_vacuum` writes every moved page into the WAL. |
| `~/.ai-orchestrator/codex/backups` | 41 GB, 445 files | A ~160 MB `VACUUM INTO` copy of `~/.codex/state_5.sqlite` at most startups, never pruned. |

Already cleaned by hand on 2026-10-22 (not part of this plan): uv/npm caches, local models, Chrome clones,
the old work-finding `_scratch` runs. Code the copies held was rescued to
`~/work/_archive/work-finding-scratch-orphans-2026-10-22/`.

## Changes

1. **Code index refuses broad roots on every path.** Move the broad-root check out of
   `CodememPrewarmCoordinator` into a shared helper, and apply it in `CodememService.warmWorkspace`, so
   spawn-time warm-ups of the home folder, its parent, `~/work`, the filesystem root and `/private/tmp`
   are skipped like prewarm already skips them.
2. **Code index gives space back.**
   - Set `journal_size_limit` on the index worker connection and the main-process connection so the WAL
     file shrinks after a checkpoint.
   - Vacuum free pages in bounded steps, checkpointing between steps, so a vacuum can never balloon the WAL.
   - Log (not ignore) a `wal_checkpoint(TRUNCATE)` that reports busy.
   - The resource governor counts `codemem.sqlite-wal` towards the size limit, as it already does for RLM.
3. **Codex state backups are pruned.** After the startup Codex state steps, keep the newest 5
   `state_5-before-*.sqlite` backups and delete older ones that are more than 7 days old.
4. **Every agent is told to clean up.** Add an always-on `[Disk Hygiene]` block to the adapter guidance
   (reaches chats, loops, plan-queue workers and automations, because every spawn goes through
   `createCliAdapter`). It says: put throwaway copies under `_scratch/` or the temp dir; prefer
   `git worktree add` over a full clone; reuse installed dependencies; delete copies, worktrees and
   `node_modules` when the check finishes, pass or fail; rescue anything not in the main repo first.
5. **Low-disk warning.** A watcher checks free space on the data volume every 10 minutes and sends a
   notification below 50 GB free (critical below 10 GB), so James hears about it before the disk fills.
6. **Old scratch folders are swept.** Daily, for the local project folders opened in Harness (recent
   directories, mapped to their repository roots), delete top-level `_scratch/` entries untouched for
   14 days. Entries holding a git checkout with uncommitted or untracked changes, commits missing from
   the owning repo, or (for linked worktrees) commits on no branch are kept and listed in a
   notification instead. Setting `scratchRetentionDays` (default 14, 0 = off).
7. **Completion-gate skill.** Clarify that "clean state" means a temporary `git worktree` (or reused
   clone) that is removed afterwards, not a fresh full clone per round. The skill lives in `~/.agents`,
   outside this repo; if this session cannot write it, give James a one-line script to apply it.

## As built (2026-10-22)

- Broad-root guard: `src/main/codemem/broad-workspace-roots.ts`, applied in the index worker's
  `warmWorkspace` (the chokepoint for every warm path) and in the prewarm coordinator.
- Space reclaim: `vacuumFreelistPages` in `cas-workspace-index-maintenance.ts` checkpoints before the
  first step and after each 64 MiB step and stops at the first busy checkpoint, without waiting on
  the busy timeout (the worker is single-threaded); `journal_size_limit`
  (64 MiB) is set in `migrate()` for both connections. The worker runs maintenance with a 10 s vacuum
  budget at startup and on request, and a 10 s reclaim every 5 minutes that never starts the one-off
  full `VACUUM`. `walTruncated` is reported and logged. The governor counts `codemem.sqlite-wal`.
- Codex backups: `codex-state-backup-retention.ts`, startup step after the two backup writers.
- Guidance: `DISK_HYGIENE_SYSTEM_PROMPT`, always appended last by `getAdapterGuidanceBlocks`; recorded
  in the context manifest as `adapter-disk-hygiene`.
- Low-disk warning: `src/main/storage/low-disk-space-watcher.ts`; notifies when the level worsens and
  once a day while it stays low, and retries hourly when quiet hours or cooldown held a notice back.
- Sweep: `src/main/storage/scratch-sweep.ts` + `scratch-sweep-scheduler.ts` (first run 10 minutes
  after startup, then daily). Activity is the later of mtime and ctime, so a fresh `cp -a` copy counts
  as recent. Only `.git` folders are skipped when judging activity: git's own store churns on fetch,
  gc and commit — and on the sweeper's own `git status` runs, which can refresh `.git/index` — so its
  timestamps cannot show use, while a repository's unsaved work is fully decided by the repository
  checks. Dependency and cache folders (`node_modules`, venvs, `__pycache__`) count for activity like
  everything else. Every git repository inside an entry is checked, at any depth and including ones
  nested in another checkout's ignored folders, submodules and dependency folders (each walk stops at
  200,000 folders and then keeps the entry): working trees must have no changes (untracked files and
  submodules included, plus edits hidden behind skip-worktree or assume-unchanged: every flagged file
  is compared with its index entry by content, because `git status` never reports them); a repository
  whose history lives inside the entry (clone, bare repo,
  separate-git-dir store, submodule store kept under `.git/modules`) must have every commit
  reachable from its own refs already reachable from
  the owning project's refs — the whole history is compared commit by commit (the owning project's
  surviving set is read once per scratch folder); ref tips are never assumed to carry their
  ancestors (a shallow owning project has the tip but not the history under it), and a stale
  remote-tracking ref is not a surviving copy — and no linked
  worktree outside the entry; a bare state is verified with git (`rev-parse --is-bare-repository`),
  never assumed from folder names; the configured checkout (`core.worktree`) of every repository is
  resolved and validated — it decides containment, never the git folder's placement, including for
  nested submodule stores — so a git folder whose configured checkout lies outside the entry is kept
  even when a `.git` pointer binds it from here, and the same goes for a work tree configured outside
  the entry; a non-bare git folder with no configured checkout is kept
  unless its dependent checkout is proven to be inside the entry (a submodule's gitlink under a work
  tree in the entry, or a `.git` file in the entry naming that store), because the checkout may run
  from outside; staged-but-uncommitted state in such a folder — what a deinitialized submodule keeps
  in its index after its checkout is gone — keeps the entry too; a linked worktree of an outside
  repository must not have a detached HEAD on no branch. Inspection fails closed everywhere: a folder that cannot be read keeps the entry
  with a `could not read …` reason instead of being treated as empty, in the activity walk, the
  repository walk and the worktree registry alike — including a registered worktree whose checkout
  cannot be read or resolved (a sealed or unplugged folder), which may be a real checkout the shared
  repository still supports. A top-level entry that is a plain file (not a folder, not a link) holds
  no repositories and is removed like any other old entry. A symlink entry
  is unlinked only, never followed. Linked worktrees are
  unregistered one by one with `git worktree remove` (no repo-wide prune, which would drop worktrees
  that are only temporarily missing). Read-only folders are made writable before removal, and that
  repair is only reached after a complete inspection. Broad roots
  are also refused on the worker's rebuild path; `/tmp` and the user temp folder are broad roots.
  `scratchRetentionDays` is read-only to agents (it governs deletion); James changes it in Settings.
- Skill: `~/.agents/skills/task-completion-gate/SKILL.md` and `references/runbook.md` updated. The
  guidance and the skill only suggest worktrees "where your instructions allow worktrees" (James's
  global policy forbids creating them unasked); otherwise one local clone, reused and then deleted.
- Dry-run preview against the real recent directories (2026-10-22, before the review fixes): ~14,800
  entries would go, 3 kept for unsaved work (including 26 commits that exist only in
  `communitytech/_scratch/move-backups-20260914/radar-rewrite`).
- Spec typecheck fix (2026-10-23): the queue verifier found this plan's own specs failing
  `npm run typecheck:spec` with TS2493 at `src/main/storage/low-disk-space-watcher.spec.ts` (two sites)
  and `src/main/storage/scratch-sweep-scheduler.spec.ts` (one site). Root cause: zero-parameter mock
  implementations such as `vi.fn((): boolean => true)` give `mock.calls[n]` the empty tuple type `[]`,
  so `mock.calls[n]![0]` is TS2493. The mocks now declare their input parameter — typed with the real
  `NotificationInput` (stronger than the `unknown` placeholder, and it keeps the `toMatchObject`
  assertions checked against the real input shape), for example
  `vi.fn((_input: NotificationInput): boolean => true)`. No assertion was changed. Evidence
  (queue worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): `npm run typecheck:spec` green
  (was 3 × TS2493 on main), `npx tsc --noEmit` green, `npm run lint` green,
  `npm run check:ts-max-loc` exit 0, and the eight plan-area spec files pass (85 tests: broad-root
  guard, stepped vacuum + journal limit, index-worker maintenance and reclaim, backup retention,
  guidance blocks, disk watcher thresholds and retries, scratch sweep and scheduler).
- Verification round 1 fixes (2026-10-23): an independent queue verifier found three holes where the
  sweep approved deleting entries it had not actually cleared, all in `scratch-sweep.ts`.
  (1) `rev-list --all --not --remotes` let remote-tracking refs bypass the owning-repo comparison, so
  a clone whose remote had been deleted was swept together with the last copy of its commits;
  remote-tracking ref tips are now compared with the owning repository like every other commit (a
  stale ref is not a surviving copy; the ancestry-closure shortcut this introduced — a tip that
  survives there takes its whole history with it — is itself unsound and was replaced by the
  whole-history comparison in the round-2 fixes below). (2) `readDirSafe` swallowed every `readdir` error, so a folder with mode 0100 read
  as "empty" and its uncommitted work was deleted (the live path even half-deleted the entry before
  failing with `failed`, while `dryRun` reported `removed`); reads now fail closed — the activity
  walk, repository walk and worktree registry keep the entry with a `could not read …` reason — and
  removal's chmod-retry is only reached after a complete inspection. (3) `findRepos` skipped every
  `node_modules`, so a nested dependency checkout with unique commits was deleted; repository
  discovery walks dependency folders now, and dependency folders count for activity too (only
  `.git`'s internals are excluded, see the Sweep note). New tests cover each hole and the controls:
  clean nested checkouts and aged installed dependency trees are still swept. Evidence (queue
  worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): the three verifier scenarios
  reproduced against the old code (`removed` with the remote gone, partial delete + `failed` for the
  0100 folder, `removed` for the `node_modules` checkout) and each now keeps the entry; the eight
  plan-area spec files pass (86 tests), `npx tsc --noEmit` green, `npm run typecheck:spec` green,
  `npm run lint` green, `npm run check:ts-max-loc` exit 0.
- Verification round 2 fixes (2026-10-23): a second independent queue verifier found three more
  holes, all in `scratch-sweep.ts`. (1) The round-1 remote-tip comparison assumed a tip that
  survives in the owning project carries its whole history there — false when the owning project is
  a shallow clone or otherwise missing history below the tip: a depth-1 owning project with one
  commit had a scratch clone swept (remote deleted) that held the only copies of the two older
  commits. The comparison now covers every commit reachable from the entry's refs and requires each
  to be reachable from the owning project's refs (that surviving set is read once per scratch
  folder); nothing is assumed about tips, and the "too many commits" cap is gone because commits
  are no longer checked one by one — a history too large or slow for git to list is kept with
  `could not list commits` instead of deleted unchecked. (2) `findWorktreeOutside` read every
  `fs.realpath` failure as "no checkout there", so a registered worktree whose checkout sat behind a
  sealed (mode 000) folder was ignored and the entry went — deleting the shared repository and
  per-worktree index that external checkout runs on. Any registration that cannot be read or
  resolved (sealed or unplugged folder, empty `gitdir` pointer) now keeps the entry. (3) An aged
  top-level plain file reached `findRepos`' `readDir`, and the fail-closed ENOTDIR read as a failed
  inspection, so old dumps and archives were kept forever as `kept-unsaved-work`; a non-folder entry
  holds no repositories and is removed like any other old entry. New tests cover each hole plus the
  controls: a full-history owning project still sweeps the same clone, and aged top-level files go.
  Evidence (queue worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): the three verifier
  scenarios reproduced against the pre-fix code (`removed` with the depth-1 owner, `removed` with
  the sealed worktree parent, `kept-unsaved-work` for the plain file) and each now behaves
  correctly; the eight plan-area spec files pass (92 tests), `npx tsc --noEmit` green,
  `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0, and
  `npm run build:main` green.
- Post-merge re-verification (2026-10-23, resumed queue round): the branch merged main
  (`8bb229425`, bringing the oct-phase4-tooltips and oct2-housekeeping plans) after the round-2
  fixes were written, so the merged tree was checked again from scratch. Nothing was lost in the
  merge: `scratch-sweep.ts` and `scratch-sweep.spec.ts` are the only plan files that differ from
  main's tip — they carry the round-2/3 fixes on top of main's version — and every other plan-area
  file is byte-identical to main's tip, because the round-1 TS2493 mock fix landed on main
  independently with identical content via the oct2-housekeeping plan. All seven Changes items were
  confirmed present and wired in the merged tree: the broad-root guard in `warmWorkspace`,
  `rebuildIndex` and the prewarm coordinator (root, home, its parent, `~/work`, `/tmp`,
  `/private/tmp` and the user temp folder); `journal_size_limit` (64 MiB) in `migrate()` for every
  connection, the stepped vacuum with a checkpoint before and after each 64 MiB step and the busy
  WAL logged, the governor counting `codemem.sqlite-wal`, the 10 s startup/on-request budgets and
  the 5-minute reclaim with `allowFullVacuum: false`; the backup-retention startup step (newest 5,
  7-day minimum age); the always-on `adapter-disk-hygiene` guidance block; the 50 GB/10 GB
  low-disk watcher with its 10-minute poll; the sweep scheduler (first run 10 minutes after
  startup, then daily) and the agent-read-only `scratchRetentionDays` setting (default 14, 0 =
  off); and the updated `~/.agents` completion-gate skill. Evidence (queue worktree
  2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): the eight plan-area spec files pass
  (98 tests), `npx tsc --noEmit` green, `npm run typecheck:spec` green, `npm run lint` green,
  `npm run check:ts-max-loc` exit 0, `npm run check:ui-hints` green, `npm run build:main` green,
  and `npm run build:renderer` green.
- Verification round 3 fixes (2026-10-23): a third independent queue verifier found two more
  holes, both in `scratch-sweep.ts`. (1) Repository discovery skipped every `.git` folder, so
  submodule stores under `.git/modules` were never inspected: after `git submodule deinit` emptied a
  submodule's checkout the superproject's status was clean, the entry was swept, and with it the
  only copy of the submodule's commits (its whole history stays in `.git/modules/<name>`).
  Discovery now walks `.git/modules` and every nested `<store>/modules` — including nested
  submodules (`modules/lib/modules/deep`) and submodule names that contain `/`, which leave
  namespace folders above the store — and each store found is checked like any other repository
  whose history lives in the entry: its whole history against the owning project, plus the
  staged-but-uncommitted state a deinitialized submodule keeps in its index (a store with no work
  tree cannot be `git status`-ed; `diff --cached` against HEAD decides, and a repository without a
  HEAD treats every index entry as uncommitted). (2) A git folder that is not bare but has no work
  tree of its own — the store of a `git clone --separate-git-dir` whose checkout is elsewhere — was
  classified as bare by the HEAD/objects/refs filename check and deleted while that outside checkout
  still ran on it (a primary checkout is not registered in `worktrees/`, so the outside-worktree
  check missed it, and the commit comparison passed because the commits were in the owning
  project). Bare state is now verified with `rev-parse --is-bare-repository`, and a non-bare store
  is only cleared once its dependent checkout is proven to live inside the entry: a submodule's
  gitlink under a work tree found in the entry, or a `.git` file found in the entry naming that
  store (matched on real paths both sides, because git writes the store's real path into the
  pointer while the walk spells the entry's path). Anything else — including a folder shaped like a
  git folder that git itself cannot read — keeps the entry as uninspected repository metadata. New
  tests cover each hole and the controls: a clean deinitialized submodule whose commits are all in
  the project is still swept, a clean `--separate-git-dir` pair inside the entry is still swept, a
  clean bare mirror is still swept, staged work in a deinitialized submodule is kept, and nested
  and slash-named submodule stores are found. Evidence (queue worktree
  2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): the two verifier scenarios reproduced against
  the pre-fix code (`removed` for the deinitialized submodule holding the unique stored commit,
  `removed` for the separate store whose outside checkout then failed with
  `fatal: not a git repository: (null)`) and each now keeps the entry (the outside checkout's
  `git status` still works); all five new keeping tests fail against the pre-fix implementation and
  pass after it (the three new control tests pass on both);
  the eight plan-area spec files pass (106 tests), `npx tsc --noEmit` green,
  `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0,
  `npm run build:main` green, `npm run build:renderer` green.

- Verification round 4 fixes (2026-10-23): a fourth independent queue verifier (whose findings were
  parked at the top of this plan as "round-3 findings to fix next") found two more holes in
  `scratch-sweep.ts`. (1) `checkoutInsideByConvention` inferred containment of every `.git/modules`
  store from its placement and never read `core.worktree`, so a deinitialized submodule store
  configured to an external checkout (that checkout's `.git` pointer names the store absolutely, and
  `core.worktree` names the checkout) was swept and the external checkout died — including for
  nested stores, which inherited the same inference. Containment is now decided by the configured
  checkout path:
  `configuredCheckout` reads `core.worktree` and lets git resolve it (relative values against the git
  folder, symlinks and all, via `rev-parse --show-toplevel` — reported even when the checkout is
  gone, so an unplugged checkout's path still fails containment and keeps the entry), and it is
  consulted for every repository, stores and work trees alike; when it is set it is authoritative
  over the placement inference, the in-entry `.git`-pointer proof and the parent-store chain, and
  when it is unset (the state `git submodule deinit` leaves) the previous proofs and the submodule
  convention apply as before. (2) `git status --porcelain` was the only worktree-content check and
  never reports edits hidden behind skip-worktree or assume-unchanged, so such entries were deleted
  as if clean. `flagHiddenChanges` now detects both flags (`git ls-files -v`: `S`, and a lowercase
  tag for assume-unchanged, `s` for both) and compares every flagged file with its index entry by
  content — `git hash-object` applies the filters staging would and never mutates the index — keeping
  the entry on any difference or unreadable flagged file. New tests cover each hole and the controls:
  a deinitialized submodule configured to an in-entry checkout is still swept, a clone whose flagged
  files are unmodified is still swept, and the paired keep tests cover a top-level and a nested
  store, a work tree configured outside the entry, and both flags. Evidence (queue worktree
  2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-23): the five verifier scenarios reproduced against
  the pre-fix code — all five keeping tests failed with the entry swept `removed` (the nested one
  first needed its `core.worktree` written through `git config --file`, because plain
  `git config` refuses to rewrite a store whose configured checkout is missing) — and each now keeps
  the entry with the external checkout still working (`git status` clean in it); the two control
  tests pass on both; the eight plan-area spec files pass (113 tests), `npx tsc --noEmit` green,
  `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0,
  `npm run check:ui-hints` green, `npm run build:main` green (its prebuild step refreshed the
  committed codex protocol snapshot to the installed codex-cli 0.164.0, as designed), and
  `npm run build:renderer` green.

### Known limits

- The verification-only providers in `src/main/providers/*-cli-provider.ts` build adapters directly and
  do not get the disk hygiene block. They run short read-only reviews.
- The test SQLite driver keeps each connection in separate memory, so the busy-reader WAL case is unit
  tested with a fake driver. It was reproduced against a real file with the `sqlite3` CLI: with a
  reader open, `incremental_vacuum` + `wal_checkpoint(TRUNCATE)` returned busy=1 and the main file
  did not shrink.
- Remote worker machines (for example `windows-pc`) are not swept; only local folders are.
- A pristine clone whose history is not in the owning project — a third-party checkout, or a
  submodule's upstream commits — is kept, because item 6 keeps "commits missing from the owning
  repo" and a remote-tracking ref does not prove its remote still exists. Such entries appear in the
  kept-for-unsaved-work notification and need a hand-delete when they are only mirrors.
- A non-bare git folder whose dependent checkout cannot be proven to live inside the entry is kept
  even when it is clean, because deleting it would strand that checkout's HEAD, index and refs.
  That covers every `--separate-git-dir` store whose checkout is outside (its checkout must be
  deleted or moved together with the entry by hand), and any folder shaped like a git folder that
  git itself cannot read, which is kept as uninspected repository metadata.
- A store with no configured checkout — the deinitialized state of a submodule store — is cleared on
  the submodule checkout convention when nothing else proves its checkout. A hand-written absolute
  `gitdir:` pointer from outside the entry into such a store cannot be seen from inside it and would
  strand when the entry goes. Git itself never writes one: every native checkout mechanism
  configures `core.worktree` (now resolved and validated) or registers the worktree (checked), but a
  hand-made binding of that shape is undetectable from the entry.
- A copy (`cp -a`) of a separate-git-dir pair, or of a checkout whose store keeps an absolute
  `core.worktree` naming the original location, is kept even when nothing outside is at risk: the
  configured path resolves outside the copy. Such copies need a hand-delete when they are only
  duplicates.
- Sweeps now walk dependency folders, so inspecting an entry that holds a full clone plus installs
  takes a few seconds (measured 2026-10-23 on this Mac: ~2-4 s of lstat/readdir per such entry) and
  entries with more than 200,000 folders are kept rather than fully walked.
- A repository history too large for git to list in one command output (the shared git runner caps
  stdout at 10 MiB) or too slow to walk keeps the entry with `could not list commits`, a tracked-file
  list over the same cap keeps it with `could not read the index`, and an owning
  project whose own history cannot be read keeps entries that have commits of their own
  (`could not compare …`); all fail closed instead of deleting unchecked.

## Verification

- **Blocking defect (found 2026-10-23 by an independent queue verifier; fixed 2026-10-23, see As
  built):** this plan's own specs `src/main/storage/low-disk-space-watcher.spec.ts` (two sites) and
  `src/main/storage/scratch-sweep-scheduler.spec.ts` (one site) failed `npm run typecheck:spec` on main
  with TS2493, because `vi.fn((): boolean => true)` is indexed as `mock.calls[n]![0]`. The mocks now
  declare a typed `NotificationInput` parameter; the assertions are unchanged and the gate is green,
  so queue verification is unblocked.
- **Verification round 1 (2026-10-23, independent queue verifier; fixed 2026-10-23, see As
  built):** three high findings in the scratch sweep — remote-tracking refs bypassed the
  owning-repository check (a clone whose remote was gone lost its last copy of unique commits),
  unreadable directories were treated as empty so uncommitted work behind a mode-0100 folder was
  deleted, and `node_modules` hid nested dependency checkouts from repository discovery. Each
  scenario was reproduced against the pre-fix code and is now covered by a keeping test; see the
  "Verification round 1 fixes" note in As built for the evidence.
- **Verification round 2 (2026-10-23, independent queue verifier; fixed 2026-10-23, see As
  built):** three findings in the scratch sweep — the remote-tip comparison deleted history a
  depth-1 owning project did not have (the scratch copy was the last full history), an unresolvable
  worktree registration was ignored so the shared repository behind an external checkout was
  deleted, and aged top-level files were kept forever as unreadable unsaved work. Each scenario was
  reproduced against the pre-fix code and is now covered by a test (the first two keep the entry,
  the last removes the file); see the "Verification round 2 fixes" note in As built for the
  evidence.
- **Verification round 3 (2026-10-23, independent queue verifier; fixed 2026-10-23, see As
  built):** two findings in the scratch sweep — a deinitialized submodule was deleted with the only
  copy of its commits because repository discovery never looked inside `.git/modules`, and a
  separate-git-dir store was deleted while an outside checkout still ran on it because the
  filename-based bare check never asked git and the primary checkout is not registered in
  `worktrees/`. Each scenario was reproduced against the pre-fix code and is now covered by a
  keeping test (plus controls that a clean deinitialized submodule, a clean in-entry
  separate-git-dir clone and a clean bare mirror are still swept); see the "Verification round 3
  fixes" note in As built for the evidence.
- **Verification round 4 (2026-10-23, independent queue verifier; fixed 2026-10-23, see As
  built):** two findings in the scratch sweep — a deinitialized submodule store configured to an
  external checkout (absolute `.git` pointer) was swept with the only git folder that checkout ran
  on, because containment of `.git/modules` stores was inferred from placement and `core.worktree`
  was never read (nested stores included), and uncommitted edits hidden behind skip-worktree or
  assume-unchanged were deleted as if clean, because `git status` never reports them. Each scenario
  was reproduced against the pre-fix code (all five keeping tests swept as `removed`) and is now
  covered by a keeping test (plus controls that a deinitialized submodule configured to an in-entry
  checkout and a clone whose flagged files are unmodified are still swept); see the "Verification
  round 4 fixes" note in As built for the evidence.
- Unit tests per change (broad-root guard, stepped vacuum + journal limit against a real SQLite file,
  backup retention, guidance block present for every adapter spawn, disk watcher thresholds, scratch
  sweep keeps recent and unsaved-work entries).
- Canonical gates from `AGENTS.md`.
- Fresh-eyes completion gate.
- Live checks that need a rebuilt app are in
  [`2026-10-22-aio-tidies-up-after-itself_plan_livetest.md`](2026-10-22-aio-tidies-up-after-itself_plan_livetest.md).

> Plan Queue parked work: `queue/2026-10-22-aio-tidies-up-after-b3eba2` — 5 commit(s), reason: round-limit.
