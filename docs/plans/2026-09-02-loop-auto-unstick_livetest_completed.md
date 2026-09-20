# Live tests — Loop auto-unstick

## Status — 2026-09-20

Open: 0 · Closed: 2 · Failed: 0
Both checks ran live against a rebuilt, relaunched dev app on 2026-09-20 with a real
review-driven Claude loop steered into a same-tool CRITICAL (signal G). See
[Evidence run — 2026-09-20](#evidence-run--2026-09-20). LT-2's "the loop stays running"
clause is superseded by L14 — the loop now parks; the hint-first half of the check holds.
Verification round 1 raised two findings about the *evidence*, not the verdicts; both are
answered in [Verification round 1 follow-up](#verification-round-1-follow-up--2026-09-20).

### Status — 2026-09-06 (historical)

Open: 2 · Closed: 0 · Failed: 0
Needs a rebuilt (`npm run build:main` + renderer) and relaunched Electron instance, then a
review-driven loop steered into a same-tool CRITICAL; otherwise agent-runnable.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-02-loop-auto-unstick_plan_completed.md](./2026-09-02-loop-auto-unstick_plan_completed.md)

## Why these are deferred

Injection, the 2-attempt cap, yield-to-human, signal-A exclusion, gated
pause-after-cap, and the in-flight HUD copy are verified in-loop by
`loop-auto-unstick.spec.ts`, `loop-coordinator-auto-unstick.spec.ts`,
`loop-issue-diagnosis.util.spec.ts`, and `loop-control.component.spec.ts`.
Those are **not** deferred and must not be re-listed here.

What is left needs a rebuilt Electron instance: the running HUD still
serves the old "Give a hint" card until main + renderer are reloaded.

## Prerequisites

- `npm run build` (or at least `npm run build:main` plus a renderer rebuild),
  then relaunch Electron. An already-running instance keeps the old
  hint-first card.
- A user-started (review-driven) loop that can be steered into a
  same-tool CRITICAL (repeated `Edit` / identical args) without being
  dangerous to the workspace.

---

## LT-1 — In-flight card does not lead with a hint

1. Rebuild and relaunch.
2. Start a loop and produce a fixable CRITICAL (signal G: same tool,
   same args, many times in one iteration).
3. Wait for that iteration to finish. Do not type a hint.

**Expected:** the diagnosis card says the loop is trying a different
approach on its own. Primary action is **See why**, not **Give a hint**.
The next iteration is already queued with an orchestrator unstick.

**Why deferred:** the running app serves the previous main + renderer
bundle until rebuild/relaunch.

## LT-2 — After the cap, the card asks for a hint

1. Let the same loop consume both auto-unstick attempts and still
   finish CRITICAL.
2. Do not pause it yourself.

**Expected:** the card returns to hint-first. The loop stays running
(review-driven). A gated loop would have paused instead.

**Why deferred:** needs a live multi-iteration run in the rebuilt app.

**Amendment — 2026-09-20.** The "loop stays running" clause is no longer the
required behaviour. L14 (`maybeParkReviewDrivenRun`,
`src/main/orchestration/loop-nonconvergence.ts:201-275`, called from
`src/main/orchestration/loop-coordinator.ts:3481`) landed after this plan and
deliberately **parks** a review-driven run once auto-unstick's two strikes are
spent on an eligible signal. It is recorded as shipped in
`docs/plans/2026-09-03-enhancements-backlog_plan_completed.md` (L14 and UX27),
which also states that L14 sits *after* this plan and owns the terminal policy
once attempts are exhausted. The still-current half of this check — the card
stops suppressing the hint and leads with it again — is what the evidence run
verifies.

---

## Evidence run — 2026-09-20

Run by the Plan Queue livetest worker for branch
`queue/2026-09-02-loop-auto-unstick-30aaa7`. Both checks **pass**, with the
LT-2 amendment above applied. No defect reproduced; nothing filed in the
remediation register.

### Environment

| Item | Value |
| --- | --- |
| Build | Worktree `.worktrees/queue/2026-09-02-loop-auto-unstick-30aaa7`, `npm run build:main` exit 0, `npm run build:renderer` exit 0 (both re-run for this session) |
| Renderer | Production bundle served from `dist/renderer/browser` on `127.0.0.1:4589` (static SPA server); Electron launched with `PORT=4589` |
| App | `npx electron .` from the worktree (cwd confirmed via `lsof -p … -d cwd`), `--remote-debugging-port=9846`, `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-b330aaa7` |
| Focus | `Emulation.setFocusEmulationEnabled` + `Emulation.setPageVisibilityOverride` sent on every CDP connection before any DOM read (`document.hidden` read back as `false`) |
| Fixture | Real Claude loop, `provider: 'claude'`, `completion.mode` resolved to `review-driven` by `loop-start-config.ts`, workspace `/tmp/aio-lt-queue-b330aaa7-ws` (throwaway git repo) |
| Host load | `load averages: 4.09 3.17 3.30` at launch — well under the runbook's ~30 threshold |

Clock times below are **UTC** (captured with `toISOString()`); the machine was on
BST, so they read one hour behind local log timestamps for the same events.

The loop goal instructed the agent to call `Read` on the same file four times
consecutively and then append a line, every iteration. That fires signal G
(`signalG_toolRepetition`: 3 consecutive identical `tool::argsHash` → CRITICAL)
while the file append keeps the review-driven stall guard resetting — exactly
the 43×-`Edit`-thrash shape the plan was written for. No renderer store was
seeded or patched; every value below came from the real coordinator through
`loop:state-changed` into the real HUD.

### LT-1 — In-flight card does not lead with a hint · PASS

Live capture, run `loop-1789939198920-5833e8bd` (raw frames:
`_scratch/lt-queue-b330aaa7/drive-out.json`, gitignored/disposable).

At 21:20:47 and again at 21:21:13 the coordinator had injected an unstick for
the iteration just completed, so `autoUnstick.seq === lastIteration.seq`:

```
state: status=running  lastSeq=1  verdict=CRITICAL  signals=[G:CRITICAL, I:CRITICAL]
       autoUnstick={seq:1, attempt:1, max:2, signalId:"G"}   inFlight=true
```

Rendered `app-loop-issue-card` (text read straight out of the DOM):

- chip: `STUCK`, severity `CRITICAL`
- headline: *Repeating the same tool calls and re-reading the same content*
- problem: *Tool Read called 3× consecutively with identical arguments*
- implication: **“The loop is trying a different approach on its own. A hint still helps if you already know a better path.”**
- what you can do: **“It is already changing approach. Hint only if you have a specific next step.”**
- actions: `Give a hint`, **`See why [PRIMARY]`**, `Stop`

So the card leads with **See why**, not **Give a hint** — the `primary` class is
on the inspect action, matching `actionsFor()`'s `hintPrimary = … && !autoUnstickInFlight`.
The same three assertions held at attempt 2/2 (21:21:13).

**“The next iteration is already queued with an orchestrator unstick”** — three
independent confirmations:

1. `state.pendingInterventions` carried an entry with `source: 'auto-unstick'`
   while a nudge was in flight (observed on the first fixture run,
   `loop-1789938871509-ddaa56b8`, which used the identical goal and config).
2. The provider *received* it. Iteration transcripts for the same run:
   - seq 2 — *“I note the automatic unstick direction to stop repeating the identical Read call…”*
   - seq 3 — *“I note the second and final automatic unstick direction…”*
   - seq 4 (after the cap) — no acknowledgement, because no nudge was injected.
3. The HUD honesty chip read `unstick 1/2 · G`, the run header read
   *“Next without you: It continues to the next iteration.”*, and the live
   activity log showed *“Iteration 3 starting in /tmp/aio-lt-queue-b330aaa7-ws”*
   while the card still showed the diagnosis for the iteration that had just
   finished (`seq 1`, displayed as iteration 2)
   (screenshot `_scratch/lt-queue-b330aaa7/shot-inflight.png`, run
   `loop-1789939423152-a6693b2f`). The screenshot also confirms `See why` is the
   visually filled/emphasised button, not just the one carrying the class.

### LT-2 — After the cap, the card asks for a hint · PASS (with the amendment above)

Same run, continuing past the cap.

**What actually happened at 21:21:33**, one iteration after the second strike
(`autoUnstick` stays at `{seq:2, attempt:2, max:2}` while `lastIteration.seq`
advances to 3, so nothing is in flight any more):

```
state: status=paused  lastSeq=3  verdict=CRITICAL  autoUnstick={seq:2, attempt:2, max:2, signalId:"G"}  inFlight=false
```

Main logged `LoopNonConvergence: Loop parked — review-driven stall survived
auto-unstick`, `note: "auto-unstick exhausted on signal G: Tool Read called 3×
consecutively with identical arguments"`. That is L14, not a regression — see
the LT-2 amendment. The verbatim log record, with its source and timestamp, is
quoted under [finding 2](#2-durable-proof-of-the-loop-parked-log-line) below. The HUD switched from the card to the no-progress banner
(`showIssueCard` is null under any banner):

- title: *Repeating the same tool calls and re-reading the same content*
- body: *“Tool Read called 3× consecutively with identical arguments. The loop
  paused because it could not prove progress. It will not continue until you
  hint, resume, or stop. Hint a different next action — a file to edit, a
  command to skip, or a new approach.”*
- actions: `Inspect`, `Inject hint`, `Resume anyway`, `Stop`
- run status pill: `PAUSED · NO PROGRESS`
  (screenshot `_scratch/lt-queue-b330aaa7/shot-parked.png`)

The “already changing approach” copy is gone and the next step is a hint again.

**The card itself, hint-first.** Clicking `Resume anyway` clears the banner and
un-pauses the run, which is the state LT-2 describes — running, review-driven,
both attempts spent. Captured at 21:22:07:

- implication: **“The loop is still running. Unstick attempts are spent, so it will pause. A hint now often unsticks it.”**
- what you can do: *Hint a different next action — a file to edit, a command to skip, or a new approach.*
- actions: **`Give a hint [PRIMARY]`**, `See why`, `Stop`

So the card is hint-first again, and its copy now warns that the run will pause
— the UX27 wording, consistent with L14. At 21:22:22 the next CRITICAL
iteration re-parked the run, confirming the park is the steady state.

### Checked and not filed

All LT-1 / LT-2 evidence above was captured in one continuous dev-app session.
The app was then restarted once, solely to chase a side observation.

A side observation — “after a renderer reload the session sidebar is empty while
main still holds the instance” — did **not** survive verification. The
`app-instance-row` selector used to count sessions is not the markup the grouped
*Projects* sidebar renders, so the zero counts measured nothing; the sidebar's
own `innerText` listed the project and its sessions throughout. No register
entry was created.

### Not verified here

- Only the `claude` provider was exercised. The auto-unstick decision is
  provider-agnostic (it runs on the coordinator's iteration result, not the
  adapter), but no second provider was driven.
- Only signal `G` was driven live. The other eligible ids (`B`, `E`, `I`, `D`,
  `D-prime`, `H`) share one code path and are covered by
  `loop-auto-unstick.spec.ts`; signal `I` co-fired as CRITICAL on every
  iteration here and did not change the outcome, since `pickAutoUnstickSignal`
  prefers `G`.
- Gated-mode behaviour after the cap was not re-driven; it is unchanged by this
  plan and covered by `loop-coordinator-auto-unstick.spec.ts`.

### Cleanup

Dev app stopped (`harness-dev` lock released, ports 4589/9846 free), static
renderer server stopped, all four loop runs cancelled, the surviving disposable
instance terminated and `listInstances` confirmed at 0. The whole isolated
profile `/tmp/aio-lt-queue-b330aaa7` and the throwaway workspace
`/tmp/aio-lt-queue-b330aaa7-ws` were deleted, so nothing from this run persists.
No settings changed, no automations created, no source files modified;
`git status --short` clean in the worktree.


---

## Verification round 1 follow-up — 2026-09-20

The independent verifier raised two findings, both about how the *evidence* is
kept rather than about what the app did. Neither changes an LT-1 / LT-2 verdict.
Work done here: one regression test in the worktree, and a durable citation for
the main-process log line.

### 1. Where this evidence persists when the branch lands

**Finding.** The item branch `queue/2026-09-02-loop-auto-unstick-30aaa7` has no
commits versus `main`, and this document is untracked in the root checkout, so
"if this branch is merged as-is, the livetest result disappears".

**It does not, and the worker must not commit it.** Plan Queue closes and lands
a document from the root checkout itself, only after a verifier PASS:

- `prepareClosedDocuments(documentPath, repoRoot)` reads the **root checkout**
  copy and returns `{ mode: 'commit', documents }` when the document is inside
  the repository and not ignored — `src/main/plan-queue/plan-queue-doc-close.ts:94-118`.
  Measured for this document: `git check-ignore -q -- docs/plans/2026-09-02-loop-auto-unstick_livetest.md`
  exits 1 (not ignored), so `committable()` is true and the closed copy takes
  the commit path, not `rename-in-place`.
- `landItemBranch` passes those documents to `buildLandingCommit`
  (`src/main/plan-queue/plan-queue-landing.ts:185-190`), which writes and stages
  them **inside** the squash commit (`plan-queue-squash.ts:135-140`) and only
  then asks whether anything is staged (`plan-queue-squash.ts:142`). A
  document-only item therefore still produces a landing commit.
- Untracked-in-the-root is deliberate: that visibility is the operator's review
  queue, and the coordinator — never the worker — moves the document to its
  `_completed` name (`plan-queue-doc-close.ts:1-13`).

**What was genuinely missing: a test pinning it.** The nearest existing cases
are `is a no-op landing when the item changed no tracked files`
(`plan-queue-landing.spec.ts:144`), which passes **no** documents, and `lands the
closed documents in the same commit as the code` (`:285`), which always has code.
Nothing covered the shape this run actually is — a livetest item that reproduced
no defect, so the closed document *is* the whole landing. A refactor that moved
the `diff --cached --quiet` bail-out above the document write would silently drop
the evidence of every such item.

Added `lands the closed document when the item branch has no commits of its own`
— `src/main/plan-queue/plan-queue-landing.spec.ts:154-171`. It lands an item
whose branch has zero commits with one `_livetest_completed.md` document and
asserts main advanced by exactly one commit containing only that document, with
the expected content, and the item checkout restored.

Negative control (the regression is real, and the test catches it): with the
`diff --cached --quiet` bail-out moved above the document write in
`plan-queue-squash.ts`, **only** the new test failed — `expected '0' to be '1'`,
17 of 18 still green — and it passed again once the file was restored. The
worktree is back to the unmodified `plan-queue-squash.ts`.

Gates re-run for that change, all from the worktree, with each exit code read
from the command itself rather than through a pipe:

| Gate | Result |
| --- | --- |
| `npm run test:quiet -- src/main/plan-queue/plan-queue-{landing,squash,doc-close}.spec.ts` | 3 files · 34 tests passed |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs before it finishes) |
| `npm run lint` | exit 0 — "All files pass linting" |
| `npm run check:ts-max-loc` | exit 0 — ratchet passed |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` (full suite) | 25744 of 25745 passed in 218.0s; the single failure is `scripts/__tests__/dependency-compatibility.spec.ts`, which fails **only** inside a queue worktree — see below |

Order of work, so the table is not read as more than it is: the full suite ran
with the spec change in place; the two Markdown edits landed afterwards, and
`npm run test:quiet -- src/main/plan-queue` (15 files, 161 tests) was re-run
green after them. No spec reads the body of either document — the four places
that name them (`plan-queue-prompts.ts:18`, `plan-queue-coordinator.spec.ts:763`,
`local-suite.ts:238`, `scripts/bench-retrieval.ts:14`) use the path only, and
neither path changed.

**The one full-suite failure is the worktree, not this branch.**
`scripts/__tests__/dependency-compatibility.spec.ts › keeps the installed
production tree valid` failed with a long list of `extraneous:` packages. Cause:
a Plan Queue worktree's `node_modules` is a farm of per-entry **symlinks** into
the root checkout's install (`node_modules/.package-lock.json` is itself a
symlink to `/Users/suas/work/orchestrat0r/ai-orchestrator/node_modules/.package-lock.json`),
so `npm ls --omit=dev --all` resolves every package outside the project and
calls the whole tree extraneous. Proof it is environmental, not the code:

| Where | Same spec, same commit | Result |
| --- | --- | --- |
| `.worktrees/queue/2026-09-02-loop-auto-unstick-30aaa7` | `npm run test:quiet -- scripts/__tests__/dependency-compatibility.spec.ts` | exit 1, 1 of 4 failed |
| root checkout `/Users/suas/work/orchestrat0r/ai-orchestrator` | `npx vitest run scripts/__tests__/dependency-compatibility.spec.ts` | exit 0, 4 of 4 passed |

Nothing in this round's diff can move an npm tree (one `.spec.ts` case and two
Markdown files), and the failure reproduces on the unmodified file.

It is still worth someone's attention — an operator who sets a queue run's
`postMergeGate` to the full suite (`plan-queue-item-landing.ts:149`) would see
every item fail on it — so it is now recorded in `docs/testing.md` under Cache
and CI, with the two commands above. I deliberately did **not** add it to
`docs/plans/livetest-remediation-register.md`: the root checkout's copy of that
register currently carries 266 uncommitted lines from other sessions, and the
landing promotion is `block-overlap` (`plan-queue-landing.ts` → `promoteIntegrationBranch`,
proved by `plan-queue-landing.spec.ts:173` "blocks, changing nothing, when a root
file would be overwritten"), so a register edit in this worktree would refuse
this item's own landing. It needs its own item once that file is clean.

### 2. Durable proof of the `Loop parked` log line

**Finding.** The `LoopNonConvergence: Loop parked …` quote in LT-2 had no
surviving artifact behind it: both `_scratch/lt-queue-b330aaa7/dev-app*.log`
files are 0 bytes and the isolated profile was deleted at cleanup.

**Why those files are empty, and where the log actually went.** Electron's
stdout carried nothing: main-process logging is file-based. `LogManager` is
constructed lazily on the first `getLogger()` call (`src/main/logging/logger.ts:643-653`)
and fixes its log path from `app.getPath('userData')` right then
(`logger.ts:333-346`). Because the house idiom is a module-level
`const logger = getLogger('X')`, that happens while `src/main/index.ts` is still
importing — before `app.setPath('userData', resolveHarnessUserDataPath(…))` at
`src/main/index.ts:64` applies `AIO_DEV_USER_DATA_PATH`. So a dev app writes
`app.log` into the **production** profile, which is what the runbook's gotcha
table says and what this run observed: deleting `/tmp/aio-lt-queue-b330aaa7`
never touched the evidence. Verbatim, from
`~/Library/Application Support/harness/logs/app.log` (line numbers as of
2026-09-20 22:45 BST; the file is still being appended to and rotates at 10 MB —
`logger.ts:88`, `:378` — so treat timestamp + `loopRunId` as the stable key):

```
45184:{"timestamp":1789939293023,"level":"info","subsystem":"LoopNonConvergence","message":"Loop parked — review-driven stall survived auto-unstick","data":{"loopRunId":"loop-1789939198920-5833e8bd","seq":3,"note":"auto-unstick exhausted on signal G: Tool Read called 3× consecutively with identical arguments"}}
45200:{"timestamp":1789939342033,"level":"info","subsystem":"LoopNonConvergence","message":"Loop parked — review-driven stall survived auto-unstick","data":{"loopRunId":"loop-1789939198920-5833e8bd","seq":4,"note":"auto-unstick exhausted on signal G: Tool Read called 3× consecutively with identical arguments"}}
```

`1789939293023` is `2026-09-20T21:21:33.023Z` — the same instant, the same
`seq`, and the same `loopRunId` as the LT-2 state frame above, and that run id is
the one `_scratch/lt-queue-b330aaa7/drive-out.json` records at its second line.
The rest of the same run's trail corroborates the whole LT-2 narrative
independently of the captured frames:

| UTC | app.log line | Event |
| --- | --- | --- |
| 21:19:58.997 | 45091 | `LoopCoordinator` — loop `loop-1789939198920-5833e8bd` starts |
| 21:21:33.023 | 45184 | `LoopNonConvergence` — parked at `seq 3`, auto-unstick exhausted on signal G |
| 21:22:07.167 | 45185 | `LoopCoordinator: Loop resumed` — the `Resume anyway` click, at the exact minute LT-2 records for the hint-first card |
| 21:22:22.033 | 45200 | `LoopNonConvergence` — re-parked at `seq 4`: the park is the steady state |
| 21:23:40.144 | 45203 | `LoopCoordinator: Loop terminated`, `status: cancelled`, `reason: user cancelled` — the cleanup this document claims |

The same file also holds `Loop parked` for the first fixture run
`loop-1789938871509-ddaa56b8` at 21:15:36.373 (line 45028), and a
`SpawnConfigBuilder` entry at 21:19:08.945 naming
`…/.worktrees/queue/2026-09-02-loop-auto-unstick-30aaa7/config/mcp-servers.json`,
which independently confirms the app under test ran from this worktree.

A copy of the 22 matching lines is in
`_scratch/lt-queue-b330aaa7/main-log-excerpt.ndjson`; `_scratch` is disposable,
so the citation above (path, line, timestamp, run id) is the authority.

**Lesson for the next run:** redirecting Electron's stdout proves nothing about
main-process logging. Copy the relevant slice of the production-profile
`app.log` into the evidence directory *before* cleanup, and cite timestamp +
`loopRunId` so the claim stays checkable after rotation.

### Verification status of this follow-up

- No new defect reproduced; nothing added to
  `docs/plans/livetest-remediation-register.md`.
- No dev app was launched for this round: neither finding needed one. Finding 2
  was answered from the log the earlier run had already written, and finding 1
  from the landing code plus a test.
- Both findings were caused by conventions that were nowhere written down, so
  the standing runbook now carries them:
  `docs/plans/livetest-campaign-runbook.md` §5 gains a rule that a quoted
  main-process log line must cite the production-profile `app.log` and be copied
  out before cleanup, and a note that a Plan Queue item which reproduces no
  defect legitimately ends with zero commits because the coordinator lands the
  document itself.
- One incidental failure was reproduced and localised — the full suite's
  `dependency-compatibility` spec inside a queue worktree — and written up in
  `docs/testing.md` rather than the remediation register, for the
  landing-block reason given above.
- Worktree diff for this round, uncommitted as the queue rules require:
  `src/main/plan-queue/plan-queue-landing.spec.ts` (+19),
  `docs/plans/livetest-campaign-runbook.md` (+15) and `docs/testing.md` (+1).
  No branch, worktree, stash or commit was created, and no `_completed` rename
  was made.
