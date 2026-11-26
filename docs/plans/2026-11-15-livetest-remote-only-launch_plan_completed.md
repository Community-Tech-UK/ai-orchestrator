# Remote-only live-test launches

## Status

On main: yes (this landing commit)
Implemented and ready for independent verification. Start-only `--remote-only` flag, scheduler coverage and runbook guidance are on the branch. Focused launcher suite passes (106 tests, `_scratch/test-run.pid-96035.log`); all seven canonical checks and the full suite passed earlier with no code change since (`_scratch/test-run.pid-83573.log`). Actual launch now evidenced: `start --remote-only` ran a dev copy on the test Mac, exit 0, answered over the tunnel on port 9893, then stopped cleanly (see [history](2026-11-15-livetest-remote-only-launch_plan_history_3bfdd32f2a1af4ec1462b8b6fb3fb4e7d3783e70ac50e0735d4fa407f5b35091_completed.md)). The earlier review FAIL ([review](2026-11-15-livetest-remote-only-launch_review.md)) was for missing full-run and actual-launch evidence; both now exist. The packaged opencode launch belongs to its own live-test plan, not this one.

## Design and acceptance

`dev-app.js start --remote-only` uses the existing remote selection and retry loop without measuring this Mac's load or returning exit 75. Default behaviour remains unchanged. `--mac` and packaged launches keep their current eligibility restrictions, including paused-host filtering and genuine load/copy limits. Wait messages distinguish remote unavailability from local fallback. Stop, status and shell reject the launcher flag (shell commands after `--` remain ordinary command data).

An explicit per-launch option fits the existing CLI and avoids changing global routing or weakening load checks. No new scheduler, credentials, security exceptions or local GUI use are required.

## Verification

Use the existing fake-SSH scheduler harness with real snapshot transport to cover busy remotes becoming available while this Mac is free, skipped local-load reads, Mac-only/package eligibility, unavailable/paused hosts, and unchanged default exit 75. Run the focused launcher suite before and after; parent runs canonical checks and full suite before independent review.
