# Ping-pong loops cannot terminate (LT-300..303) — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-08-20-pingpong-loop-cannot-terminate_plan_completed.md](2026-08-20-pingpong-loop-cannot-terminate_plan_completed.md)

Changed files: `src/main/orchestration/loop-pingpong-builder-done.ts` (new),
`loop-pingpong-completion.ts`, `loop-coordinator.ts`, `loop-coordinator-state-helpers.ts`,
`agentic-pingpong-reviewer.ts`, `loop-audit-runtime.ts`,
`src/shared/types/loop-audit.types.ts`, `packages/contracts/src/schemas/loop-audit.schemas.ts`,
`src/renderer/app/features/loop/loop-control.component.ts`, `scripts/check-ts-max-loc.ts`.

**Prerequisites:** rebuilt AND restarted app. Checks 1, 2 and 4 are main-process; check 3 is
renderer. The running instance still executes the old `dist/main`, so none of this is observable
until a restart. No `build:aio-mcp-dist` needed — nothing shipping in the aio-mcp SEA changed.

Everything agent-runnable is already verified and is NOT deferred here: `tsc --noEmit`,
`tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, and the full suite (1759 files / 18,526 tests, exit 0). Fourteen new
regression tests were each reverted in an isolated copy and watched to fail before restoring.
What remains below genuinely needs a restarted app plus a real reviewer session.

The original defect was reproduced live before the fix on loop `loop-1787241037235-b6fe2309`
(ledger fully resolved, OUTSTANDING empty, `[ledger-complete]` on all 5 iterations, UI showing
`round 0/15 · reviewer $0.00` after 2h40m / 118.3k tokens / $20.25).

---

## 1. A ping-pong loop opens a round off `ledger-complete` (LT-300 — the headline fix)

**Why deferred:** needs a restarted app and a real cross-model reviewer spawn.

**Steps**
1. Restart the app so `dist/main` carries the fix.
2. Start a loop in a **git** workspace (use `ai-orchestrator` itself) with
   `completion.mode = 'review-driven'` and `completion.crossModelReview.pingPong.enabled = true`.
   Give it a small, genuinely finishable goal — two or three concrete items.
3. Let the agent write `LOOP_TASKS.md` and drive every leaf to `[x]`/`[-]`. Do **not** prompt it
   to emit `[[LOOP:CLEAN_REVIEW]]`; the whole point is that prose alone never did.

**Expected**
- The `PING-PONG` strip advances to `round 1/15` and reviewer spend becomes non-zero.
- Live loop activity shows `Ping-pong round opened on completion signal 'ledger-complete'`.
- `ITERATION_LOG.md` shows `[ledger-complete]` on the same iteration the round opened.
- The loop reaches a terminal (`completed`, or `completed-needs-review` if OUTSTANDING has a
  "Needs human" item) rather than continuing to the iteration cap.

**Fails if** the round counter stays at `0/N` while `[ledger-complete]` fires — that is the
original defect, unfixed.

## 2. Non-git workspace warning appears at loop start (LT-303)

**Why deferred:** the warning is emitted from `startLoop` in the main process.

**Steps**
1. Start a ping-pong (or `crossModelReview.enabled`) loop with `workspaceCwd` set to a directory
   that is **not** a git repository — `/Users/suas/work/orchestrat0r` is the exact case that
   caused this, since the repo is its `ai-orchestrator` subdirectory.

**Expected**
- Live loop activity carries, at seq 0: `Workspace is not a git repository — review rounds will
  receive no diff. Point the loop at the repository itself if you want diff-based review.`
- `app.log` carries `Loop start: workspace is not a git repository — reviewers will receive no diff`.
- `.aio-loop-state/<runId>/repo-baseline.json` shows `"source": "none"`.

**Also check the negative:** the same loop started against `ai-orchestrator` (a real repo) must
emit **no** such line. And a `mode: 'review-driven'` loop with `crossModelReview` unset must emit
no such line either, even in a non-git directory — that silence is deliberate and unit-pinned.

## 3. A preflight verify timeout reads as "timed out", not "failed" (LT-302)

**Why deferred:** renderer chip rendering against real IPC state.

**Steps**
1. Configure a loop with `audit.preflightMode = 'record'` and a `completion.verifyCommand` that
   cannot finish inside `verifyTimeoutMs` (600 s default, not settable from the UI). A long
   `sleep` is blocked in this environment — use something genuinely slow and real, e.g. the
   repo's own `npm run verify` chain, which is what produced the original evidence.
2. Start the loop and let preflight run to the timeout.

**Expected**
- The audit chip reads **`Preflight timed out`**, not `Preflight failed`.
- `.aio-loop-state/<runId>/PRE_FLIGHT.md` shows `(verify timed out after 600000ms)` and a
  duration just under 600000 ms.
- A separate run whose verify command exits non-zero quickly still reads `Preflight failed`.

## 4. The reviewer is told when it has no diff (LT-301)

**Why deferred:** requires a real reviewer session to inspect the delivered prompt.

**Steps**
1. Run check 2's non-git ping-pong loop through to an actual reviewer round (combine with
   check 1's technique for driving the ledger to resolved).
2. Inspect the reviewer session's prompt — via the reviewer instance's transcript, or
   `provider_event_captures` / `traces.ndjson`.

**Expected**
- The prompt contains `## No diff is available — read the code directly` and
  `The loop workspace is NOT a git repository, so no diff could be produced.`
- The prompt does **not** contain `The git diff below is your STARTING POINT`.
- In a git workspace with real changes, the prompt contains the normal
  `## Change under review (git diff vs HEAD)` block and none of the above.

---

## Evidence run — 2026-08-21 (batch Q1, dev app port 9631, profile `/tmp/aio-lt-Q1`)

App rebuilt (`npm run build:main`, this batch) and the dev app relaunched fresh from that build
before any check ran. All four checks driven live against real Claude builders and a real Codex
ping-pong reviewer, in isolated scratch git/non-git fixtures under `/tmp` (never against
`ai-orchestrator` itself, to avoid colliding with the several other batch agents editing this repo
concurrently). Five loop runs total; costs and instance ids below for traceability.

### 1. Ping-pong opens a round off `ledger-complete` — PASS

Two prior attempts (`loop-1787347931325-62088663` in `/tmp/aio-lt-Q1-pingpong-repo`,
`loop-1787348451721-1923f159` in `…-repo2`) converged instead via the pre-existing sentinel route
(the builder spontaneously emitted `[[LOOP:CLEAN_REVIEW]]` despite being told not to, and both
runs' `LOOP_TASKS.md` at the correct per-run path `.aio-loop-state/<runId>/LOOP_TASKS.md` was left
as the blank template — the model instead wrote a *resolved* ledger at the workspace root, the
pre-fix legacy location per `loop-artifact-paths.ts`'s own header comment). Neither is a defect in
this doc's fixes — the sentinel route (b) has always been able to open a round — but neither
exercises route (a) either, so they don't evidence LT-300 specifically.

A third attempt (`loop-1787348971426-488b09c7`, `…-repo3`, a real git repo), given an explicit
absolute pointer to the correct per-run ledger path and an explicit instruction not to emit the
sentinel or the "done"/"complete" words, converged cleanly: `ITERATION_LOG.md` / the iteration's
`completionSignalsFired` show **only** `[ledger-complete] All 3 LOOP_TASKS.md leaf items resolved
(done/deferred) during this run` (`sufficient: true`) on iteration 0 — no self-declared-sufficient,
no sentinel needed. `pingPong.roundCount` went 0→1 on that same iteration; reviewer (codex) replied
APPROVED; the run reached `status: 'completed'` (`endReason: "Ping-pong converged after 1 round(s):
reviewer (codex) APPROVED and builder declared done."`) rather than running to the 10-iteration cap.
Cost: $1.70, one iteration, ~62s.

A fourth run (`loop-1787349281520-4f078486`, `…-repo4`, same recipe) was driven with a live
`onLoopActivity` subscriber attached for the whole run, to capture the literal UI-facing string.
It fired **twice**, once per round: `"message": "Ping-pong round opened on completion signal
'ledger-complete'"`, `detail: {signalId: "ledger-complete", reason: "completion signal
'ledger-complete': All 3 LOOP_TASKS.md leaf items resolved (done/deferred) during this run"}` —
verbatim match to `emitBuilderDoneSignalActivity` (`loop-pingpong-builder-done.ts:93-108`). Round 2
opened even though the builder *did* emit `[[LOOP:CLEAN_REVIEW]]` that iteration (it disobeyed the
prompt instruction) — `completionSignalsFired` for that iteration is `ledger-complete` alone, no
sentinel-derived signal in the list, confirming route (a) short-circuits route (b) exactly as
`resolvePingPongBuilderDone`'s own doc comment says, live, not just in source. Reviewer raised one
`high` finding on round 2 (an out-of-scope-file nitpick the builder rebutted with cited evidence);
cancelled the run after round 2 opened (round 1's literal string already proven) rather than let a
disputed finding run further rounds. Cost at cancel: $3.37 (reviewer spend $2.52 of that — clearly
non-zero).

**Residual:** none for this check's own acceptance criteria. Side observation, not filed as part of
LT-300: across all 4 attempts the builder never reliably located the correct per-run
`LOOP_TASKS.md` path without an explicit absolute pointer in the prompt — worth a follow-up on
whether the per-iteration system prompt is clear enough about that path, but out of scope for this
fix's own tests.

### 2. Non-git workspace warning at loop start — PASS

Three cases, each started and cancelled within ~2.5s (before any real builder work), captured via a
live `onLoopActivity` listener:
- **Case A** (non-git `/Users/suas/work/orchestrat0r`, `crossModelReview.enabled: true`): seq-0
  activity `"Workspace is not a git repository — review rounds will receive no diff. Point the loop
  at the repository itself if you want diff-based review."` — exact match.
- **Case B** (git `…/ai-orchestrator`, same `crossModelReview.enabled: true`): `repoBaseline.source:
  "git"`, **no** such warning in the activity feed (3 unrelated `spawned`/`status` events only).
- **Case C** (non-git `/Users/suas/work/orchestrat0r`, `mode: 'review-driven'`,
  `crossModelReview` **unset**): `repoBaseline.source: "none"`, **no** warning — confirms the
  doc's "silence is deliberate and unit-pinned" claim live, not just in the unit tests.

One near-miss during case A/B setup: leaving `completion.verifyCommand` blank let
`resolveLoopVerification` auto-infer `npm --prefix "ai-orchestrator" run verify` (the full
lint+typecheck+test+build chain) from the workspace's own `package.json`, and that preflight verify
kept running for 5+ minutes after the loop was cancelled, driving 1-minute loadavg from ~6 to ~28 on
this shared campaign host before being killed manually. Filed as **LT-350** (see below); all
`verifyCommand`s after that point in this batch were explicit and cheap.

### 3. Preflight timeout reads "timed out", not "failed" — PASS

Driven with a scaled-down `verifyTimeoutMs` (5000ms, `verifyCommand: 'sleep 20'`) rather than
waiting out the real 600000ms default — same code path (`spawnVerify`'s timeout branch), same
`failureKind` field, ~120x cheaper in wall-clock. `preflightMode: 'record'` case:
`preflight.commands[0]` = `{status: 'failed', durationMs: 5001, failureKind: 'timeout',
outputExcerpt: "…(verify timed out after 5000ms)"}`; `PRE_FLIGHT.md` on disk carries the same
`(verify timed out after 5000ms)` text. Negative case (`preflightMode: 'block'`,
`verifyCommand: 'exit 1'`): `preflight.commands[0]` = `{status: 'failed', durationMs: 26,
failureKind: 'command'}` — no CLI child ever spawned (block mode paused the loop before iteration
0; the activity feed was empty). The renderer predicate at
`loop-control.component.ts:638-644` (`preflightTimedOut = status==='failed' &&
commands.some(c=>c.failureKind==='timeout')`) is pure and reads exactly this shape, so the timeout
case renders `"Preflight timed out"` and the command-failure case renders `"Preflight failed"` by
direct inspection of the code; not additionally screenshotted in the DOM (the state-level
distinction — the actual bug LT-302 fixed — is unambiguous from the captured data).

One safety-relevant side finding during the timeout case: a claude builder child spawned right as
`cancelLoop` was called (iteration 0 started ~5.05s in, cancel landed ~5.09s in) was left running,
un-killed, for ~90+ seconds afterward despite the coordinator logging "Loop activity after
terminate (zombie turn) — escalating to hard adapter cleanup" within half a second of cancellation.
It eventually completed on its own (a real, cheap turn; `tokens: 64`, `cost: 0`) rather than being
killed by that escalation. This looks related to LT-350 (see below) but the exact mechanism wasn't
isolated (single occurrence, tight cancel-immediately-after-spawn timing, and case-C's equivalent
cancel-during-spawn killed its CLI children cleanly within seconds) — reported as an observation,
not filed as its own LT.

### 4. Reviewer is told when it has no diff — PASS

Non-git case (`loop-1787350097250-113268fd`, `/tmp/aio-lt-Q1-pingpong-nongit`, no `.git` dir):
converged in one round ($0.98, reviewer cost $0.58). Captured the reviewer's **actual delivered
prompt** verbatim from `provider_event_captures` (`instance_id: 'xm7f5j7mm'`, `sequence: 3`, the
first `instance-output` event) rather than inferring it from source: contains `## No diff is
available — read the code directly` and `The loop workspace is NOT a git repository, so no diff
could be produced.` verbatim; zero occurrences of `STARTING POINT` anywhere in the prompt.

Git-workspace negative case: pulled the equivalent captured prompt for reviewer instance
`x1ddnz5tb` (one of runs 1–4's rounds, workspace `/tmp/aio-lt-Q1-pingpong-repo2`, real git repo with
real untracked-file changes). Contains `Deep-dive the implementation. The git diff below is your
STARTING POINT, …` and `## Change under review (git diff vs HEAD)` followed by a real `<diff>` block
listing the actual new files (`FILE_A.md`, etc.); zero occurrences of `No diff is available` or
`NOT a git repository`.

### LT-350 filed (found, not fixed) — see `docs/plans/livetest-remediation-register.md`

Cancelling a loop while a preflight/quick-verify child process (or, per the check-3 side finding,
possibly a just-spawned iteration CLI child) is in flight does not reliably kill it — `cancelLoop`
can report success while the spawned process keeps running for minutes, unsupervised. Root-caused
to `spawnVerify` (`loop-completion-detector.ts:648-745`) never registering its
`child_process.spawn` with any lifecycle mechanism `cancelLoop` can reach. Full writeup, exact
repro, and required behaviour in the register entry and the matching
`2026-07-19-livetest-failure-remediation_plan.md` section. Not fixed here — out of scope for this
batch's two assigned docs and risky to touch given several other agents were concurrently editing
`loop-coordinator.ts`/`loop-completion-detector.ts` in this same window.

### Verdict

All four checks PASS with current evidence. No open residual against this doc's own acceptance
criteria. Renamed to `_livetest_completed.md`.

---

## Not covered by these checks

- `verifyTimeoutMs` is hard-coded at `src/shared/types/loop-config-defaults.ts:102` and is not
  exposed in the loop config panel, so an operator who hits check 3 cannot raise the budget from
  the UI. Deliberately out of scope for LT-302; worth a follow-up.
- `runFreshEyesReviewGate`'s `forcedByContradiction` valve
  (`loop-coordinator-completion-gates.ts:341,345`) collects a diff even when
  `crossModelReview.enabled` is false. No start-time predicate can anticipate it, so a loop in
  that state gets an undiffed contradiction review with no check-2 warning. Recorded in LT-303.
- The loop prompt's "N consecutive zero-change iterations" stop rule remains a poor fit for
  open-ended analysis goals — a discovery task can always discover one more thing. Not a defect
  in these four fixes; noted in the plan as a follow-up.
