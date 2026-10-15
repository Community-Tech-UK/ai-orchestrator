# Plan Queue resumed landing safety: installed-app checks

Status: pending installed-app validation. The source repair has been integrated normally after canonical and independent code verification. A DIFFERENT final review of the landed output returns PASS with no unresolved actionable findings. See the [current as-built companion status](2026-10-13-plan-queue-resumed-landing-safety-status.md), which supersedes the closed code plan's last worker-handoff status and links the final evidence. This does not establish that the running installed app uses the repair.

Plan: [immutable completed code plan](2026-10-13-plan-queue-resumed-landing-safety_plan_completed.md). AIO closed and integrated this code plan; installation and real persisted-queue checks below remain open. The companion status supplies current as-built evidence without editing that closed record.

Prerequisites: normal AIO integration of the reviewed five-file repair; verified signed local build; James's approval to install and restart the current Mac Harness app, which can interrupt open sessions. Preserve original overlapping work and leave both October runs paused. Browser/UI work uses Browser Gateway health/preflight and explicitly targets `windows-pc`; no Mac browser/desktop control or Harness Computer Use is authorized. Read-only files, CLI and authenticated queue APIs are sufficient for the checks below.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before this campaign. A newly reproduced live defect goes in [livetest-remediation-register.md](livetest-remediation-register.md). The historical implementation record is [2026-07-19-livetest-failure-remediation_plan_completed.md](2026-07-19-livetest-failure-remediation_plan_completed.md); reopen it or create a dated follow-up plan before adding a matching implementation-status section, and never edit a closed document. Keep dated per-check evidence here. The Windows routing rule and heap-aware `npm run typecheck:spec` override stale runbook text.

## 1. Activate the verified build

- [ ] Obtain explicit installation/restart approval after all local preparation and normal integration are verified.
- [ ] Preserve the installed application as rollback material, install the complete signed bundle through the normal local deployment procedure, and restart only after active queue work is safely checkpointed. Do not replace individual application source files or live SQLite rows. Never enter credentials or interact with security dialogs through ordinary typing.
- [ ] Read back the running process's executable and open package path through non-interactive process/file inspection. Extract the three queue modules from that actual installed package and compare their hashes with the executed code in `_scratch/oct-queue-recovery/queue-resume-landing-repair/package-runtime-code-identity.json`. Confirm normal authenticated queue status is available from the restarted application. Package existence alone is not activation proof.

Expected: the running installed package contains the reviewed resume/checkpoint/verification invalidation code; normal queue APIs answer; original root files and paused October runs remain preserved. Settings relaxation remains off unless James explicitly authorizes it.

Why deferred: this needs a real application installation/restart with James's authority. Isolated source/compiled/package-file checks and all agent-runnable build/tests are already performed.

## 2. Resume Phase 0 safely

- [ ] Through the normal parent-owned queue API, resume the existing October run just long enough to assign its waiting Phase 0 verification, then pause further scheduling. Let AIO synchronize the updated base and own checkpointing; do not manually merge or edit queue metadata.
- [ ] Read only the owning Phase 0 row/status: entering a new verification must clear the previously saved `landed_commit` candidate. Confirm the checkpoint and verified base identify the version actually under review. Preserve the row and source receipts.
- [ ] Run current full canonical verification and a different genuinely fresh whole-original completion gate covering every current/deleted Phase 0 path, relevant callers/wiring and all twelve original criteria. Reject a shallow official PASS. Keep the three original dirty overlap files in place until this gate passes.
- [ ] Only after that PASS, use the previously authorized three-file preservation, normal AIO integration and reconciliation. Verify the landed code matches the reviewed repaired checkpoint and its completed evidence, restore both sets of original changes, and run current combined verification plus a different fresh gate. Do not infer completion from a green suite alone.

Expected: the obsolete prepared candidate is not promoted; reviewed repaired code and current evidence land together; both sets of edits survive; no plan is closed from an unverified verdict. Subsequent October plans then continue in their documented dependency order using normal queue controls.

Why deferred: this validates the restarted application's persisted queue recovery and normal live integration. Fixture-verifiable candidate, document-only, overlap and crash behavior already passed independent source/compiled real-Git checks; those checks are not being deferred.

## Evidence retained before activation

- Parent canonical receipts and original-work preservation: `_scratch/oct-queue-recovery/queue-resume-landing-repair/`.
- Independent code PASS: `_scratch/oct-queue-recovery/queue-landing-safety-fresh-gate/review.md`, with exact HEAD-plus-five-file fixture, full suite, source/compiled public scenarios and coverage.
- Original reproduced defect and source/compiled repair checks: `_scratch/oct-queue-recovery/queue-resume-landing-audit/`.
- Signed local artifact: `_scratch/oct-queue-recovery/queue-resume-landing-repair/package/`; signature, helper identity and package module identity checks passed. `package-manifest.json` identifies the artifact. It has not been installed or launched.

All live checkboxes remain open. Rename this document `_livetest_completed.md` only after all checks pass with observable evidence.

2026-10-13 normal queue worker intake: the supplied queue checkout now contains the exact reviewed five-file payload. Its 118 focused tests, both type checks, lint, size check, both builds, generators and contract/IPC/export checks passed with Node v24.15.0. The 11 source and 11 compiled public-path scenarios passed in fresh fixtures. Current assigned-verifier full-suite/independent verdict and normal integration are still pending; no installed-app activation or Phase 0 continuation was attempted. Worker receipts are at `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-plan-queue-resumed-14f579/_scratch/queue-resumed-intake-20261013-14f579/`.
