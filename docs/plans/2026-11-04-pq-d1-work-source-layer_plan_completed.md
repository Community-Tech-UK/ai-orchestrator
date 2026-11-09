# Plan Queue programme: the work-source layer (Phase 6) — implementation plan

**Status:** Completed 9 November 2026. Implemented 8 November 2026 by Plan Queue run `b61083ee` (item `ddb36ba9`); every gate passed (typecheck, spec typecheck, lint, size, UI hints, both builds, full test suite) and the independent checker returned PASS with no findings. It parked only because 4 of 5 acceptance criteria need a rebuilt app; James authorised the landing, and it landed on main 9 November 2026 as `3ca1ad4de`. Not verified yet: the four live checks that need a rebuilt and restarted app, recorded in [2026-11-04-pq-d1-work-source-layer_plan_livetest.md](2026-11-04-pq-d1-work-source-layer_plan_livetest.md). Written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). **Hold lifted 8 November 2026:** James said "go anyway" without waiting for the targets in [2026-11-05-plan-queue-reliability_plan.md](2026-11-05-plan-queue-reliability_plan.md) to be measured.

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Design → One owner for each fact, Work source boundary
- Evidence → Where the queue assumes "document"
- Phases → Phase 6
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

This is the largest refactor in the programme and must change no behaviour except step 6.4's new argument: the existing plan-queue tests all pass, changed only for field names. It runs last, after the other plans have landed (`docs/plans/*pq-a*`, `*pq-b*`, `*pq-c*`): check that they have; if any has not landed, park and say which. New code goes in new modules; `plan-queue-coordinator.ts` and `plan-queue-item-flow.ts` are at their line limits. The identity migration must be tested on a copy of the real database (read-only source, copy written to `_scratch/`).

## Steps (copied verbatim from the programme plan)

- [x] 6.1 **Add the layer.** `QueueWorkSource` and the markdown adapter. Today's discovery, readiness, doc-close,
  doc-merge, parked notes, naming and landing text move behind it, with no logic changes. New modules only:
  `plan-queue-coordinator.ts` and `plan-queue-item-flow.ts` are at their line limits (allowlist 727 and 706, plus
  slack, in `scripts/check-ts-max-loc.ts`). M.

- [x] 6.2 **The identity migration** from the Design section: `source_kind` and `sort_key` added; `document_path`
  kept as the stored source reference. Test it on a copy of the real database (read-only source, copy written to
  `_scratch/`), checking row counts, ordering and every existing query before and after. S.

- [x] 6.3 **Update every reader in the same change:** DTOs, MCP status, the renderer item list and questions banner,
  the mobile gateway, triage records (add `sourceRef` beside `documentPath`), the step-up name, the branch name, the
  checkpoint message, and the interrupted-landing recogniser's prefix list. S.

- [x] 6.4 **`plan_queue_start` gains an optional `workspace` argument** (an absolute repository path), so a session
  in another folder can start a run there.
  - Allowed only for folders on James's saved Plan Queue folder list, which can be edited only on the Plan Queue
    page. The Linear project links in 7.2 add to the same list.
  - Anything else is refused with a plain reason.
  - Test: an unlisted folder is refused. S.

- [x] 6.5 **The existing plan-queue tests all pass,** changed only for field names.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- `QueueWorkSource` and the markdown adapter exist and today's discovery, readiness, doc-close, doc-merge, parked notes, naming and landing text run behind it.
- `source_kind` and `sort_key` are added without rebuilding the table; the copy-of-real-database test checks counts, ordering and every existing query before and after.
- Every reader changes in the same change (DTOs, MCP status, renderer, mobile gateway, triage records, names, recogniser prefix).
- `plan_queue_start` accepts an optional `workspace`, only for folders on the saved list; an unlisted folder is refused with a test.
- Every bullet of the step text above is met, or this plan's as-built notes say plainly, with the reason, which part was not and what remains.

## Verification

Run the targeted tests for what you changed, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

(Known: three `scripts/__tests__` tests fail on this machine because the installed Vite is older than `package.json` asks for; that is an environment fault, not yours. Say so rather than hide it.)

## Checklist

- [x] Step 6.1 implemented, wired, tested and verified (worker-side; the independent verifier still has to pass it)
- [x] Step 6.2 implemented, wired, tested and verified (worker-side; also tested on a copy of the real database)
- [x] Step 6.3 implemented, wired, tested and verified (worker-side)
- [x] Step 6.4 implemented, wired, tested and verified (worker-side; the live run in a rebuilt app is in the livetest file)
- [x] Step 6.5 implemented, wired, tested and verified (worker-side)
- [x] As-built notes written below

## As-built notes

Worker notes, 8 November 2026. The prerequisite plans (`pq-a1` to `pq-a5`, `pq-b1` to `pq-b4`, `pq-c1`, `pq-c2`) all exist as `_completed` documents, so this job was not parked.

**6.1 The layer (`src/main/plan-queue/`).** New modules only; the two files at their line limits got no extra lines (`plan-queue-coordinator.ts` 858 lines, unchanged; `plan-queue-item-flow.ts` 813 to 808).
- `plan-queue-work-source.ts`: the `QueueWorkSource` interface, `WorkCandidate`, and `LANDING_COMMIT_PREFIXES`.
- `plan-queue-markdown-source.ts`: the markdown adapter. It forwards, without changing them, to discovery, readiness (`reconcileWaitingDocuments`, `missingDocumentNote`), closing documents (`prepareClosedDocuments`, the retire-or-rename step that used to be `PlanQueueItemLanding.finishDocuments`), the merge with the root checkout's uncommitted edits (`plan-queue-doc-merge.ts`: overlap resolver, register clashes, `rootEditWouldMerge`, landing and boot recovery) and parked notes. It owns the naming: session name, branch slug, full file name, checkpoint line and landing subject, which were repeated in six places (`documentStem` in the item flow, the checker spawn, the landing code and the worker-session message; `planQueueBranchName`; the step-up notice).
- `plan-queue-work-sources.ts`: `workSourceFor(kind)` (an item's own kind; absent means markdown), `workSourceForRun(run)` (plan and livetest runs are both markdown) and `allWorkSources()` (boot recovery). Lazy on purpose, because the sources import the modules that call it.
- Callers switched to the item's source: `startRun` (discover), `claimDocumentsAndCreateItems` (needs-plan, left-out note, remembered decision), the pump and boot recovery (`reconcileWaiting`, `recoverInterruptedMerges`), `applyTriageRecords`, `startVerification` (`missingNote`), the item flow (session name, park note on and off), the landing code (merge recovery, review check, closed documents, commit subject, retire step), `syncItemWithBase` and the promotion (register clashes, overlap resolver), the landing wait, the worktree service (branch name, label, checkpoint line), the step-up notice, the checker spawn and the run messages.
- `oversizedNote` moved from `plan-queue-run-start.ts` to the markdown adapter (only the start code used it). `recoverInterruptedDocumentMerges` is no longer re-exported from `plan-queue-recovery.ts` (nothing else imported it from there).
- **The interface is smaller than the programme plan's sketch, on purpose.** A method is there only because a caller needed it: no `brief`, `onQueueEvent`, `afterLanding`, `blockedBy` or priority yet (Phase 7 adds them with the code that uses them), and `PlanQueueSourceKind` is `'markdown'` only. `discover(repoRoot, query)` takes the folder, not the run.
- **Still markdown-only, reading `sourceRef` as a file path (not moved, listed so nobody assumes otherwise):** the checker's document identity (`plan-queue-document-review.ts`, `plan-queue-verification.ts`, `plan-queue-check-groups.ts`), the plan pins and diet, the progress fingerprint, triage memory, the set-aside agent's "document closed" check, and the prompt text. They belong to Phase 7's `brief`. The planning-file naming guard in `plan-queue-squash.ts` also stays where it is: it is a Git hygiene rule that applies to every source's branch, not a rule of one source. `previewPlanQueueDocuments` stays in `plan-queue-discovery.ts`, as the markdown form preview.

**6.2 Identity migration.** Migration 044 `044_plan_queue_item_source_sort` (the number the programme held; it left `PLAN_QUEUE_RESERVED_MIGRATIONS`) adds `source_kind TEXT NOT NULL DEFAULT 'markdown'` and `sort_key TEXT NOT NULL DEFAULT ''` by plain `ADD COLUMN`. The table is not rebuilt, `document_path` keeps its name. (Main's migration 054, merged in later, takes the table-level `UNIQUE (run_id, document_path)` off and adds a unique index on run, document and step; 044 leaves that index alone, and 054 rebuilds from the live columns so it keeps the two new ones.) `sort_key` is a fixed-width string (`plan-queue-sort-key.ts`: priority rank, source order, discovery index; no priority sorts after Low). `PlanQueueStore.listItems` and `listRunSnapshots` order by `sort_key, created_at, id`; rows from before hold `''`, which sorts first and in `created_at` order, so no existing run changes order. Both columns are written when an item is created and left alone by later saves (a stale snapshot cannot undo a re-prioritisation; Phase 7 gives that its own writer).
- **Tested on a copy of the real database** (`plan-queue-identity-migration.spec.ts`, which runs the real-copy block only when `PLAN_QUEUE_REAL_DB_COPY` is set). The copy was made with `sqlite3 -readonly <live db> ".backup '<worktree>/_scratch/real-db-copy/loop-mode.db'"` and then switched to the non-WAL format (on the copy only), because the test backend's in-memory images cannot open WAL files. The live file was never opened for writing. The copy had migrations 1 to 52 without 44, 264 runs (253 with items), 2,388 items over 812 documents, 29,691 events, 215 verdicts, 102 pins, 513 spend rows and 35 triage decisions. After migrating a writable in-memory copy of it: every queue table has the same row count; every old column of every item is identical, row by row, including row numbers; every item has `markdown` and an empty key; the order of all 264 runs equals the old `ORDER BY created_at, id` order (also through `listRunSnapshots`); and 21 existing store reads (runs, active runs, folders, kept folders, git ownership, passed landings, queue health, latest attempts, newer attempts, parked-in-folder, per-item reads for 300 items and 300 documents) return the same as the same reads on the unmigrated copy, ignoring the two new fields. The test backend gained `openSqliteWasmFileCopy` (a writable in-memory copy of a file, test-only, in `sqlite-wasm-driver.ts`). The copy was deleted afterwards.
- Also tested without the real copy: an install with 45 to 52 applied and 044 missing (applies once and is idempotent; rows, the step unique index and every old value unchanged; the table text only gains the two columns); a new run ordered by sort keys, not creation times; a stale snapshot not changing the kind or key; **crash window**: a half-applied earlier attempt (one column already there) makes the migration fail as a whole, leaving neither column and no receipt, so the next start applies it whole.

**6.3 Readers.** `PlanQueueItem.documentPath` is now `sourceRef` (plus `sourceKind?` and `sortKey?`; absent kind means markdown, so test fixtures and older callers need no change). Changed in the same change: the item DTO schema (`sourceRef`, optional `sourceKind`), `itemToDto`, MCP status (`document` still names the file), the renderer store, item list, questions banner, parked list, run controls, skip list, bulk preview and the needs-you sources, the mobile gateway DTO and projection (the phone app reads only `title`, not the old field), the step-up name, the branch name, the checkpoint message, and the interrupted-landing recogniser, which now takes its first words from `LANDING_COMMIT_PREFIXES` (`Plan`, `Livetest`, and `Ticket`, listed ahead of the Linear source so a landing it interrupts is still recognised). Triage records name their work by `documentPath` or `sourceRef` (either; `sourceRef` wins); the triage prompt still asks the agent for `documentPath`. The folder and checklist schemas moved to `plan-queue-folders.schemas.ts`, re-exported from `plan-queue.schemas.ts`, because the schema file was at its 700-line limit; imports are unchanged.

**6.4 The `workspace` argument.**
- New operator-only setting `planQueueFolders` (list of full paths, each once; schema `PlanQueueFoldersSchema`), wired like `planQueueFolderChecklists`: `settings.types.ts`, defaults, metadata (hidden), surfacing (`bespoke`), `readOnly(...)` and `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` in `settings-control-policy.ts`. It is the 28th anchor, so the count in `orchestrator-settings-tools.spec.ts`, `docs/AIO_MCP_CLI.md` and `docs/llm/AIO_MCP_CLI_REFERENCE.md` went from 27 to 28 (the check-size ceiling of `settings-control-policy.ts` rose by 4). A new test proves `set_setting` and the privileged CLI both refuse it.
- Editor: new `plan-queue-folder-list-panel` on the Plan Queue page's Setup tab ("Folders a session may start a run in"), following the checklist panel's structure. Failed saves show the real reason through `presentError(...).rawDetail`, as the visible-error ratchet requires.
- `plan_queue_start` takes optional `workspace` (schema and MCP tool description). `plan-queue-saved-folders.ts` (`resolveListedWorkspace`, called first in `start` of `plan-queue-tool-operations.ts`) refuses, in this order and with a plain sentence each: a path that is not full; a folder not on the saved list (without touching the disk; the sentence says only James can add one, on the Plan Queue page); a listed folder that is only inside a project (it names the project's top folder). Spellings of one folder (slashes, `..`, links) are compared as the setting's own rule compares them. With no `workspace` nothing changes. The page's own start path (IPC, James himself) is not affected. The Linear project links of step 7.2 will add to the same list.
- Advertised tool-schema size: `workspace` and `sourceRef` take the full orchestrator set to 76,866 bytes, so the `orchestratorFull` ceiling in `tool-schema-budgets.spec.ts` rose from 76,800 to the next 1 KiB (77,824), with a reason comment there.
- Tests: unlisted and empty list refused with nothing started; a listed project starts there; no argument starts in the session's own folder; the folder-list panel has its own spec.

**6.5 Existing tests.** Changed only for field names (`documentPath` to `sourceRef` on items, `path` to `ref` on discovery candidates), plus the places where the new fields necessarily show: the store spec's item fixture and its four raw-row assertions after migration gain `source_kind` and `sort_key`, the page spec's Setup heading list gains the new section, and the settings spec's anchor count is 28.

**Checks run in the worktree (all exit 0 unless noted)**
- Before editing: `npm run test:quiet -- src/main/plan-queue src/main/orchestration/loop-migration-numbers.spec.ts`: 1 of 1,804 failed (`plan-queue-coordinator.spec.ts`, the replay of stored PASS verdicts: it expected `verifying` and saw `working`, at a machine load average of 15 to 40). It is not in the final run's failures.
- `npm run checks` (on the Windows PC): `typecheck`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints`, `build:main`, `build:renderer`, all passed (run twice; the second after the last renderer edit).
- A named list of 1,047 spec files (everything under `src/main/plan-queue`, `src/main/mcp`, `src/main/mobile-gateway`, `src/main/orchestration`, `src/main/core/config`, `src/main/db`, `src/main/context`, `packages/contracts`, `src/shared`, `scripts`, and the renderer's plan-queue, workboard, instance-list and state folders), run through `npm run test:quiet -- <files>`, which sent it to the Windows PC: 1,044 files, 14,097 tests passed in 3 m 39 s. An earlier run of the same list found two failures (the page spec's heading list, and my own panel spec's expected order) and one in `visible-error-ratchet.spec.ts` (new raw error sites in the new panel), all fixed. The full suite (`npm run test:quiet` with no files) was not run, as instructed; the three `scripts/__tests__` Vite failures the plan warns about did not appear on the PC.
- `npm run verify:architecture`, `verify:ipc`, `verify:exports`, `check:contracts` and `generate:aliases` pass, and the generated files (`register-aliases.ts`, `channels.ts`, `architecture-inventory.json`) needed no change.
- Real-database-copy block: `PLAN_QUEUE_REAL_DB_COPY=<copy> npm run test:quiet -- src/main/plan-queue/plan-queue-identity-migration.spec.ts` (local, 9 of 9). The PC run skips that block, which needs the copy.
- **Mutation checks (each guard removed, the named tests failed, then restored and re-run green):** the folder-list check removed: 4 tests failed (`plan-queue-saved-folders.spec.ts` x2, `plan-queue-tool-operations.spec.ts` x2). `listItems` back to `ORDER BY created_at, id`: 2 failed (the sort-key order tests in the migration and run-start specs). `sort_key = excluded.sort_key` added to the save: 1 failed (the stale-snapshot test). `Ticket` removed from `LANDING_COMMIT_PREFIXES`: 2 failed (the leftover spec's Ticket case and the prefix test).

**Choices made without asking (evidence in the code and the programme plan)**
- Kept the interface to what has a caller (above); did not add a Linear kind.
- Left the phone's `documentPath` field out rather than keeping both names, because the phone app (`apps/mobile`) never reads it.
- Put the folder-list check in the tool operations, not in `startRun`, because only an agent-supplied `workspace` needs it; the Plan Queue page starts runs as James.

**Deferred live checks** (rebuilt app, James's real database): see [2026-11-04-pq-d1-work-source-layer_plan_livetest.md](2026-11-04-pq-d1-work-source-layer_plan_livetest.md): (1) migration 044 applies on restart, (2) a session starts a run elsewhere only when James has listed the folder, (3) the folder list cannot be changed by an agent, (4) a new run keeps its names and order.

**Not done / for others:** nothing in 6.1 to 6.5 is left open. Mismatches between docs and code found: none that needed a decision.

**Verification round 1 fix (9 November 2026).** The verifier found that the landing-wait notice (`plan-queue-landing-wait.ts`) still took its work name from `path.basename(item.sourceRef)`. It now uses `workSourceFor(item.sourceKind).fullName(item)`, which gives the same text for markdown work (the file name with its extension), and the unused `node:path` import is gone. The same pattern was in two other messages shown to James, so they went through the source as well: the "Waiting to be checked together with ..." detail in `plan-queue-check-groups.ts` and the "could not clear" note in `plan-queue-set-aside.ts`. Remaining `basename(sourceRef)` uses are the markdown adapter itself and the mobile gateway's row title fallback, which is outside the Plan Queue naming this step covers. Checks: typecheck exit 0; the landing-wait, check-groups and set-aside specs pass (94 tests).
