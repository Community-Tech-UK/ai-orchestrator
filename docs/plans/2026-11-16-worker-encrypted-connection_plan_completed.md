# Worker encrypted-connection setup

## Status

On main: yes (this landing commit)
Code done. Connection-only CLI (`update-connection`) and fail-closed listener validation are implemented and were source-reviewed. 26 Nov round: focused connection tests passed (71 tests, 4 files) and all seven canonical checks passed. Full suite not run by the worker (verifier's gate); the earlier full-suite log's visible failures are in Plan Queue specs, not connection code. Remaining work is live and deferred to [the livetest doc](2026-11-16-worker-encrypted-connection_plan_livetest.md): Windows/test Mac launcher and recovery route, certificate issuance and renewal owner, coordinator restart with TLS, worker migration, real socket checks, rollback route, secure Codex sign-in and Browser Gateway checks. Native Windows ACL execution is also unverified. No certificate issuance, restart or login performed. Evidence: `_history.md`, `_scratch/windows-connection-preflight.md`, `_scratch/codex-wss-migration-preflight.md`.

## Required behaviour

1. A supported worker command changes an existing worker's coordinator connection to a validated encrypted URL without reenrolling it or altering authentication, node identity, account data or browser setup. Old plaintext alternatives cannot remain usable after migration. Configuration writes must be atomic and preserve appropriate permissions; errors must not disclose configuration contents or credentials.
2. Configuring only part of the listener's TLS material must refuse startup. It must never silently open an unencrypted listener. Existing intentionally unencrypted operation with no TLS configuration remains supported.
3. The actual migration must use the same coordinator and existing worker launchers, retain independent recovery access, and validate certificates and actual worker sockets. A command or passing unit test does not establish live confidentiality.

## Implementation and verification

- Read the current worker CLI/configuration and listener call paths, baseline focused tests, then reproduce missing behaviour before implementing.
- Follow existing CLI parsing, validation, persistence and error-reporting conventions. No new transport layer, certificate-verification bypass, token copying or service reenrollment.
- Run focused regressions, all canonical project checks and the full test suite, then a fresh independent completion review.
- Finish the migration preflight and certificate lifecycle procedure before changing live connections. Establish the installed launcher, current nonsecret connection candidates and rollback route for each worker.
- After deployment, verify both real encrypted connections, exact Codex identity, secure device login and the originating hardened Browser Gateway checks separately.

## References

- [Codex sign-in plan](2026-11-15-codex-device-login-handoff_plan.md)
- Read-only investigation: `_scratch/codex-wss-migration-preflight.md`
- Prior source review: `_scratch/codex-device-login-gate.md` (no actionable source defect, live acceptance unfinished)

Keep this plan untracked and active until its implementation and required verification are complete. No commits, branches or worktrees are authorised.

> Closure history: `2026-11-16-worker-encrypted-connection_plan_history_9b214297c53b131dd49eacea565da7510b6557384b18c7ca1aa1e39c77389cd3_completed.md`.
