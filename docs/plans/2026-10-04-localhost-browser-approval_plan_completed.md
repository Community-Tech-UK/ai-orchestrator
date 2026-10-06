# Localhost browser approval

Status: implemented and independently verified, with a deferred restarted-app live check. Scope: James's request to stop browser permission prompts for localhost.

## Approach

Compose a localhost approval policy at Browser Gateway runtime startup alongside the existing per-instance automation policy. Reuse the shared approval-to-grant path so managed profiles and shared tabs retain audit records, grant expiry, scope, and execution checks. Permit exact localhost, IPv4 loopback, and IPv6 loopback HTTP(S) origins; require every requested origin to remain local, reject wildcard/subdomain scope and external navigation. Preserve credential, payment, identity-secret, CAPTCHA, and persistent-grant restrictions.

## Tasks

- [x] Reproduce localhost grant requests being held for approval.
- [x] Implement and wire the policy into runtime initialization.
- [x] Verify local grant requests and mutations, repeat requests, remote-node scope, and external/unsafe boundaries.
- [x] Run canonical typechecks, lint, size check, both builds, and full quiet test suite.
- [x] Obtain an independent task-completion-gate review and fix findings.
- [x] Record the restart-dependent live check, update as-built notes, and close this plan after all runnable checks pass.

No branch/worktree creation, commit, push, deployment, or app restart is in scope. Preserve unrelated changes.

## As-built evidence

- Before the policy, the new localhost regression returned `requires_user` instead of `allowed`; external-site behavior passed. Reproduction log: `_scratch/test-run.pid-5023.log`.
- Browser Gateway focused suite passed: 119 files / 1537 tests, `_scratch/test-run.pid-7025.log`.
- Implementation is `withLocalBrowserAutoApproval` in `browser-auto-approve.ts`, composed into `initializeBrowserGatewayRuntime` in `index.ts`. Existing auto-approval remains the fallback for external sites. Local audit grants use `auto_approved_localhost` and retain existing grant expiry, worker/profile scoping, and submit/destructive autonomy.
- Pending localhost requests are resolved by the existing approval-list polling path. Verified through the production service seam, without altering the renderer.
- Restart-dependent UI check: [localhost browser live check](2026-10-04-localhost-browser-approval_livetest.md).
- All seven canonical gates exited 0. Summary and exact logs: `_scratch/localhost-approval-verification.json`; full suite: 2349 files / 29636 tests, `_scratch/localhost-approval-full-tests.log` and `_scratch/test-run.pid-10930.log`.
- After that full run, the non-loopback boundary test was strengthened to align the supplied origin/proposal with each external page, ensuring it exercises host trust rather than only the independent origin-mismatch guard. No production code changed after the canonical gate; the strengthened focused file passed separately.
- A genuinely fresh verifier returned `VERDICT: PASS` with no unresolved actionable findings. It independently reran all seven canonical gates and focused tests, with cached test results disabled; full suite again passed 2349 files / 29636 tests. It also verified the compiled runtime, old/new baseline behavior, scope boundaries, grant matching across workers/instances/providers, secret scanning, and bounded policy performance. Evidence: `_scratch/localhost-completion-review.md`, `_scratch/localhost-review-verification.json`, and the distinct `_scratch/localhost-review-*` raw logs and structured results.
- The two production-file changes, new regression file, and this plan remain uncommitted. No branch/worktree was created, no app was restarted, and unrelated dirty documentation was preserved.
