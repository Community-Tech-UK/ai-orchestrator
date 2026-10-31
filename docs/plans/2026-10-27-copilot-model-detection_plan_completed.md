# Copilot model detection repair

Status: implementation ready for independent queue verification; not closed.
User request: fix Harness rejecting `claude-opus-5.5` before Copilot starts.

Queue worker status (2026-10-31): the assigned checkout already contains the
implementation and regression tests. Fresh focused tests, source and compiled
real-CLI resolver checks, both type checks, lint, line/hint checks, generators,
and both builds pass. No further tracked code changes were necessary. Final
full-suite verification and the independent completion gate belong to the queue
verifier. This document remains active and untracked; only the coordinator may
rename it after verifier PASS. See the latest worker ledger below; older
evidence applies only to its named checkout and date.

## Evidence and approach

The production log records the explicit model rejected against 32 known ids. The
installed archive has the same validation helper as source. `copilot --version`
reports 1.0.103, but Harness's `--no-auto-update` probe runs the installed base
1.0.62 and its help roster omits Opus 5.5. A real authenticated discovery under
the work profile returns Opus 5.5; the legacy profile does not. New-session
validation currently constructs an accountless adapter, so it cannot discover
that live-only id. The picker already unions the configured profiles.

Use `listCopilotModelsAcrossProfiles` in `getKnownModelsForCli` when no Copilot
profile is supplied. Keep explicit-profile validation scoped to that profile,
and preserve the unified catalog merge and existing offline fallback. No account
routing, CLI launch flags, settings or provider entitlements change.

## Work and verification

- [x] Read implementation, callers and adjacent tests; run focused baseline.
- [x] Reproduce Opus rejection through the actual resolver and account discovery.
- [x] Update `src/main/instance/lifecycle/create-validation-helpers.ts` to use
  existing routed profile discovery for an unspecified Copilot profile.
- [x] Verify with the real CLI/runtime before editing test expectations.
- [x] Extend `src/main/instance/lifecycle/__tests__/create-validation-helpers.spec.ts`
  with cross-profile Opus selection, scoped validation, catalog union and offline
  fallback coverage. Keep all existing behavior assertions.
- [x] Run focused tests, both type checks, lint, line and hint checks, main and
  renderer builds. Keep full output under `_scratch/`.
- [ ] Queue verifier: run the full quiet suite (explicitly reserved for the
  verifier by the current worker brief).
- [ ] Queue verifier: run fresh independent `task-completion-gate` review and
  resolve any findings before coordinator closure.
- [x] Record worker evidence and the installed-app check needing a rebuild/restart.
  This plan stays active until the coordinator closes it after verifier PASS.

## Constraints and review focus

Work in this checkout and preserve unrelated edits. No commit, push, branch,
worktree, deployment or installed-app restart. All browser work, if needed, must
use Windows through Browser Gateway; no browser is needed for this repair.
Check legacy-only configuration, one failed account, explicit-profile isolation,
catalog-only models, total discovery failure, and unchanged strict-provider checks.

## Evidence so far

Baseline focused run: `_scratch/test-run.pid-90021.log`, exit 0. Real resolver
probe `_scratch/copilot-model-detection-probe.cjs` selected Gemini with a
degradation before the fix (exit 1), then kept `claude-opus-5.5` without a
degradation after it (exit 0). The probe supplies configured profile metadata
inside its own process because Electron settings are unavailable under Node;
model rosters come from the actual CLI and the two existing account homes.
No model prompt is sent and installed settings are unchanged.

Updated focused run: `_scratch/test-run.pid-99359.log`, exit 0. Canonical gate
commands and individual exit codes are recorded in
`_scratch/copilot-model-detection-verification/results.json`.

## Queue worker ledger — 2026-10-27

Worktree: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-copilot-model-detec-76304c`.
All evidence paths in this section are relative to that worktree. Earlier
evidence above belongs to the original root-checkout investigation, not this run.
No linked spec is named by this plan; its concrete approach and review-focus
requirements define the implementation scope.

- Ruling: restore the described implementation and tests despite the checked
  boxes above. The queue baseline lacked both changes; relying on the old
  checkboxes would ship the original bug. Cost if wrong: a redundant small fix,
  checked against the actual source and resolver before editing.
- Ruling: reserve the full quiet suite and final independent
  `task-completion-gate` for the queue verifier, per the current worker brief.
  They remain open below; no independent PASS or full-suite success is claimed.
- Baseline: focused helper and profile-discovery specs passed, exit 0, 16 tests;
  `_scratch/test-run.pid-25740.log`. The initially supplied resolver filter had
  no matching file; its actual `__tests__/` path is included in the final run.
- Reproduction: the real `ModelSelectionResolver` with actual installed CLI
  discovery returned `gemini-3.1-pro-preview`, `degraded: true` for the explicit
  Opus 5.5 request, exit 1. The process-only profile list came from the original
  investigation probe; no settings or account routing were changed.
- Regression proof: three new tests failed on the original helper (Opus
  preservation, routed legacy home, surviving account after another fails),
  exit 1; `_scratch/test-run.pid-59292.log`. No existing assertions were removed.
- As built: unscoped Copilot validation calls the same cross-profile discovery
  helper as the picker. Explicit-profile validation retains its adapter path;
  both paths still merge the catalog snapshot and retain the offline fallback.
- Runtime proof after the fix: the same real-CLI resolver probe returned
  `claude-opus-5.5`, `degraded: false`, exit 0. No model prompt was sent.
  Plain-Node settings-migration warnings are expected because Electron's
  `app.getPath` is unavailable; discovery used the existing account homes.
- Focused final run: helper, profile discovery, model resolver, and mobile
  session-plan specs passed, exit 0, 44 tests;
  `_scratch/test-run.pid-75017.log`.
- Installed-app smoke check is deferred to
  [the live-test document](2026-10-27-copilot-model-detection_livetest.md).
- Final automated worker gates: both type checks, lint, line/hint checks, main
  build, and renderer build all exited 0. Alias and IPC generators also exited 0
  and introduced no tracked changes. Full command output and per-command exit
  codes are in `_scratch/copilot-model-detection-verification/results.json`
  and its adjacent logs. The file-size gate reports existing allowlisted
  over-ceiling notes within tolerance; neither changed file is listed.
  The renderer build exits 0 with an initial-bundle budget warning (1.63 MB
  versus the 1.00 MB warning threshold); no renderer source changed.
- The same real-CLI resolver probe also passed against the newly compiled
  `dist/main` code, exit 0. Captured runtime logs:
  `_scratch/copilot-model-detection-verification/probe-success.log` and
  `_scratch/copilot-model-detection-verification/probe-compiled-success.log`.
- Author diff review: only the helper and its regression spec changed. Existing
  behavior assertions remain; no dependencies, suppressions, compiler/test
  configuration, IPC contracts, routing policy, or CLI launch flags changed.
  `git diff --check` passed. This is not an independent completion verdict.
- Handover report, command observations, and source/evidence SHA-256 seal:
  `_scratch/copilot-model-detection-verification/report.md`,
  `observations.json`, and `worker-seal.json`. Build output created by this worker
  is removed after sealing; `cleanup-receipt.json` records the actual cleanup.
  The pre-existing linked dependency install and caches are preserved.

> Plan Queue parked work: `queue/2026-10-27-copilot-model-detec-76304c` — 1 commit(s), reason: verifier-unreliable.

## Root checkout verification — 2026-10-27

The original root-checkout implementation is now automatically verified and has
a fresh independent `VERDICT: PASS`. This is evidence for the two root-checkout
code files, not a submitted Plan Queue verdict. Queue ownership, the parked
branch and its records are preserved; this document remains active and untracked
for the coordinator to close through its own lifecycle.

- Both task files still match the source hashes recorded before full verification.
  No test, dependency, configuration, routing or launch-flag change was needed
  after the original repair and its regression tests.
- All eight canonical gates exited 0 under the existing `.nvmrc` installation,
  Node v24.22.1. Exact commands, exits and raw logs are in
  `_scratch/copilot-model-detection-verification/pinned-node/results.json`.
  The full suite passed with zero failed assertions; raw evidence is
  `_scratch/test-run.copilot-pinned-final.log` and
  `_scratch/test-results.copilot-pinned-final.json`.
- The freshly built resolver again retained `claude-opus-5.5` without degradation
  using the real existing account homes, exit 0. Receipt:
  `_scratch/copilot-model-detection-verification/pinned-node/compiled-resolver-probe.log`.
  No model prompt or installed-app settings change was performed.
- A new independent context reviewed the unchanged task diff, reran the relevant
  helper, profile, resolver and executable-build tests successfully, checked the
  current full-suite evidence, and returned PASS with no actionable findings.
  Report: `_scratch/copilot-model-detection-verification/independent-review-final.md`.
  Verification used the shared checkout; no clean-install claim is made.
- Earlier failed runs are retained, not reclassified as passes. A separate Plan
  Queue prompt test passed on focused rechecks. The later executable-build tests
  failed before their assertions with a source-map reporting error. Running their
  builders directly exposed the underlying refusal: the ambient Homebrew Node
  26.12.1 executable lacks the required Node SEA fuse. The unchanged tests passed
  with the existing project-pinned Node installation, followed by the passing
  full run above. No test expectations or runner behavior were weakened.
- The exploratory filesystem-read preload was excluded from gate evidence and
  removed. Its two known temporary fixture directories are absent; the direct
  builder probe also removed its temporary directory. No verification command
  or diagnostic program remains running.
- The installed-app round trip remains deferred to the existing live-test
  document. Rebuild and restart are still prerequisites; this source-level PASS
  does not claim the installed archive contains the change.

## Queue worker ledger — 2026-10-31

Worktree: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-copilot-model-detec-cbd464`.
Evidence paths below are relative to this worktree, under
`_scratch/copilot-model-detection-verification/` unless stated otherwise.
No linked spec is named in this plan.

- Ruling: retain the repair and tests already present in the assigned HEAD.
  The worktree was clean before verification. The actual helper already uses
  `listCopilotModelsAcrossProfiles()` for unscoped Copilot validation and the
  existing adapter for explicitly scoped validation. Both retain catalog merging
  and offline fallback. Reapplying the historical patch would be redundant.
  Cost if wrong: an omitted repair; current source, regression and runtime checks
  below test that decision. No tracked source or test file was edited.
- Executing path read: `instance-lifecycle.ts:1574` invokes
  `ModelSelectionResolver.resolve`, whose default dependency invokes
  `getKnownModelsForCli`; the Copilot branch at
  `create-validation-helpers.ts:39` calls the routed profile union. The picker's
  discovery service uses the same helper. Explicit-profile validation remains
  scoped, with the existing provider catalog merge preserved.
- Focused verification: four files and 43 tests passed, zero failed assertions,
  exit 0, with the test cache disabled. Includes the validation helper, real
  profile-union helper with mocked adapters, resolver, and mobile session-plan
  specs. Raw runner evidence: `_scratch/test-run.pid-22418.log` and
  `_scratch/test-results.pid-22418.json`; command receipt: `focused.receipt.json`.
  No tests or expectations were changed or suppressed.
- Source and freshly compiled real-CLI probes both preserved `claude-opus-5.5`
  without degradation, exit 0 (`runtime-source.log`, `runtime-compiled.log`).
  The probe supplies profile metadata only inside its own process, reads the
  existing account homes, and sends no model prompt. Installed settings and
  routing were not changed. Expected plain-Node Electron settings warnings are
  retained in the logs.
- Important evidence limit: today's accountless discovery also preserved Opus
  5.5. The historical stale-roster rejection was **not** reproduced against
  today's CLI; its result cannot be reused as fresh failure evidence. The
  existing regression test independently supplies a stale first-profile roster
  and a live-only second-profile model and exercises the actual resolver and
  profile-union helper. No regression-failure claim is made for this run.
- Automated gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, and
  `npm run build:renderer` each exited 0 under the project-pinned Node v24.22.1.
  Alias and IPC generators exited 0 and produced no tracked diff. The line
  ratchet reports tolerated legacy entries; the renderer build warns that its
  initial bundle is 1.64 MB against the 1.00 MB warning budget. No renderer
  source changed. Exact commands, environment overrides and exits are in
  `results.json` and the individual `*.receipt.json` files; raw logs are adjacent.
- Author review: the helper, regression tests, profile discovery, resolver and
  relevant production call sites were reread. `git diff --check` passed; the
  tracked worktree is unchanged from HEAD after generation and verification.
  No additional architecture, dependency, credential, routing, launch-flag or
  configuration changes were needed. This is not an independent gate verdict.
- Worker verification is ready for handover. The full suite and independent
  `task-completion-gate` remain unchecked above, explicitly reserved for the
  queue verifier by the current worker instructions. The installed-app smoke
  check remains pending in the existing
  [live-test document](2026-10-27-copilot-model-detection_livetest.md); neither
  an installed-app restart nor an external provider turn was authorised here.
- Handover: `report.md`, `observations.json`, `results.json`, and
  `worker-seal.json` retain the verified source identities and command evidence.
  After sealing, this worker's `dist/` output is removed and `.angular/` is
  checked for absence; actual removals are recorded in `cleanup-receipt.json`. Existing dependency
  installs are retained for the verifier. The root plan and live-test document
  remain untracked, with their original filenames.
