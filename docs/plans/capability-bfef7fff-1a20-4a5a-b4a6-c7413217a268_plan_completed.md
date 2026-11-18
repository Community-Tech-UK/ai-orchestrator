# Capability repair bfef7fff-1a20-4a5a-b4a6-c7413217a268

## Status

On main: yes (this landing commit)
Implemented, awaiting independent review and runtime probe. Reproduced at tree level: queue/2026-10-10-oct-housekeeping-b3df31 lacks dev-app.js, live-test-copy.js and live-test-context.ts, is 119 commits behind main, and merging main conflicts in 7 files; that merge belongs to that branch's owner (not done here). Built: `dev-app.js start` now refuses such a checkout before sending anything (scripts/remote-checks/dev-app.js, 4 new cases in dev-app.spec.ts, fail without the fix). `npm run checks` green (7/7) and dev-app.spec 55/55, re-run 18 Nov after resume (park was only no free test computer; Windows PC reachable again). Evidence: capability-bfef7fff-1a20-4a5a-b4a6-c7413217a268_plan_history_91e28ca0a92cd63a996828fdefb3741b0cfa710733a1654f6cb164d289976432_completed.md. A repaired control never marks the originating check passed.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "queue-branch-lacks-live-test-launcher",
  "check": "Step 1 / 4 and Step 4 Doctor checks on a rebuilt isolated dev app",
  "requiredAction": "Start an isolated dev app copy of this queue branch through dev-app.js",
  "platform": "macos",
  "provider": "harness",
  "classification": "setup",
  "attempts": [
    {
      "operation": "node scripts/remote-checks/dev-app.js start --port 9668 --data /tmp/aio-lt-queue-77b3df31 from the queue worktree",
      "observedAt": 1794793000000,
      "result": "Sent to ct-test-mac, main and screens built, then Cannot find module scripts/remote-checks/live-test-copy.js; 'live-test profile or executable could not be owned safely'."
    },
    {
      "operation": "Compared script and source files between the worktree and main",
      "observedAt": 1794793100000,
      "result": "Worktree lacks dev-app.js, live-test-copy.js and src/main/app/live-test-context.ts; branch is 95 commits behind main."
    },
    {
      "operation": "dev-app.js status after the failure",
      "observedAt": 1794793200000,
      "result": "No Harness copies on the test Mac or the Windows PC; nothing left running."
    }
  ],
  "alternative": "Launching on this Mac with the old env-variable method is not allowed here: no exit 75, and the failure is branch skew rather than load.",
  "expectedResult": "After main is merged into the branch, start succeeds, the copy answers on http://127.0.0.1:9668 and the Doctor checks can be driven.",
  "implementation": "No new product code: merge main into queue/2026-10-10-oct-housekeeping-b3df31 (coordinator's merge-main step), rebuild, and rerun the same start command. Verify by reading the runtime receipt and /json/version.",
  "repairRepository": "/Users/suas/work/orchestrat0r/ai-orchestrator"
}
</capability_evidence>

## Refined proposal (this round)

Reproduction: the stale branch tree has none of `scripts/remote-checks/live-test-copy.js`, `scripts/remote-checks/dev-app.js`, `src/main/app/live-test-context.ts` (`git cat-file -e` on the branch). The launcher runs from the root checkout's copy, sends the branch files, and only after install, `build:main` and the screens build does `remote-run.sh` (line ~987) run `node scripts/remote-checks/live-test-copy.js prepare` and fail with "Cannot find module". No tool is missing: dev-app.js already exists on main and on this branch.

Smallest bounded change: in `start`'s snapshot step (`takeChecked`), refuse before sending when the snapshot lacks `scripts/remote-checks/live-test-copy.js` or `src/main/app/live-test-context.ts`, say which file and that the checkout is probably behind main (merge main, run again). Exit 1, nothing sent, no remote copy left. Uses existing `snapshotFileHash` (`none` = absent). Production and approval restrictions untouched.

Acceptance: spec cases for (a) missing file refused with nothing sent over ssh and exit 1, (b) the `--checked-tree` path refused the same way, (c) existing 51 cases still pass with the files in the fixture; `npm run checks` green; checker probe starts the copy from this checkpoint on the test Mac or PC.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Step 1 / 4 and Step 4 Doctor checks on a rebuilt isolated dev app",
  "expectedResult": "After main is merged into the branch, start succeeds, the copy answers on http://127.0.0.1:9668 and the Doctor checks can be driven."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
