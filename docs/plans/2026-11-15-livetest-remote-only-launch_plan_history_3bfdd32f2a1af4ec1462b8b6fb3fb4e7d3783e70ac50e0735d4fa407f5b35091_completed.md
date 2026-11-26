## Snapshot of 2026-11-15-livetest-remote-only-launch_history.md

# Remote-only launch history

## Round: actual launch evidence (26 Nov 2026)

The flag, scheduler coverage and runbook bullet were already on the base branch; the worktree had no further diff.

- `node scripts/remote-checks/dev-app.js start --port 9893 --data /tmp/aio-lt-remote-only-check --remote-only` ran from the queue worktree. It sent the checkout to the test Mac (ct-test-mac), built main, helper and screens, and exited 0 ("Harness is running on the test Mac"). Log: `_scratch/test-run`-style scratch file `_scratch/remote-only-launch.log` in the worktree.
- `curl http://127.0.0.1:9893/json/version` answered with the Harness(Dev) Electron user agent through the tunnel.
- `dev-app.js stop --port 9893` stopped it; `status` then showed no copies on the test Mac or the PC.
- `npm run test:quiet -- scripts/remote-checks/dev-app.spec.ts`: 1 file, 106 tests passed (Windows PC), log `_scratch/test-run.pid-96035.log`.
- `node --check scripts/remote-checks/dev-app.js`: exit 0.
- Earlier rounds (canonical checks, full suite exit 0 at `_scratch/test-run.pid-83573.log`) are unchanged: no code changed this round.
- The earlier prior review FAIL was for missing full-run and actual-launch evidence; both are now present.
