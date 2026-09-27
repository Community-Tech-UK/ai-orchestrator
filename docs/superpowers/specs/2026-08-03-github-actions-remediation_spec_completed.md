# GitHub Actions Remediation Specification

**Status (2026-09-23):** Implementation and agent-runnable verification are complete. The four required `mytrademail` GitHub production secret names exist, production deploy run `35842040642` passed, the installed wrapper matches the source, and production DSNs/FCM key match their intended Sentry/Firebase projects. All four configured values are represented in the production Bitwarden item. The final full suite passed 2,218 files / 26,397 tests; typechecks, lint, LOC, and both builds passed. A fresh independent completion review returned `VERDICT: PASS`. Synthetic event delivery, alert acknowledgement, and inherited Firebase IAM remain pending in [the live-test document](../plans/2026-08-03-github-actions-remediation_livetest.md). Earlier blocker statements below describe the 2026-08-26 state.

**Implementation plan:** [2026-08-03-github-actions-remediation_plan_completed.md](../plans/2026-08-03-github-actions-remediation_plan_completed.md)

## Scope

Repair the two reproducible failures in the `ai-orchestrator` CI run at commit `eb78077a` without changing provider behavior or loop semantics:

1. `npm run check:provider-parity` must discover `CanonicalCliType` from its canonical source after the settings primitive-type split.
2. Concurrent loop-control initialization must not let stale-directory pruning remove a control directory that another loop has just created.

The related `mytrademail` production deploy failure is configuration-only, but investigation found that the required credentials have never been provisioned. It remains blocked on account-authorised creation of three Sentry projects/DSNs and an FCM service-account key for the repository's Firebase project. The `central-auth` failures are out of implementation scope because both failed runs were transient DNS errors and their immediate reruns passed.

## Evidence and Root Causes

- Provider parity fails with `Could not find CanonicalCliType in .../settings.types.ts`. Commit `afab2e1e` moved the alias to `settings-primitives.types.ts` while leaving the checker pointed at the old file.
- The slow CI tier failed in `loop-coordinator-concurrent-isolation.e2e.spec.ts` with `ENOENT` while renaming a unique temporary `control.json` file. The UUID temp-name fix is present, so the missing source file means its containing loop directory was removed. `prepareLoopControl()` prunes every directory absent from a caller-supplied active-ID snapshot; two concurrent starts each receive an incomplete snapshot and may classify the other freshly-created directory as stale.
- `mytrademail` production deploys fail before source checkout because the installed wrapper requires backend Sentry and FCM credentials. The reviewed repository wrapper and backend production schema require three distinct Sentry DSNs plus the FCM service-account path. None exists in the GitHub `production` environment, VPS `.env`, project-local credentials, shared credential mirror, or Bitwarden references inspected by name. The one shared Firebase admin key belongs to a different project, verified by project-ID hash comparison.

## Design

### Provider parity

Point the checker directly at `src/shared/types/settings-primitives.types.ts`, the source that owns `CanonicalCliType`. Keep the parser and checklist contract unchanged.

### Loop-control pruning

Treat age as part of stale classification. A loop-control directory absent from the active-ID snapshot is eligible for pruning only after a conservative grace period. Fresh directories are preserved, closing the initialization race while retaining bounded cleanup of crash leftovers; normal terminal cleanup remains immediate through `cleanupLoopControl()`.

The regression test will create an unregistered, newly-created control directory representing a concurrent initialization, prepare another loop with an incomplete active snapshot, and assert that the fresh directory survives. It must fail against the current implementation before the production change.

### Deployment configuration

Do not weaken production startup or wrapper validation and do not substitute unrelated credentials. Once account-authorised credentials exist, store `SENTRY_DSN`, `MTM_SENTRY_DSN`, `SBE_SENTRY_DSN`, and `FCM_SERVICE_ACCOUNT_KEY_PATH` in the GitHub `production` environment, install the repository's reviewed wrapper on the VPS, and rerun the failed deploy. Credential values must never enter logs, repository files, or chat.

## Acceptance Criteria

- `npm run check:provider-parity` passes and reports the canonical provider list.
- The new loop-control pruning regression fails on the old behavior and passes after the fix.
- The focused loop-control spec and slow test tier pass repeatedly.
- The repository's required typecheck, lint, build, and full test gates pass.
- GitHub's `production` environment lists all four missing `mytrademail` secret names and the rerun deploy succeeds, or the task is explicitly reported incomplete with account-level credential creation as the blocker.
- No `central-auth` files or configuration are changed.
- Existing unrelated working-tree changes remain untouched.

## Risks

- A grace period delays cleanup of crash-orphaned control directories; these are small, ignored metadata directories and terminal cleanup still removes healthy-run directories immediately.
- Creating Sentry projects and a Firebase service-account key is an account-level external change requiring new credential authority; no placeholder or cross-project credential is acceptable.

## Current Verification Evidence

- Recheck on 2026-09-23: provider parity reports eight current providers; the focused loop-control spec passes 19 tests. Production deployment `35842040642` passed, and local/installed deployment wrappers have matching SHA-256 hashes. The three deployed DSNs each map to the intended distinct Community Tech Sentry project; enabled payment, provisioning, and regression alert rules are configured. The production FCM file matches the dedicated sender account and SBE Firebase project, with only the FCM admin grant visible at project scope. All four configured values are present in the production Bitwarden item. External event delivery and inherited IAM are deferred to the linked live-test document.

- Provider parity reports all seven canonical providers.
- The loop-control regression failed before the production fix and passes after it (13 focused tests).
- The slow tier passed three consecutive runs.
- Main and spec TypeScript checks, lint, TypeScript LOC policy, and the Electron main build passed.
- The full default test suite passed in its four CI-equivalent shards: 1,728 test files and 18,013 tests.
- A single unsharded local run exceeded the Node 4 GiB heap, so the successful full-suite evidence uses the workflow's four-shard layout with the workflow's 5 GiB heap setting.
- A fresh independent completion-gate review reproduced the clean install, complete CI chain, all 18,013 default tests, and the slow tier under Node 24.15.0, then returned `VERDICT: PASS` with no findings.
- Commits `08b7e684` and `13787e42` were pushed to `main` with James's explicit approval. GitHub Actions run `30809724132` passed every job, including lint/typecheck/build, all four test shards, production dependency audit, slow tests, and macOS native packaging/launch smoke.
- No `central-auth` files or configuration were changed.
