# OpenCode launch environment: packaged-app acceptance

Status: Open. Source and compiled factory startup plus real replies passed with provider-default and High thinking. These checks concern the rebuilt/restarted installed app and have not passed yet.

Implementation plan: [launch environment](2026-10-13-opencode-launch-environment_plan_completed.md). Defect and implementation status: [LT-704](livetest-remediation-register.md#lt-704), [LT-705](livetest-remediation-register.md#lt-705), [remediation status](2026-10-13-opencode-startup-remediation_plan.md). Deferred-check record for the closing remediation plan: [startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md). Historical failure and original variant check: [owning evidence](2026-10-13-opencode-effort-variant-startup_livetest.md).

Prerequisites update (2026-10-14): the build/install/restart prerequisite below is satisfied — the archive installed 2026-10-14 13:00:28 UTC contains both repairs (compiled launcher byte-identical to the verified worktree build) and the production app booted 13:08:32 UTC after it; provenance receipts are in `_scratch/opencode-startup-remediation-queue-worker-20261014-bf56b9/`. Only the three smoke checks below remain.

## Remediation flow

Read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before a campaign. Record any reproduced defect in [livetest-remediation-register.md](livetest-remediation-register.md) with matching status in an active remediation plan; never add scope to a completed plan. Keep per-check evidence here. Rename this file `_livetest_completed.md` only when every check passes.

## Prerequisites and why deferred

Use the local checkout containing the launch environment correction. Select the installed Node version pinned in `.nvmrc` (24.15.0); finish the normal local package build (`rtk npm run localbuild`), install its Harness build through the normal workflow, and restart Harness when James can safely interrupt his active sessions. Main and renderer builds alone do not replace the installed archive or the running app.

Harness desktop control is hard-denied, and James has not authorised interrupting his active sessions. The agent verified the source and compiled factory against the actual locally configured ComTechSpare account, without controlling a desktop or changing project files in the smoke sessions. A packaged UI acceptance check still requires James's restarted app. Record build provenance and time for the new sessions; never copy native configuration, credentials or task contents into evidence.

## Checks

- [ ] In the newly restarted Harness, create a disposable session in `/Users/suas/work/12steps`. Select OpenCode, MiMo-V2.6-Pro, account ComTechSpare (Amsterdam), and provider-default thinking. Send `Reply with exactly OK. Do not use tools or change files.` Expected: startup succeeds, ComTechSpare and MiMo-V2.6-Pro remain selected, and the session responds `OK` without a model-limit or selected-model-confirmation error. Retain safe startup evidence and build provenance here.
- [ ] Create a second otherwise identical disposable session with High thinking and send the same prompt. Expected: startup and response succeed; High thinking and ComTechSpare remain selected. Record the observed selections and reply here, then end only the disposable smoke sessions.
- [ ] (LT-705) Repeat the provider-default check in `/Users/suas/work/communitytech` with a build containing the LT-705 change. Expected: startup succeeds on OpenCode 1 with ComTechSpare and MiMo-V2.6-Pro retained, and the session replies `OK`.

## Run evidence — 2026-10-13 20:22 UTC (packaged, communitytech)

James's session `icott8xxw` in `~/work/communitytech`, on the archive built at 20:17 UTC with the LT-704 repair, failed at 20:22:28 UTC with the selected-model confirmation refusal (`textChars: 92`, `textHash: 7d9b0dca8f11b1bd`) after falling back to OpenCode 2 at 20:22:27. This is a new cause, recorded as [LT-705](livetest-remediation-register.md#lt-705); it is not a 12steps run, so the checks above stay open.

## Already verified, separate from these checks

Actual source factory: `_scratch/opencode-launch-runtime-default.log` and `-high.log`; compiled factory: `_scratch/opencode-launch-compiled-default.log` and `-high.log`. All four exited 0 and confirmed the exact routed account model, requested effort where applicable, and real `OK` response. No experimental HOME injection or other diagnostic workaround was used in these repaired-path runs.

Independent code completion review: `_scratch/opencode-launch-fresh-gate.md`, VERDICT: PASS. Its six build/static gates, focused tests, full suite and native compiled default/High replies all exited 0. This does not close the packaged checks above.
