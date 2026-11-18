## Snapshot of capability-bfef7fff-1a20-4a5a-b4a6-c7413217a268_history.md

# History: capability repair bfef7fff

## Round 1 (2026-11-16)

Reproduction (read-only git on the root repo; no remote copy started, no worktree made for the stale branch):
- `queue/2026-10-10-oct-housekeeping-b3df31`: 119 commits behind main, 6 ahead; `git cat-file -e` shows it lacks scripts/remote-checks/dev-app.js, scripts/remote-checks/live-test-copy.js and src/main/app/live-test-context.ts.
- `git merge-tree --write-tree main <branch>` conflicts in 7 files (livetest-remediation-register.md, leftover-worktree-report.ts, doctor-settings-tab spec, leftover-worktrees-card html and spec, storage-usage-card html and spec). So the merge is not mechanical and belongs to that branch's owner/coordinator.
- Call path: AGENTS.md launches the root checkout's dev-app.js, which sends the branch files; remote-run.sh devapp-start installs, builds main and screens (minutes), then runs `node scripts/remote-checks/live-test-copy.js prepare` (line ~987) and fails with Cannot find module.

Change: scripts/remote-checks/dev-app.js `LIVE_TEST_FILES` + check in `takeChecked` (uses snapshotFileHash; covers the --checked-tree path and re-runs after each wait). Message names the missing file and says merge main. dev-app.spec.ts: fixture now commits the two files; 4 new cases (each file, checked-tree, neither file) assert exit 1, message, no ssh traffic.

Checks:
- npm run test:quiet -- scripts/remote-checks/dev-app.spec.ts: baseline 51 passed; after 55 passed; with the fix reverted the 4 new cases fail (4 of 55).
- npm run checks: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all passed (Windows PC, 3m22s).

Not done: docs/plans/livetest-capability-repair-runbook.md exists only in the root checkout, so a note on the new refusal was not added. Runtime probe left to the independent checker.

## Resume round (2026-11-18)

Parked earlier because no remote test computer was free for the runtime probe (test Mac load 22-35 on 10 cores, Windows PC unreachable). No code change needed. Re-ran at 13:5x: dev-app.spec 55/55 (on test Mac, exit 0); `npm run checks` 7/7 green (ran on the Windows PC, which is reachable again). Runtime probe is left to the independent checker.
