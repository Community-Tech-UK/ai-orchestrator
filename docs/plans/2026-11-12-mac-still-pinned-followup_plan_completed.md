# Follow-up to "keep this Mac as a backup" (after commit 66c566c2a)

## Status

- **Why this exists:** [the plan](2026-11-12-mac-still-pinned_plan_completed.md) was committed and renamed `_completed` at 22:22
  on 12 November while independent review rounds 4 and 5 were still finding problems. A `_completed` file takes no new content,
  so the fixes after that commit are recorded here.
- **Done in the working tree, not committed:**
  1. With this Mac switched off, a named spec list now always goes to the far machine as plain `vitest run <files>` (the
     `argv` route), never as the commit hook's related-tests run. That run passes with no tests (`passWithNoTests`), so a spec
     the config leaves out (such as `src/worker-agent/worker-start.e2e.spec.ts`) reported "0 tests passed" there while the
     same command fails here. `scripts/remote-checks/route.js`, with `remote-checks.spec.ts` and
     `run-tests-quiet-remote.spec.ts` updated.
  2. Part C's chat-start log (`mcpServerNames` and "Chat helper servers resolved" in
     `src/main/instance/lifecycle/spawn-config-builder.ts`, with its spec in `spawn-config-builder.native-search.spec.ts`)
     was left out of the commit. Live check LT-C depends on it.
  3. The livetest doc's LT-A3 and LT-A4 expected a wait while the machines were paused; a pause gives "not run" at once.
     Both now say so, and show how to see the wait with a copy of the config whose hosts are unreachable and not paused.
- **Corrections to the committed plan's Status:** seven independent review rounds ran, not two passes with no findings
  (rounds 1 to 6 each found something, all fixed; round 7 passed). "A non-file name goes as Vitest's filter" now applies to every
  named list (item 1). The latest full suite on the PC had 7 failures, all from other sessions' uncommitted work on the Claude
  adapter and cost tracking (review round 5 confirmed: they pass on a clean copy of HEAD with this plan's changes).
- **Done (13 Nov):** items 1 to 3 passed an independent review (round 7, PASS); James asked for them to be committed, and the
  committed plan's Status was corrected at the same time.
