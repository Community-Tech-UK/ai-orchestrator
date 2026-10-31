## Verifier findings (25 Oct, queue verification round 2 of 3 — fixed 25 Oct, round 10)

1. High - `scratch-sweep.ts:805` - the sweep deletes scratch entries holding the owning repository's only packed
   or loose objects when a symlink below its object-store root points into the entry. `loadObjectStores` records
   object-store roots and `objects/info/alternates` lists, but never dependencies below those roots, so
   `ownerObjectStoreDependency` clears entries holding `objects/pack`, individual `.pack` files, or loose-object
   fanout directories. Independently reproduced all three layouts using disposable real Git repositories: move
   the relevant path into `owner/_scratch`, symlink its original location to the moved path, and call
   `sweepScratchFolders` with `retentionDays:14` and `now` advanced 30 days. Before each sweep, `git log` and
   `git show HEAD:draft.txt` succeed; each sweep returns `removed` and deletes the entry; afterward `git log`
   exits 128 with `cannot read commit object` or `bad object HEAD`. This violates the plan's requirement that the
   owning object's graph survive independently of deleted entries. Track the dependent object paths and their
   symlink resolution, or fail closed for these layouts, with regression tests.

Fixed (2026-10-25) — see "Verification round 10 fixes" in As built and "Verification round 10" below.

## Verifier findings (25 Oct, queue verification round 1 of 3 — fixed 25 Oct, round 9)

1. High - `scratch-sweep.ts:795` - the sweeper deletes alternates metadata that the owning repository still needs,
   leaving that repository unable to read HEAD. `loadObjectStores` records only each object-store directory's named
   and resolved paths (line 789) but follows `objects/info/alternates` (line 795) without recording dependencies on
   the alternates file itself or its symlink resolution, and a plain-file entry bypasses dependency inspection
   entirely (lines 310-314). With the owner's objects moved to a durable directory outside `_scratch` and
   `owner/.git/objects/info/alternates` symlinked to `_scratch/alternate-list` (a plain file naming the durable
   objects path) or to `_scratch/alternate-list/alternates` (the same list inside a folder entry), `git log` works
   before sweeping, `sweepScratchFolders` returns `removed` for the file/folder, and `git log` afterward exits 128
   with `fatal: bad object HEAD`. Track the alternates file's own resolved and intermediate path dependencies,
   including chained stores, and apply that protection to plain-file entries as well as folders/symlinks; add
   regression tests preserving the owner's readable history.

Fixed (2026-10-25) — see "Verification round 9 fixes" in As built and "Verification round 9" below.

## Verifier findings (24 Oct round 3, coordinator handoff — fixed 24 Oct, round 8)

1. `scratch-sweep.ts:710` - `decodeAlternatesRecord` turns octal escapes into characters with `String.fromCharCode`
   instead of decoding BYTES (Git's `caf\303\251` becomes `cafÃ©` not `café`), and the resulting ENOENT ends the
   alternates chain as "normal" - the owner's last object store can be deleted. Decode octal escapes as bytes with the
   filesystem encoding (or fail closed) and add the regression.
2. `scratch-sweep.ts:793` - the object-store dependency check tests only the lexical spelling and the final realpath,
   missing intermediate symlink resolutions (alias -> entry -> symlink -> durable store): paths the owner still needs get
   deleted. Check every intermediate resolution dependency or fail closed, with a regression.

Both are fixed (2026-10-24) — see "Verification round 8 fixes" in As built and "Verification round 8" below.

## Verifier findings (24 Oct round 2, coordinator handoff — fixed 24 Oct, round 7)

1. `scratch-sweep.ts:672` - `loadObjectStores` passes quoted alternates lines straight to `path.resolve` without
   decoding Git's C-style quoting, and a resulting ENOENT ends the chain as "normal": a quoted alternates path to the
   OWNER's only objects can be deleted, breaking the owner repository. Decode Git alternates syntax or fail closed on
   unsupported records, with a regression.
2. `scratch-sweep.ts:123` - the symlink branch unlinks an aged symlink BEFORE any owner-dependency check, and
   `loadObjectStores` keeps only real paths (dropping symlink path components): a symlink in the owner's
   alternates chain gets unlinked and the owner breaks. Preserve lexical and resolved object-store dependencies and
   check them before unlinking, with a regression.

Both are fixed (2026-10-24) — see "Verification round 7 fixes" in As built and "Verification round 7" below.


## Verifier findings (24 Oct, queue verification round 2 of 3 — fixed 24 Oct, round 6)

1. High - `scratch-sweep.ts:395` - the commit-survival check compares only `rev-list` commit IDs against
   `loadSavedCommits`, so matching commit IDs can still delete the last durable copy of git objects. A
   `--filter=blob:none` owner and a full scratch clone share every commit ID while a historical blob exists only
   in the scratch copy (sweep returned `removed`; the owner's `git show` then failed `bad object`), and a valid
   owner `objects/info/alternates` chain pointing into the aged scratch repository makes the entry part of the
   owner's own object graph (sweep returned `removed`; `git log` in the owner then failed `fatal: bad object
   HEAD`). Fail closed when the owner's surviving object graph is incomplete or depends on the entry (including
   alternate chains).

Fixed (2026-10-24) — see "Verification round 6 fixes" in As built and "Verification round 6" below.

## Verifier findings (24 Oct coordinator handoff — fixed 24 Oct, round 5)

1. High - `scratch-sweep.ts:424` reads `core.worktree` with `git config --local`, missing worktree-specific config
   (`config.worktree` when `extensions.worktreeConfig=true`): a store serving an OUTSIDE checkout can be deleted. Read
   the effective configuration (including worktree config/includes) before approving removal.
2. High - `scratch-sweep.ts:327` - a non-bare store with an in-entry configured checkout is swept with only
   `storeStagedChanges`; unstaged/untracked work in that checkout is deleted. Check the resolved configured checkout
   even without a `.git` pointer.
3. Medium - `scratch-sweep.ts:459` - the hidden-change check compares blob hashes only, missing executable-bit and
   file-type changes behind `assume-unchanged`/`skip-worktree`. Compare tracked type and executable mode too.

All three are fixed (2026-10-24) — see "Verification round 5 fixes" in As built and "Verification round 5" below.

# AIO tidies up after itself — plan

On main: no.

**Status:** READY FOR QUEUE VERIFICATION (parked fixes restored and locally verified 2026-10-31; round-10 findings fixed 2026-10-25; round-9 findings fixed 2026-10-25; round-8 findings fixed 2026-10-24; round-7 findings fixed 2026-10-24; round-6 finding fixed 2026-10-24; round-5 findings fixed 2026-10-24;
round-4 findings fixed 2026-10-23;
previous round-3 findings fixed 2026-10-23; post-merge re-verified 2026-10-23). Written 2026-10-22 after
James's Mac filled its 4 TB
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
  no repositories and is removed like any other old entry — after the owning project's object-graph
  dependency check, which runs for every entry kind (folder, symlink and plain file alike) and keeps
  an entry that is or leads to an `objects/info/alternates` list the owner reads its chain out of, or
  that holds or leads to a link below an object-store root — a `pack` folder, one `.pack`, a
  loose-object fanout, one loose object — the packed and loose objects are read through. A
  symlink entry is unlinked only, never followed (after that same check). Linked worktrees are
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

- Verification round 5 fixes (2026-10-24): the coordinator handoff findings (parked at the top of this plan) found
  three more holes in `scratch-sweep.ts`. (1) `configuredCheckout` read `core.worktree` with `git config --local`,
  which never sees the worktree-specific `config.worktree` (used when `extensions.worktreeConfig=true`) or an
  `include`; a store whose `core.worktree` named an outside checkout only there read as unconfigured, fell to the
  placement/submodule-convention inference, and was deleted with the only git folder that outside checkout ran on.
  It now reads the effective value (`git config --get core.worktree`) and, when set, lets `rev-parse --show-toplevel`
  decide containment exactly as before. (2) A non-bare store with an in-entry configured checkout was cleared with
  only `storeStagedChanges` (index-vs-HEAD), so unstaged edits and untracked files in that checkout were deleted —
  and the checkout is missed entirely when it carries no `.git` pointer of its own and is so never inspected as a
  repository. The `inside` case now runs `checkoutUnsaved`, which checks the resolved checkout's untracked files
  (`ls-files --others`), unstaged non-deletion changes (`diff-files --diff-filter=d`), the staged index and the
  flagged files. Pure worktree deletions of tracked files are deliberately not treated as work: they are the empty
  remnant `git submodule deinit` leaves and remain recoverable from the owning project (which the commit comparison
  has already proved holds them). (3) `flagHiddenChanges` compared only blob hashes, so a hidden
  skip-worktree/assume-unchanged change that flipped the executable bit or the file type (both keep the blob
  identical) looked clean. It now also compares the tracked mode and executable bit against the working file's own
  mode (`lstat`), honouring `core.fileMode` for the executable bit. New tests cover each hole plus the controls: a
  deinit store configured to an in-entry checkout is still swept, a clone whose flagged files are unmodified is
  still swept, and a worktree-configured in-entry checkout that is clean is still swept. Evidence (queue worktree
  2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-24): the three verifier scenarios reproduced against the pre-fix
  code (all `removed` — outside checkout stranded, in-entry work deleted, hidden mode/type change deleted) and each
  now keeps the entry (four new keeping tests — one per scenario, with two for the hidden-change case); the control
  that a worktree-configured in-entry clean checkout is still swept passes, as do the existing controls that a deinit
  store configured to an in-entry checkout and a clone whose flagged files are unmodified are still swept; the eight
  plan-area spec files pass (118 tests, incl. 59 scratch-sweep + 5 scheduler), `npx tsc --noEmit` green,
  `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0 (scratch-sweep.ts added to
  the allowlist at 730 lines — it encodes the git-safety rules and grew across three hardening rounds),
  `npm run check:ui-hints` green, `npm run build:main` green, `npm run build:renderer` green. The two
  nested-submodule tests were given a 20 s timeout (they are
  inherently slow: `submodule update --init --recursive`) — assertions unchanged; they were borderline-flaky at the
  5 s default even before these fixes.

- Verification round 6 fixes (2026-10-24): an independent queue verifier (round 2 of 3) found one more hole in
  `scratch-sweep.ts`: the commit-survival check compared only `rev-list` commit IDs against `loadSavedCommits`, so
  matching commit IDs could still delete the last durable copy of git objects. (1) A `--filter=blob:none` owning
  project lists every commit while its historical blobs were never fetched — `rev-list --objects --all
  --missing=print` showed them missing — and the full scratch clone held the only copy of one; the sweep returned
  `removed`, and with the source remote gone the owner's `git show` then failed with `bad object`. (2) A valid
  owner `objects/info/alternates` chain pointing into the aged scratch repository made the entry part of the
  owner's own object graph (the owner's HEAD object existed only there, so `--missing=print` even reported the
  graph complete); the sweep returned `removed`, and `git log` in the owner then failed with `fatal: bad object
  HEAD`. The commit-survival check now proves the owning project keeps the history *and its contents* on its own:
  `loadSavedCommits` became `loadOwnerSurvival`, which still reads the ref-reachable commits and additionally
  (a) requires the owner's reachable object graph to hold every object — `rev-list --objects --all --missing=print`
  is read passively (`cat-file` would fetch promised objects from a still-living remote and mask the gap) and any
  `?` line keeps every entry that has commits of its own (`… may hold the last copy of its contents: … is missing
  objects from its own history`; an object list the runner cannot read keeps them the same way), and (b) reads the
  owner's object stores — its own plus every store named by an `objects/info/alternates` chain, relative names
  resolved against the objects directory that names them, chains followed through stores outside the owner, cycles
  tolerated — and keeps any directory entry holding one of those stores (`the owning project … reads objects from
  inside this folder`), because deleting it would break the owner itself. A chain that cannot be read fails closed
  the same way (`could not read the object stores of …`): an alternate names an object store directory, so plain
  file entries are still removed. New tests cover both verifier cases, the chain form of the second, the
  unreadable-chain case, and two controls (an
  owner sharing objects only with stores outside the folder still sweeps a clean clone; a plain folder is still
  removed while the owner is missing objects, since the gate is about history contents). Evidence (queue worktree
  2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-24): the two verifier scenarios reproduced against the pre-fix
  code (all four new keeping tests returned `removed`) and each now keeps the entry, with the owner still able to
  `git log` after the sweep; the eight plan-area spec files pass (118 tests, incl. 65 scratch-sweep + 5
  scheduler), `npx tsc --noEmit` green, `npm run typecheck:spec` green, `npm run lint` green,
   `npm run check:ts-max-loc` exit 0 (scratch-sweep.ts ceiling raised 730 -> 835 for the object-survival rules),
   `npm run check:ui-hints` green, `npm run build:main` green, `npm run build:renderer` green.

- Verification round 7 fixes (2026-10-24): the coordinator handoff findings (parked at the top of this plan) found
  two more holes in `scratch-sweep.ts`, both in the owning-project object-store check. (1) `loadObjectStores` read
  every `objects/info/alternates` line as a raw path, while git reads a C-quoted record through its own unquoting
  (verified against git on this Mac 2026-10-24: quoted paths and `\n`/`\t`/`\"`/`\\`/octal escapes decode and load,
  a missing closing quote or an unknown escape is refused with `unable to normalize alternate object path`, and raw
  lines keep their spaces untrimmed). A quoted record therefore named a path with literal quote characters in it;
  the ENOENT under that invented name ended the chain as "no alternates here", the store the record actually names —
  the owner's only objects — was never seen, and the entry holding it was deleted (`removed`), after which the
  owner's `git log` failed with `fatal: bad object HEAD`. Records are now decoded exactly as git reads them
  (C-style escapes `\a \b \f \n \r \t \v \\ \"` plus up to three octal digits; whitespace-only slack after the
  closing quote; raw lines used untrimmed, spaces and all), and a record the decoder cannot read fails closed
  (`could not read the object stores of …` keeps every entry): it may name any store at all, so independence from
  the entries cannot be proven. (2) The symlink branch in `decideAndSweep` unlinked an aged symlink entry before
  any owner-dependency check, and `loadObjectStores` kept only `realpath` results, dropping the spellings the owner
  re-resolves on every git command: a symlink the owner's alternates chain runs through — the entry itself, or one
  inside a folder entry while the store lands outside it — was unlinked with the entry (`removed`), the named path
  then failed to normalize on the owner's next command, and the owner broke even though the objects themselves were
  untouched. `loadObjectStores` now records both spellings of every store — the name the chain spells (symlink
  components intact, `..` not collapsed, relative records joined against the naming store's spelling) and where
  that name lands (symlinks resolved) — with pair-keyed cycle tolerance and a 32-link chain bound that fails
  closed beyond it, and `ownerObjectStoreDependency` checks both before anything is removed: resolved containment
  (the objects are read from inside the entry) and lexical containment (the name runs through the entry, in either
  the entry's as-spelled or resolved form, raw or `..`-collapsed). The check runs for directory entries in
  `inspectEntry` as before and now for symlink entries in `decideAndSweep` before the unlink — plain-file entries
  are unchanged, since an alternate names a directory and a chain can never run through a file. New tests cover
  both verifier cases plus the chain form of the first and the fail-closed branch (six keeping tests, each
  returning `removed` against the pre-fix code), and two controls pass on both (a C-quoted link naming only stores
  outside the folder still sweeps a clean clone, and a folder whose symlink the chain does not run through is still
  removed). Evidence (queue worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-24): the two verifier
  scenarios reproduced against the pre-fix code (all six new keeping tests returned `removed`; with the quoted
  path gone the project's own `git log` then failed `fatal: bad object HEAD`, and the symlink scenarios left the
  owner's alternates name dangling the same way) and each now keeps the entry with the owner's `git log` intact;
  the eight plan-area spec files pass (133 tests, incl. 73 scratch-sweep + 5 scheduler), `npx tsc --noEmit` green,
  `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0 (scratch-sweep.ts
  ceiling raised 835 -> 971 for the alternates decoder and the lexical+resolved dependency checks),
  `npm run check:ui-hints` green, `npm run build:main` green, `npm run build:renderer` green.

- Verification round 8 fixes (2026-10-24): the coordinator handoff findings (parked at the top of this plan) found two
  more holes in `scratch-sweep.ts`, both in the owning-project object-store check. (1) `decodeAlternatesRecord` decoded
  octal escapes as characters (`String.fromCharCode`), while git's C-style unquoting produces BYTES that the filesystem
  encoding then reads as a name (verified against git on this Mac 2026-10-24: an alternates record spelling `café` as
  `"caf\303\251"` loads and serves objects, because `\303\251` is the two UTF-8 bytes of `é`, not the characters `Ã©`).
  Read as characters, the record named `cafÃ©-source` — a path that does not exist — and the ENOENT under that invented
  name ended the chain as "normal": the store the record really named (the owner's only objects) was never seen and the
  entry holding it was deleted (`removed`), after which the owner's `git log` failed with `fatal: bad object HEAD`. The
  alternates file is now read as raw bytes and each record is decoded byte for byte (C-style escapes and up to three
  octal digits produce the bytes they name; values past 0xFF truncate like git's own store) into a name in the
  filesystem encoding, with a name the encoding cannot represent — NUL bytes included — failing closed
  (`could not read the object stores of …`), exactly like a record the decoder cannot read. (2) `ownerObjectStoreDependency`
  tested only the store name's lexical spelling and its final realpath, while a name's resolution can run through the
  entry at an intermediate symlink hop: alias (outside) to entry to symlink (inside the entry) to a durable store
  (outside) — neither the name as spelled nor where it lands touches the entry, but every git command re-resolves the
  name through the entry's link, and removing the entry makes the name `unable to normalize alternate object path` (its
  objects become unreadable even though they are untouched — verified against git on this Mac 2026-10-24). The check now
  walks the name's resolution hop by hop (`resolutionSpellings`/`lookupSpellings`) and checks every lookup spelling —
  each component, `..` pops included, and after every symlink hop the link's target looked up component by component
  (relative targets against the directory the link sits in) — plus the name as spelled and collapsed, against the entry
  in four spellings (as named, collapsed, fully resolved, and resolved-parent-plus-name, which is the spelling an
  intermediate hop lands on for a symlink entry whose `realpath` is its target). A walk that cannot be finished — an
  unreadable component, a symlink loop, more than 32 hops (the kernel's ELOOP bound), a name that is not absolute —
  fails closed (`could not resolve the object stores of …`) for every folder and symlink entry: the independence of
  those entries from the name is unproven (an unplugged drive behind a hop is the everyday case). New tests cover both
  verifier cases (a C-quoted record spelling the clone's store as `caf\303\251`, and the alias-entry-symlink-durable
  chain), the fail-closed half (a symlink entry that is a hop of a name whose next hop is unplugged), and a control
  (an octal-escaped record naming only stores outside the folder still sweeps a clean clone — the octal escapes decode
  to a working name rather than being rejected). Evidence (queue worktree 2026-10-22-aio-tidies-up-after-b3eba2,
  2026-10-24): the two verifier scenarios and the fail-closed case reproduced against the pre-fix code (all three new
  keeping tests returned `removed`; with the octal path gone the project's own `git log` then failed `fatal: bad object
  HEAD`, and the hop case left the owner's name unable to normalize the same way) and each now keeps the entry with the
  owner's `git log` intact; the eight plan-area spec files pass (130 tests, incl. 77 scratch-sweep + 5 scheduler),
  `npx tsc --noEmit` green, `npm run typecheck:spec` green, `npm run lint` green, `npm run check:ts-max-loc` exit 0
  (scratch-sweep.ts ceiling raised 971 -> 1130 for the byte-accurate alternates decoder and the intermediate-resolution
  walk), `npm run check:ui-hints` green, `npm run build:main` green, `npm run build:renderer` green.

- Verification round 9 fixes (2026-10-25): an independent queue verifier (round 1 of 3) found one more hole in
  `scratch-sweep.ts`: the alternates metadata itself was not a tracked dependency. `loadObjectStores` recorded only
  each object-store directory's named and resolved paths and then followed `objects/info/alternates` without
  recording the file it reads the chain out of — or the symlink hops that file's own resolution runs through — and a
  plain-file entry bypassed `ownerObjectStoreDependency` entirely (the `inspectEntry` early return for non-folders
  ran before any owner-dependency check). With the owner's objects moved to a durable directory outside `_scratch`
  and `owner/.git/objects/info/alternates` symlinked to `_scratch/alternate-list` (a plain file naming the durable
  store) or to `_scratch/alternate-list/alternates` (the same list inside a folder entry), `git log` worked before
  the sweep, `sweepScratchFolders` returned `removed`, and `git log` afterward exited 128 with `fatal: bad object
  HEAD`. (1) `loadObjectStores` now records every `objects/info/alternates` file the chain is actually read out of —
  the owner's own and each chained store's alike — with both path spellings (named and resolved), exactly like the
  stores themselves: the list is the only reason the owner can find the stores after it, so a list the entry holds
  or leads to dies with the entry. A list that cannot be read still ends the chain there exactly as git sees it
  (`ENOENT`/`ENOTDIR` is the normal "no alternates here"), and anything else still fails closed. (2)
  `ownerObjectStoreDependency` now checks both dependency groups — stores and alternates lists — before anything is
  removed: resolved containment (`isInside` on the list's realpath, so a plain-file entry that IS the list, or a
  folder that contains it, is kept) and every lookup spelling of the list's resolution (symlinks followed hop by
  hop, intermediate hops included) against the entry's spellings, with a walk that cannot be finished failing
  closed; a hit on the list group reports `reads its object store links from inside this folder`. (3) The check is
  hoisted to `decideAndSweep` and now runs for every entry kind — folders, symlinks and plain-file entries alike —
  instead of only for folders and symlinks. New tests cover the two verifier scenarios (a plain-file list and a
  folder list the owner's link resolves through), the chained-store form (a chained store's own `info/alternates`
  runs through the entry), the intermediate-hop form (the list resolves through the entry and lands outside), the
  symlink-entry form, and a control (a list that does not run through the folder still sweeps aged file and folder
  entries); each keeping test asserts the owner's `git log` works before and after the sweep. Evidence (queue
  worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-25): the two verifier scenarios reproduced against the
  pre-fix code exactly as reported (all five new keeping tests returned `removed`; the verifier's own repro log
  `/tmp/aio-verifier-34106e97-alternates-repro.log` shows the same two cases ending `AFTER_EXIT=128 fatal: bad
  object HEAD`) and each now keeps the entry with the owner's `git log` intact; the eight plan-area spec files pass
  (143 tests, incl. 83 scratch-sweep + 5 scheduler), `npx tsc --noEmit` green, `npm run typecheck:spec` green,
  `npm run lint` green, `npm run check:ts-max-loc` exit 0 (scratch-sweep.ts ceiling raised 1130 -> 1160 for the
  alternates-file dependency tracking and the plain-file coverage), `npm run check:ui-hints` green,
  `npm run build:main` green, `npm run build:renderer` green.

- Verification round 10 fixes (2026-10-25): an independent queue verifier (round 2 of 3) found one more hole
  in `scratch-sweep.ts`: nothing below the owning project's object-store roots was tracked. (1) `loadObjectStores`
  recorded each store root and each `objects/info/alternates` list but no dependency under a root, so
  `ownerObjectStoreDependency` cleared an entry a link below a root pointed into — the `pack` folder moved aside
  and linked back, one `.pack` (its `.idx` left in place), or a loose-object fanout — and the owner's `git log`
  then failed with `cannot read commit object` or `bad object HEAD` while the objects themselves were untouched
  (all three layouts reproduced with disposable real git repositories). `loadObjectStores` now records every link
  below each store root — where the packed and loose objects themselves are read through — with both spellings
  (named and resolved), following directory links too (a link can lead to a folder that links back into an entry)
  with every folder reached visited once so a cycle cannot walk forever; a walk that cannot be finished — an
  unreadable folder below a root, or more than 1,000 links — fails closed (`could not read the object stores of
  …` keeps every entry: which paths the owner reads its objects through is then unproven). (2)
  `ownerObjectStoreDependency` checks the new `contents` group like the stores and alternates groups before
  anything is removed — resolved containment (an entry that holds the link's target, plain-file entries that ARE
  the moved pack included) and every lookup spelling of the link name's resolution, symlink hops included — for
  every entry kind. The implementation was checkpointed before a session pause; tests, ceiling, evidence and
  these notes were completed after resume. New tests cover the three verifier layouts (pack folder, individual
  `.pack`, loose-object fanouts), the plain-file entry form (the moved `.pack` is itself the entry), the
  intermediate-hop form (`objects/pack` resolving through the entry and landing outside), the fail-closed branch
  (an unreadable folder below a store root), and a control (a pack folder linked from outside `_scratch` still
  sweeps aged entries); each keeping test asserts the owner's `git log` works before and after the sweep. Evidence
  (queue worktree 2026-10-22-aio-tidies-up-after-b3eba2, 2026-10-25): the three verifier layouts reproduced
  against the pre-fix code in disposable real repositories (`git log` and `git show HEAD:README.md` fine before
  the sweep, the sweep returning `removed`, `git log` afterward `fatal: cannot read commit object` for the pack
  layouts and `fatal: bad object HEAD` for the loose one — fixtures removed afterwards) and all six new keeping
  tests return `removed` against the pre-fix code and keep the entry after it with the owner's `git log` intact
  (the control passes on both); the eight plan-area spec files pass (143 tests, incl. 90 scratch-sweep + 5
  scheduler), `npx tsc --noEmit` green, `npm run typecheck:spec` green, `npm run lint` green,
  `npm run check:ts-max-loc` exit 0 (scratch-sweep.ts ceiling raised 1160 -> 1283 for the store-contents
  dependency tracking), `npm run check:ui-hints` green, `npm run build:main` green, `npm run build:renderer`
  green.

### Queue worker reconciliation (2026-10-31)

The new queue checkout started at `507d1592d` with the original 323-line scratch sweeper, despite
this document describing later fixes. The parked branch
`queue/2026-10-22-aio-tidies-up-after-b3eba2` preserves those fixes. Its merge-base-to-tip diff
contains only the sweeper, its tests and the file-size ceiling. Those changes were read and restored
as working-tree edits in `queue/2026-10-22-aio-tidies-up-after-e058a4`, without switching branches,
merging, committing, or changing the parked branch. The root plan remains at its original absolute
path and filename; there is no separate spec.

The current checkout's newer Electron-safe `../util/remove-tree` helper is retained in
`removeSealedTree`, including the permission-repair retry. The parked code's direct `fs.rm` calls
were not brought back. The restored file-size ceiling is 1,284 lines, with a concise explanation;
other ceilings and all enforcement logic are unchanged. The restored tests are byte-identical to
the parked tests. No dependencies, compiler/test settings, or generated contracts changed.

Implementation checklist (source-level checks complete; installed-app checks below remain open):

- [x] 1. Broad-root guard: shared helper plus prewarm and worker warm/rebuild guards. Traced
  `warmCodememWithTimeout` -> `CodememService.warmWorkspace` -> worker gateway -> worker guard
  (`src/main/instance/warm-codemem.ts:51`, `src/main/codemem/index.ts:161`,
  `src/main/codemem/index-worker-main.ts:316,366`). The guard is at the worker's indexing entry,
  as recorded in the original as-built notes.
- [x] 2. Index space reclaim: `migrate` sets the journal limit for both live connections;
  bounded vacuum/checkpoint steps stop on busy readers; worker maintenance reports/logs the
  result; the resource governor counts the WAL (`cas-schema.ts:130`,
  `cas-workspace-index-maintenance.ts:156`, `index-worker-main.ts:473,489`,
  `src/main/app/late-runtime-initialization-steps.ts:321`).
- [x] 3. Codex backup retention: newest five plus seven-day protection, startup after the two
  backup-producing steps (`codex-state-backup-retention.ts:32`,
  `src/main/app/late-runtime-initialization-steps.ts:293-295`).
- [x] 4. Agent cleanup guidance: appended by the central adapter factory, with duplicate avoidance
  and context-manifest attribution (`adapter-factory.ts:637`, `adapter-spawn-helpers.ts:347`,
  `src/main/providers/provider-runtime-service.ts:113`).
- [x] 5. Low-disk watcher: ten-minute poll, warning below 50 GiB and critical below 10 GiB,
  retries/reminders and startup wiring (`src/main/storage/low-disk-space-watcher.ts:9-11,107`,
  `src/main/app/late-runtime-initialization-steps.ts:298`).
- [x] 6. Scratch sweep: all recorded round-1 through round-10 fixes restored, including unreadable
  content, hidden edits, nested repositories/submodule stores, external checkouts, full-history
  comparison, missing objects, alternates metadata and symlink dependencies below object stores.
  The scheduler/settings wiring remains intact; agents cannot change the retention setting.
- [x] 7. Completion-gate skill: read the actual global `~/.agents/skills/task-completion-gate/SKILL.md`
  and `references/runbook.md`; both already require one reusable temporary copy and removal after
  verification, respecting the user's worktree policy. No further global edit is needed.

Fresh evidence from this checkout:

- Baseline scratch tests: 27 passed, exit 0 (`_scratch/test-run.pid-76026.log`).
- Restored tests run against the original implementation: four selected safety cases failed,
  exit 1, each reporting `removed` instead of keeping the entry (vanished remote, alternates-list
  file, object-store pack directory, hidden skip-worktree edits;
  `_scratch/test-run.pid-66614.log`). No test expectation was weakened to obtain a pass.
- Restored implementation: 90 scratch tests passed, exit 0
  (`_scratch/test-run.pid-71718.log`); seven other plan-area files passed, 53 tests, exit 0
  (`_scratch/test-run.pid-17505.log`); guidance integration and real-Electron/Node deletion-helper
  checks passed, 11 tests, exit 0 (`_scratch/test-run.pid-34244.log`).
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`, and `git diff --check`
  all exited 0. Renderer build reports the bundle-size warning (1.64 MB initial vs 1 MB warning
  budget); no renderer code changed. `generate:aliases` and `generate:ipc` exited 0 and produced
  no tracked changes; the main prebuild found the committed Codex protocol snapshot current.
- Own review checked restored safety rules, callers, removed helper references, test integrity,
  the retained Electron deletion path and the final three-file scope. It is not an independent
  gate. Independent verifier dispatch was unavailable in this worker context
  (`collab spawn failed: ... invalid thread-store request: no rollout found`); the queue
  coordinator's independent verification remains required, as the worker contract specifies.
- Full suite intentionally not run: it belongs to the queue verifier. All installed-app checks
  remain pending in the existing
  [live-test document](2026-10-22-aio-tidies-up-after-itself_plan_livetest.md); no installed app
  was started, restarted or changed and no actual user scratch folders were swept.

Handover evidence is in this worktree's `_scratch/tidies-worker-report.md`,
`_scratch/tidies-command-receipts.json`, and `_scratch/tidies-worker-seal.json`.
Only disposable test fixtures and compiled output were created; fixtures were removed by test
teardown and the worker removes its compiled output after writing these records. Existing shared
dependency/cache symlinks remain in place for the verifier. This plan is ready for queue
verification, not independently accepted or renamed complete.

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
- When the owning project's object graph is incomplete — a `--filter=blob:none` clone that never fetched some
  blobs is the everyday case — every entry that has commits of its own is kept, even one that does not itself
  hold the missing objects: a matching commit ID no longer proves the contents survive anywhere, and the sweep
  does not cross-check object by object. Fetching the missing objects into the owning project (or finishing the
  clone) lets those entries go.
- `objects/info/alternates` chains are followed (relative names against the objects directory that names them,
  chains through stores outside the entry included), with every record decoded as git reads it — C-style
  quoting and byte escapes included (an octal escape names a byte; the name is what the filesystem encoding
  reads out of the decoded bytes) — and kept in both the spelling the chain names it by and the place that
  spelling lands. Every lookup spelling of the name's resolution is checked as well — symlinks followed hop
  by hop, so a link's target spelling through the entry counts as a dependency exactly like the store the
  name reaches — and a resolution that cannot be walked (a component behind an unplugged drive, a symlink
  loop, more than 32 hops) keeps every entry (folders, symlinks and plain files alike) with
  `could not resolve the object stores`; a record the decoder cannot read and a chain deeper than 32 links keep
  them the same way with `could not read the object stores`. The lists themselves are dependencies too: each
  `objects/info/alternates` file the chain is read out of — the owner's own and every chained store's — is kept
  in both spellings exactly like a store (its resolved containment and every lookup spelling of its own
  resolution, `info` and symlink hops included), so an entry that holds one or leads to it is kept with
  `reads its object store links from inside this folder`. Dumb-HTTP `objects/info/http-alternates` URLs are not
  treated as local object stores.
- Every link below an object-store root is tracked the same way as the stores and lists themselves: the `pack`
  folder, one `.pack`, a loose-object fanout, one loose object — the paths the packed and loose objects are read
  through — each recorded where it is spelled and where it lands, directory links followed too (a link can lead to
  a folder that links back into an entry), and checked before removal, so an entry that holds one or leads to one
  is kept with `reads its object store contents from inside this folder`. A store whose contents cannot be fully
  walked — an unreadable folder below a root, more than 1,000 links — keeps every entry with
  `could not read the object stores`, exactly like an alternates chain that cannot be read.
- A symlink entry whose *target* holds an object store or an alternates list the project names directly (not
  through the link) is kept too, because the entry's resolved target is checked like the entry itself before
  unlinking and only the link itself would go. Such a link needs a hand-delete when it is merely stale.
- A repository history too large for git to list in one command output (the shared git runner caps
  stdout at 10 MiB) or too slow to walk keeps the entry with `could not list commits`, a tracked-file
  list over the same cap keeps it with `could not read the index`, an owning
  project whose own history cannot be read keeps entries that have commits of their own
  (`could not compare …`), and an owning project whose *object* list cannot be read keeps them with
  `… has an object graph that could not be read`; all fail closed instead of deleting unchecked.

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
- **Verification round 5 (2026-10-24, coordinator handoff; fixed 2026-10-24, see As
  built):** three findings in the scratch sweep — `core.worktree` set only in worktree-specific
  config (or an include) was missed by `git config --local`, so a store serving an outside checkout
  read as unconfigured and was deleted; a non-bare store with an in-entry configured checkout was
  checked only for staged index changes, so unstaged/untracked work in that checkout (especially a
  checkout with no `.git` pointer of its own) was deleted; and the hidden-change check compared blob
  hashes only, missing executable-bit and file-type changes behind skip-worktree/assume-unchanged.
  Each scenario was reproduced against the pre-fix code (all `removed`) and is now covered by a
  keeping test (plus controls that a deinit store configured to an in-entry checkout, a clean
  worktree-configured in-entry checkout, and a clone whose flagged files are unmodified are still
  swept); see the "Verification round 5 fixes" note in As built for the evidence.
- **Verification round 6 (2026-10-24, independent queue verifier round 2 of 3; fixed 2026-10-24, see As
  built):** one finding in the scratch sweep — the commit-survival check compared only commit IDs, so a
  `--filter=blob:none` owning project whose historical blob existed only in the scratch clone still lost that
  clone (last durable copy of the blob destroyed), and an owning project whose `objects/info/alternates` chain
  pointed into the entry still lost the store its own `git log` ran on (`fatal: bad object HEAD`). The owning
  project's object graph must now be complete and independent of the entry before history is cleared; both
  verifier scenarios were reproduced against the pre-fix code and are now covered by keeping tests (plus the
  chain form of the second case, and controls that a clean clone under an owner sharing objects only with
  outside stores is still swept and that a plain folder is still removed while the owner is missing objects);
  see the "Verification round 6 fixes" note in As built for the evidence.
- **Verification round 7 (2026-10-24, coordinator handoff; fixed 2026-10-24, see As
  built):** two findings in the scratch sweep — `objects/info/alternates` records were read as raw
  paths without Git's C-style quoting, so a quoted name to the owner's only objects resolved to an
  invented path, the ENOENT under it ended the chain, and the entry holding the real store was deleted
  (owner then `fatal: bad object HEAD`); and an aged symlink entry was unlinked before any
  owner-dependency check while only real paths were kept from the chain, so a symlink the owner's
  alternates name runs through died with the entry (the name dangles on the owner's next command) even
  though the objects were untouched. Alternates records are now decoded exactly as git reads them
  (unsupported records fail closed), every store keeps its named and its resolved spelling, and both
  spellings are checked before anything is removed — symlinks included. Both verifier scenarios were
  reproduced against the pre-fix code (all six new keeping tests returned `removed`) and are now covered
  by keeping tests (plus the chain form of the quoting case, the fail-closed case, and controls that a
  C-quoted link naming only outside stores still sweeps a clean clone and a folder whose symlink the
  chain does not run through is still removed); see the "Verification round 7 fixes" note in As built
  for the evidence.
- **Verification round 8 (2026-10-24, coordinator handoff; fixed 2026-10-24, see As
  built):** two findings in the scratch sweep — `objects/info/alternates` octal escapes were decoded as
  characters instead of bytes, so a record spelling the owner's only store as `caf\303\251` named the
  nonexistent `cafÃ©-source`, the ENOENT under it ended the chain as normal, and the entry holding the
  real store was deleted (owner then `fatal: bad object HEAD`); and the object-store dependency check
  missed intermediate symlink resolutions, so an alias-outside to entry to symlink to durable-store name
  — which dies with the entry although neither its spelling nor its landing touches the entry — got its
  entry deleted and the name became `unable to normalize alternate object path`. Records are now decoded
  byte for byte into a filesystem-encoding name (undecodable names fail closed), and every lookup
  spelling of a name's resolution — symlink hops followed component by component — is checked against
  the entry, with a walk that cannot be finished failing closed. Both verifier scenarios and the
  fail-closed case were reproduced against the pre-fix code (all three new keeping tests returned
  `removed`) and are now covered by keeping tests (plus a control that an octal-escaped link naming only
  outside stores still sweeps a clean clone); see the "Verification round 8 fixes" note in As built for
  the evidence.
- **Verification round 9 (25 Oct, independent queue verifier round 1 of 3; fixed 2026-10-25, see As
  built):** one finding in the scratch sweep — the `objects/info/alternates` files the owner reads its
  chain out of were not tracked as dependencies (only the store directories were), and plain-file entries
  skipped the owner-dependency check entirely, so an alternates list held by a plain-file or folder entry
  (or reached through a symlink hop inside one) was deleted and the owner's `git log` then failed with
  `fatal: bad object HEAD` while every object was untouched. The lists themselves — at the owner and at
  every chained store — are now recorded and checked like stores (resolved containment plus every lookup
  spelling of their resolution, symlink hops included), and the check covers plain-file entries too. Both
  verifier scenarios were reproduced against the pre-fix code and are now covered by keeping tests (plus
  the chained-store, intermediate-hop and symlink-entry forms, and a control that unrelated aged file and
  folder entries are still swept); see the "Verification round 9 fixes" note in As built for the
  evidence.
- **Verification round 10 (25 Oct, independent queue verifier round 2 of 3; fixed 2026-10-25, see As
  built):** one finding in the scratch sweep — dependencies below the owning project's object-store
  roots were not tracked, so an entry a link under `objects/` pointed into (the `pack` folder moved
  aside and linked back, one `.pack`, a loose-object fanout) was deleted as clean and the owner's
  `git log` then failed with `cannot read commit object` or `bad object HEAD` while the objects were
  untouched. Every link below a store root is now recorded where it is spelled and where it lands and
  checked before anything is removed, for every entry kind, with a contents walk that cannot be
  finished failing closed. All three verifier layouts were reproduced against the pre-fix code and are
  now covered by keeping tests (plus the plain-file and intermediate-hop forms and the fail-closed
  branch, and a control that a pack folder linked from outside `_scratch` still sweeps aged entries);
  see the "Verification round 10 fixes" note in As built for the evidence.
- Unit tests per change (broad-root guard, stepped vacuum + journal limit against a real SQLite file,
  backup retention, guidance block present for every adapter spawn, disk watcher thresholds, scratch
  sweep keeps recent and unsaved-work entries).
- Canonical gates from `AGENTS.md`.
- Fresh-eyes completion gate.
- Live checks that need a rebuilt app are in
  [`2026-10-22-aio-tidies-up-after-itself_plan_livetest.md`](2026-10-22-aio-tidies-up-after-itself_plan_livetest.md).

> Plan Queue parked work: `queue/2026-10-22-aio-tidies-up-after-b3eba2` — 5 commit(s), reason: round-limit.
