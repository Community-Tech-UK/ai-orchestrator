# Plan Queue Implementation Plan

**Status:** Completed 2026-09-19 — approved by James 2026-09-18 via review artifact
`2026-09-18-plan-queue` (decisions 1, 3 and 6 changed from the draft; applied below). Phases 0–6
implemented and verified; landing reworked 2026-09-19 at James's direction so the landing commit
runs the repository's hooks and carries the closed documents. Fresh-eyes gate: VERDICT PASS on
2026-09-19 after four rounds on the landing rework, following ten on the original build. Live checks deferred to
[2026-09-18-plan-queue_livetest.md](./2026-09-18-plan-queue_livetest.md) (7 open); the first live
run must use a scratch repository (Stop-and-Confirm gate 2).
**Date:** 2026-09-18
**Spec:** [2026-09-18-plan-queue_spec_completed.md](./2026-09-18-plan-queue_spec_completed.md)

**Goal:** James says "work through all the plan files" (or livetests) in any session. AIO runs one
visibly-parented worker instance per document in its own worktree, has a different-provider
verifier judge each one, lands verified work on `main` as one squash commit, and never leaves work
hidden in a worktree.

**Architecture:** A deterministic main-process coordinator (`src/main/plan-queue/`) modelled on
`AutomationRunner` (instance tracking) and `CampaignCoordinator` (persisted runs, recovery, IPC).
LLMs triage, work and judge; code decides everything else. Loop mode and Campaigns are untouched.

## Global Constraints

- Work in James's current checkout on `main`. Do not create a branch or worktree to build this.
  (The feature itself creates AIO-managed worktrees at runtime; that is the product, not the
  build process.)
- Do not stage or commit this plan, the spec, or any implementation unless James asks.
- Read every affected file, its callers and its tests in full before editing it.
- Do not modify `loop-*` or `campaign-*` behaviour. The only shared files touched are
  `loop-schema.ts` (one additive migration), `worktree-integration.ts` (one opt-in policy with the
  existing default preserved), the MCP registration files, and boot wiring.
- New `.ts` files stay under the 700-line `check:ts-max-loc` limit; split rather than allowlist.
- No new package dependencies.
- Prompt text follows `docs/prompt-engineering-house-style.md`.
- Tests that touch git use real temporary repositories under the OS temp directory, never this
  checkout. Never run `git stash`, `git reset --hard` or `git checkout --` in this repo.
- Never run the full suite while another heavy job is running; check `uptime` first.

---

## Phase 0 — Reproduce before changing

### Task 0.1: Reproduce the dirty-root landing block

- [x] Confirm an unrelated untracked root file blocks promotion. Done 2026-09-18 during planning:
      the existing test "blocks on a dirty root without changing main or the dirty file"
      (`src/main/workspace/git/worktree-integration.spec.ts:361`) covers exactly this and passes
      (`npm run test:quiet -- src/main/workspace/git/worktree-integration.spec.ts`, 18 passed).
      That test stays as the guard for the default `block-any` policy in Task 1.6.
- [x] Diagnose why the leftover `task-*` worktrees were neither harvested nor reaped. Done
      2026-09-18, read-only. `loop_runs` shows eight runs at lifecycle phase `blocked`,
      `lastError = 'Harvest failed with uncommitted work'` (five `completed-needs-review`, three
      `cap-reached`; an earlier note here said nine and four, which was a miscount);
      `finalizeLoopWorktree` returns there and keeps the worktree
      (`loop-worktree-lifecycle.ts:102-106`). Their indexes are fully staged, so `git add -A` ran
      and `git commit` was refused. `harvestWorktree` does not pass `--no-verify`
      (`worktree-manager.ts:367`); the pre-commit hook runs the plan-spec guard and `test:staged`
      (`scripts/run-git-hook.js:15-32`). The promotion block in Task 1.6 was never reached. The
      queue's invariants cover this: Task 1.4's checkpoint uses `--no-verify` and its spec must
      include a hook that always fails. One more leftover is a live run parked on a provider
      limit (`acquired`), not a defect. Loop code and those worktrees were not touched.

**Checkpoint:** the spec's Problem items 3–4 are confirmed or corrected in the spec before any
product code is written.

---

## Phase 1 — Safe worktree substrate (no LLM involved)

### Task 1.1: Contracts and types

- [x] `packages/contracts/src/schemas/plan-queue.schemas.ts`: item state enum, run/item DTOs,
      verdict, triage record, question/answer, start/control payloads, per-kind default config.
- [x] `packages/contracts/src/channels/plan-queue.channels.ts`; export from
      `packages/contracts/src/channels/index.ts`. **Moved to Phase 3** (done there): `verify:ipc-usage` fails
      on a channel with no handler, so channels land together with their handlers.
- [x] Alias `@contracts/schemas/plan-queue` added to `tsconfig.json`, `tsconfig.electron.json`
      and `vitest.aliases.ts` (the real vitest alias source; `vitest.config.ts` imports it).
      `src/main/register-aliases.ts` is generated — regenerated with `npm run generate:aliases`.
      `npm run check:contracts` passes (38 subpaths).

### Task 1.2: Persistence

- [x] Migration 17 in `src/main/orchestration/loop-schema.ts`: `plan_queue_runs`,
      `plan_queue_items`. `LOOP_SCHEMA_VERSION` bumped to 17; the pinned assertion in
      `loop-schema.spec.ts` updated to match.
- [x] `src/main/plan-queue/plan-queue-store.ts` and `plan-queue.types.ts`. Deliberate difference
      from `campaign-store.ts`: writes throw instead of logging, because "row before worktree"
      cannot hold if a failed write is swallowed.
- [x] Spec: round-trip, migration applies on a version-16 database, cascade delete, duplicate
      document refused, failed write throws.

### Task 1.3: Pure state machine

- [x] `src/main/plan-queue/plan-queue-state.ts`: transition table and guards as pure functions;
      illegal transitions throw.
- [x] Spec: happy path, fix cycle, stale PASS, discarded verification, terminal states, "any
      non-terminal → parked", landing reachable only from `verifying` or an operator override.

### Task 1.4: Item worktree service

- [x] `src/main/plan-queue/plan-queue-worktree.ts`:
  - `prepare(item)` — write branch/path to the row first, then
    `WorktreeManager.createWorktree` with prefix `queue-`.
  - `checkpoint(item)` — `git add -A` + `git commit --no-verify --no-gpg-sign` via
    `getGitWriteQueue()`, record the hash on the row; no-op when clean.
  - `removeWithProof(item)` — refuse unless tree clean and HEAD = recorded checkpoint.
  - `deleteBranchWithProof(item)` — refuse unless item is `landed` or discard was requested.
- [x] Spec against a temp repo (real `WorktreeManager`, 11 tests): row exists before directory;
      no worktree when the row write fails; dirty tree is never removed; checkpoint includes
      untracked files; checkpoint succeeds with a pre-commit hook that always exits 1 and with a
      `x_plan.md`; removal works from the row alone after a simulated restart; branch deletion
      refused unless landed or discarded.
- [x] **Found while testing, not in the original plan:** `WorktreeManager` provisions each
      worktree with a `.mise.local.toml` port override and copies of the root's `.env*.local`
      files. This repo ignores them; a repo that does not would have them swept into a checkpoint
      by `git add -A` and squash-landed on `main`, env files included. `prepare()` now records
      whatever is untracked straight after provisioning in the worktree's private git dir, and
      checkpoints and the removal proof exclude those paths. Covered by its own test. Known gap:
      a worktree re-created for a resumed parked branch has no such record yet (Task 2.3 resume).

### Task 1.5: Reconciler

- [x] `src/main/plan-queue/plan-queue-reconciler.ts`: compare `.worktrees/queue-*`, `queue/*`
      branches and rows; emit alerts `unowned-worktree`, `missing-worktree`, `unowned-branch`.
      Never deletes. Ignores every worktree and branch without the queue prefix.
- [x] Spec with a temp repo (7 tests): a queue worktree with no row alerts; a `task-*` worktree
      with uncommitted files is ignored entirely; vanished worktree alerts; parked item is quiet;
      subdirectory workspaces resolve; the repository is byte-for-byte unchanged afterwards.
      As built the queue's worktrees live under `.worktrees/queue/<stem>-<id>` because the branch
      is `queue/<stem>-<id>` and `WorktreeManager` names the directory after the branch.

### Task 1.6: Overlap-aware promotion

- [x] `src/main/workspace/git/worktree-integration.ts`: add `dirtyRootPolicy?: 'block-any' |
      'block-overlap'` to `promoteIntegrationBranch`, default `'block-any'`. Under
      `'block-overlap'`, compute the landing diff's paths and block only on intersection with root
      status paths. Read all five `mergeWorktree`/promotion callers first and leave them on the
      default.
- [x] Spec: an unrelated untracked file and an unrelated modified tracked file both promote under
      `'block-overlap'`; an overlapping untracked file still blocks with a reason naming the path;
      the 18 pre-existing tests, including the default `block-any` one, pass unchanged (21/21).
      Both callers (`worktree-manager.ts:699`, `loop-worktree-lifecycle-reconcile.ts:337`) pass no
      options and keep the default. `git status -z` needs untrimmed output, so a `gitRaw` helper
      sits beside the trimming `git` helper.

### Task 1.7: Squash landing

- [x] `src/main/plan-queue/plan-queue-landing.ts`:
  - `syncItemWithBase` merges a moved `main` into the item branch; a conflict is left in place in
    the worktree for the worker and the conflicted files are returned.
  - `runPostMergeGate` runs the configured deterministic commands in the item worktree and stops
    at the first failure (15-minute timeout per command, output tail returned).
  - `landItemBranch` squashes through the existing `integrateIntoSharedBranch` on a per-item
    `integration/queue/...` branch (which writes the ownership ref the promoter checks), promotes
    with `'block-overlap'`, and always deletes the integration refs afterwards. Idempotent after
    a crash: a recorded `landedCommit` already on `main` short-circuits; a stale integration
    branch is rebuilt; an item that changed no tracked files is a no-op landing.
- [x] `src/main/plan-queue/plan-queue-doc-close.ts`: coordinator-only rename to `_completed`, the
  plan's `_spec_planned.md` found beside it or in a sibling `specs/` directory, links re-pointed
  in both files, and a docs-only commit limited by pathspec to exactly those files. Refuses to
  commit any path not ending `_completed.md`, refuses to overwrite an existing completed file,
  skips the commit for documents outside the repository (the EBRD layout) or ignored by it, and
  is a no-op when re-run. `appendParkedNote` adds one findable line naming a parked branch.
- [x] Specs: landing 11 tests, doc close 8 tests, all against temporary repositories.
- [x] ~~Deviation: the squash and docs-close commits used `--no-verify`.~~ **Superseded
  2026-09-19 at James's direction** — see "Landing with hooks" under Phase 2. The landing commit
  now runs the repository's pre-commit hook in the item worktree, and the separate docs-close
  commit no longer exists.
- [x] `AIO_ALLOW_MAIN_UPDATE=1` is not needed: promotion fast-forwards `main` from the root
  checkout while it is on `main`, which the stay-on-main guard always allows. It would only be
  needed if the root were on another branch, where promotion is refused as blocked anyway.

**Checkpoint — reached 2026-09-18.** `src/main/plan-queue` 6 spec files, 56 tests passed;
`src/main/workspace/git` plus the loop schema and store specs 13 files, 177 tests passed;
`npx tsc --noEmit` exit 0; spec `tsc` exit 0 (8 GB heap, see gate note); `npm run lint` "All files
pass linting"; `npm run check:ts-max-loc` passed; `npm run build:main` exit 0. Full suite and
`build:renderer` not run yet — reserved for Phase 6. The substrate can be exercised from a test
with no instances at all.

**Gate note (2026-09-18):** `npx tsc --noEmit -p tsconfig.spec.json` ran out of memory at Node's
default heap once during this work (exit 134) after passing twice earlier the same day; it passes
with `NODE_OPTIONS=--max-old-space-size=8192`. The spec project is close to the default limit
independent of this feature. Use the larger heap for that gate.

---

## Phase 2 — Coordinator, worker, verifier (plans)

### Task 2.1: Discovery

- [x] `src/main/plan-queue/plan-queue-discovery.ts`: walks `docs/` (skipping `node_modules`,
      `.worktrees`, `.claude`, `archive`/`_archive`, `_scratch`, `dist`), filters by an optional
      repo-relative glob, classifies by filename (`_plan.md`, `_livetest.md`, unplanned
      `_spec.md`; `_completed`, `_spec_planned`, prompts ignored), skips standing registers
      (`Type: standing register` header line, either bold form), and reports a plan whose
      `**Spec:**` link points at a missing file, or a spec with no plan, as not ready.
- [x] Spec (`plan-queue-discovery.spec.ts`, 7 tests) over a fixture tree of real filename shapes
      from `docs/plans/` and `docs/superpowers/plans/`.

### Task 2.2: Instance tracking

- [x] `src/main/plan-queue/plan-queue-instance-tracker.ts`: the AutomationRunner rules (idle or
      `complete` after assistant output; `waiting_for_*` → needs-input; failure statuses and
      removal; provider-limit classification of the final output), adapted for a worker that
      lives for many turns: after an outcome it is quiet until `beginTurn` re-arms it, a worker
      James answers directly re-arms itself, and process-level exits count only mid-turn (an
      idle worker's CLI is killed by hibernation, which is not a failure).
- [x] The provider-limit classifier moved to the neutral `src/main/cli/final-output-provider-limit.ts`;
      `automations/automation-run-provider-limit.ts` re-exports it and `AutomationRunner` imports
      the new module. Automation specs unchanged and green. Nothing is imported from `automations/`.
- [x] Spec (`plan-queue-instance-tracker.spec.ts`, 9 tests): the fake only replays recorded
      envelope sequences.

### Task 2.3: Coordinator core

- [x] `plan-queue-coordinator.ts` (singleton, `getPlanQueueCoordinator`, `_resetForTesting`):
      `startRun`, scheduler (worker slots per run = items holding a worktree, verification slots
      shared by every run, load gate on the 1- and 5-minute averages, 30 s periodic pass),
      triage, answers, operator controls, events. Split for the 700-line limit into
      `plan-queue-item-flow.ts` (side effects per item, serialised by a per-item lock, plus the
      single landing chain), `plan-queue-host.ts` (port types), `plan-queue-recovery.ts`,
      `plan-queue-messages.ts` (DTOs and parent messages) and `plan-queue-git.ts`.
- [x] `plan-queue-prompts.ts`: worker, livetest worker, fix-round, conflict, post-merge-gate
      failure, resume, verifier and triage prompts (house style: data in escaped delimiters,
      task and contract last, a schema-valid example call).
- [x] `plan-queue-verifier-select.ts`: installed providers minus the worker's and minus
      automation exclusions, preference codex → claude → copilot, then `resolveCheckerPlan`
      (family diversity, licence containment). No candidate or a blocked plan parks the item as
      `no-diverse-verifier`. The live worker's resolved provider and model are used when known.
- [x] Tree-unchanged check: HEAD and `git status -z` snapshot before verification; a changed
      tree discards the verdict, reverts only the verifier's changes (commits, edits, staged
      adds, untracked files) and counts an errored round. A verifier that ends without calling
      the tool, fails, or stops is an errored round; two park the item as `verifier-unreliable`.
- [x] Reclaim hold: `src/main/process/reclaim-holds.ts`; `ResourceGovernor.selectReclaimCandidates`
      sorts held instances after unheld ones (hibernation and reclaim stay allowed; the
      async-work inhibitor is untouched). Two new governor specs.
- [x] Spec (`plan-queue-coordinator.spec.ts`): three items with two worker slots, one
      verification and one landing at a time; FAIL → fix → PASS on the same worker; round limit
      parks with the branch kept and named in the document; verifier silent twice parks;
      neither the worker nor the parent can report a verdict while the item is verifying;
      verifier tree change discarded and reverted; not-ready document answered and landed;
      cancel parks in-flight work (checkpointed) and skips the rest.
- [x] **Found while testing, fixed:** (1) a cancel (or any park) racing an in-flight
      `prepare` could overwrite the parked row with a stale `preparing` copy — fixed by the
      per-item operation lock with the slot-reserving transitions kept synchronous; (2)
      `cancelRun` iterated a stale item list across awaits, so the scheduler started the next
      queued item mid-cancel and the cancel then overwrote it — fixed by pausing the run first
      and re-reading each item; (3) `WorktreeManager.createWorktree` on an existing branch fails
      and its cleanup deletes that branch, so Resume / Land anyway use a new
      `PlanQueueWorktreeService.reattach` (closes the Task 1.4 known gap; spec added).
- [x] Added beyond the plan: `verifier_gates` / `post_merge_gate` run options. The defaults are
      this repository's commands, which cannot pass in any other repository; an empty verifier
      list tells the verifier to run the repository's own documented checks.

### Task 2.4: MCP tools

- [x] `src/main/mcp/plan-queue-tools.ts` (specs shared with the forwarder), composed into
      `orchestrator-tools.ts`; RPC dispatch via `isPlanQueueRpcMethod` and toolset entries in
      `orchestrator-tools-rpc-server.ts`; forwarder proxies generated from the same specs
      (calendar proxies now share that helper); wiring in `orchestrator-tools-step.ts` through
      `plan-queue-tool-operations.ts`.
- [x] Caller checks: `plan_queue_report_verdict` only from the item's registered verifier,
      `plan_queue_report_triage` only from the run's triage instance, `plan_queue_answer` /
      `plan_queue_control` only from the run's parent. `plan_queue_start` is omitted from the
      tool list of queue-spawned instances (so dispatch refuses it) and `startRun` refuses it too.
- [x] `docs/AIO_MCP_CLI.md` and `docs/llm/AIO_MCP_CLI_REFERENCE.md` updated; forwarder snapshot
      spec updated; `plan-queue-tools.spec.ts` (5 tests); `npm run build:aio-mcp-dist` exit 0.

### Task 2.5: Boot and recovery

- [x] `plan-queue-bootstrap.ts`, called from a "Plan queue coordinator" step right after the
      campaign step in `late-runtime-initialization-steps.ts`. Recovery order: relaxation restore
      (then re-apply for runs still active), reconciler, items (preparing / working / fixing →
      re-attach a live worker or checkpoint and respawn with a resume prompt; verifying →
      awaiting-slot; landing → re-run the idempotent landing).
- [x] Specs: simulated restarts from working, verifying, landing and preparing (with discovered
      items re-triaged and needs-answer left open), and relaxation restore/re-apply on boot.
- [x] **Fresh-eyes finding 1 (high), fixed:** the live tree guard's snapshot is in memory, so a
      crash mid-verification left a dead verifier's edits in the worktree to become the next
      round's baseline. Recovery of a `verifying` item now puts the worktree back to the recorded
      checkpoint (keeping provisioned files) before re-verifying. The restart spec now has the
      verifier edit, stage and create files before the crash; it fails with the restore removed.
- [x] **Second fresh-eyes review, findings 1 (high) and 2 (medium), fixed:** a checkpoint taken
      while a merge of the base was still conflicted (on park, cancel, provider limit, or resume
      after a restart) committed the conflict markers and completed the merge silently.
      `PlanQueueWorktreeService.checkpoint` now throws `UnresolvedMergeError` while `MERGE_HEAD`
      exists with unmerged paths (a resolved merge is still completed by the checkpoint, which
      is the worker contract). A worker that ends its turn unresolved parks as `merge-conflict`;
      a park keeps the worktree with the merge in progress and names the files; Resume and a
      restart re-send the conflict prompt instead of committing. Recovery of a `verifying` item
      aborts a coordinator merge left by a crash before the move to `fixing`, and the next
      verification redoes it. A missing worktree at verification now parks as `worktree-error`
      rather than being mislabelled. Four real-conflict specs (cancel mid-resolution + Resume,
      unresolved turn end, restart mid-resolution, crash window); removing the checkpoint guard
      fails two of them and removing the merge abort fails the crash-window one.
- [x] **Third fresh-eyes review, fixed:** (1, medium) the live verifier tree revert did not
      clear a merge the verifier had started, leaving `MERGE_HEAD` to break the next sync —
      `revertToSnapshot` now abandons any in-progress merge (every baseline it restores has
      none), which also covers the crash-window case in recovery; (2, medium) specs added for
      the merge helpers and the revert's merge abort (`plan-queue-git.spec.ts`), the checkpoint
      guard and resolved-merge completion and `reattach` onto an unfinished merge
      (`plan-queue-worktree.spec.ts`), a stale PASS whose landing-time merge conflicts, and Land
      anyway on an item parked mid-merge; (3, low) a return to `fixing` now records why in the
      item detail, and Land anyway clears the stale park note. **Found by the new Land anyway
      spec:** Land anyway on an item of a finished run could send it back to a worker that no
      scheduler picked up — it now re-opens the run, as Resume does. Removing the revert's merge
      abort fails the crash-window and git specs.
- [x] **Fourth fresh-eyes review, fixed (medium):** two concurrent runs with `relax_settings`
      each snapshotted the settings, so the second recorded the relaxed values as its
      "originals", and the first to end restored the true originals under the still-active
      second run. Now exactly one active run holds the snapshot; a later relaxed run shares the
      settings in force (its DTO still lists them), and a holder that ends while another relaxed
      run is active hands the snapshot over instead of restoring. Boot recovery still restores
      every snapshot and then re-applies for the first active relaxed run. New spec with two
      overlapping runs; removing either the holder check or the hand-over fails it.
- [x] **Fifth fresh-eyes review, fixed:** (1, medium) the per-worker "runs under relaxed
      settings" audit line keyed on holding the snapshot, so a sharing run's workers were never
      logged. The rule "which settings are relaxed for this run" is now one function,
      `relaxedSettingsFor` in `plan-queue-relaxation.ts`, used by both the DTO and the audit
      line; the overlapping-runs spec asserts the sharing run is audited and fails with the old
      condition. (2, low) specs added for a holder cancelled while the heir is paused and for a
      restart with two relaxed runs active (exactly one ends up holding the true originals),
      plus unit specs for `relaxedSettingsFor`.
- [x] **Sixth fresh-eyes review, fixed (medium):** after a crash between the renames and the
      docs commit, re-closing a plan whose spec lives in a sibling `specs/` directory (the
      `docs/superpowers/` layout) looked for the closed spec only beside the plan, so it
      committed the plan alone and left the renamed spec untracked. The first pass and the
      re-run now share one lookup (`findSpec`, both locations). New spec for that combination;
      with the old lookup it is the only test that fails.
- [x] **Seventh fresh-eyes review, fixed (high):** a crash after both renames but before the
      links were re-pointed made the re-run take the recovery branch, which committed the
      `_completed` files with dangling links (the round-six spec checked filenames, not content).
      `closeDocuments` now always runs the idempotent link repair once the closed spec is known,
      on the first pass and on any re-run. Specs now assert committed content for the sibling
      layout, the renames-done crash, and a crash between the plan and spec renames; skipping
      the repair on the recovery path fails two of them.
- [x] ~~Deviation: a document-close failure after the squash left the item `landed`.~~
      **Superseded 2026-09-19 at James's direction** — the closed documents are now prepared
      before, and committed inside, the landing commit, so a failure to close them parks the item
      `land-blocked` with nothing landed (see "Landing with hooks" under Phase 2).
- [x] **Eighth fresh-eyes review, fixed (blocking):** the scheduler compared the verification
      count shared by all runs against each run's own cap, so with the defaults (plans 2,
      livetests 1) a livetest item could wait forever while one plans verification ran. The
      total is now bounded by the largest cap among active runs (default 2, "shared by every
      run") and each run by its own cap. New two-run spec; with the old condition it fails.
      Also corrected the MCP module comment: `plan_queue_status` is read-only and deliberately
      open to every session. The same review found the renderer, MCP/IPC wiring and migration
      17 clean line by line.
- [x] **Ninth fresh-eyes review (VERDICT: PASS), its two actionable findings fixed anyway:**
      (1, medium) the reconciler matched queue worktrees by string prefix, so a sibling such as
      `.worktrees/queue-manual-experiment` was reported as unowned — it now uses the
      boundary-aware `isInsideOrEqual`, with the sibling added to the "ignores hand-made
      worktrees" spec (the old prefix fails it); (2, medium) verifier findings carried no
      `confidence`, which `docs/prompt-engineering-house-style.md` requires — `confidence`
      (0-100) is now a required field on `PlanQueueFindingSchema` and the verdict tool, is asked
      for in the verifier contract and its example, and is shown in the fix prompt and the
      round-limit park detail.
- [x] **Accepted house-style deviation (ninth review finding 3):** the style guide says
      verification agents should be read-only. AIO has no read-only instance tier —
      `yoloMode: false` makes the CLI stop at every permission prompt with nobody to approve it,
      so an unattended verifier could not run the gates at all. The verifier therefore runs with
      `yoloMode: true`, and the tree snapshot/compare/revert guard around every verification is
      what enforces "must not change the work" instead.

### Task 2.6: Triage and questions

- [x] One triage instance per run reporting through `plan_queue_report_triage`; `needs-answer`
      persisted with a guaranteed `skip` option; two failed triage attempts hand the remaining
      documents to James with a generic question. Questions go to the parent session as a
      message naming each `item_id` and `option_id`. A worker that stops on `waiting_for_input`
      surfaces its last message as an item question (continue / park).

**Checkpoint — reached:** the integration spec drives whole runs with scripted fake instances
against temporary repositories and ends with a squash commit on the temporary `main`, `_completed`
documents and no queue worktree or branch.

### Landing with hooks (2026-09-19, at James's direction)

Resolves the two spec deviations James was asked to confirm; the spec's Landing section now
describes this.

- [x] `plan-queue-squash.ts`: the landing commit is built in the item's own worktree (provisioned
      with dependencies) — detached at the base tip, `git merge --squash` of the item branch, the
      closed documents added, then `git commit` **with the repository's hooks**, a `buildCliEnv()`
      PATH (a packaged app's stripped PATH may not find node/npm) and a 15-minute budget. The
      worktree is always restored to the item branch in a `finally`, and at the start of every
      landing (a crash mid-build leaves a detached HEAD). A code-level guard mirrors the global
      plan-spec guard (same suffixes, same standing-register exception) so repositories without
      that hook are covered too.
- [x] `plan-queue-landing.ts` `landItemBranch` builds that commit, records it through
      `onCommitBuilt` before promoting (a crash in between re-promotes it; a stale base rebuilds),
      and promotes through the managed-integration refs as before. `integrateIntoSharedBranch`
      (loop-owned) is no longer used and was not modified. The post-merge gate also uses
      `buildCliEnv()` now.
- [x] `plan-queue-doc-close.ts`: `prepareClosedDocuments` computes the closed, link-repaired
      copies without touching the root (throws on missing / taken names / a plan and spec split
      across the repository boundary); `retireActiveDocuments` removes the superseded root copies
      only if unchanged since the commit was built; `renameDocumentsInPlace` handles documents
      outside the repository or ignored by it (never committed). The `docs: close` commit and its
      `--no-verify` are gone. Also fixed: a planned spec's closed name is `_spec_completed.md`.
- [x] `plan-queue-item-landing.ts` (moved out of the item flow for the 700-line limit): a hook
      refusal or active documents go back to the worker once with the output; a second refusal
      parks `land-blocked`. A document that cannot be closed parks `land-blocked` before anything
      lands.
- [x] Specs: landing 17 (hook runs and what it stages lands; refusing hook restores the checkout;
      active documents refused but a standing register allowed; documents in the one commit;
      re-promote after a build/promote crash; recovery from a detached crash state), doc-close 14,
      coordinator 34 (one commit carries code and documents and the root copies are retired; hook
      refusal → worker → lands; second refusal parks with nothing landed; unclosable document
      parks). Mutation-checked: `--no-verify` restored, the active-document guard removed, the
      `finally` restore removed, and the refusal limit raised each fail their named tests.
- [x] Fixed after the fresh-eyes review of this change (it returned FAIL):
      1. A hook timeout killed only `git`, orphaning the hook's generators and tests in the
         worktree the next worker is handed (reproduced). `commitWithHooks` now runs in its own
         process group and a timeout kills the whole group (`killProcessGroup`).
      2. The landing-refusal count lived in memory, so a restart between two refusals reset
         "the second refusal parks". It is now `plan_queue_items.landing_refusals` (migration
         `018_plan_queue_landing_refusals`), cleared on landing, parking and Resume.
      3. Re-promoting a recorded landing commit after a crash re-prepared the documents it
         already carries, and could park on a document that had since moved. It no longer does.
      Specs: `plan-queue-squash.spec.ts` (hook tree killed on timeout; hook passes), coordinator
      +3 (the second refusal parks across a restart with exactly two hook runs; active documents
      twice park; a recorded commit promotes after a restart with the documents gone),
      loop-schema v18 upgrade. Mutation-checked: plain `child.kill` (hook descendant survives),
      counter not read back from the row, counter zeroed across the restart (three hook runs),
      and the prepare guard removed each fail their named tests.
- [x] Fixed after the second fresh-eyes review (FAIL): the hook commit and the post-merge gate
      now share `plan-queue-process.ts` `runInProcessGroup`, which (a) kills the whole process
      group on the timeout, (b) returns as soon as the top process exits — with its real exit
      code — and stops anything it left running after a 2-second grace (a passing hook with a
      stray background process used to hold the result for the full 15 minutes and log a false
      "timed out"; reproduced), and (c) registers with the app's cleanup registry so a normal
      quit kills a running group. The post-merge gate had the same orphan defect. On Windows the
      tree kill cannot reach descendants after the top process has exited. Specs:
      `plan-queue-process.spec.ts` (4), coordinator +1 (a recorded commit made stale by a base
      move is rebuilt with the closed documents in it). Mutation-checked: no grace kill, no
      cleanup registration, not detached, and the stale commit kept each fail their named tests.
- [x] Fixed after the third fresh-eyes review (FAIL): the result still waited on the output
      pipe, so a process that moved itself out of the group (`setsid`, a detached spawn) could
      hold a landing — and the single landing chain behind it — forever (reproduced). Now, 2
      seconds after any kill, our end of the pipes is closed and the call returns; such a process
      is reported in the output ("not waiting for it"), not stopped, because no group kill can
      reach it. Specs: `plan-queue-process.spec.ts` +2 (an escaped process after a clean exit and
      after a timeout). Mutation-checked: without the settle step both fail.

---

## Phase 3 — IPC and renderer

- [x] `src/main/ipc/handlers/plan-queue-handlers.ts`, registered in `ipc-main-handler.ts`;
      channels in `packages/contracts/src/channels/plan-queue.channels.ts`; preload domain
      `src/preload/domains/plan-queue.preload.ts`; state-changed push carries the run DTO.
      `npm run generate:ipc` (only the new channels changed), `npm run verify:ipc` passed.
- [x] `core/services/ipc/plan-queue-ipc.service.ts`, `core/state/plan-queue.store.ts` (private
      writable signals, readonly computed views: open questions including a waiting worker's,
      parked items that still have a branch, alerts, the livetest need-James list and the
      policy-gated count; state-changed pushes replace the run in place).
- [x] `features/plan-queue/`: routes, page, run list, run controls (cancel confirms), item list,
      question card (radio controls), parked list (branch, lazily fetched diffstat, Resume /
      Land anyway / Discard, the last two with a confirm step), reconciler alerts with refresh,
      need-James list, and a Start form (root session as parent, kind radio, optional glob).
      Standalone, `OnPush`, `inject()`, `input()`/`output()`, separate templates and styles.
- [x] Route in `app.routes.ts`, surface in `control-surface.registry.ts` (+ id type, icon,
      registry spec), `PLAN_QUEUE_HELP` in `shared/help/`.
- [x] Rail marker in `instance-row.component` for `metadata.planQueueRole` (worker / verifier /
      triage) with tooltip and accessible name, following `isAutomation`; two new row specs.
- [x] Fixed during review: Skip was offered on in-flight items the coordinator refuses to skip
      (now only discovered / needs-answer / queued); worker questions were not rendered;
      discarded items stayed in the parked list; help and need-James wording corrected.
- [x] Component and store specs (11 files, 75 tests); `npm run build:renderer` exit 0.

---

## Phase 4 — Livetest mode

- [x] Livetest worker prompt built on the runbook: reads it in full, isolated dev app with a
      per-item `AIO_DEV_USER_DATA_PATH` and debug port derived deterministically from the item id
      (`livetestEnvironmentFor`), evidence and defect-filing rules, need-James only for real
      boundaries.
- [x] Outcomes: a livetest PASS with `document_complete: false` lands with the document still
      open; `true` renames it to `_livetest_completed.md` through the same coordinator-only close.
- [x] Need-James audit: the verdict carries `need_james` entries classified
      `real` / `policy-gated` / `stale`; the end-of-run message lists the real ones and counts the
      policy-gated ones.
- [x] Parallelism default 1 (worker and verification). Specs for outcome mapping, the roll-up and
      the defaults (3 tests).

---

## Phase 5 — Relaxation profile

Scope set by review decision 1 (option c): two settings only, `computerUseAutonomyLevel` and
`providersExcludedFromAutomation`.

- [x] Read `settings-control-policy.ts` and `settings-manager.ts`: the operator-only tier governs
      the agent/MCP/CLI writers; `SettingsManager.set` itself applies no tier, validates the
      value and emits `setting-changed`. The relaxation writes through it from the main process.
- [x] `plan-queue-relaxation.ts`: plan (snapshot) → persist on the run row → apply; restore at run
      end and on every boot, leaving a value James changed during the run alone. One active run
      holds the snapshot at a time (see the fourth review note under Task 2.5). Opt-in per run
      (`relax_settings`), off by default. Use is logged per worker spawn under a relaxed run.
- [x] Spec (`plan-queue-relaxation.spec.ts`, 6 tests): restore after a simulated crash, hand
      change left alone, other keys rejected (also from a tampered snapshot); plus the boot
      restore/re-apply coordinator spec.
- [x] Need-James classification includes *policy-gated* in the verifier contract and the
      end-of-run message.

---

## Phase 6 — Gates and close-out

- [x] Canonical checklist from `AGENTS.md`, each run separately and unpiped:
      `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
      `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`,
      `npm run test:quiet`. Final run 2026-09-19 on the final code: every gate exit 0, plus
      `build:aio-mcp-dist`; full suite 2161 files / 25,642 tests passed.
- [x] Update `docs/architecture.md` with the new subsystem.
- [x] Create `2026-09-18-plan-queue_livetest.md` with the remediation-flow header: a real
      three-item run against disposable plan files in the rebuilt app (nesting in the rail, panel,
      verdict round-trip, squash commit on a scratch repo), restart mid-run, provider-limit park,
      reconciler alerting on a seeded unowned `queue-*` worktree.
- [x] Fresh-eyes completion gate by an independent agent; fix and repeat until `VERDICT: PASS`.
      PASS 2026-09-19 (fourth round on the landing rework); every earlier FAIL finding fixed
      and recorded above.
- [x] Update both documents' as-built notes, then rename plan and spec to `_completed` last.

## Stop-and-Confirm Gates

1. After Phase 0, if the leftover-worktree diagnosis shows a cause the spec's invariants do not
   cover, stop and revise the spec.
2. The first live run (livetest doc) uses disposable plan files in a scratch repository, not this
   backlog. Pointing the queue at the real 20 plans is James's call after that passes.
