# Plan Queue large status reader: loaded-runtime acceptance

Status: ACTIVE, untracked. Open: 1; verified live checks: 1 (check 1 witnessed
14 October 2026; check 2 retains its live witness set but stays open on one
literal clause — see the 14 October acceptance run below).

> **Found a reproduced defect?** Add an `LT-NNN` entry (index row, observed behaviour,
> root cause, required behaviour and acceptance) to
> `docs/plans/livetest-remediation-register.md`, with a matching implementation-status
> section in a new dated follow-up remediation plan, or explicitly reopen the
> historical remediation plan before editing it. Never add content to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md` while closed.
> Keep per-check evidence here. Read `docs/plans/livetest-campaign-runbook.md` first;
> current AGENTS.md routing, authority and verification rules override its older
> Mac fallback, process-kill and bare spec-typecheck examples.

Plan: [coordinator-closed implementation plan](2026-10-10-plan-queue-large-status_plan_completed.md).
Spec: [coordinator-closed specification](2026-10-10-plan-queue-large-status_spec_completed.md).

## Coordinator closure qualification — 13 October 2026

The coordinator accepted the assigned review and integrated only the plan and spec.
Its recorded seven canonical command exits are zero. The review also records a
low-severity finding about the empty implementation diff and unchecked lifecycle
items. A separate fresh completion-gate review is in progress to assess the original
repair and this closure; no finding-free whole-acceptance PASS is claimed here.
Both live checks below remain open. Neither document closure nor a helper's presence
on disk establishes that the serving app executed the required Queue path.

The separate fresh gate has now returned **VERDICT: FAIL** for lifecycle and live
acceptance, with focused source tests passing and no actionable source defect found.
The [active acceptance follow-up](2026-10-13-plan-queue-large-status-acceptance-followup_plan.md)
owns those unresolved findings and preserves the closed historical records.

## Prerequisites and authority

Target the existing packaged Harness instance and the eligible Community Tech Queue
run rooted at `/Users/suas/work/communitytech/work-finding`. This worker has authority
to inspect and test source, not to replace or restart Harness, interrupt active
sessions, control another parent's Queue run, promote a stale candidate or waive
native review. Harness is a hard-denied desktop-control target. James must coordinate
any necessary app restart; an authorised surviving parent may perform supported Queue
controls without a new routine approval. Parent availability and candidate readiness
are technical prerequisites, not automatically human-only actions.

The installed archive already contains the reader as of 13 October 2026. Do not
install the historical 10 October ZIP solely because the old plan proposed it.
First establish the current loaded generation. If a rebuild/restart is necessary,
use the current normal build/package route after independent verification and
James's authority for adoption/timing; preserve active handovers and live user data.
Quitting calls synchronous process termination and asynchronous Queue/instance
shutdown (`src/main/index.ts`, `src/main/process/harness-shutdown-operations.ts`).
No flags or settings need changing for these checks. Do not enable debug ports,
relax safety settings, rewrite Queue metadata or edit ignore rules to obtain a pass.
Any browser work explicitly targets `windows-pc` through the Browser Gateway after
worker/browser preflight. No local Mac UI launch or automation is authorised here.

## 1. Qualify the generation actually serving the Queue

- [x] Obtain current runtime evidence tying the serving Harness process to a build
containing `git-status-stream.js` and both streaming calls in
`worktree-integration.js`. Retain the process/build identity, startup observation
and module pins, with timestamps and the route used to obtain them. Disk hashes
alone, version `0.1.0`, an available `plan_queue_status`, or a separate Node helper
execution do not identify loaded memory. If the current supported read surfaces
cannot establish this, have James coordinate a normal quit/reopen of the already
qualified current app after preserving active work; record the resulting startup
and serving-instance evidence. A worker must not kill or relaunch Harness itself.

Result (14 October 2026, witnessed): the serving generation is established and no
restart proposal is required. Process/build identity: `lsappinfo list` reports
Harness, bundle `com.ai.orchestrator`, pid 79185, executable
`/Applications/Harness.app/Contents/MacOS/Harness`, foreground (receipt
`runtime-generation.json`). The helper family's full command lines — retained via
`pgrep -fl` in `process-args-pgrep.txt` (route note: `ps`/`top` are TCC-blocked on
this host while `pgrep` full-cmdline listing works) — show the renderer carrying
`--app-path=/Applications/Harness.app/Contents/Resources/app.asar`, and 241 app.log
stack frames resolve `/Applications/Harness.app/Contents/Resources/app.asar/dist/main/…`
module paths (116 in the pre-restart process window, 125 in the current one;
`app-asar-stack-binding.json`), directly binding both processes' loaded main
modules to the installed archive.
Startup observation: LaunchServices check-in 2026-10-14 14:08:32 +0100, the
Electron `SingletonLock` target `MacBook-Pro-4.local-79185` (with matching
`SingletonCookie`/`SingletonSocket` mtimes), and the app's own `App: Initializing
Harness` log line at 14:08:32 +0100 all agree. Module pins: the bound archive
(mtime 2026-10-14 14:00:28 +0100, 479,052,042 bytes — eight minutes before
startup) yields `git-status-stream.js` SHA256
`3050d71e62c6e66493caed244a60b72e4865b55eeca3d36f59b0ba2a0a6a563b` and
`worktree-integration.js` SHA256
`a4dd5357680d7c2a41cab1f39b290bf14cc2e622a5a193d35664b0d9f286cbe1`, both
byte-identical to the freshly compiled worktree build and both containing the
streaming import and its two call sites. Ordering: archive mtime precedes process
startup, so the loaded main code comes from those bytes; the prior app process
(started 2026-10-13 23:40:42 +0100, banner in `app.log.1`) began after the
repaired archive was first pinned on 13 October and serves the same byte-identical
repair modules. Post-startup behaviour corroborates the wiring: the live Queue
executed `promoteIntegrationBranch` (the caller of both streaming reads) at
16:28:08 and 17:14:08 +0100 (check 2 evidence). Limits retained: `ps`/`top`
process queries remain TCC-blocked (`Operation not permitted`) and no
loaded-module introspection surface exists, so the binding rests on process
identity + startup ordering + bundle path + module pins + executing-path
behaviour, not require-cache introspection. Full receipts:
`_scratch/plan-queue-large-status-acceptance-20261014/runtime-generation.json`
and `asar-module-pins.json` (root checkout, ignored).

## 2. Exercise the real large-checkout Queue path

- [ ] From the authorised Community Tech parent, call `plan_queue_status` to identify
  the current run, item, branch and prospective candidate. Recheck native/ownership
  review and candidate freshness; do not reuse the parked Supply candidate merely
  to trigger the reader. Measure and retain the successful raw status stream using
  `rtk proxy git --no-optional-locks -C /Users/suas/work/communitytech/work-finding status --porcelain=v1 -z --untracked-files=all` with binary stdout redirected to
  an ignored evidence file; preserve its exit code, byte count and hash. It must
  exceed 10 MiB at the actual Queue inspection. Record root HEAD/index and hashes
  of operator-owned paths before proceeding. If a currently eligible verified item
  exists, its parent may use supported normal Queue lifecycle (`resume-item` only
  when applicable), retain the resulting status/log evidence and inspect the landed
  diff or named safety blocker. Never use `land-anyway`, manual promotion or ref
  edits. If no eligible candidate exists, keep this check open with that prerequisite.

Expected: the live Queue reaches root status/overlap inspection and handles the
whole >10 MiB listing without `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` or either
inspection-error blocker. A real overlap must still name the conflicting path and
preserve root HEAD/index/operator bytes. A nonoverlapping eligible item may land
only through ordinary verifier/ownership/hook gates; its diff must contain only
its owned verified work and closed documents. A different earlier blocker does not
prove that the reader executed. Correlate the run/item and timestamps with check
1's serving generation. Retain before/after operator-byte and index evidence; an
authorised landing may advance HEAD and its expected tracked paths.

Status after the 14 October 2026 acceptance run: kept OPEN on one literal clause,
with the live witness set retained. What is witnessed (see
`_scratch/plan-queue-large-status-acceptance-20261014/` in the root checkout,
ignored):

- Run identification: `plan_queue_status` shows run
  `f0779c05-045d-4f52-9ad7-b71c9235366e` (plans, `/Users/suas/work/communitytech/work-finding`,
  base `main`, running). Eligible independently reviewed items are real: item
  `f5af6275` `desk-colleague-sending_plan` (verdict PASS after 5 rounds) LANDED at
  16:28:08 +0100 and item `4c06bf72` `ingress-accepted-precondition_plan` (verdict
  PASS after 3 rounds) LANDED at 17:14:08 +0100, both through the ordinary
  verifier/hook/ownership path (`landItemBranch` → `promoteIntegrationBranch`,
  `dirtyRootPolicy: 'block-overlap'`); three further verified PASS candidates
  (`desk-crm-links-and-basic-removal` r4, `desk-fast-deploys` r1,
  `desk-schema-release` r5) remain parked `land-blocked` with named-path blockers.
  No stale Supply candidate was reused; `research-supply-native-review-repair`
  stays untouched in `queued`. No `land-anyway`, metadata edit, ref edit or
  ownership bypass occurred. The run's parent is session `ih4422nvd` (children
  spawned under it from 00:41:14 +0100; its history entry
  `ea95d2ed-4dd6-45a3-898e-a9d0922d0a00` survives app-startup archiving and is
  restorable), and the run keeps coordinating (workers provisioned through 17:14).
- Executing Queue inspection, whole large listing, real checkout: with the
  >10 MiB listing present (44,462,226 bytes measured 13 October; the 7.6 GB /
  131,725-file evidence population was visible until the operator's `.gitignore`
  edit at 14:34:44 +0100, committed in merge `0b166956` at 16:11:54), the live
  Queue ran root status/overlap inspection four times today under the app process
  started 2026-10-13 23:40:42 +0100 (check 1 pins its generation to the same
  byte-identical repair modules): 04:19:46 PROMOTED
  `integration/queue/deploy-settle-clock-measuremen-294bce` → `fdbc007e`;
  06:46:15 BLOCKED `desk-fast-deploys` naming `apps/desk/AGENTS.md`; 11:09:52
  BLOCKED `desk-schema-release` naming `apps/desk/src/revenue/tenderSourceLinks.ts`;
  12:49:29 BLOCKED `desk-crm-links` naming `apps/desk/shared/openapi.json`. None
  produced `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` or either inspection-error blocker
  ('unable to inspect root checkout status' / 'unable to compare root changes with
  the promotion'); the named-path overlaps prove complete stream reads (success
  requires process close and complete framing even after a match), and blocked
  attempts wrote nothing. Under the current process (14:08:32 +0100), the same
  code path ran twice more: 16:28:08 PROMOTED `desk-colleague-sending` →
  `5fcb1ff2` (147 files, all owned work: 146 under `apps/` plus
  `work-finder/triage-rules.md`) and 17:14:08 PROMOTED
  `ingress-accepted-precondition` → `bd3d7c2c` (its two closed documents only),
  with further ordinary Queue landings after the evidence snapshot (18:33:46,
  18:42:29; bracketed in `queue-events-addendum.json`).
  Both landed commits are hook-gated squashes ("Landed by Plan Queue after N
  verification round(s)") containing only owned verified work and closed
  documents. Line-level receipts: `queue-events.json`; diffs/reflog:
  `reflog-and-landed-diffs.json`.
- Operator HEAD/index/byte preservation: the root reflog's 14 October entries as
  retained in `reflog-and-landed-diffs.json` (captured 18:01 +0100) are exactly
  five HEAD-advancing events — three Queue landings (04:19:46
  `deploy-settle-clock-measurement` → `fdbc007e`, 16:28:08 `desk-colleague-sending`
  → `5fcb1ff2`, 17:14:08 `ingress-accepted-precondition` → `bd3d7c2c`) and the
  operator's two publish-merge advances (16:11:54 → `0b166956`, 16:12:19 →
  `e9cb0e52`) — plus one no-op `reset: moving to HEAD` at 14:31:00 and no other
  movement in that receipt window. Further ordinary Queue landings followed
  after the snapshot and are bracketed rather than re-enumerated as exhaustive
  (18:33:46 `jim-access` → `3462275e`, 18:42:29 `ingress-normal-observer-preparation`
  → `3faa546f`; `queue-events-addendum.json`). The operator-owned census
  (captured 17:47 +0100; 5 modified tracked paths + 205 untracked paths with
  per-file SHA256 and mtimes; `operator-paths-snapshot-1.json`) shows 200
  untracked operator files with mtimes predating the 16:28 landing —
  untouched by it — and the blocked attempts preserved everything by writing
  nothing. A live before/after bracket is retained in the same packet for any
  landing that occurs after the snapshot.
- The prescribed raw status stream measurement was executed with the git command
  as prescribed (the `rtk proxy` usage wrapper is an unfiltered passthrough and
  was omitted; `status-measurement.json` discloses both command strings): exit 0,
  17,519 bytes, SHA256
  `8f6820254ed99a537f64b6daa07b2fa959ab34b2e86017445ce07c0a8b116305`
  (`ct-status-raw-1.bin`; 210 records: 5 modified, 205 untracked).

The one unmet literal clause: that retained measurement does NOT exceed 10 MiB,
because the operator's working-tree `.gitignore` edit at 14:34:44 +0100 (published
in merge `0b166956`, "Merge remote main and publish verified Work Finder changes")
now ignores plan-folder evidence dumps (`/documents/plans/*/verification-*/` and
siblings) while the 7.6 GB / 131,725-file population stays on disk. Every
>10 MiB live inspection therefore predates the current app process (they ran
04:19–12:49 under the 23:40:42 process), and no Queue inspection on the large
listing occurred in the 14:08:32–14:34:44 window when the current process and the
large listing overlapped. Exact remaining action, which only James can provide:
either (a) accept the retained live witness set above (whole >10 MiB listing
handled by the live Queue, generation-pinned to byte-identical repair modules,
with named-blocker and byte-preservation evidence) as check 2's actual result, or
(b) authorise one more live Queue inspection while a >10 MiB raw status listing
exists — which requires operator-side action on his own committed ignore rules or
a naturally large untracked population. A worker must not edit ignore rules or
fabricate the untracked population to obtain a pass.

## Evidence run — 13 October 2026 (Queue worker)

Safe in-loop source checks passed: 65 focused tests, renderer and spec typechecks,
lint, LOC, main and renderer production builds. Full tests and the fresh completion
gate belong to the coordinator's independent verifier under the current worker task.
The compiled reader matched raw Git across 44,462,226 bytes and 169,479 ordered
path/status pairs with unchanged Community Tech HEAD/index/helper pins. The installed
reader module equals the freshly compiled helper byte for byte. These are source
and disk evidence, not passes for checks 1 or 2.

Evidence packet (root checkout, ignored; survives managed-worktree cleanup):
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/plan-queue-large-status-queue-worker-20261013-eb9521/`.
Primary files: `checks.json`, `generators.json`, retained focused raw log/JSON,
`compiled-reader.json`, `installed-reader.json`, `HANDOFF.json`, `CUSTODY.json`.
No installed-app replacement, restart, Queue write or promotion occurred.

Check 1 is witnessed (14 October 2026). Check 2 stays open until its two actual
results are both witnessed under one qualified generation — its live witness set
is retained above but the prescribed current stream measurement cannot exceed
10 MiB while the operator's ignore rules stand. A fresh whole-acceptance verifier
must reconcile this evidence before any closure. This document may become
`_livetest_completed.md` only after both checks pass.

## Evidence run — 14 October 2026 (acceptance-followup worker)

Check 1 witnessed; check 2 executed to the boundary of worker authority and kept
open on its one unmet literal clause (above). Independent fresh
task-completion-gate review of the original repair, its executing callers and
this acceptance reconciliation is recorded in the
[active acceptance follow-up](2026-10-13-plan-queue-large-status-acceptance-followup_plan.md).
Worker gates in the AIO worktree on the landed repair state all exited 0:
focused quiet tests (`git-status-stream.spec.ts` + `worktree-integration.spec.ts`),
`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`, `generate:aliases`, `generate:ipc`, `verify:ipc`,
`verify:exports`, `build:main`, `build:renderer`, with no tracked diff after the
generators. The full suite was independently reproduced in the same accepted
state by the fresh completion-gate verifiers: 2,427 files, 31,458 tests passed,
0 failed, 7 pre-existing foreign skips (round 2 captured exit 0; logs under
`review-20261014/` and `review2-20261014/`).

Evidence packet (root checkout, ignored; survives managed-worktree cleanup):
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/plan-queue-large-status-acceptance-20261014/`.
Primary files: `runtime-generation.json`, `asar-module-pins.json`,
`status-measurement.json` + `ct-status-raw-1.bin`, `queue-events.json`,
`queue-run-f0779c05.json`, `reflog-and-landed-diffs.json`,
`operator-paths-snapshot-1.json`, `checks.json`, `HANDOFF.json`, and the
`gate-*.log` raw streams. No installed-app replacement, restart, Queue write,
ignore-rule edit, promotion or foreign edit occurred.
