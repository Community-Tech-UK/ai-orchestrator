# Test suite pruning (2026-11-09)

## Status

Completed 11 November 2026. On main: yes. James's commit `2924bfbab`
("October updates", 10 Nov 2026 20:00) took the whole working tree, including every batch and fix here and 19
temporary timing copies by mistake.

- **Done:** Batches 0-12 and the seven fixes in section 7 (James, 10 Nov: "fix the issues", "do batch 11 and 12").
  47,894 → 46,720 tests; summed test time about 1,440 s → 1,112 s; full run 6 m 21 s on the PC. Checks 7/7 and
  full suite green (11 Nov). Every batch and fix passed independent review (`VERDICT: PASS`, no actionable findings).
- **Committed:** the deletion of the 19 temporary timing copies and the posix-cleanup ready-signal fix went in with
  James's commit `d61437d44` ("October updates", 11 Nov 2026 08:37). This plan was committed on 12 November 2026
  after James said "Commit automatically".
- **Decisions:** keep every test that guards a user-visible behaviour, safety or data-loss path, security check,
  contract, `LT-NNN` defect or recorded incident, or is the only test reaching a branch. Speed slow tests up rather
  than delete them. Pruning batches are tests only; the section 7 fixes change app code.
- **For James, not in scope:** unreached code (section 6); open notes in section 7 items 4 and 5.
- Batch log: section 5. Per-batch notes and evidence: `_scratch/prune/` (swept after 14 days).

## 1. What James asked

On 9 November 2026 James said the suite's 48,000 tests seem excessive and asked for them to be reviewed in batches,
keeping only what is necessary. A test is necessary when it protects something real. The aim is less to maintain and
a faster run with no loss of protection; the count is a symptom, not the target.

## 2. Criteria

Always keep: user-visible behaviour; safety and data-loss guards (Git, files, credentials, approvals, sending to a
person); security checks; contracts (persisted data, migrations, IPC and wire formats, tool schemas, public APIs);
tests citing `LT-NNN`, an incident or one of James's rules; the only test reaching a branch.

Remove or change, with a one-line reason each in the batch log:

- duplicates at the same level (same file or another file);
- table rows reaching the same branch with the same kind of input (keep boundaries and one row per branch);
- tests that only check a mock was called as the code calls it, asserting nothing observable;
- tests pinned to implementation detail that any refactor breaks with no behaviour change;
- one- or two-test files that share a sibling's setup (merge, never drop);
- slow tests: make them faster (shorter test-only waits, shared fixtures, fake timers), never delete them for speed.

Every batch: read each touched spec and the code it tests in full; compare line and branch coverage of the exercised
sources before and after (`_scratch/prune/cov.sh`, which runs `vitest related --coverage` with v8 on this Mac) and
explain every drop; run the batch's specs, `npm run checks` and the full `npm run test:quiet`; independent
`task-completion-gate` review until `VERDICT: PASS`; commit only that batch's files by name after James's yes.

## 3. Inventory (re-measured 9 November 2026, evening)

Full run on the Windows PC, no cache: 3,723 spec files, **47,894 tests**, 11 skipped, 45 failing. All 45 failures are
in seven Plan Queue files another session is changing (`host.queueFolderLimit is not a function` and one coordinator
assertion); none is in a file this plan touches. Wall time 6 m 49 s with 8 workers; the tests' own time adds up to
about 24 minutes (1,440 s on the 9 November report).

| Area | Files | Tests | Test time |
| --- | ---: | ---: | ---: |
| `src/renderer/app` | 639 | 7,023 | 138 s |
| `src/main/cli` | 402 | 4,834 | 129 s |
| `src/main/instance` | 297 | 4,547 | 76 s |
| `src/main/orchestration` | 308 | 3,707 | 257 s |
| `src/main/browser-gateway` | 153 | 2,389 | 53 s |
| `src/main/plan-queue` | 117 | 2,020 | 214 s |
| `src/main/app` | 48 | 1,861 | 3 s |
| `src/shared/types` | 56 | 1,474 | 1 s |
| `scripts` | 108 | 1,288 | 215 s |
| everything else | 1,588 | 18,659 | 354 s |

Findings that shape the plan:

- **The count is mostly real.** Eight read-only reviewers sampled every area (about 10% of files read in full, chosen
  by size, tables, call-check ratio, small-file clusters and speed). Outside a few tables the suite is mostly
  per-branch and contract tests. Table rows that test one branch many times are concentrated in a handful of files.
- **One word list is pasted four times.** About 200 "filler or status title" strings appear in
  `title-derivation.spec.ts` (twice), `auto-title-service.spec.ts` (two uses) and `history.types.spec.ts` (six
  assertions per row): about 900 to 1,100 tests between them.
- **Time is in setup, not in test count.** A 1.5 s pause after every loop iteration costs about 205 s across 21 loop
  spec files; a fresh Git repository per test costs about 190 s across 53 files; a freshly migrated database per test
  costs 40 to 75 s across 81 files; four script tests (`remote-run.linux`, `run-tests-quiet-remote`, posix cleanup,
  hung-parent waits) cost about 90 s more than they need to.
- **Only one snapshot** exists in the whole suite. 11 tests are skipped, all deliberately (platform or environment).
- **Duplicates found while fixing the flaky test:** a merge on 6 November (`b6fb889a7`) copied five Plan Queue
  coordinator tests in twice, byte for byte.

Expected result if every batch lands: about 1,300 to 1,900 fewer tests (3 to 4%), about 450 to 650 s less test time
(30 to 45%), and the run's longest files fall from 87 s and 64 s to under 30 s. The honest headline for James: the
suite is not padded in general; it is slow in specific places.

## 4. Batches

Order: mechanical before judgement, one area at a time. Dirty files from other sessions are left out and listed.

| # | Area | Kind | Files | Expected change |
| --- | --- | --- | --- | --- |
| 0 | flaky fixes | fix | 2 | 5 duplicate tests out, 2 flaky tests fixed |
| 1 | title word lists (`shared/types`, `instance`) | mechanical table trim | 3 | −860 to −1,100 tests |
| 2 | loop coordinator speed (`orchestration`) | speed, test-only wait override | about 25 | −120 to −175 s, no test removed |
| 3 | `orchestration` judgement and merges | duplicates, rows, small-file merges | about 30 | −10 to −20 tests, about 15 fewer files |
| 4 | `cli` mechanical | table trims, fake timers | about 8 | −45 to −75 tests, −10 s |
| 5 | `cli` judgement and spawn-worker speed | duplicates, weak tests, shared worker | about 17 | −25 to −40 tests, −35 to −50 s |
| 6 | `renderer` | copy-of-logic specs, duplicates, mock-only, fake timers | about 15 | −40 to −60 tests |
| 7 | `scripts` and worker-agent speed | shared fixtures, shorter waits | about 9 | −70 to −90 s |
| 8 | gateway, worker-agent, remote-node judgement | duplicates, merges | about 12 | −20 to −40 tests |
| 9 | providers, core, shared, tasks | duplicates, tautological type specs, rows, cadence matrix | about 25 | −50 to −90 tests, −20 to −30 s |
| 10 | `instance`, `session`, `history` | rows, fake timers, merges | about 40 | −15 to −60 tests, −5 s |
| 11 | Plan Queue and automation setup | shared Git template, migrated-database template, split coordinator spec | about 60 | −100 to −150 s; after the other session lands |
| 12 | ACP consent integration tables | judgement on a consent guard | 1 | −80 to −100 tests; ask James first |

Batch 12 needs James: `acp-permission-consent.integration.spec.ts` repeats its unit spec row for row, but it is a
consent safeguard (a free-text "yes" can approve a command). The unit spec stays whole either way.

## 5. Batch log

### Batch 0: flaky fixes (verified; independent review PASS)

- `src/main/plan-queue/plan-queue-coordinator.spec.ts`
  - Removed five duplicate tests copied in by `b6fb889a7`: "respawns a worker for a working item whose session
    died…", "refuses a verdict from anyone but the assigned verifier", "discards a verdict from a verifier that
    changed the tree…", "asks James about a genuine authority boundary…", "parks in-flight work and skips the rest
    when James cancels". Each copy was byte-identical to the kept test; the two "boot recovery" describes are merged.
  - Fixed "parks in-flight work…": an item shows as working before its fake worker runs, and `vi.waitFor` used its
    1 s default. Reproduced both failures: the 1 s wait timing out on a loaded Mac, and, with a 1.5 s delay injected
    before the fake worker writes, the checkpoint check failing (`git show` finds no file). The test now waits up to
    15 s for the worker to have written its file, then cancels; it passes with the same injected delay, and every
    original check stays. Independent review reproduced the 1.5 s case on HEAD (a 300 ms delay did not reproduce).
  - Same cause, found by the review: "a user-closed verifier consumes no errored round…" waited for its checker with
    the 1 s default and failed once under load. Its wait now has the file's usual 15 s budget. About 20 other waits
    in this file still use the default; they go to Batch 11 (this file is shared with another session's work).
- `src/main/persistence/rlm/rlm-wal-native.spec.ts`: "bounds total waiting when a writer becomes a persistent
  reader". The lock holder released its write lock and then took a read lock in a second step; in that gap the
  journal mode can switch to WAL and the test sees no failure. Reproduced by widening the gap (fails with
  `expected undefined to match object { code: 'SQLITE_BUSY' }`). A second connection now takes the read lock before
  the write lock is released (a write lock still admits readers), so there is no gap; passes with 100 ms delays
  injected around the hand-over, and 3 of 3 plain runs.

### Batch 1: title word lists (verified; independent review PASS with Batch 0)

One list of about 200 filler titles ("Completed", "Ready to assist", "Fixing this issue"...) was checked in four
places. The words in `LOW_SIGNAL_TITLE_WORDS` are the guard itself, so the list's home stays whole: the
`isLowSignalTitle` table in `title-derivation.spec.ts` is untouched (the number of filler words that appear in some
test string is 237 before and after; 171 of the 408 words never had a whole-word test row, before or after), as are the "preserves useful title" table,
the lifecycle-status table and the Harness-ID table. The other copies keep the rows that reach their own code.

- `src/shared/types/title-derivation.spec.ts`, `validateGeneratedTitle` rejects: removed 177 rows that the real code
  rejects only because every word is filler (checked with `_scratch/prune/title-rows.ts`, which runs the real
  presentation and vocabulary checks per row) and that appear word for word in the `isLowSignalTitle` table. Kept all
  59 layout rows (numbering in every script, bullets, headings, code fences, line breaks, sentences, narration,
  label prefixes, first person, thinking tags, length) and 6 filler samples that show validation reaches the word
  check.
- Same file, accepts: removed 29 plain titles also in the "preserves useful title" table (validation adds nothing for
  plain words). Kept the rows that test layout: unwrapping, thinking blocks, colons, dashes, slashes, `IT` versus
  `it`, digits first, label words first.
- `src/main/instance/auto-title-service.spec.ts`: the service passes model output through `validateGeneratedTitle`,
  strips lead-ins, then validates again. Kept every "Please …" row (they reach the second validation), the
  truncation row, and one row per kind of rejection (filler, label, numbering in two scripts, heading, first person,
  gerund, plural, one lifecycle status). Removed 25 opening-naming rows, 160 boundary rows plus 20 of the 21 spread
  lifecycle statuses (each used twice, so 360 tests), 28 formatted-title rows and 5 local-only rows.
- `src/shared/types/history.types.spec.ts`: the history resolvers use the same presentation and filler checks; what
  is theirs is recovery order and keeping deliberate renames. Kept 10 malformed rows (including the "Please" re-check
  and a non-Latin digit), the 4 legacy-only rows (`__init__.py`, `auth__handler.ts`, `R`, the truncation marker) plus
  4 samples, and 12 status rows including "Untitled thread" (the absence label) and one lifecycle status. Removed 23,
  28 and 163 rows plus 20 of the 21 spread lifecycle statuses.
- Result: 1,497 → 636 tests in the three files. Coverage of `title-derivation.ts`, `auto-title-service.ts` and
  `history.types.ts` from these three files, compared statement by statement and branch by branch
  (`_scratch/prune/covcmp.cjs`): 234/194, 180/129, 61/89 before and after, nothing lost. Because no other spec
  changed, coverage from the wider related set cannot drop either.
- Checks (Batches 0 and 1 together): `npm run checks` all seven pass on the Windows PC. Full suite, no cache:
  3,723 files, **47,023 tests passed**, 0 failed, 7 m 25 s on the Windows PC (baseline 47,894 tests with 45 failures
  from the other session's then-unfinished Plan Queue work, since fixed by that session).

### Batch 2: loop coordinator speed (verified; independent review PASS)

No test removed. `loop-coordinator.ts` waits 1.5 s after every iteration (`sleep(1500)` at the end of the iteration
loop and after a branch-select adoption or plan regeneration); specs that drive a real coordinator spent most of their
time there.

- New test helper `src/main/orchestration/loop-coordinator-test-pause.ts` (beside `loop-coordinator-test-cleanup.ts`):
  a `vi.mock` of `loop-coordinator-utils` whose `sleep` turns exactly that 1.5 s pause into 5 ms and leaves every
  other wait real (the 250 ms admission poll and the breaker and transport backoffs, which would otherwise spin).
  `useRealIterationPause()` restores the real pause for the rest of one test.
- 20 spec files opt in. Nine more were tried and put back as committed after review, because their tests finish
  within one iteration or stop mid-iteration and never reach the pause (accept-completion, audit, block-sanity,
  cancel-preflight-verify, fresh-eyes, harness-stop, usage-throttle, global-pause, global-pause-clock).
- `loop-coordinator-review-driven.spec.ts`: "resets the clean-pass streak…" slept 7 s and "does not treat ambiguous
  completion claims…" slept 5 s to let iterations pass, then asserted no completion. They now wait for the fourth and
  third invocation, which proves the iterations under test were judged; the assertions are unchanged. The coordinator
  keeps terminal loop state, so the streak check still reads real state if the loop reaches its cap first.
- Tests that read state "after iteration N" while N+1 had not started (timed against the real gap) keep the real
  pause via `useRealIterationPause()`, each with a one-line reason; their assertions are unchanged:
  `loop-coordinator-auto-unstick` "broadcasts a recovered streak…", `loop-coordinator-review-driven` "does not audit
  a verified no-change claim…", `loop-coordinator-terminal-intents` "imports a fail intent at the next
  pre-iteration boundary…". (The audit, usage-throttle and block-sanity tests that needed it are in files now left
  as committed.)
- Left out: `loop-coordinator-degraded-retry.spec.ts`. With the short pause two different tests raced its teardown
  (an iteration still writing `control.json` after the workspace was removed), so it keeps the real pause.
- Verification: the 29 files 8 runs in a row on this Mac, 180 of 180 each time (after the opt-outs; before them, 5
  tests failed, and all five pass at HEAD, which is how the gap-timed tests were found). `npm run checks` all seven
  pass; full suite 3,723 files, 47,028 tests passed, 0 failed, 6 m 45 s on the Windows PC. Orchestration test time
  in the full run: 260 s → 98 s (review-driven 45 s → 14 s, cold-resume 25 s → 12 s, pre-iteration 16 s → 1 s).
- Observation for James, not changed: record-mode preflight is started and not awaited
  (`void startVerifyBaseline(...)`, `loop-coordinator.ts:1884-1889`), so the audit smoke test's check that the
  preflight file exists already depends on timing at HEAD; with a fast loop it was missing at completion.
- Review: independent `task-completion-gate` review, VERDICT: PASS, no actionable findings (11 runs of the 29 files
  with no failure, 6 under doubled load; summed per-file time 228 s → 70 s against a HEAD clone).

### Batch 4: `cli` mechanical table trims (verified; independent review PASS)

Batch 3 (orchestration judgement) is not started; Batch 4 went first because its trims are mechanical.

- `src/main/cli/adapters/resume-error-classifier.spec.ts`: the four patterns in `resume-error-classifier.ts` are
  regex alternations. Kept one row per alternative, one case variant and one phrase embedded in a sentence per
  group; removed 17 case and suffix variants of alternatives already covered. The 9 negative near-misses stay.
  (`expired session`, an alternative, had no row before or after: a gap, not a change.)
- `src/main/cli/adapters/__tests__/copilot-usage-diagnostics.native.spec.ts`: a privacy guard (no usage source text
  may reach logs). All 11 value kinds still run on `premiumRequests`; `totalApiDurationMs` and `sessionDurationMs`
  pass through the same `copilotUsageDiagnostic` call (`copilot-cli-adapter.ts:599-601`), so each keeps a present
  (`source string`) and a missing row. 33 → 15.
- `src/main/cli/adapters/opencode-account-startup.spec.ts`: region only picks the source account (`ams` reads from
  `sgp`, every other region from `ams`), so `cn` took the `sgp` branch in all 16 of its rows; `cn`'s native model is
  derived in `opencode-account-spawn.spec.ts:238`. 48 → 32.
- Result: 203 → 152 tests. Coverage from these three files of `resume-error-classifier.ts`,
  `copilot-cli-adapter.ts`, `copilot-usage-diagnostics.ts`, `opencode-adapter-factory.ts`, `acp-cli-adapter.ts` and
  `opencode-config-shapes.ts`: nothing lost.
- Checks: `npm run checks` all seven pass. Full suite 46,989 tests, 2 failed, both in plan-queue files another
  session is changing (`store.waits.paused is not a function` from its unfinished pump change); the three files
  here passed.
- Not done here, moved to Batch 5: `acp-input-stop-lifecycle` and `acp-input-receipt` each wait out the real 5 s
  stdin write timeout; fake timers need care in those async fixtures. `claude-cli-argv-builder` budget rows were
  left alone: a spend cap, and the two removable rows cost nothing.

### Batch 5: `cli` judgement and spawn-worker speed (verified; independent review PASS)

Full notes: `_scratch/prune/batch5-log.md`. 21 tests removed, 1 added (net −20), 5 fewer spec files, about 70 s
less test time.

- Speed, real spawn worker: the 3 s per test was teardown, not start-up: the worker's `shutdown()` always waited
  its full 3 s grace even with no child left. That was a production defect (it also delayed quitting) and is now
  fixed at the cause (section 7, item 2). Five files (`cli-worker-failed-usage`, `-resident-cost`,
  `-cancelled-usage`, `claude-direct-failed-usage`, `claude-dispatch-failure`) are back to their HEAD form with
  plain `gateway.close()`: 81 s → 12 s of test time.
- Speed, `acp-input-receipt` and `acp-input-stop-lifecycle`: the real 5 s stdin write timeout (its only production
  caller passes no timeout) now runs on fake `setTimeout`/`clearTimeout`; 5.2 s → under 0.25 s each, 20/20 in 6 runs.
- Removed: `degraded-output-classifier` 6 (same-path healthy rows, one test pinned to protected field names);
  `opencode-account-provider-config` 8 (a 4 × 3 regex table to 4 diagonal rows); `adapter-factory-claude-remote-policy`
  2 (`node-run` forwarded by truthiness like `review`; it keeps three dedicated tests); `claude-cli-adapter` 2
  ("does not throw", a constant's format); `codex-cli-adapter.app-server` 3 (assertions not depending on the option
  under test; a repeated getter check).
- Merged (verbatim, same setup): three registry specs into new `__tests__/cli-registry.spec.ts`; one-test files
  `codex-exec-input-dispatch`, `codex/exec-process-input-write` and `codex-loop-compaction` into their siblings.
- Added: `cli-spawn-worker-gateway.spec.ts` "does not start a worker when a restart scheduled before close comes
  due" (fake timers). The speed change stopped reaching that early return by accident; it is now covered on purpose
  and fails when the guard is removed. The NdjsonParser buffer-cap test asserted `length >= 0`; it now checks what
  the parser does past the cap, and fails under two deliberate breakages.
- Kept after checking: logger positive controls (privacy checks), per-provider factory tests (separate code),
  real-worker rows (different routes), token-ceiling pair (different units), usage-limit wire values.
- Coverage of `src/main/cli/**`: statements 5,699 → 5,698, branches unchanged; the one statement is still reached
  and asserted by two other specs. `npm run typecheck:spec` passes; oxlint clean on changed lines; raw eslint
  errors are all present at HEAD.

### Batch 3: `orchestration` judgement and merges (verified; independent review PASS)

Full notes: `_scratch/prune/batch3-log.md`. 5 rows removed, 5 fewer spec files. Rule: merge only files with the
same `vi.mock` setup, in one feature or into the same unit's spec; several Phase 1 merge leads failed it.

- Merged: the five `loop-outstanding-*` specs (7 tests, no mocks) into new `loop-outstanding.spec.ts`;
  `loop-finish-merge.spec.ts` into `loop-worktree-lifecycle.spec.ts`.
- `orchestration-protocol.spec.ts` 115 → 110: each row mapped to the regex alternative and word it reaches; the five
  removed rows repeat one with the same input shape. 27 of 27 alternatives still reached. Most of the tables
  reviewer's 16 suggested removals were distinct alternatives and stay.
- Kept: `coordinator-event-bridge` "wires debate events" (its call count is the only check that a plain round sends
  no synthesis event); `verify-failure-keys` rows (each a separate arm of a fail-safe guard);
  `loop-review-reuse-anchor` table (James's 7 September 2026 rule; `spigot.yml` is the only row of its rule); the
  automation delivery pair and remaining micro specs (different mocks or different units).
- Coverage of the eight sources: identical. eslint and oxlint clean.

### Batch 9a: providers, core, memory, context evidence, code search, local AI guard (verified; review PASS)

Full notes: `_scratch/prune/batch9a-log.md`. 47 tests removed, 9 fewer spec files, three slow files faster.

- Speed: `context-evidence-incident-replay` runs its 44-record replay once in a `beforeAll` for the two tests that
  read it (25-39 s → 8-12 s; under heavy load HEAD timed out and the new file passed). `code-retrieval-load` runs
  10 searches spread over the files instead of 50 on the same path, same fixture and the same 500 ms ceiling
  (6-8 s → 1.5-2 s in the batch's runs; it failed once at HEAD on that ceiling). The reviewer measured 21-25 s at
  load about 30, with one clean-up timeout that a HEAD copy also hit, so the saving is not proven under load; the
  ceiling now covers 10 searches instead of 50, a slightly weaker check of slow outliers. `local-ai-health-repository` seeds 10,001 rows in one
  transaction (about 0.8 s → 0.55 s). Five runs each, no failures.
- Table trims, each mutation-checked: `provider-limit-ledger` 5 (`''` and `'   '` take the same branch),
  `mimo-startup-recovery` 1 (HTTP 500 like 429 and 503), `model-call-recorder` 1, `named-model-call-usage` 27 (the
  6 × 8 matrix to 21 rows: all 8 modes on one path, and each path keeps success, cancelled and paid-failure rows).
- Duplicates: 11 per-provider envelope tests already covered by the parity matrix and `base-provider.spec.ts`;
  2 reset tests whose reset another test already proves.
- Merged verbatim: seven `settings-control-policy.*` one- or two-test files into `settings-control-policy.keys.spec.ts`;
  `parse-cli-shadow-report`, `provider-doctor-opencode-install` and `mimo-session-refresh-persistence` into siblings.
- Kept: "same instance" singleton tests (the only cover of the cached branch); "no legacy EventEmitter" tests
  (different classes); `app/` and `context/` small files (own mocks or different sources).
- Coverage: identical in every group. `npm run typecheck:spec` passes; one raw eslint error present at HEAD.

### Batch 7: remote-checks, scripts and worker-agent speed (verified; independent review PASS)

Full notes: `_scratch/prune/batch7-log.md`. No test removed or added; every `expect(` line unchanged. Eight spec files
and one test helper sped up: in two paired runs against HEAD the six main files went 397 s → 97 s and 226 s → 66 s
(load 30-290). An earlier agent was cut off mid-batch; its edits were reviewed and finished.

- `remote-run.linux.spec.ts`: independent tests run concurrently (own machine folder, project, slots and run id
  each); the one timed test stays serial; clean-up moves to `afterAll` because ending a child's stdin is how the
  script sees a closed connection. 113-160 s → 38-41 s.
- `run-tests-quiet-remote.spec.ts`: the committed project is built once and copied per test instead of
  `git init/add/commit`; async spawn; concurrent. 61-185 s → 18-46 s.
- `fake-ssh.testing.ts`: a fixed `sleep 5` replaced by waiting until the main report has been fetched, which is
  stricter than the sleep (the old test passed only if 5 s happened to be enough).
- `recall-replay-runner`, `worker-node-executor.posix-cleanup`, `worker-rpc-dispatcher.node-ops`: the real
  signal-ignoring child stays; the runner's own deadlines run on fake timers, or the child reports readiness so a
  short timeout cannot race its start-up. 11 s → 0.1 s, 14 s → 4.7 s, 6.6 s → 4.7 s.
- `remote-instance-telemetry.spec.ts`: 20 s → 0.1 s. Its teardown sent real SIGTERM and SIGKILL to the made-up pid
  4242 and waited 5 s; a spy now catches signals for that pid only. On a machine where 4242 is one of James's
  processes, the old test would have killed it.
- `browser-mcp-stdio-server` and `browser-tool-reveal-continuity` hung-parent tests: the restore's three 2 s
  attempts on fake timers (reviewed by the lead; coverage identical, 18 s → 8 s for the pair, 5 clean runs).
- Runs: every changed file 5 in a row plus once shuffled, no failures. Coverage of in-process sources loses only
  lines reached by teardown or chance, each tested deliberately elsewhere. `typecheck:spec` and oxlint pass.
- After the 11 November review: the posix-cleanup signal-ignoring child wrote its ready file before printing
  `ready`, so with the 50 ms timeout a loaded Mac could kill it before the output was sent (pipe writes are
  asynchronous on macOS). It now writes the ready file from the write's callback; 5 clean runs, eslint and oxlint
  clean.
- Script-side waits (decided, no change): the remaining `sleep 1` and 2 s poll in `remote-run.sh` would save only
  8-12 s now the tests overlap; not worth changing a script that runs on the far machines. This closes the plan's
  open question for Batch 7.

### Batch 9b: shared, preload, tasks, channels (verified; independent review PASS)

Full notes: `_scratch/prune/batch9b-log.md`. 29 tests removed, 14 fewer spec files, two files faster. An earlier
agent was cut off mid-batch (account switch); its edits were reviewed against HEAD and partly put back.

- Type specs that build a literal and assert it back: four deleted (their types are checked by `tsc` through real
  code). `knowledge-graph-types.test.ts` 5 → 2 and `remote-fs.types.spec.ts` 4 → 1 keep the tests of `KGEntity`,
  `KGEntityQuery` and `FsErrorData`: nothing else uses those types, so this is their only `tsc` check, and unused
  code is James's decision (added to section 6).
- Table trims (coverage identical): `tool-outcome` 3 exit codes the code never looks at; `usage-normalization`
  `-Infinity` (same `Number.isFinite` check as `Infinity`); `machine-session` 8 origin rows and a repeated null test
  become one loop that also checks each origin is a known reason; `opencode-account-login-command` runs each
  unsupported version once, rotating through the three profiles (24 → 8 real `node` processes, mutation-checked).
- Speed: `background-task-manager` waits for each task's own end event instead of fixed sleeps (2.4 s → 0.14 s,
  mutation-checked); `display-names.guard` reads and parses each file once per run (about 2.9 s → 2.2 s). Five clean
  runs each.
- Not kept: a shared-repository speed-up of `vcs/turn-file-baseline.spec.ts`. That file already fails on the loaded
  Mac at HEAD (the service's own 2 s git limit), so the change could not be shown safe; the lead put the file back.
- Merged verbatim: 15 small preload specs into 5 (no `vi.mock` anywhere in preload, 25 → 25 tests, coverage
  identical); the seven `channel-message-router` restricted-path tests into one `it.each` with every row (each row
  now also checks the refusal message).
- `npm run typecheck:spec` passes; eslint and oxlint clean.

### Batch 6: renderer (verified; independent review PASS)

Full notes: `_scratch/prune/batch6-log.md`. 238 → 209 tests in the 11 touched files, one file fewer. An earlier agent
was cut off mid-batch; its edit-mode tests were reviewed and kept.

- `input-panel-edit-mode.spec.ts` (14 tests of a copy of the logic) is replaced by four tests on the real
  `InputPanelComponent` with real key presses: Up edits the last message only from the start of the box, Escape
  restores the draft, Enter resends (refuses blank text, works while busy), switching session leaves edit mode. Each
  fails when its behaviour is broken (temporary source edits, reverted). 40/40 in 5 runs; coverage of the component
  495 → 545 statements.
- `instance-detail-edit-resend.spec.ts` also tested its own copy; it now calls the real `onResendEdited` (0 → 18
  statements reached). Not break-tested: that component carries another session's staged change.
- Trimmed or merged, each replacing direct method calls with real clicks where it removed tests:
  `verification-results` 46 → 41 (two `toBeTruthy` checks made exact), `verification-dashboard` 59 → 55,
  `tasks-page` 14 → 12 (see below), `provider-quota-settings-tab` 14 → 13, `settings.store` 14 → 13,
  `renderer-error-handler` 9 → 8, `context-size-advice` 17 → 13. Coverage unchanged or higher in each.
- Speed: `history-side-chat-attention` tooltip test on fake timers (about 680 ms → under 380 ms). The tooltip's
  zero-delay open was reached before only by timing luck; it has its own deliberate tests.
- Kept: `context-warning-level` (LT-034); the IPC pass-through tests (wire contract); single checks no other test
  makes. Render-once restructuring (under 1 s, not measurable on the loaded Mac) and the remaining merges not done.
- `npm run typecheck:spec` and eslint pass; oxlint ignores `src/renderer` by its own config.
- Found a real defect (section 7, item 1).
- After review: the removed `tasks-page` "refresh(false)" test was the only check of the background poll's
  argument, but it called the method directly. Replaced by "polls every 4 s without the loading indicator", which
  rebuilds the page on a fake interval clock and checks the poll's store call. It fails when the poll passes `true`
  or when `refresh` ignores its argument (two deliberate breaks, source restored and `git diff` clean); 5 clean
  runs; eslint and `typecheck:spec` pass.

### Batch 10: `instance`, `session`, `history` (verified; independent review PASS)

Full notes: `_scratch/prune/batch10-log.md`. 88 tests removed, 6 fewer spec files, coverage identical for every
exercised source, every trim of a guard mutation-checked.

- Speed: `history-restore-coordinator` "still waits out the window" runs on fake timers and now also checks the
  restore is still pending at 3.9 s (stronger than the old wall-clock lower bound); file 4.1 s → 0.1 s, 6 clean runs.
- Mechanical trims: `instance-spawn-policy` 36 → 25 (13 machine-session reasons all reach `!machineSession`; kept 4,
  plus every inferred-metadata path), `instance-auth-failure-detection` 30 → 23 (a 5-row table repeating the
  documented "check 7" table; every veto keeps a row that matches an auth pattern; the "docker" row matched no
  sign-out pattern and tested nothing, so it now reads "docker: unauthorized: authentication required, please log
  in (401)" and fails when the docker exclusion is removed), `history-restore-helpers`
  28 → 24 (a passthrough to `providerName`, tabled in `display-names.spec.ts`), `should-archive-instance` 1,
  `communication-completion-cost.credits` 1.
- T4 matrices: `runtime-reconciler-account-handoff` 52 → 35 (region only names the target; kept every logical
  provider and failure mode on one region, one row for each other region; effort rows kept where the fixture can
  observe them), `instance-lifecycle-system-prompt-contract` 86 → 45 (style handling reads only the requested
  provider; seven deliberate code breaks each fail a kept row).
- Other tables: `instance-communication-overflow-policy` 1, `instance-system-prompt` 5.
- Merged verbatim (same source, no mocks): `tool-pool-filtering` into `tools/tool-list-filter.spec.ts` (not a
  duplicate as Phase 1 thought: the only test of several deny rules at once); the two resolve-provider specs into new
  `provider-runtime-helpers.spec.ts`; four one- or two-test files into same-source siblings. One merge was undone
  because another session's active plan names the file in its test commands.
- Kept after reading: status-merge, transport-recovery, child-completion, permission-request, history
  reconciliation (privacy) and the continuation tables (each row a separate guard); `stuck-process-detector`.
- `npm run typecheck:spec` passes; oxlint clean; raw eslint errors are all present at HEAD.

### Batch 8: browser gateway, worker-agent, remote-node judgement (verified; independent review PASS)

Full notes: `_scratch/prune/batch8-log.md`. 38 tests removed (773 → 735 in the touched files), 7 fewer spec files,
two slow files about 6.5 s faster each, every trim of a guard mutation-checked.

- `worker-rpc-dispatcher.account-route` 28 → 13: the dispatcher parses `instance.spawn` with Zod first, so most
  region and malformed-route rows end in the same refusal; the full tables still run against
  `materializeWorkerAccountRoute` in `worker-account-route.spec.ts`. Kept the rows that reach the worker's own
  validator, path traversal and the codex-only wire row.
- Table trims: `browser-approval-reason` 3, `rpc-schemas` 6 (seven registry tests into one table with all 14 rows),
  `browser-extension-assets` 5 (window-bounds rows; each kept row caught a deliberate break), `worker-node-exec-policy`
  2, `browser-one-time-code-field-probe` 2.
- Merged: `reconnect-backoff` `.test` into `.spec` (three repeats dropped); `server-lifecycle` `.test` into `.spec`
  (two repeats dropped); six platform service tests into `service-definition-files.test.ts` and
  `service-managers.test.ts` (verbatim, no mocks). `__tests__/capability-reporter.spec.ts` (2 tests) into
  `capability-reporter.spec.ts` despite different mocks, on purpose: it ran the real OpenCode CLI and probed this
  Mac's local AI services on every run, and once timed out a full run (27 October). The moved tests are now
  self-contained. Four lines it reached only through this Mac's real accounts (advertising the OpenCode major
  version and MiMo account ids) now have four mocked tests that assert the advertised values; each fails under a
  deliberate break, and coverage of `capability-reporter.ts` matches HEAD.
- Speed: `remote-claude-failed-cost` runs the adapter's 3 s close deadline on fake timers (6.6-7.0 s → 0.1-0.3 s);
  `browser-gateway-reload-no-effect` uses the file's own fake-clock pattern for three busy-poll waits
  (6.1-6.7 s → 0.1-0.6 s). First attempts at both lost coverage and were replaced; final coverage matches HEAD, and
  one deadline line that was reached only by chance is now reached every time and fails when removed.
- Kept, findings wrong: config-update forwarding tests (each the only guard of its line), the 14 press_key rows (each
  the only check of its key), `desktop-app-policy` (safety guard; trimming needs a second hand-picked list).
- Five clean runs per file; `npm run typecheck:spec` passes; eslint and oxlint findings are all present at HEAD.

### Batch 11, Git part: template repositories and coordinator split (verified; awaiting independent review)

Full notes: `_scratch/prune/batch11-git-log.md`; evidence in `_scratch/prune/b11g/`. No test removed, every
assertion unchanged, no production code changed. An earlier agent was cut off twice (usage limit, session restart);
its edits were reviewed and finished.

- New helper `src/main/workspace/git/git-repo-template.test-helpers.ts`: one committed repository built per file and
  copied per test, so each test still has its own. 18 specs adopted (15 Plan Queue, `campaign-worktree-landing`,
  `loop-worktree-lifecycle-reconcile`, `loop-convergence-cost-safety.integration`). Set-up per test 212 ms → 32 ms;
  lighter files roughly halved, the heaviest vary more with load than they gain.
- `plan-queue-coordinator.spec.ts` split into five files (`-recovery`, `-operator`, `-landing`, `-routing` and the
  rest), moved word for word with shared `plan-queue-coordinator.test-helpers.ts` and `.test-mocks.ts`; the only
  edits are 43 assignments turned into setter calls (a module cannot assign another module's variable); all 752
  `expect(` lines identical. Wall time 651 s → 259 s on the Mac, no file over 166 s. The 13 waits still on the 1 s
  default now get 15 s: the unsplit file failed once on one of them, the split never did.
- 725/725 in 5 runs plus one shuffled. Coverage: nothing lost in Plan Queue or Git sources; one loop-coordinator
  failure path is reached by chance in either version.
- 19 temporary timing copies (`*.b11ghead.spec.ts`, `plan-queue-coordinator.b11gbase.spec.ts`) went into James's
  "October updates" commit (`2924bfbab`), which took the whole working tree; they are deleted in the working tree,
  and the deletion still needs committing (otherwise about 725 duplicate tests run).

### Batch 11, database part: migrate once per file (verified; awaiting independent review)

Full notes: `_scratch/prune/batch11-db-log.md`; changed files in `_scratch/prune/b11d/changed.txt`. No test removed,
no test body or assertion changed, no production code changed.

- Measured first: a full RLM migration costs about 65 ms per test on the PC (112 ms on the loaded Mac); copying a
  migrated template costs 1.5 ms. Loop-schema databases (about 12 ms per test, about 3 s in all, mostly Plan Queue)
  were left out.
- New helper `src/main/db/sqlite-template.test-helpers.ts`: migrates once per file and gives each test its own
  fresh in-memory copy at the point where it used to build one; the template is only read. Checked per file for
  what a copy could change (two migration-time clock values, the driver wrapper versus the plain test driver, tests
  that change their own schema): none is relied on in the 59 adopted files.
- 59 spec files: summed test time about 84 s less on the Mac (expected about 56 s on the PC, about 7 s of wall
  time). HEAD and edited back to back, 5 rounds plus one shuffled: medians 102.5 s → 18.1 s.
- Put back to HEAD: `automation-check-retry-integration` and `automation-start-stats.integration`, which timed out
  at 5 s under load at HEAD (23 failures) as often as edited (24), so no safety could be shown (section 7, item 7).
  Left out on purpose: `thread-wakeup-start-stats` (needs a production change), `claude-cost-reconcile-handlers`
  (could depend on a migration-time clock value), the migration specs, about 50 small files.
- Coverage: no net loss (the driver wrapper's statement cache is still covered by two unchanged specs). 922 tests
  pass; `typecheck:spec` and oxlint pass; raw eslint errors are all present at HEAD.

### Batch 12: ACP consent integration tables (James approved 10 November 2026; verified, awaiting review)

Full notes: `_scratch/prune/batch12-log.md`. `acp-permission-consent.integration.spec.ts` 131 → 39 tests, about
8.8 s → 2.7 s. The unit spec `acp-permission-outcome.spec.ts` keeps every row and gains one.

- Nothing between the card and `selectAcpPermissionOutcome` changes the input (replies sent as typed, a click sends
  the option id, Cancel one space; IPC handler, schema and adapter pass text and options through). A scratch script
  ran every original row through the real function with both option sets and tagged the `return` it hit: each of
  the 92 removed rows has a unit row with the same input, outcome and return line (pairs in the log).
- Kept per table: each outcome (grant once, grant always, refuse) and input shape end to end, plus the one row that
  is not a duplicate (`Allow once` on a lasting option reaches the "once wording on a lasting label" check, which
  the unit spec's row never did).
- New unit test "never grants a lasting option from its own one-time label" closes that gap: it is the only unit
  test that fails when the check (`acp-permission-outcome.ts:82`) is removed.
- Twelve deliberate breaks (six in the decision function, six in the card, adapter and registry) each fail a kept
  row; sources back to HEAD after each. Coverage of the seven sources from both specs together unchanged.
  39/39 five times; 153/153 with the unit spec; `typecheck:spec`, eslint and oxlint clean.

### Checks after Batches 3 to 10 (10 November 2026)

- Net change this round: 252 tests and 47 spec files fewer (Batch 3 −5, 5 −20, 6 −29, 7 0, 8 −34, 9a −47, 9b −29,
  10 −88).
- `npm run checks`: all seven pass on the Windows PC (`_scratch/prune/final-checks.out`).
- Full suite, `npm run test:quiet` on the Windows PC: 3,676 files, **46,738 tests passed**, 0 failed, 7 m 33 s wall
  (`_scratch/prune/final-full.out`). Tests' own time summed over files: about 1,133 s, against 1,440 s on the
  9 November report. Wall time on the shared PC is noisy and did not fall with it.
- Whole plan so far: 47,894 → 46,738 tests (−1,156) and 3,723 → 3,676 spec files.
- After the independent review one test was added to `tasks-page` (Batch 6 note), so the tree holds one more test
  than that run (net this round −251).

### Decisions taken while reading later batches

- Batch 3 (`orchestration` judgement): read `evidence-resolver.spec.ts` in full. The flagged near-duplicates sit in
  the "agent-cannot-self-declare invariant" block or differ by candidate type, and save about a millisecond each.
  Keep. The remaining Batch 3 value is the small-file merges (about 30 files), which save worker start-up only.
- Batch 9: `automation-cadence.spec.ts` (22 s) is the T10 equivalence check between the fast and the legacy
  `estimateDailyRuns` around real 2026 clock changes. The area reviewer's suggested trim would have dropped hourly
  schedules, which are exactly the ones a 23- or 25-hour day changes. Keep whole; its cost is the legacy walk itself.
- Batch 6: `input-panel-edit-mode.spec.ts` (14 tests) re-implements the composer's edit-mode logic inside the spec
  and never touches `InputPanelComponent`, so it protects nothing. The real behaviour (Up arrow edits the last
  message, Escape restores the draft, instance switch resets) is only partly covered in
  `input-panel.component.spec.ts`. Replace it with real component tests in Batch 6 rather than just deleting it.
- Biggest remaining time savings, in order: Batch 7 (`remote-run.linux` 64 s and `run-tests-quiet-remote` 29 s;
  both are Mac-only specs, so they run on this Mac after every remote full run and lengthen it directly), Batch 11
  (shared Git and migrated-database templates, 90 to 150 s across about 130 files), Batch 5 (one shared worker
  per spawn-worker spec, 35 to 50 s).
- Batch 11 detail: per-test database set-up (`createTables` + `createMigrationsTable` + `runMigrations` on a fresh
  in-memory database) appears in 152 spec files. The driver has no serialize/open-from-buffer, so a shared template
  needs either a file copy per test or a small test-only driver helper; measure the per-test cost properly first.
  Expected real-run gain is modest (about 10 s of wall time over 8 workers).
- 10 November 00:03: something outside this session staged 148 paths in the repository's index, including this
  work's files; the other live Harness session confirmed it was not them. This session unstaged its own files
  (working tree unchanged) and, in `plan-queue-coordinator.spec.ts`, left only the other session's two
  "queue spend reductions" hunks staged. Everything else staged was left as found.
- Batch 7 detail: every `remote-run.linux.spec.ts` test takes about 2 s even when trivial, because
  `scripts/remote-checks/remote-run.sh` itself waits (`sleep 1` after each run for the log tail at line 391, a 2 s
  slot poll at line 312, a 10 s grace on stop at line 372). Shortening those needs a change to the script (for
  example an environment override used only by its tests), which is outside "tests only": ask James. Test-side
  options without that: build each fake machine and snapshot once per file instead of per test.

## 6. Code that nothing reaches (James decides; nothing deleted)

Checked by searching for importers outside tests, docs and scratch (`rg`, including scripts and resources).

| Source | Tests | Note |
| --- | ---: | --- |
| `src/main/browser-gateway/browser-procurement-review.ts` | 7 | reviewer gate designed but never wired in |
| `src/main/context-evidence/context-evidence-diagnostics.ts` | 5 | |
| `src/main/context-evidence/execution-receipt-linker.ts` | 4 | |
| `src/main/memory/hybrid-recall-fusion.ts` | 9 | |
| `src/main/memory/retrieval-eval/memory-instruction-gate.ts` | 7 | a default-on setting exists with no caller: lost wiring? |
| `src/main/core/system/provider-quota/claude-auth-refresh-readiness.ts` | 13 | completed plan `2026-10-05-claude-auth-darkwake` says `claude-credentials-reader.ts` uses it; it does not: lost wiring? |
| `src/main/tools/tool-rw-lock.ts` | 4 | |
| `src/main/communication/priority-queue.ts` | 13 | |
| `src/main/orchestration/loop-health-model.ts` | 11 | marked "NOT WIRED" on purpose, parked |
| `src/main/orchestration/loop-liveness-probe-policy.ts` | 8 | marked "NOT WIRED" on purpose, parked |
| `src/main/cli/adapters/base-cli-adapter.ts` `tagResponseIfEnabled` | 12 | method with no caller |
| `src/renderer/app/shared/menu/*` | 24 | only a comment refers to it |
| `src/renderer/.../reviewer-model-options.ts`, `cost-estimator.component.ts` | 2 files | no importer |
| `KGEntity`, `KGEntityQuery` (knowledge-graph types), `FsErrorData` (remote-fs types) | 3 | types no file uses (Batch 9b) |

## 7. Found while pruning (fixed 10 November 2026 at James's request unless noted)

1. **Fixed: a typed draft was lost after editing the last message and pressing Escape.** Typing in edit mode saved
   the edited text as the draft (`input-panel.component.ts:1027`, `:1854`); the draft-sync effect (`:883-902`) then
   reloaded it after `cancelEditMode` restored the stash. `persistComposerText` now saves nothing while edit mode is
   on (`:1855-1858`). Two new tests on the real composer (Escape restores box and saved draft; switching session
   while editing keeps the original draft) failed before the fix and pass after; 12 composer specs pass. Not tried
   in the running app (manual steps: `_scratch/prune/fix-1-log.md`).
2. **Fixed: quitting waited 3 s once the spawn worker had started.** `shutdown()` slept its full grace before
   answering; quit awaits that answer within a 3 s step budget (`index.ts:169`), so the step timed out on every
   quit. Only reached with the default-off `enableSpawnWorkerOffload` setting and a started Gemini session. Now it
   SIGTERMs each child and answers as soon as all have closed (at once with none), still SIGKILLing survivors
   after the grace (`cli-spawn-worker-main.ts:244-262`). New `cli-spawn-worker-main.spec.ts` (3 tests; two failed
   at about 3,000 ms on HEAD). The Batch 5 test helper that worked around it is deleted. Quit time in the running
   app not measured (`_scratch/prune/fix-2-log.md`).
3. **Fixed: cancelling a running background task whose work then threw ended it as failed, with no cancel
   event.** A timeout wrote into the same cancel record, so the code could not tell them apart. Timeouts now have
   their own record; a user's cancel ends the task cancelled with exactly one event whether the work throws or
   returns; a timeout still ends failed with its message (new test). The old "emits task-cancelled only once" test
   now asserts exactly one cancel event and the final status, and failed on the old code
   (`_scratch/prune/fix-3-log.md`). Noted, not changed: cancelling a task that never started leaves its cancel
   record behind; no current path reuses the id.
4. **Fixed: timing-dependent tests that failed on a loaded Mac at HEAD** (`_scratch/prune/fix-4-log.md`).
   - `vcs/turn-file-baseline.spec.ts`: the failures came from the service's 300 ms send wait, not the 2 s git
     limit. The 300 ms cap is deliberate (a send is never held longer; a miss shows "unavailable", not a wrong
     count), so the app's timings are unchanged; the service now takes its limits as an optional constructor
     argument and most tests use long ones, the limit tests the app's. With git slowed by 60 ms per call, HEAD
     failed 15 of 36 and the fixed spec passed. Open for James: one slow snapshot hides that folder's change counts
     for 5 minutes.
   - `codemem/__tests__/code-retrieval-load.spec.ts`: `stop()` takes 0 ms; the slow clean-up was deleting 3,500
     files. The default spec keeps every functional check on a smaller workspace; the 500 ms real-clock ceiling
     moved to `soak.spec.ts`, which CI's slow-test job runs.
   - The incident replay's 30 s budget passes under load since Batch 9a's single replay.
5. **Fixed: the OpenCode login refusal looked like a crash.** The generated script now prints one line and exits 1
   instead of throwing (no stack dump of the one-line script in the user's terminal). Every route refuses before
   starting anything; the spec's check fails if the refusal becomes a crash again (all 21 refusal tests). Commands
   grow 40 characters; the worst default is about 8,074 with the Windows wrapper, under cmd.exe's 8,191. Open for
   James, already true at HEAD: a pinned OpenCode 1.x choice with a 220-character Windows path makes an 8,271
   character command, over that limit.
6. **Fixed for the future: orphaned test fixture processes.** Fixtures in the three worker-agent specs now exit
   within about 0.9 s once their test process is gone (`exitOnceProcessGone` in `src/tests/fixtures/process-fixture.ts`,
   regression test in `process-fixture.spec.ts`); HEAD's were still alive after 10 s. Three `ps`-dependent tests
   skip in agent sessions and run in the full suite. The 89 old idle processes are still on the Mac and this
   session may not stop them: clear with `pkill -f 'late success|aio-node-exec-tree|aio-node-exec-policy'` from a
   normal Terminal.
7. **Fixed: two automation specs timed out at 5 s on a loaded Mac** (`automation-check-retry-integration`,
   `automation-start-stats.integration`; 23 failures in 5 rounds at HEAD). Not the machine load (only read at
   workload levels 1 and 2; these run at 3): every check ran as `$SHELL -lc` (`automation-pre-check.ts:149`), i.e.
   James's full zsh login profile with `brew shellenv`, about 10 times slower to start than a plain shell. With a
   `SHELL` that waits 5.5 s, HEAD failed 14 of 19 (exactly the tests that run a check). Both specs now run checks
   through `/bin/sh -c`; hashing, baseline comparison and run notes still use the real code, and the login-shell
   path keeps its own tests. 5 runs plus one shuffled, slowest test 988 ms (`_scratch/prune/fix-7-log.md`).
