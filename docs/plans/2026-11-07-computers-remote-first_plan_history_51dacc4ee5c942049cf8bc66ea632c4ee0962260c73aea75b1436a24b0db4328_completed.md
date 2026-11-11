## Snapshot of 2026-11-07-computers-remote-first_history.md

# History: use the other computers first (round of 11 November 2026)

Resumed Plan Queue worker; the branch had no commits of its own beyond the base, which already holds Stages 1 to 6.5.

- **Stage 2 (2.1 to 2.5):** boxes were unticked though built. Verified wired: `scripts/remote-checks/checks.js` (named `checks.js`, not `run-checks.js`), `remote-run.sh` `cmd_checks`/`known_check`, `BATCHED_CHECKS` in `src/main/plan-queue/plan-queue-gate-receipts.ts`, `npm run checks`, the push hook in `scripts/run-git-hook.js:58`, and the AGENTS.md checklist. `npm run checks` in the worktree: 7 of 7 passed, "Ran on the test Mac in 1m 40s" (exit 0).
- **5.3:** added `describeSetup` and `offersSetup` (`computers-list.model.ts`), a "Set up for tests and checks" disclosure in `computers-list.component.html` (Settings only, paired computers with no test machine). Specs: model (4 new) and component (1 new); `npm run test:quiet -- src/renderer/app/features/settings/computers-list`: 2 files, 37 tests passed.
- **7.2:** wrote `2026-11-11-agent-sessions-on-other-computers_plan.md`, using the run log (`report:where-work-ran`, 8 to 10 November) and `resolveExecutionLocation`, automations' `forceNodeId` and `remote-spawn-metadata.ts` as read in code.
- **Not done:** 6.6 (edits the Undistilled repository, outside this worktree) and 7.1 (James's sign-in) are in the livetest doc, with two live UI checks.
- **Round 2 (11 November):** fixed the setup guide emitting invalid JSON for names with quotes (`configEntry` builds the entries with JSON.stringify; new spec). Targeted specs: 38 passed; type checks, lint, ui-hints and renderer build re-run. Deferred checks re-reported with the same titles as the livetest doc.
