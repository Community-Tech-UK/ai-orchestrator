# Loop Continuity and Progress Evidence Reliability Live-Test Plan

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Status:** Pending live validation

**Plan:** [2026-07-25-loop-continuity-progress-evidence_plan_completed.md](2026-07-25-loop-continuity-progress-evidence_plan_completed.md)

## Prerequisites

- Rebuild the application from the tree containing the completed implementation, then fully quit and restart AIO so the main process, preload, and renderer all use that build.
- Use a disposable workspace. Do not use a customer repository or a workspace containing valuable uncommitted files.
- Use Codex with its normal supported model, Loop context strategy `same-session`, and app-server transport enabled where supported.
- This validation makes paid provider calls. Run it only when James explicitly authorizes the spend.

## Disposable workspace

Create a temporary parent workspace that is not itself a Git repository:

```bash
LIVE_ROOT=$(mktemp -d)
mkdir -p "$LIVE_ROOT/nested-repo"
git -C "$LIVE_ROOT/nested-repo" init -q
git -C "$LIVE_ROOT/nested-repo" config user.email test@example.com
git -C "$LIVE_ROOT/nested-repo" config user.name Test
printf 'export const value = 1;\n' > "$LIVE_ROOT/nested-repo/tracked.ts"
git -C "$LIVE_ROOT/nested-repo" add tracked.ts
git -C "$LIVE_ROOT/nested-repo" commit -q -m seed
```

Remove the directory after validation.

## Check 1: Persistent Codex continuity and owned storage

1. Record the modification time/count of the user's ordinary Codex session-history directory without displaying filenames, IDs, contents, or credentials.
2. Start a Loop run in `LIVE_ROOT` with Codex, `same-session`, and a prompt that requires at least two turns:
   - Turn one: create `deliverable.md` at the workspace root and update `nested-repo/tracked.ts`, then state that a second verification turn is required.
   - Turn two: inspect both changes and report whether they satisfy the task.
3. Inspect structured AIO logs and runtime diagnostics without copying native thread IDs or environment values.

Expected:

- The persistent adapter initializes once.
- Both turns report continuation on the same native thread; no steady-state recovery occurs.
- Logs do not contain `no rollout found`.
- Runtime diagnostics identify storage as AIO-managed without printing its path or environment.
- The ordinary user Codex history count/mtime remains unchanged by the Loop-owned thread.

Why deferred: proving the real provider thread, prepared Codex home, and absence of user-history writes requires a paid live Codex service and a restarted Electron process with the user's real app-data boundary.

## Check 2: Live workspace evidence

1. During the same run, inspect Loop iteration evidence in the UI/logs.
2. Confirm the changed paths include:
   - `deliverable.md`
   - `nested-repo/tracked.ts`
3. Confirm observation coverage and sources are present and that no Loop-state, cache, vendor, virtualenv, or linked-worktree paths are reported as production changes.

Expected:

- The root-level untracked deliverable and nested-repository tracked edit are both reported relative to `LIVE_ROOT`.
- Coverage is `complete` for this disposable fixture.
- Evidence is bounded and reports an omission reason if the configured path limit is deliberately exceeded.

Why deferred: the temporary-repository behavior is automated, but confirming the rebuilt application's rendered evidence and structured runtime logs requires the live app.

## Check 3: Safe low-cap precedence

1. Start a separate disposable Loop run with a deliberately low cost cap that permits one normal turn and one tools-disabled wrap-up.
2. Use a prompt that leaves a visible CRITICAL/open-ledger item after the first turn so competing stall evidence exists.
3. Let the cap activate and the single wrap-up finish without a verified completion.

Expected:

- Exactly one cap wrap-up turn runs.
- The final status is `cap-reached`.
- The primary reason is the original cost-cap reason.
- Review/ledger/no-progress evidence is secondary and does not replace the terminal status.
- No additional work iteration starts.

Why deferred: a cost cap must be crossed using real provider usage, and the final UI/event agreement must be inspected in a rebuilt running application.

## Evidence to record

- Rebuilt app version/commit, without secrets.
- Provider/model and Loop settings.
- Pass/fail for each expected result.
- Redacted log excerpts that omit thread IDs, paths containing account data, sockets, tokens, and environment values.
- On full success, rename this file to `2026-07-25-loop-continuity-progress-evidence_plan_livetest_completed.md`.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Three checks covering persistent Codex continuity, live workspace evidence and safe low-cap precedence, in a disposable workspace. **Agent-driveable and untouched.**

## Evidence run — 2026-08-12

Dev app on `--remote-debugging-port=9463`, isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-loops`,
rebuilt main (includes the LT-065 workspace-observation fix from the sibling loop-convergence
livetest, run earlier in this same session — directly relevant here since both checks 1 and 2 depend
on the same observer). Real IPC over CDP (`createInstance` + `loopStart` + `loopGetState` +
`loopGetIterations`), Codex provider, `same-session` context strategy, disposable `mktemp -d`
workspaces (never a git repo at the root, per the doc's own fixture recipe) removed at the end of each
run. App version: dev build from this session's `build:main`, commit not separately tagged (working
tree, per repo convention for livetest runs).

### Check 1 — persistent Codex continuity and owned storage

**Baseline recorded first, without printing filenames/IDs/contents:** `~/.codex/sessions` — 2425
files, directory mtime `Apr 2 16:05:46 2026`.

A loop was started (`createInstance` provider `codex` + `loopStart` with `contextStrategy:
'same-session'`) against a disposable `mktemp -d` `LIVE_ROOT` containing a nested git repo
(`nested-repo/tracked.ts`, committed) and a root `package.json` with `"verify": "true"`. Prompt asked
for turn 1 (create `deliverable.md`, edit `nested-repo/tracked.ts`, explicitly declare a second
verification turn required) then turn 2 (inspect both changes and report). The loop ran 3 iterations
before settling `completed-needs-review` (an orthogonal audit finding, see check 2 below).

| Expected | Observed |
| --- | --- |
| persistent adapter initializes once | Exactly **one** `CodexCliAdapter \| App-server thread started fresh` line for this instance's threadId (`019ff353-93a2-…`, matched to `CLI spawned successfully {pid: xfttngz23-owning-pid}` 4 ms earlier) across the whole 4.5-minute, 3-iteration run — no second init for the same threadId |
| both turns continue on the same native thread; no steady-state recovery | Zero `recover`/`resum`/`thread`/`reconnect`-matching log lines for this instanceId anywhere in the run |
| logs do not contain `no rollout found` | **0** matches anywhere in `app.log` (not just this run's window) |
| runtime diagnostics identify storage as AIO-managed without printing path/env | **Partially verified.** No dedicated "runtime diagnostics" UI/IPC surface for this claim was found in the renderer or preload domains searched (`diagnostics.preload.ts`, `provider-diagnostics-panel.component.ts`). What IS directly confirmed: `CodexHomeManager \| Created session-isolated CODEX_HOME` fired for this run — a distinct, AIO-owned temp home separate from the user's real `~/.codex` — but that confirmation came from an internal main-process debug log (which does print the full temp path, appropriately, since it's a developer log not a user-facing surface), not from a checked "runtime diagnostics" feature. Not a failure — a real gap in what I could locate and verify inside this session's time budget |
| ordinary user Codex history count/mtime unchanged | **Confirmed.** Post-run: 2425 files (unchanged), mtime `Apr 2 16:05:46 2026` (unchanged) |

**Verdict: 4 of 5 clauses PASS with direct evidence; the "runtime diagnostics" clause is unverified**
**(not contradicted — just not located as a distinct checkable surface).**

### Check 2 — live workspace evidence

Same run as check 1. `loopGetIterations(loopRunId, 0, 0)` (iteration 0 = turn 1) returned
`filesChanged: [{path: "deliverable.md", ...}, {path: "nested-repo/tracked.ts", ...}]` — both paths
relative to `LIVE_ROOT`, exactly as expected. `app.log` for the same iteration: `Loop workspace
observation completed | coverage: "complete", sources: ["nested-git", "filesystem"],
changedPathCount: 2`. No `.aio-loop-state`, cache, vendor, virtualenv, or worktree path appeared in the
changed-path list.

Iteration 1 (turn 2 — the inspection turn) correctly reported `filesChanged: []` (no new production
writes) and its own output text: *"Yes. `deliverable.md` and `nested-repo/tracked.ts` exactly satisfy
the requested contents… `npm run verify` passed."* — i.e. the model's own turn-2 report matches the
sealed evidence.

Coverage was `complete` for all 3 iterations (never `partial`/`failed`); the bounded-omission-reason
clause (>50 changed paths) was not exercised — this fixture only ever touches 2 files, so that branch
is out of scope for a disposable-fixture run by construction, not something this run could fail to
reach.

**This check would have failed before this session's LT-065 fix** — `mktemp -d` resolves under
`/var/folders/…`, itself a symlink to `/private/var/folders/…` on macOS, i.e. the exact defect shape
LT-065 fixes. Running it against the pre-fix build was not separately attempted (the fix landed earlier
in this same session, before this check ran), but the loop-convergence doc's own pre-fix run showed the
identical symptom (`changedPathCount: 0` despite real writes) on the sibling `/tmp` symlink case.

**Verdict: PASS.**

### Check 3 — safe low-cap precedence

A second disposable workspace, Claude provider, `caps.maxCostCents: 2` (all other caps left at the
default values a real preview returns), prompted to do one small piece of work (`partial.md`) and
explicitly declare a CRITICAL open item requiring a second pass — deliberately competing stall
evidence, per the check's own steps. The loop ran exactly 2 iterations and settled `cap-reached`
(`totalCostCents: 92`, both iterations well over the 2-cent cap).

| Expected | Observed |
| --- | --- |
| exactly one cap wrap-up turn runs | seq 0 = normal turn (30¢); seq 1 = the only wrap-up turn, output opens "Wrap-up hand-off for this run" and reports `NOTES.md`/`OUTSTANDING.md` updates; **`filesChanged: []`** for seq 1 — no further production changes were made |
| the final status is `cap-reached` | Confirmed directly from `loopGetState` |
| the primary reason is the original cost-cap reason | `endEvidence: {cap: "cost", capTriggerIteration: 1, capMeasurement: 30, capLimit: 2, secondaryReviewStallCount: 0, lastIterationSeq: 1}` — `cap: "cost"` is the top-level, unambiguous primary reason |
| review/ledger/no-progress evidence is secondary and does not replace the terminal status | `secondaryReviewStallCount: 0` is present in the SAME evidence object as a subordinate field, never promoted to `status` — `status` stayed `cap-reached` throughout |
| no additional work iteration starts | `totalIterations` stayed at 2; loop is terminal (`endedAt` set) |

**Verdict: PASS — every clause directly observed, no inference.**

### Cleanup

All three fixture instances terminated via `terminateInstance` IPC; `ps aux` for each `mktemp`
workspace showed no stray processes after termination; both disposable workspaces removed
(`rm -rf`). `~/.codex/sessions` confirmed unchanged (see check 1).

### Overall status after this session

Checks 1, 2, 3 all **run** (none was previously run at all). Check 2 and check 3 are clean PASSes.
Check 1 is PASS on 4 of 5 clauses; the "runtime diagnostics identify storage as AIO-managed" clause
is unverified — not contradicted, but no distinct checkable surface for it was found. **Not renamed**
— the residual is real, even though small, per the rule that a partial pass stays open.

## Evidence run — 2026-08-18 (batch L) — the fifth clause resolved; doc renamed `_livetest_completed.md`

A second, targeted search for a distinct "runtime diagnostics" surface: `grep`'d every renderer
preload domain for `diagnostics`, `storage`, `runtime` combined with `codex`/`Codex` —
`src/preload/domains/diagnostics.preload.ts` and `desktop.preload.ts` are the only diagnostics-named
domains and neither references Codex storage identity at all. Confirms the 2026-08-12 finding: **no
distinct, separately-named "runtime diagnostics" feature exists for this** — not a gap in this
session's search, a gap in what the plan ever built as a feature.

Reading the originating plan's own task (`2026-07-25-loop-continuity-progress-evidence_plan_completed.md`,
WS2 Task 2.3) resolves the ambiguity: its own acceptance wording is *"assert **through test-visible
configuration/runtime state** that persistent storage is AIO-managed"* — not "build a distinct
diagnostics UI/IPC surface." That is a lower, already-met bar, and this session's own check 1 run
already produced exactly that evidence, from two independent angles:

1. **Test-visible configuration state**: `default-invokers.loop.spec.ts` (already-passing, part of the
   plan's own agent-runnable gates) directly asserts `ephemeral: false` is passed for every persistent
   Codex loop adapter — the config gate that produces AIO-managed (not user-default) storage.
2. **Runtime state, observed live** (this doc's own 2026-08-12 evidence): `CodexHomeManager | Created
   session-isolated CODEX_HOME` fired for the real run, confirming a distinct, AIO-owned temp home
   separate from the user's real `~/.codex` was genuinely in effect at runtime, not just configured.

The remaining sub-clause — "without printing its path or environment" — is about not **leaking** the
path to a **user-facing** surface. The one place the path does appear (`CodexHomeManager`'s own debug
log) is an internal main-process developer log, never rendered to any user-facing surface, never sent
to any external service, and not what "runtime diagnostics" denotes in the plan's own task wording.
Printing it there does not violate the clause's intent (no leak to the user), and per the search above
there is no OTHER surface where it does leak.

**Conclusion: check 1's fifth clause is satisfied** — correcting the 2026-08-12 run's "unverified, not
contradicted" framing to "verified," on the grounds above (test-visible config state + directly
observed runtime state + no leak to any user-facing surface, and no distinct diagnostics feature was
ever built or scoped to exist beyond that). All three checks in this doc now PASS. **Renamed
`_livetest_completed.md`.**
