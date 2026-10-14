# Live-test campaign defects (LT-664 to LT-702) — remediation plan

**Status — 2026-10-14:** implementation and focused verification are ready for the
independent Plan Queue verifier. The prior implementation (parked branch
`queue/2026-10-05-livetest-campaign-d-c9429d`) has been ported into the current Plan Queue
worktree `queue/2026-10-05-livetest-campaign-d-9b7ea8` and re-verified on that base, including
a fresh re-verification after the item's 16:06 `land-blocked` resume. That block was not an
implementation failure: the promoter refused to fast-forward because the root checkout held
uncommitted register edits on a promoted path, and those edits are committed to `main` now
(the root is clean on every path this work promotes). All 17
code items have passing regressions. The full suite and fresh-context completion gate remain
the verifier's responsibility; 16 real-runtime acceptance checks are deferred to
[the live-test document](2026-10-05-livetest-campaign-defects_livetest.md).
This plan remains active and untracked; only the coordinator may close it after PASS.
Created 2026-10-05 from the 2026-10-04 live-test campaign. This is the
active follow-up record for the new defects; the historical
[remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is closed and was
not edited.

**Source of truth for each defect:** its entry in
[the remediation register](livetest-remediation-register.md) (observed behaviour, root cause,
required behaviour, acceptance). This plan only orders the work and records implementation status.
Fix nothing from this list without first reproducing it with the smallest focused test, per the
register's operating rules. The register's "Current status corrections — 2026-10-14" section now
records the 17 items as fixed + regression-tested with live re-checks pending.

## Order of work

Priority first, then shared-file grouping so related fixes land together.

| # | Item | Priority | Area | Owning live test to re-run |
| --- | --- | --- | --- | --- |
| 1 | LT-670 | P1 | Respawn watchdog terminates sessions waiting out a circuit-breaker backoff | [Crash-turn auto-continue LT-C](2026-09-28-crash-turn-auto-continue_livetest.md) |
| 2 | LT-702 | P1 | Ping-pong round hangs with a finished reviewer verdict | [Ping-pong](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md) (closed; LT-702 acceptance only) |
| 3 | LT-665 | P2 | `check_session` treats an unreadable page as logged out and re-logs in | [Login recipe check 1](2026-09-23-browser-login-recipe-persistence_livetest.md) |
| 4 | LT-680 | P2 | Message sent into a Codex goal turn loses its reply; session reads idle | [Codex compaction reliability check 4](2026-09-27-codex-compaction-reliability_livetest.md) |
| 5 | LT-690 | P2 | OpenCode output-ceiling ending classified as an ordinary completion | [Provider hardening check 1](2026-10-02-provider-hardening_livetest.md) |
| 6 | LT-671 | P2 | Crash continuation skipped after a fresh-session replay | [Crash-turn auto-continue LT-A](2026-09-28-crash-turn-auto-continue_livetest.md) |
| 7 | LT-673 | P2 | Renderer reload leaves the session list empty (resync before auth token) | [Session title quality](2026-09-30-session-title-quality_livetest.md) |
| 8 | LT-700 | P2 | Plan Queue verifier spawned before the tools socket listens after restart | [Plan Queue check 3](2026-09-18-plan-queue_livetest.md) |
| 9 | LT-701 | P2 | Normal quit parks mid-turn Plan Queue items and completes the run | [Plan Queue check 3](2026-09-18-plan-queue_livetest.md) |
| 10 | LT-666 | P3 | Page-specific login markers make a recipe unrecoverable | [Login recipe checks 1–2](2026-09-23-browser-login-recipe-persistence_livetest.md) |
| 11 | LT-664 | P3 | Retired Local AI target's incidents never close | [Local AI CLI parity check 1](2026-10-04-local-ai-cli-parity_livetest.md) |
| 12 | LT-672 | P3 | User Stop posts "provider ended this turn with an error" | [Crash-turn auto-continue LT-B](2026-09-28-crash-turn-auto-continue_livetest.md) |
| 13 | LT-674 | P3 | Errored resident Claude turn's completion dropped after adapter teardown | [Outstanding plans sweep check 3](2026-09-23-outstanding-plans-sweep_livetest.md) |
| 14 | LT-675 | P3 | Signed-out Claude CLI banner accepted as an AI title | [Session title quality](2026-09-30-session-title-quality_livetest.md) |
| 15 | LT-681 | P3 | Codex Compact now shows a fabricated ~0% meter | [Codex compaction visibility check 3](2026-09-24-codex-compaction-turn-visibility_livetest.md) |
| 16 | LT-683 | P3 | A Codex goal turn starting 7 ms after the last was not followed (seen once) | [Codex compaction reliability check 1](2026-09-27-codex-compaction-reliability_livetest.md) |
| 17 | LT-682 | P3 | Interrupt tooltip says "Interrupt Claude" on every provider | — (cosmetic) |

## Decisions

Recorded 2026-10-05 (James):

- Stranded-worktree rescue LT-5 (on-screen spend meter): **dropped**. The meter stays hidden.
- Grok catalog live test, "Grok 4.6 still listed": **dropped**. That document is now closed.
- Agent-runtime residual AR-007 (ACP no-output terminal failure): **dropped**.

- Ping-pong **Skip round does not use up a round** (keep current behaviour; no code change).
  James delegated the call and accepted the recommendation. Reason: `maxRounds` caps paid
  reviewer rounds; a skipped round spawns no reviewer and costs nothing, so counting it would only
  exhaust the review budget and could push a loop to arbitration with fewer real reviews. Each skip
  needs a fresh operator click and the loop's other caps still apply, so it cannot run away. The
  early return in `loop-pingpong-completion.ts` (skip branch, before the cost backstop) already
  leaves `roundCount` unchanged.

## Implementation status — 2026-10-06 (historical)

Updated 2026-10-06. No commit. Live re-checks in the owning `*_livetest.md` files were not run:
they need a rebuilt app, a restart, a person, or an external machine, and this session did not
restart or drive the local Harness UI. Those files stay `*_livetest.md`.

Regression tests below pass with the fixes. A fresh red run before each fix was not repeated in
this session for items that were already implemented when the session resumed.

| Item | Regression test | Live re-check |
| --- | --- | --- |
| LT-670 | `instance-respawn-watchdog.spec.ts` | 2026-10-06 dev app: a Codex session sat in circuit-breaker backoff (attempts 3 and 4) and was not terminated; both waits ended in the expected next state |
| LT-702 | `instance-settled-tracker.spec.ts` | not run |
| LT-665 | `browser-session-relogin.spec.ts` | not run |
| LT-680 | `codex-cli-adapter.provider-turns.spec.ts` | not run |
| LT-690 | `turn-ending-classifier.spec.ts` | not run |
| LT-671 | `instance-continuation-dispatch.spec.ts` | not run |
| LT-673 | `instance-list.store.spec.ts` | 2026-10-06 dev app: reload kept the session in `listInstances`, `stateResync`, and the rail |
| LT-700 | `plan-queue-coordinator.spec.ts` (defers the recovered verifier until the tools waiter resolves) | not run |
| LT-701 | `plan-queue-instance-tracker.spec.ts` | not run |
| LT-666 | `browser-session-relogin.spec.ts` (no password field) and `browser-remember-login-fingerprint.spec.ts` (markers must be on the live page) | not run |
| LT-664 | `local-ai-incident-retirement.spec.ts` | not run. Startup also resolves incidents for targets that are already retired, which is how `51c88683-…` clears on the next launch. |
| LT-672 | `turn-ending-classifier.spec.ts` | 2026-10-06 dev app: Stop on a busy Codex turn returned to idle with interrupt notices only |
| LT-674 | `instance-communication.spec.ts` (errored completion recorded before cleanup deletes the adapter) | not run |
| LT-675 | `auto-title-service.spec.ts` (Claude and Codex sign-in banners are rejected and the next provider is tried) | not run |
| LT-681 | `compaction-runtime.spec.ts` | 2026-10-06 dev app: manual Codex compact kept 23.6% as `awaiting-post-compaction-usage`, estimated, not 0% |
| LT-683 | `codex-cli-adapter.provider-turns.spec.ts` | not run |
| LT-682 | `instance-header.component.spec.ts` | 2026-10-06 dev app: busy Codex button title was `Interrupt Codex (Esc)` |

Gates run on 2026-10-06, all passed: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and `npm run test:quiet` (2375 files, 29910 passed, 6 skipped). The first full-suite run failed 6 tests in `local-ai-runtime.spec.ts` because startup incident cleanup called `targets.list` on test doubles that did not provide it. Those doubles now return an empty list. A fresh-eyes completion review has not been run.

## Queue worker as-built notes — 2026-10-13

Worktree: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-05-livetest-campaign-d-c9429d`.
Branch: `queue/2026-10-05-livetest-campaign-d-c9429d`. No commits, stashes,
branch switches, worktree creation or app restarts were performed.
This root-checkout plan was never copied into the worktree. There is no separate
linked specification; the register's 17 acceptance sections are the specification.

### Investigation and implementation decisions

The fixes named in the historical table were already present in the supplied
checkout. A cache-disabled run of its 15 named regression files passed 873 tests.
The worker retained those implementations and investigated the register's required
behaviour rather than treating the old green report as proof of complete coverage.

Four acceptance gaps remained and were repaired:

1. **LT-665 / LT-666:** missing fingerprint markers alone now produce
   `unknown / fingerprint_markers_missing`, so page-specific markers cannot navigate
   a signed-in tab to login. A password field or login-shaped URL remains a positive
   logged-out signal. Failed post-login observations return `unknown` with the
   specific reason and stop further credential attempts. An unreadable login-form
   query also stops immediately. The existing secret-observation escalation remains
   intact; a readable login URL without a password field retains the recipe-specific
   diagnostic. Four new regressions failed before these changes and passed afterwards.
   Existing sentinel/timeout expectations were updated only after that behavior passed.
2. **LT-671:** a refused crash-continuation reservation after recovery now writes a
   metadata-only warning containing instance ID, request count, state and wait kind.
   Existing fresh-replay admission remains in the shared dispatcher. A new regression
   failed for the silent refusal and passed after the logging change.
3. **LT-701:** shutdown suppresses failure and settlement outcomes at their common
   tracker boundaries, covering provider error/exit, removal and late completion in
   addition to the earlier status-only guard. Queue shutdown is signalled before
   synchronous provider kills as well as before async instance termination. Four
   new regressions failed before the tracker change and passed afterwards. Normal
   non-shutdown failures continue to be covered by the existing tracker tests.
4. **LT-664:** target updates and retired-target incident resolution now share the
   repository's SQLite transaction, before lifecycle observers run. This covers
   Settings/IPC repository callers as well as the public CLI path. A database trigger
   that aborts incident resolution proves retirement rolls back and observers see no
   partial change. Two new regressions failed before the change and passed afterwards.
   The startup-cleanup fixture explicitly recreates a legacy stale incident after
   retirement so that it still tests cleanup of already-retired targets.

Ruling: retain the supplied implementations for the other items; their named focused
regressions pass and no additional acceptance gap was established. This avoids
rewriting fixes already in the base checkout. Real-provider/runtime acceptance is
not inferred from those tests.

### Per-item implementation checklist

- [x] LT-670 — backoff-aware watchdog regression passes.
- [x] LT-702 — interval re-evaluation of the settled predicate passes.
- [x] LT-665 — unreadable snapshots/queries and ambiguous marker evidence never trigger re-login; post-login observation failures stop retries.
- [x] LT-680 — accepted Codex steer keeps capture open through real completion.
- [x] LT-690 — injected-cap saturation fallback and ordinary-completion negative cases pass.
- [x] LT-671 — stale fresh-replay wait admission and refused-reservation logging pass.
- [x] LT-673 — auth-ready resync retry and persistent-failure loading/error handling pass.
- [x] LT-700 — recovered verifier spawn waits for orchestrator-tools readiness.
- [x] LT-701 — normal shutdown preserves tracking across status/error/exit/removal/completion paths.
- [x] LT-666 — live-marker validation and readable no-password login-form guard pass.
- [x] LT-664 — transactional retirement, rollback, status exclusion and legacy startup cleanup pass.
- [x] LT-672 — interrupted Claude-result classification is client cancellation.
- [x] LT-674 — errored completion capture/cost/hook processing precedes adapter cleanup.
- [x] LT-675 — Claude/Codex auth banners are rejected and title escalation continues.
- [x] LT-681 — missing native post-compaction usage retains the measured occupancy as estimated.
- [x] LT-683 — overlapping native provider turns are followed without an early idle edge.
- [x] LT-682 — provider-specific interrupt tooltip component regression passes; no live deferral required by acceptance.

### Current worker verification

All commands ran in the supplied worktree and exited 0:

- Cache-disabled focused run: **23 files, 990 tests passed**, 91.7 s. It includes
  every regression in the historical table plus sentinel, continuation detector,
  Local AI repository/public/management/runtime/IPC callers and shutdown operations.
- `npx tsc --noEmit` and `npm run typecheck:spec`.
- `npm run lint` and `npm run check:ts-max-loc` (ratchet passes with existing tolerated legacy warnings).
- `npm run build:main` and `npm run build:renderer`.
- `npm run generate:aliases` and `npm run generate:ipc` (no generated-file drift).
- `npm run verify:ipc`, `npm run check:contracts` and `npm run verify:exports`.
- `git diff --check`.

The worker performed a separate diff review of transaction ordering/rollback,
observer timing, shutdown event paths, login uncertainty/credential side effects,
metadata-only logging and test integrity. No unresolved self-review finding remains.
This does not substitute for the coordinator's independent fresh-context gate.

Full test suite: **not run**, per the explicit Plan Queue worker instruction.
Independent verifier: **pending**. Live acceptance: **deferred**, exact steps,
expected results and execution prerequisites are in
[2026-10-05-livetest-campaign-defects_livetest.md](2026-10-05-livetest-campaign-defects_livetest.md).

Command output, red/green evidence and final full Vitest output are retained at
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/lt-2026-10-13/campaign-defects/`.
The final focused-run log records its complete command and test count. The
11 newly reproduced failing assertions belong to the existing four acceptance
items above, so no new LT number or historical completed-plan edit was made.

> Plan Queue parked work: `queue/2026-10-05-livetest-campaign-d-c9429d` — 1 commit(s), reason: land-blocked.

## Queue worker as-built notes — 2026-10-14 (port to `queue/2026-10-05-livetest-campaign-d-9b7ea8`)

Worktree: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-05-livetest-campaign-d-9b7ea8`.
Branch: `queue/2026-10-05-livetest-campaign-d-9b7ea8`, cut from `main` at `bed58972c`. No commits,
stashes, branch switches, worktree creation or app restarts were performed. This root-checkout
plan was never copied into the worktree. There is no separate linked specification; the register's
acceptance sections are the specification.

### Port

The parked branch's single checkpoint commit (`7b508cfc8`, 11 files) was applied verbatim to this
worktree and reconciled with the as-built notes above; nothing was reimplemented. The handover's
alternative `git diff $(git merge-base HEAD main) <parked-branch> | git apply` was deliberately not
used: `main` advanced six commits past the parked base after the handover was written, so that
range would also have reverted newer `main` work. Only the checkpoint commit's own diff was
applied. It merged cleanly with the new base, including `src/main/index.ts`, where `main` already
shut the queue down in the async `terminateInstances` phase and the port adds the sync-phase call
in `killActiveProcessesSync` — both call sites are intended (shutdown signalled before synchronous
provider kills as well as before async instance termination). `getPlanQueueCoordinator` was
already imported there.

Full-file review of the ported implementation against the new base found no incoherence:
`browser-session-relogin.ts` / `browser-session-sentinel.ts` (missing markers `unknown`, positive
logged-out signals retained, post-login observation failures and unreadable login forms stop
retries), `instance-reasoning-collapse-continuation.ts` (metadata-only warning on refused crash
reservation), `local-ai-target-repository.ts` + `local-ai-incident-retirement.ts` (transactional
retirement; `import type` only back to the target repository, so no runtime import cycle),
`plan-queue-instance-tracker.ts` (shutdown suppression at `fail`/`settle`), and the shutdown
wiring in `index.ts`. The per-item checklist contained no unchecked items after the prior worker,
so this session's code work was the port itself.

### Register

The shared register (edited in the worktree, tracked like code) gained a
"Current status corrections — 2026-10-14" section covering all 17 items as
FIXED + REGRESSION-TESTED 2026-10-14 (working tree), each with its live re-check pointer into the
campaign livetest (LT-682 needs none; LT-670/LT-672/LT-673/LT-681/LT-682 also carry their
2026-10-06 dev-app re-check notes). This follows the register's documented convention that dated
corrections supersede the index-row status phrases. No new LT numbers: the port reproduced no new
defects, and the historical completed remediation plan was not edited.

### Verification in this worktree (all exit 0)

- Cache-disabled focused run of the same 23 regression files as the parked run: **1014 tests
  passed** (173.5 s). The count exceeds the parked run's 990 because `main` added tests to these
  files in the meantime; the parked assertion set is a subset and all of it passes against the
  ported code.
- `npx tsc --noEmit` and `npm run typecheck:spec`.
- `npm run lint` and `npm run check:ts-max-loc` (ratchet passes with existing tolerated legacy
  warnings).
- `npm run build:main` and `npm run build:renderer`.
- `npm run generate:aliases` and `npm run generate:ipc`; `git status` shows only the 11 ported
  source files plus the register correction above, so generated files are current with no drift.
- `npm run verify:ipc`, `npm run check:contracts` and `npm run verify:exports`.
- `git diff --check` clean.

Logs: `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/lt-2026-10-14/campaign-defects-port/`
(focused-tests.log records the full command and count). The prior worker's red/green evidence
remains at `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/lt-2026-10-13/campaign-defects/`.
No runtime was created that needed deletion: `node_modules` pre-existed in the worktree, and no
database cluster, browser binary or copied source tree was created.

Full test suite: **not run**, per the explicit Plan Queue worker instruction.
Independent verifier: **pending**. Live acceptance: **deferred**, unchanged — exact steps,
expected results and execution prerequisites remain in
[2026-10-05-livetest-campaign-defects_livetest.md](2026-10-05-livetest-campaign-defects_livetest.md).

> Plan Queue parked work: `queue/2026-10-05-livetest-campaign-d-9b7ea8` — 2 commit(s), reason: land-blocked.

## Queue worker as-built notes — 2026-10-14 (resume after `land-blocked`)

James resumed the parked item at 16:11; this session was spawned with the resume prompt into the
same worktree `queue/2026-10-05-livetest-campaign-d-9b7ea8`. No commits, stashes, branch switches,
worktree creation or app restarts were performed. This root-checkout plan was never copied into
the worktree. The per-item checklist was already complete (17/17) when the session resumed, so
the code work here was investigation, a register coherence note, and fresh re-verification —
nothing was reimplemented.

### Why the item was parked, and why landing can proceed now

- The queue log records the block exactly (app.log 2026-10-14 16:06:21, `PlanQueueLanding`):
  `root checkout has uncommitted changes to a promoted path: docs/plans/livetest-remediation-register.md`.
  The landing commit promotes this branch's register correction section; the promoter's
  `block-overlap` policy refuses to fast-forward over a dirty root path the landing touches, so
  a half-finished register edit in the ROOT checkout stopped the promotion. This is the same
  mechanism as the earlier `c9429d` park (`src/main/index.ts` dirty at 2026-10-13 13:31), and
  both causes are gone: the root's register edits were committed to `main` at 16:09:56 as
  `69b51a9e6`, and a 2026-10-14 check shows all 12 promoted paths clean in the root (the root
  keeps 117 unrelated dirty paths, none overlapping this work).
- Residual landing risk to know about: if `docs/plans/livetest-remediation-register.md` (or any
  other promoted path) is edited in the root checkout again before promotion, landing re-blocks
  by design. Land after that edit is committed.
- Landing will bring `main` (now `69b51a9e6`) into the branch first. `git merge-tree` of that
  merge reports **0 conflicts**; the merged register keeps this branch's corrections section and
  `main`'s newer LT-665 detail and LT-703–705 entries side by side. The run's post-merge gate is
  `npx tsc --noEmit` + `npm run typecheck:spec`, both re-run green below.

### Scope check against `main`'s newer register content

- `main`'s LT-665 detail gained (2026-10-11 restored-tab reproduction) an extension-side
  inventory-stamp fix and an acceptance bullet for it. That half is already in the codebase —
  landed on `main` in the 2026-10-13 "october improvements" commit, not pending in any working
  tree: `browser-target-inspection.ts` maps `host_permission_denied` / `page_text_read_failed`
  to `inspection_unavailable` even when an older extension stamped `readable`,
  `buildTabPayloadLocked` in `resources/browser-extension/background.js` stamps the same, and
  `browser-target-inspection.spec.ts`, `browser-extension-tab-store.spec.ts` ("does not keep a
  host-permission failure as a readable target") and `browser-extension-assets.spec.ts` cover
  it. There was nothing to implement for it here, so the checklist stays 17/17 with no hidden
  gap: the new bullet is satisfied by base code with its own regressions, not by this plan's
  diff.
- The shared register's LT-665/666 corrections row now carries a scope note saying exactly that,
  so a diff-scoped reviewer cannot mistake the separately landed inventory-stamp half for a gap
  in this work. Both halves' live confirmation still needs the fixed extension (≥0.2.39; the
  tree ships 0.2.40) on `windows-pc`.
- LT-703–705 belong to other plans (per `main`'s register header) and stayed out of scope.

### Fresh verification on the resumed worktree (all exit 0)

- Cache-disabled focused run of the same 23 regression files as the earlier runs: **1014 tests
  passed** (121.6 s).
- `npx tsc --noEmit` and `npm run typecheck:spec` (the exact post-merge gate).
- `npm run lint` and `npm run check:ts-max-loc` (ratchet passes with the existing tolerated
  legacy warnings).
- `npm run build:main` and `npm run build:renderer`.
- `npm run generate:aliases` and `npm run generate:ipc`; `git status` stays clean, so generated
  files are current with no drift (the only working-tree change from this session is the
  register scope note above).
- `npm run verify:ipc`, `npm run check:contracts` and `npm run verify:exports`.
- `git diff --check` clean.

Logs: `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/lt-2026-10-14/campaign-defects-resume/`
(focused-tests.log, tsc.log, lint-loc.log, builds.log, generators.log). Earlier evidence remains
at `.../campaign-defects-port/` (2026-10-14 port) and `.../lt-2026-10-13/campaign-defects/`.
No runtime was created that needed deletion: `node_modules` is linked into the worktree by the
worktree manager, and no database cluster, browser binary, dependency install or copied source
tree was created.

Full test suite: **not run**, per the explicit Plan Queue worker instruction (the run's
verifier gates own `npm run test:quiet`).
Independent verifier: **pending**. Live acceptance: **deferred**, unchanged — exact steps,
expected results and execution prerequisites remain in
[2026-10-05-livetest-campaign-defects_livetest.md](2026-10-05-livetest-campaign-defects_livetest.md).
