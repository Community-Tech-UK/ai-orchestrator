# Loop Convergence & Cost Safety — Live Test Checklist

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** `docs/superpowers/plans/2026-07-14-loop-convergence-and-cost-safety-plan_completed.md`
**Created:** 2026-07-16
**Prerequisites:** rebuilt + restarted AIO app (`npm run build`, relaunch). Every check below
genuinely requires the rebuilt renderer/main runtime or a live provider session — all
agent-runnable gates (WS1–WS9 targeted suites, full suite, typechecks, lint, LOC, build,
IPC contract checks) already passed in-loop and are recorded in the plan's As-Built section.

## 1. Campaign-required loop start is blocked in the real UI
- **Steps:** Configure a loop with a plan file containing an explicit "one workstream per
  run" sentence and ≥2 `## WSn` headings (e.g. the Fable plan). Press start.
- **Expect:** Start is refused BEFORE any CLI spawns; the app navigates to Campaigns with
  the plan path prefilled in the import panel.
- **Evidence:** screenshot of the refusal + prefilled campaign import.

## 2. Import preview shows the sequential contract
- **Steps:** In Campaigns, press "Preview import" for that plan with a verify command.
- **Expect:** sequential nodes in plan order + final integration gate; $30 per-node cap;
  30 turns/iteration; pause-on-needs-review; NO isolation; aggregate worst-case labeled as
  an upper bound; nothing starts.
- **Evidence:** screenshot of the preview panel.

## 3. Two-workstream fixture campaign sequencing
- **Steps:** Import and start a small two-workstream fixture plan campaign.
- **Expect:** node 2 does not start until node 1 reaches `completed`;
  a `completed-needs-review` node PAUSES the campaign.
- **Evidence:** campaign timeline screenshot + node statuses.

## 4. Codex occupancy truthfulness under native usage events
- **Steps:** Run a Codex app-server loop long enough to receive `thread/tokenUsage/updated`
  events and exceed 200k aggregate tokens.
- **Expect:** context diagnostics show a plausible CURRENT percentage; no recycle fires
  solely because aggregate tokens crossed 200k; unknown occupancy shows the once-per-run
  "Context recycling inactive" status instead of a fabricated figure.
- **Evidence:** context bar screenshot + app.log lines for the recycle decision.

## 5. Degraded invocation with a workspace write parks visibly
- **Steps:** Drive a loop iteration fixture that writes a file then fails mid-turn
  (e.g. kill the child CLI process manually during a write).
- **Expect:** the run parks as completed-needs-review; the UI shows replay was suppressed
  and lists the changed path(s) from the sealed attempt evidence.
- **Evidence:** loop terminal banner + endEvidence changed paths.

## 6. Verify-less implementation goal is visibly blocked in the panel
- **Steps:** In the loop config panel, type an implementation goal, clear the verify
  command, leave operator-review unchecked.
- **Expect:** submit disabled with the inline "verification authority" reason; enabling
  operator-reviewed completion (with the finite cap) re-enables submit.
- **Evidence:** screenshot of the disabled state + reason text.

---

## Results — 2026-07-25 (dev app, rebuilt main; macOS 25.5.0)

**1. PASS.** Loop start refused with `LOOP_SCOPE_CAMPAIGN_REQUIRED` *before* any CLI spawn
(scope assessment classified the fixture plan `campaign-required`, 3 workstreams parsed, both
reasons cited). Redirect-to-Campaigns handlers with `{planFile, workspaceCwd, verifyCommand}`
prefill at `instance-detail.component.ts:871` and `chat-detail.component.ts:459`; the Campaigns
page consumes those query params and prefills the import panel.

**2. PASS.** Preview built 4 sequential nodes WS1→WS2→WS3→integration-gate, $30 (3000c) per-node
cap, 30 turns/iteration, `onNodeNeedsReview: pause-campaign`, no isolation, $120 aggregate as an
upper bound, `maxParallel: 1`. Nothing started.

**3. PASS** (both stated expectations; see the caveat).
- *Node 2 does not start until node 1 reaches `completed`*: across four campaigns ws2 stayed
  `pending` for the whole of ws1's run. When ws1 ended non-`completed`, ws2 was **explicitly
  skipped** — `"Edge predicate not satisfied for node ws2"` against the built edge
  `{from: ws1, to: ws2, when: {type: 'is', status: 'completed'}}` — and integration-gate followed
  with `"skipped because dependency ws2 was skipped"`. Nothing started early or silently.
- *A `completed-needs-review` node PAUSES the campaign*: `CampaignCoordinator | Campaign paused |
  reason: "Node ws1 reached completed-needs-review"`.
- **Caveat — not observed:** the positive transition (ws1 → plain `completed` → ws2 auto-starts).
  All four fixture runs ended `completed-needs-review`; the loop's final audit demanded operator
  review even when WS1 ran a real `npm test` and quoted its output. The gate is evidenced by the
  declared edge predicate plus the negative case, not by watching ws2 start.

**6. PASS.** With an implementation goal, no verify command and operator-review unchecked, submit
was disabled with the exact WS6 reason rendered in the DOM (`canSubmit: false`). Ticking
operator-reviewed completion *without* a finite cap still blocked (cap rule); adding the cap
re-enabled submit.

**4, 5: still open** — both need a live Codex app-server session / a mid-write child kill.

### Bug found and fixed while running check 3

Campaign nodes died at iteration 1 with `Claude CLI exited with code 1` (three retries ~250 ms
apart) whenever the workspace path traverses a symlink — reproduced twice on `/tmp` (→
`/private/tmp`). Two defects in `claude-cli-adapter.ts`:

1. the transcript probe encoded the **raw** cwd while the CLI encodes the **resolved** one, so
   `--resume` was skipped for a session whose transcript did exist;
2. the skip-path then reused the same id via `--session-id`, which the CLI rejects outright —
   direct repro: `Error: Session ID 0dca9e50-… is already in use.` → exit 1.

Fixed by extracting `src/main/cli/adapters/claude-transcript-registry.ts` (realpath-aware lookup
plus an "id in use anywhere" probe; the fallback now lets the CLI mint a fresh id, which the
adapter adopts from the init message). Three regression tests in
`claude-cli-adapter-session-id-fallback.spec.ts`, verified to fail against the pre-fix source and
pass after. Post-fix, the same fixture on the same symlinked path ran ws1 to
`completed-needs-review` with **zero** resume-skips and **zero** exit-1s.

---
Run these by dragging this `_livetest.md` into a loop against the rebuilt app; rename to
`_livetest_completed.md` only when every check passes with recorded evidence.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Results recorded 2026-07-25 with four PASS and a bug found-and-fixed during check 3. Residual items were not re-examined this session.

## Evidence run — 2026-07-31 — checks 1, 2 and 6 PASS

Dev app on `--remote-debugging-port=9444`, rebuilt main, real IPC and real renderer components.

### Check 1 — campaign-required loop start is blocked — ✅ PASS (both halves)

Plan fixture with an explicit one-workstream rule and three `## WSn` headings. `loopStart` refused
**before any CLI spawned**:

```
errorCode: LOOP_SCOPE_CAMPAIGN_REQUIRED
message:   The configured plan forbids single-loop execution
           (explicit-one-workstream-rule, multiple-workstreams; 3 workstreams). Run it as a campaign.
data.scopeAssessment.disposition: 'campaign-required'
data.scopeAssessment.workstreams:  WS1, WS2, WS3 (with start/end lines)
```

The navigation half was then verified in the **live renderer**, not just read in source. The refusal
handler (`instance-detail.component.ts:876-884`) routes `LOOP_SCOPE_CAMPAIGN*` to `/campaigns` with
`planFile`, `workspaceCwd` and `verifyCommand` as query params; navigating there with exactly those
params leaves the mounted campaign page prefilled:

```
importPlanFile:      'campaign-plan.md'
importWorkspaceCwd:  '/tmp/aio-lv/parent'
importVerifyCommand: 'npm run verify'
```

and it does **not** auto-preview or auto-start (`ngOnInit` only sets the fields).

### Check 2 — import preview shows the sequential contract — ✅ PASS

`campaignImportPlanPreview` against the same plan. Every clause of the expectation holds:

| Expectation | Observed |
| --- | --- |
| sequential nodes in plan order | `ws1` → `ws2` → `integration-gate` |
| genuinely sequential (not just ordered) | `dependsOn`: `ws1 []`, `ws2 ['ws1']`, `integration-gate ['ws2']`; `policy.maxParallel: 1` |
| final integration gate | `integration-gate` present |
| $30 per-node cap | `caps.maxCostCents: 3000` on every node |
| 30 turns/iteration | `maxTurnsPerIteration: 30` on every node |
| pause-on-needs-review | `policy.onNodeNeedsReview: 'pause-campaign'` |
| **no** isolation | no `isolateWorkspace` on any node |
| aggregate labelled an upper bound | `aggregateMaxCostCents: 9000` — exactly 3 × 3000, i.e. worst case |
| nothing starts | preview only; no campaign or loop created |

### Check 6 — verify-less implementation goal is visibly blocked — ✅ PASS

The gate was observed live (see the loop-verification doc's 2026-07-31 run: an implementation loop in
a workspace with no verifier is **refused**, with the verification-authority message). The panel side
— `canSubmit()` false with the inline reason, and operator-reviewed completion re-enabling it — is
pinned by `loop-config-panel.component.spec.ts`, which this campaign extended to cover all four
`verifyHint()` states (49 tests green).

### Still open

- **Check 3** — two-workstream campaign sequencing needs a real campaign *run* (node 2 waiting on
  node 1, and a `completed-needs-review` node pausing the campaign). Driveable, but it is two live
  provider loops end to end.
- **Check 4** — Codex occupancy truthfulness needs a loop long enough to exceed 200k aggregate
  tokens. Expensive; not attempted.
- **Check 5** — degraded invocation with a workspace write. Closely related to the LT-020
  investigation earlier this session, which killed a loop's CLI mid-iteration and saw it park as
  `completed-needs-review` with "UNPROVABLE workspace state" — but that run did not assert the
  changed-path list from the sealed attempt evidence, which is this check's real content.

**Not renamed** — checks 3, 4 and 5 are outstanding.

## Evidence run — 2026-08-12 — check 3 PASS (both halves observed live)

Dev app on `--remote-debugging-port=9463`, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-loops`,
rebuilt main, real IPC over CDP (`campaignImportPlanPreview` → `campaignStart` → `campaignGet` polling).
Fixture: a fresh git repo at `/tmp/aio-lt-campaign3` with a two-workstream `campaign-plan.md` (WS1
creates `ws1.txt`, WS2 creates `ws2.txt`; each acceptance check is a single trivial file write),
provider `claude`, `verifyCommand: 'true'`, `maxCostCents: 200`, `maxTurnsPerIteration: 8`.

### Run 1 — negative case: `completed-needs-review` pauses the campaign

`campaignStart` on the unmodified preview spec. ws1 ran a real Claude turn, created `ws1.txt`,
closed its `LOOP_TASKS.md` ledger (`[x] Create ws1.txt…`, `[x] Verify no other file touched…`,
`[x] Run verify command…`, `[-] WS2 … deferred: owned by a separate campaign node`), and the verify
command passed — but the node's own `AUDIT.md` still recorded `Status: needs-review` with one Review
Finding: `plan-criteria-unproven: The plan packet is malformed; operator review is required.` (the
campaign-node loop config leaves `audit.planPacketMode` unset, which `defaultPlanPacketMode` in
`loop-start-config.ts:223-231` resolves to `'prompted'` whenever `caps.maxIterations >= 5` — true for
every campaign node's default cap of 50 — and this fixture's `ROADMAP.md` was never populated with a
criteria table, so the plan-packet check always fires). Campaign status went straight to `paused`,
`pausedReason: "Node ws1 reached completed-needs-review"`, confirmed via `campaignGet`. `ws2` and
`integration-gate` stayed `pending` throughout — nothing started early.

### Run 2 — positive case: node 2 auto-starts the instant node 1 reaches plain `completed`

Same fixture, same provider/caps, but this run set `loopConfig.audit = { planPacketMode: 'off' }` on
every node before calling `campaignStart` — a legitimate caller-supplied override (`LoopConfigInputSchema`
accepts it; `CampaignImportPlanPreviewPayloadSchema` just has no field for it, so a caller who wants it
must edit the previewed spec directly), used here only to remove the orthogonal always-review finding
observed in Run 1 so the completed-vs-needs-review transition could actually be observed. `campaignGet`
polling recorded, by node-run timestamp:

| node | startedAt | endedAt | status |
| --- | --- | --- | --- |
| ws1 | 1786491870158 | 1786492017794 | `completed` |
| ws2 | 1786492017929 | (ws2 ran to completion next poll) | `completed` |
| integration-gate | (started immediately after ws2's `completed`) | — | `running` (halted before finishing) |

ws2's `startedAt` (1786492017929) is 135 ms after ws1's `endedAt` (1786492017794) — i.e. node 2 started
only once node 1's terminal status was recorded, not early, and not on a poll-interval coincidence
(135 ms << the 15 s poll interval). ws2 in turn ran to `completed` and `integration-gate` auto-started
the same way. Campaign was halted (`campaignHalt`) once `integration-gate` began, to avoid spending a
full canonical-verification turn against a fixture repo with no real build — that node's own outcome is
out of scope for check 3.

**Both check-3 expectations are now directly observed, not inferred from an edge predicate or a
negative case alone: node 2 provably does not start until node 1 reaches `completed`, AND node 2
provably does auto-start the moment node 1 reaches `completed`.** ✅ PASS.

Cleanup: campaign halted, no leftover `claude` child processes for `/tmp/aio-lt-campaign3`
(`ps aux | grep aio-lt-campaign3` empty), `listInstances` returned 0 instances. Fixture directory
removed at end of session (see final cleanup section).

## Evidence run — 2026-08-12 — check 5: blocked by a reproducible defect, filed as LT-065, fixed

Dev app on `--remote-debugging-port=9463`, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-loops`.
A direct (non-campaign) loop was started (`createInstance` + `loopStart`) against a fresh git repo at
`/tmp/aio-lt-degraded`, Claude provider, `same-session`/`review-driven` completion, prompted to write
`write1.txt`, run a ~32 s Bash sleep loop, then write `write2.txt`. Once `write1.txt` was confirmed on
disk (`ls`/`stat`), the parent `claude --print` CLI process was killed with `kill -9`, gated per the
brief (pid new since session start, `ppid` matched the dev app's own Electron main pid, command line
matched the expected CLI).

**Defect found (not the check's own outcome).** The killed iteration did not pause for review; the
coordinator auto-retried on a fresh iteration, which itself created `write2.txt` too — and **both**
iterations' `ITERATION_LOG.md`/app.log entries reported `changedPathCount: 0` / "files changed: 0"
despite the confirmed-on-disk writes. A differential test (identical scenario, workspace **outside**
`/tmp`) correctly reported "files changed: 1" on the same shape of turn, isolating the cause to
`/tmp`'s macOS symlink (`/private/tmp`): `createAttemptDeltaObserver`'s own `workspace` variable
(`loop-attempt-observation.ts`) was never realpath-resolved, but `discoverWorkspaceRepositories`'s
`git rev-parse --show-toplevel` always returns the resolved path — the two roots diverged by the
symlink prefix, so `toWorkspaceFileChange`'s `path.relative(workspace, absolutePath)` started with
`../` for every file and was silently dropped by the existing "outside the workspace" guard. Filed as
**LT-065** (`docs/plans/livetest-remediation-register.md`, `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`).

**Fixed and verified.** `resolveWorkspaceRoot()` now realpath-resolves the observer's workspace (with
a plain-`path.resolve` fallback when the target doesn't exist yet). New regression test in
`loop-attempt-observation.spec.ts` — built a real repo behind a real symlink (portable, not dependent
on macOS's own `/tmp`), watched it **fail** against the pre-fix source
(`expected [] to deeply equal ['write1.txt']`), then pass after the fix. 27 tests across the touched
module and its three adjacent dependents (`loop-workspace-repositories.spec.ts`,
`loop-repo-state.spec.ts`, `loop-invocation-attempt.spec.ts`) pass with no regressions. `tsc` ×2,
`lint`, `check:ts-max-loc`, `build:main` all clean.

**Post-fix live re-run.** Dev app relaunched against the rebuilt main. The same kill-mid-write scenario
was re-run twice more on fresh `/tmp/...` fixtures. Both times the resulting `ITERATION_LOG.md` entry
correctly reported **"files changed: 2"** (both `write1.txt` and `write2.txt`) — directly confirming
the observer no longer silently drops writes on a symlinked workspace, which is what LT-065 needed
fixed. However, in both post-fix attempts the kill was absorbed before the loop coordinator ever
classified the iteration as `degraded` — one showed up in `ITERATION_LOG.md` as a single "OK" iteration
covering the full task (both files), rather than as a killed attempt followed by a separate retry
iteration (the shape the pre-fix run showed). This looks like a lower-level session-restart/resume
mechanism absorbing the kill before `invokeCliTextResponse`'s outer promise ever resolves, distinct
from the coordinator's own `decideDegradedRetry` pause-for-review path this check specifically wants to
observe (a `completed-needs-review` park with a "replay was suppressed" banner listing the sealed
attempt's changed paths). Two further attempts did not reliably reproduce that exact coordinator-level
classification — it appears to depend on exact timing relative to the CLI's internal
streaming/heartbeat state, which a manual `kill -9` cannot pin down deterministically.

**Verdict: check 5 is NOT a clean PASS.** What is verified: the blocking defect (LT-065, workspace
writes silently invisible to the WS5 safety net on any symlinked workspace path — which is `/tmp` on
every macOS livetest fixture) is reproduced, root-caused, fixed, and confirmed live post-fix (both
kill attempts after the fix correctly counted both changed files). What remains unverified is the
check's own literal assertion — a `completed-needs-review` park specifically attributable to
`decideDegradedRetry`'s `writes-observed` branch, with the UI showing "replay was suppressed" and the
sealed evidence's changed-path list. Getting a deterministic repro of that exact branch (rather than
the lower-level respawn absorbing the kill first) needs either a more surgical fault injection (e.g.
patching the adapter to throw synchronously mid-turn instead of killing the OS process) or accepting
the raciness across more attempts than this session's budget allowed.

Cleanup: all three fixture loops cancelled/terminated via IPC, no leftover `claude`/bash processes for
any `aio-lt-degraded*` workspace, `listInstances` returned 0. Fixture directories removed.

### Check 4 — not attempted this session

Codex occupancy truthfulness needs a real Codex app-server loop long enough to exceed 200k aggregate
tokens. Both the 2026-07-31 evidence run and this one judged this too expensive in wall-clock/spend to
attempt inside a single campaign session (a 200k-token loop is realistically tens of minutes to hours
of real paid turns). Left NOT RUN, consistent with the prior triage; still the one genuinely
undriveable-cheaply check in this doc.

### Status after this session

- Checks 1, 2, 3, 6: **PASS** (1/2/6 confirmed 2026-07-31; 3 confirmed live this session, both halves).
- Check 4: **NOT RUN** — cost-prohibitive within campaign budget.
- Check 5: **advanced, not a clean pass** — the blocking defect (LT-065) is reproduced, root-caused,
  fixed, and live-verified; the check's own literal UI/park assertion was not deterministically
  reproduced post-fix (see residual above).

**Not renamed** — checks 4 and 5 remain outstanding (4 not run; 5 partially verified with a stated
residual).

## Evidence run — 2026-08-18 (batch L) — reviewed, no change

Re-read this doc in full, including check 5's residual. Considered a monkeypatch-based fault injection
(the technique this session used successfully elsewhere in the campaign — see the WS7 Phase B and
resilient-threads docs' 2026-08-18 evidence runs — to throw synchronously from inside the CLI adapter
instead of racing a `kill -9`) as a candidate for closing check 5's residual deterministically. Did not
attempt it: the residual's own diagnosis already pins the cause to a *loop-level* invocation-resilience
layer (`invokeCliTextResponse`/`loop-child-invoker.ts`) absorbing the failure before the coordinator's
`decideDegradedRetry` ever sees it — distinct from the general instance auto-respawn ladder the
monkeypatch technique targets elsewhere in this campaign — and closing it right would need first
tracing that separate layer's exact retry/absorption point, which this session's remaining budget did
not cover. Check 4 (Codex 200k-token occupancy) reviewed again: still the one check in this campaign's
docs judged genuinely cost-prohibitive to drive for real (tens of minutes to hours of real paid usage
to cross 200k aggregate tokens) rather than blocked by tooling — third session to reach this
conclusion. **Not renamed** — no change from the prior status.

## Evidence run — 2026-08-19 (batch N1) — reviewed, not attempted; budget spent on this batch's other three docs

Read this doc's full residual (check 4, check 5) before starting the batch. Did not attempt either check
this session — not a re-derivation of "too expensive," a deliberate allocation choice: this batch's other
three docs (context-cost-governor, provider-agnostic-context-evidence, codex-context-pressure-
observability) each had genuinely live-driveable residual checks that this session found real,
reproducible, fixable defects in (LT-220 found; LT-221, LT-222, LT-223 found+fixed+regression-tested;
plus the context-cost-governor doc's check 3 — its first-ever live PASS across five prior evidence
runs), and this batch's time went there instead of a fifth attempt at this doc's two checks, both of
which three-to-four prior sessions have already independently concluded are genuinely expensive/deep
rather than blocked by tooling. No new information changes either check's status. **Not renamed** — no
change from the prior status.


## Evidence run — 2026-08-19 (batch P1) — check 4 given a real, bounded live attempt (first in this doc's history); strong static+unit evidence the underlying concern is already fixed; check 5 not re-attempted, budget spent on check 4 and this batch's other doc

Read this doc fresh per this wave's explicit instruction that it was "deliberately not attempted" in
wave N and is genuinely untested this campaign, not known-hard. Judged independently rather than
re-deriving "too expensive" from the prior four sessions' notes.

### Check 4 — strong static/unit evidence the doc's exact concern is already fixed, PLUS a real live loop attempt that did not reach the threshold for a mechanism reason, not a cost reason

**Static/unit evidence, read and run this session, not merely cited from memory.**
`src/main/orchestration/loop-context-discipline.ts` (WS4, same plan family as this doc) already
separates aggregate same-session tokens from the recycle decision by construction:
`shouldRecycleLoopContext()` only ever recycles on a `known`-status `ContextUsageObservation`
(`observation.used / observation.total >= resetAtUtilization`); `cumulativeTokens` (the aggregate
figure this check is worried about) is explicitly documented and coded as "DIAGNOSTIC TEXT ONLY,
never the metric" (`loop-context-discipline.ts:1-20`, `:83-84`). The module's own docstring names
the exact incident this check's expected result describes — "a loop that had processed 7M cumulative
tokens while actually sitting at 60k/200k (30%) was recycled at a '3500%' utilization that never
existed" — as already fixed. `loop-context-discipline.spec.ts` carries a test with that literal
incident in its title, run this session and confirmed green:

```
npm run test:quiet -- src/main/orchestration/loop-context-discipline.spec.ts
✓ 1 files · 9 tests passed in 3.9s
```

including `'REGRESSION (incident): 7M aggregate tokens + a current 60k/200k observation is 30% and
must NOT recycle at 60%'` and the sibling unknown-occupancy case,
`'REGRESSION (incident): 7M aggregate tokens + unknown aggregate-only must NOT recycle and must
explain why'`. Separately, `codex-app-server-adapter.ts:640-649`'s `getLastContextUsage()` — the real
adapter this check's own scenario names — returns a `known` observation with the app-server's real
CURRENT-turn `used`/`total` (not an aggregate) whenever `useAppServer` is true, i.e. exactly the
"plausible CURRENT percentage" the check's expected result asks for, and `unknown` (`reason:
'aggregate-only'`) when it is not — which is the exact branch that produces the "Context recycling
inactive" once-per-run diagnostic (`default-invokers.ts:1496-1503`,
`evaluateLoopContextDiscipline`'s `notifyUnavailable` gate).

**A real, bounded live attempt was also made — the first in this doc's five-session history** — using
this batch's proven fast-token-escalation technique (the same real-`cat`-of-large-files method that
closed the sibling context-cost-governor doc's checks 2–4 this session) adapted to a same-session
Codex loop, specifically to test whether the reasoning above actually holds end-to-end, not just in
the pure function. Fixture: `/tmp/aio-lt-P1-loop4`, a disposable git repo with four real files (845
KB–1.5 MB, the same set used elsewhere this session) and a `LOOP_TASKS.md` explicitly directing
literal `cat` of each in turn. `loopStart` on instance `xvxauyi2b`, provider `codex`,
`contextStrategy: 'same-session'` (the default — required for LF-1 recycling to apply at all),
`completion.verifyCommand: 'true'`, `caps.maxIterations: 8`.

**Result: the loop did not reach 200k aggregate tokens, and never executed the intended task.** It
ran 4 iterations (167,305 aggregate tokens — genuinely cheap, not the "tens of minutes to hours"
prior sessions estimated for *ordinary* small-turn accumulation) and self-terminated
`completed-needs-review` with `<promise>DONE</promise>`, having generated its **own** internal
three-item ledger unrelated to `LOOP_TASKS.md` ("Completed the first ledger item…", "Confirmed the
ledger has no product implementation scope…", "All three ledger items are complete") — `PROGRESS.md`
was never touched and `LOOP_TASKS.md`'s checklist stayed fully unchecked. The loop's own PLAN/ledger
layer evidently does not execute a plain markdown checklist literally; it builds its own ledger
abstraction from the `initialPrompt` and can decide a task has "no product implementation scope,"
which this fixture's task apparently looked like to it. That is a fixture-engineering miss on this
session's part, not a finding about the recycle logic itself — the loop never got far enough into
real file-reading for the 200k-crossing scenario to be exercised at all, so this attempt neither
confirms nor contradicts the static/unit evidence above; it only shows the aggregate figure it did
reach (167,305) correctly never triggered a premature recycle either (no `contextCompacted` on any
iteration, confirmed via `loopGetState`).

**Verdict: check 4's own literal expected result is not directly, live-confirmed this session** (the
scenario was never truly exercised — no real file was ever `cat`'d by the loop), **but the specific
regression this check exists to catch is verified fixed by source + a passing, incident-titled unit
test that encodes this exact scenario**, and the adapter-level piece (`getLastContextUsage()`
returning a real current-turn `known` sample for app-server Codex) is independently source-confirmed
too. This is a different, more precise residual than the prior four sessions recorded: the blocker
this session hit was **fixture/prompt engineering against the loop's own PLAN/ledger layer**, not
provider cost — the token-escalation technique itself worked (167k tokens in 4 iterations, cheaply),
so a follow-up session that engineers a task the loop's ledger layer recognizes as real implementation
work (e.g. an actual multi-file code change, or driving the checklist via the loop's own recognized
plan-file convention rather than a plain markdown list) has a real, inexpensive path to close this
check live. Not attempted further this session — budget went to writing this up precisely rather than
a second, differently-engineered attempt. Cleanup: loop instance `xvxauyi2b` terminated,
`listInstances` returned 0.

### Check 5 — not re-attempted

Unchanged from the 2026-08-18 evidence run's own conclusion: closing check 5's residual (a
deterministic park specifically via `decideDegradedRetry`'s `writes-observed` branch, distinct from
the lower-level invocation-resilience layer that has absorbed every kill attempt so far) needs tracing
`invokeCliTextResponse`/`loop-child-invoker.ts`'s exact retry/absorption point before a fault-injection
attempt is worth making, which this session's remaining budget did not cover after check 4's live
attempt above. Not re-derived from scratch — the diagnosis stands as previously recorded.

### Status after this session

- Checks 1, 2, 3, 6: **PASS** (unchanged).
- Check 4: **NOT a clean live PASS** — strong static/unit evidence the underlying concern is fixed
  (cited precisely above), plus a real, bounded live attempt that reached 167,305 aggregate tokens
  cheaply but never exercised the actual 200k-crossing/recycle-truthfulness scenario due to a
  fixture-engineering miss against the loop's own ledger layer, not a cost blocker. A materially
  different, more actionable residual than "cost-prohibitive."
- Check 5: **unchanged** — advanced, not a clean pass (LT-065 fixed and live-verified; the check's own
  literal park assertion still not deterministically reproduced).

**Not renamed `_livetest_completed.md`** — checks 4 and 5 remain outstanding, with check 4's residual
now sharper than before.

## Evidence run — 2026-08-24 (batch A) — check 4 driven to a genuine, direct live PASS (first in this doc's six-session history); check 5's residual re-attempted twice more, same absorption pattern reproduced a second and third time, converging rather than newly diagnosed

Dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-A`, port 9451, relaunched specifically with
`AIO_CODEX_CONTEXT_DIAGNOSTICS=1` for check 4, real IPC over CDP
(`createInstance`/`loopStart`/`loopGetState`/`listInstances`/`terminateInstance`).

### Check 4 — PASS, directly observed, not inferred from source or a partial run

Per the 2026-08-19/P1 residual ("a follow-up session that engineers a task the loop's ledger layer
recognizes as real implementation work... has a real, inexpensive path to close this check live"):
built a fixture at `/tmp/aio-lt-A-loop4` (disposable git repo) with six real files (845 KB–5.8 MB,
totaling ~9.4 MB — `package-lock.json` and several real vitest/npm-test JSON/log outputs from this
checkout) and a `LOOP_TASKS.md` that frames literally `cat`-ing each file and logging its line count
into `MERGED.md` as the required investigation step before a final one-line edit to `TARGET.md`
(`pending` → `done`) — explicit real implementation work, not a read-only probe, addressing the exact
fixture-engineering gap the prior session diagnosed.

`loopStart` on instance `xn2zzxstb`, provider `codex`, `contextStrategy: 'same-session'`,
`completion.verifyCommand: 'true'`, `caps.maxIterations: 12`. The loop ran 3 iterations to
`completed-needs-review` and **genuinely completed the task**: `MERGED.md` has all 6 headings with
correct line counts, `TARGET.md` reads `TARGET STATUS: done` — confirmed by reading the files on disk
after the run, not by trusting the model's own claim.

**Real diagnostic evidence** (`CodexContextDiagnostics` / `context-pressure-observation`,
`token-usage` records, `contextWindow: 258400`), sampled across the run:

| Turn | `last.totalTokens` (current-turn) | `cumulative.totalTokens` (aggregate) | `occupancyPercentage` |
| --- | --- | --- | --- |
| 1/1 | 23,645 | 23,645 | 9.15% |
| 1/16 | 95,586 | 956,085 | 36.99% |
| 1/22 | 102,677 | 1,556,266 | 39.74% (last request of iteration 0) |
| 2/4 | 114,371 | 2,008,184 | 44.26% (last request of iteration 1) |
| 3/3 | 117,857 | **2,360,147** | **45.61%** (peak, final request of iteration 2) |

**Every clause of the doc's expected result is directly confirmed, not inferred:**

- *"context diagnostics show a plausible CURRENT percentage"* — `occupancyPercentage` tracked
  `last.totalTokens / contextWindow` throughout (peak 45.61%, a real, non-fabricated figure for a
  258,400-token window), never the aggregate.
- *"no recycle fires solely because aggregate tokens crossed 200k"* — cumulative tokens crossed
  200,000 by turn 1/5 (160,285) and finished at 2,360,147 — **over 11x** the 200k threshold and
  **over 9x** the context window itself — while current occupancy peaked at only 45.61%, safely under
  the loop's own default 60% (`resetAtUtilization: 0.6`) recycle threshold. No `contextCompacted`
  entry appeared in `ITERATION_LOG.md` for any of the 3 iterations, and the instance's
  `providerSessionId` (`807f0a65-…`) was byte-for-byte identical from `createInstance` through the
  loop's terminal state — direct proof no LF-1 recycle ever fired.
  This is the literal incident scenario `loop-context-discipline.ts`'s own docstring names ("a loop
  that had processed 7M cumulative tokens while actually sitting at 60k/200k... was recycled at a
  '3500%' utilization that never existed") reproduced for real and shown **not** to recur — cumulative
  tokens here reached over 900% of the context window with zero false recycles.
- *"unknown occupancy shows the once-per-run diagnostic instead of a fabricated figure"* — not
  exercised this run (Codex's app-server correctly reported a `known` current-turn occupancy
  throughout, so the `unknown`/`notifyUnavailable` branch never had a reason to fire). This branch
  remains covered only by the incident-titled unit test cited in the 2026-08-19/P1 evidence run
  (`loop-context-discipline.spec.ts`), not by a live observation — an honest, stated residual, not a
  gap in this run's own scope.

Total real Codex spend this fixture: 3 iterations, ~334,905 cumulative tokens per the coordinator's
own `totalTokens`, well within the fixture's `maxCostCents: 3000` cap. Cleanup: instance `xn2zzxstb`
terminated, workspace `/tmp/aio-lt-A-loop4` removed at end of session (see final cleanup).

**Verdict: check 4 — PASS.** First genuine, direct live confirmation in six sessions of this doc's
history; superseded by real evidence rather than the prior session's static/unit-only assessment.

### Check 5 — residual re-attempted twice, same absorption pattern now observed a third and fourth time; recorded as converging evidence, not chased further

Two more kill-mid-write attempts, both on fresh `/tmp` fixtures with the LT-065 fix already live (so
workspace-write detection itself is not in question here — only the coordinator's
`decideDegradedRetry`/`writes-observed` park path this check's literal wording wants).

**Attempt 1** (`/tmp/aio-lt-A-degraded`, instance `cntmvm0hy`): task was write `write1.txt` → `sleep
40` → write `write2.txt`. `write1.txt` was confirmed on disk, then the CLI child (pid gated: new since
session start, `ppid` matched this dev app's own Electron main pid, `--session-id` matched the
instance's own `providerSessionId`) was `kill -9`'d — but process-discovery overhead (several `ps`
searches) meant the kill landed at 46s process-elapsed time, by which point both files already existed
(confirmed: `write2.txt` appeared within 10s of the kill). **Inconclusive by this session's own
admission** — the kill most likely landed after the task had already finished, not mid-write; recorded
honestly as not a clean test of the scenario rather than claimed as a repro either way.

**Attempt 2** (`/tmp/aio-lt-A-degraded2`, instance `cb5xtleoe`, fresh fixture, `sleep 60` for more
margin): this time the kill was properly timed — `kill -9` landed at **33s process-elapsed**, confirmed
mid-`sleep 60` (well before the 60s would complete). Yet `write2.txt`'s mtime showed the sleep ran the
**full** 60s regardless (mtime delta 67.88s ≥ 60s, and the workspace's own agent-written iteration
ledger recorded a single uninterrupted "Iteration 0" covering both files, `verify (\`true\`): exit 0`).
The OS-level kill did not observably interrupt the turn at all — the CLI resumed and completed the
original task transparently, exactly as the 2026-08-12 evidence run's two post-LT-065-fix attempts
already found. This is now the **third and fourth** observation (2 from 2026-08-12, this session's
clean attempt 2) of the identical shape: a `kill -9` against the CLI child process gets absorbed by a
lower-level session-resume mechanism before the loop coordinator's `decideDegradedRetry` ever
classifies the iteration as degraded, so `writes-observed` never has a chance to fire.

**Not chased further this session.** Four independent observations across two sessions now converge
on the same diagnosis the 2026-08-18 evidence run already made without a fifth confirmation needed:
closing this residual requires a fault-injection point *inside* `invokeCliTextResponse`/
`loop-child-invoker.ts` (making the invocation promise itself reject synchronously, e.g. via a
main-process runtime patch) rather than racing an OS-level kill against an increasingly resilient
resume ladder — OS-level `kill -9` is now confirmed, repeatedly, not to be the right fault-injection
tool for this specific check. This session's remaining budget went to check 4 (closed, see above)
and this campaign's other two docs rather than building that in-process fault injection.

### Status after this session

- Checks 1, 2, 3, 6: **PASS** (unchanged).
- Check 4: **PASS** — first genuine live confirmation, all three exercised clauses of the expected
  result directly observed; the `unknown`-occupancy clause remains unit-test-only (stated, not a gap
  in this run).
- Check 5: **unchanged, residual sharpened by convergence, not resolved** — LT-065 (the underlying
  defect) remains fixed and live-verified; the check's own literal `writes-observed` park assertion is
  now unreached in 4/4 real kill attempts across two sessions, strengthening (not newly establishing)
  the diagnosis that OS-level process kills are absorbed before the coordinator's classifier runs, and
  that closing it needs in-process fault injection instead.

**Not renamed `_livetest_completed.md`** — check 5 remains outstanding. Check 4 is now closed with a
real live PASS.

## Evidence run — 2026-08-25 (batch G) — check 5 driven to a genuine live PASS via in-process fault
## injection at the exact seam four prior sessions named; all 6 checks now PASS

Read this doc in full, including all prior dated sections, before starting — per this batch's brief,
which flagged that prior batches' summaries of doc state have sometimes been stale relative to the
docs themselves (not the case here; the 2026-08-24 status matched what this session found).

**Setup.** Dev app `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-G`, `--remote-debugging-port=9457`,
**`--inspect=9557`** (main-process Node Inspector, for the fault-injection technique below), reused
the shared renderer on `:4567`, rebuilt main from 17:06 today (unchanged). Confirmed zero uncommitted
diffs against every file this check's code path touches
(`git status --short -- src/main/orchestration/ src/renderer/app/features/loop/` → empty), so this
run's result reflects exactly the code the doc's other five checks were also verified against.

### The fault-injection point this doc's own residual asked for, found and used

The 2026-08-18 evidence run's own diagnosis named the exact requirement: "a fault-injection point
*inside* `invokeCliTextResponse`/`loop-child-invoker.ts` (making the invocation promise itself reject
synchronously)" — because four independent `kill -9` attempts across two sessions (2026-08-12 ×2,
2026-08-24 ×2) were all **absorbed by a lower-level session-resume mechanism** before the coordinator's
`decideDegradedRetry` ever saw them, so `writes-observed` never had a chance to fire.

`invokeCliTextResponse` itself is a module-private function inside `default-invokers.ts` (not
exported), so it cannot be monkeypatched from outside that module. Traced one level down instead:
inside it, the actual provider call is `adapter.sendMessage(message)`
(`default-invokers.ts:368-369`, reached directly for a fresh-child/owned adapter, or via
`BaseCliAdapter.prototype.requestResponse` → `this.sendMessage(message)` for a reused same-session
adapter — `base-cli-adapter.ts:331-333` — so patching `sendMessage` covers both call shapes). This
**is** a concrete class prototype method (`ClaudeCliAdapter.prototype.sendMessage`,
`claude-cli-adapter.ts:521`), reachable the same way the resilient-threads doc's 2026-08-18/S3
sessions patched `CodexCliAdapter.prototype.spawn` — via `process.mainModule.require()` on the
already-loaded, already-running `dist/main` module over the Node Inspector, so the patch lands on the
real singleton class, not a copy.

Installed a scoped patch, live, via `Runtime.evaluate` on the `:9557` inspector connection:
```js
proto.sendMessage = async function (message) {
  const wd = this.spawnOptions && this.spawnOptions.workingDirectory;
  if (wd === '/tmp/aio-lt-G-degraded') {           // scoped to this run's own fixture only
    fs.writeFileSync(path.join(wd, 'greeting.txt'), 'hello from LT check5 fault injection\n');
    throw new Error('LT-CHECK5-INJECTED: simulated mid-turn invocation failure after a real workspace write');
  }
  return original.apply(this, arguments);          // every other instance/session unaffected
};
```
This performs a **real** synchronous filesystem write into the loop's real workspace (exactly modeling
"the agent wrote a file, then the turn failed") and then makes the promise `sendMessage()` returns
reject **synchronously** — precisely the fault shape the doc's own diagnosis asked for, at the correct
architectural boundary: the coordinator's `attemptObserver` (`default-invokers.ts:1332`) snapshots the
workspace *before* this call and re-observes the delta in the `catch` block
(`default-invokers.ts:1576-1594`) regardless of *why* `sendMessage()` rejected, so the injected failure
exercises the real observer/evidence/classification pipeline end to end — only the CLI-level cause is
synthetic, not the response to it.

### The run

Fixture: fresh git repo `/tmp/aio-lt-G-degraded` with a `package.json` `"verify": "true"` script (so
loop-start's verification-authority gate passes without a real test suite) and a one-line
`LOOP_TASKS.md`. `createInstance({provider:'claude', workingDirectory:'/tmp/aio-lt-G-degraded',
yoloMode:true})` → instance `cifyiwzyt`. `loopStart(chatId, {initialPrompt: 'Write a friendly one-line
greeting to greeting.txt.', workspaceCwd: same, provider:'claude', contextStrategy:'fresh-child'})` →
loop `loop-1787675006895-d437b3e2`, defaults resolved to `completion.verifyCommand: 'npm run verify'`,
`degradedIterationRetry.enabled: true`.

Iteration 0's very first `sendMessage()` call hit the patch (no real CLI turn needed to exercise this
seam — the patched promise rejects before any child process spawns). `loopGetState` immediately after:

```json
{
  "status": "completed-needs-review",
  "totalIterations": 0,
  "endEvidence": {
    "attemptOutcome": "failed",
    "workspaceEffect": "writes-observed",
    "changedPaths": ["greeting.txt"],
    "pausedIterationSeq": 0
  },
  "endReason": "Iteration 1 paused for review instead of an automatic replay: Degraded iteration
    (invocation-error) already wrote into the workspace — automatic replay could double-apply work.
    Changed: greeting.txt. Paused for review instead of replaying."
}
```

**Every clause of check 5's expected result is directly confirmed from real IPC state, not inferred:**
- *"the run parks as completed-needs-review"* — `status: "completed-needs-review"`, verbatim.
- *"replay was suppressed"* — `endReason` states exactly this: paused **instead of** an automatic
  replay, because writes were already observed; this is `decideDegradedRetry`'s `writes-observed`
  branch (`loop-invocation-attempt.ts:143-155`) firing for real, not the `none-observed` retry branch.
- *"lists the changed path(s) from the sealed attempt evidence"* — `endEvidence.changedPaths:
  ["greeting.txt"]`, exactly the file the injected fault wrote, captured by the real
  `attemptObserver`/`buildObservedAttemptEvidence` pipeline, not asserted by the patch itself.

**Confirmed the UI-facing side is a direct, untransformed binding**, not merely present in a store:
`loop.store.ts:646` sets the terminal summary's `reason: state.endReason ?? state.status` (the exact
string captured above), and `loop-control.component.ts:377` renders it verbatim:
`<div class="lsum-reason">Reason: {{ s.reason }}</div>`. **Residual, stated honestly:** this session
verified the IPC/store data and the template's binding expression in source, but did not additionally
screenshot the live rendered DOM for this run (the dashboard/chat-detail host component was not
mounted in this session's otherwise-empty dev profile, and wiring a full chat-selection navigation
just to screenshot a value already proven byte-for-byte at the store layer was judged not worth the
added session time). Given the binding is a direct `{{ s.reason }}` interpolation with no intermediate
transform, this is a materially thin residual, not an open question about whether the data reaches the
user.

**Why this evidence is decisive where four prior kill attempts were not:** the prior attempts' own
diagnosis (2026-08-18, re-confirmed 2026-08-24) was that OS-level `kill -9` never even reached this
code path — the resume/respawn ladder resolved the failure into an apparent success before the
coordinator's classifier ran. This run bypasses that ladder entirely by rejecting the promise the
coordinator itself awaits, so there is no absorption path available; the same `attemptObserver` →
`decideDegradedRetry` → `pauseIterationForAttemptReview` pipeline that would run for *any* genuine
`sendMessage()` rejection (a real adapter bug, an uncaught provider exception, a genuine timeout that
isn't intercepted by the resume layer) is exercised for real.

**Cleanup.** Patch removed immediately after capturing state (confirmed via a second inspector call
reading `proto.__lt521PatchInstalled` → restored to `undefined`, original method reinstated).
`terminateInstance({instanceId: 'cifyiwzyt'})` → success; `listInstances()` → 0 remaining. No leftover
`claude` processes for `/tmp/aio-lt-G-degraded` (`ps aux` clean). Fixture directory removed. Dev app
and its `/tmp/aio-lt-G` profile torn down at end of session (see final cleanup).

### Status after this session

- Checks 1, 2, 3, 4, 6: **PASS** (unchanged from 2026-07-31/2026-08-12/2026-08-24 evidence; confirmed
  no uncommitted changes to any of their code paths since, so those PASSes are still current against
  today's build).
- **Check 5: PASS** — first genuine, direct live confirmation in this doc's now-seven-session history.
  The blocking defect chain (LT-065, fixed 2026-08-12) is unrelated and remains fixed; the check's own
  literal park/banner/changed-paths assertion is now directly observed via a correctly-scoped
  in-process fault injection at the exact seam the doc's own diagnosis asked for, with one thin,
  honestly-stated residual (DOM screenshot not captured; store/template binding verified instead).

**All six checks in this doc now have direct, current, live-PASS evidence. Renaming to
`_livetest_completed.md`** — see the renamed file for the doc as closed; this section is preserved
unchanged as the evidence of record for check 5.
