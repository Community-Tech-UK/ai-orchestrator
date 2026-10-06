# Remove the hidden resource governor session cap

Status: completed 2026-10-06. Implemented, independently verified (Plan Queue verifier PASS, round 2, no findings) and landed on `main` as commit `81ae5a218`. The only open item is the installed-app check in [the live checklist](2026-10-01-hidden-resource-governor-cap_livetest.md), which needs a rebuilt and restarted app.

## Problem and evidence

The running app rejects manual session creation with `instance-limit`. App logs confirm the resource governor starts with a separate default `maxTotalInstances: 50`. Startup does not configure that value from AppSettings. Its count is the complete published session map, including hibernated sessions. Settings has its own limit (20 in this installation), used by orchestration. Changing that setting cannot remove the hidden governor cap.

## Scope and acceptance

- [x] Reproduce default-governor rejection with at least 50 retained sessions.
- [x] Default the governor's optional independent cap to unlimited (0). Keep explicitly configured governor limits enforceable and leave the existing orchestration settings policy intact.
- [x] Verify the real governor admission method before updating tests; add regression coverage for counts at and above 50, explicit limits, and memory recovery.
- [x] Run focused tests, both typechecks, lint, line-count checks, both production builds, and the full test suite. (2026-10-06: the Plan Queue verifier ran all seven canonical gates in the item worktree, each exit 0, including `npm run test:quiet`.)
- [x] Obtain an independent fresh-agent completion review using task-completion-gate. (2026-10-06: independent Plan Queue verifier on a different provider returned PASS with no findings in round 2, after round 1's worktree-only dependency-check finding was fixed.)
- [x] Record any necessary installed-app rebuild/restart validation in a livetest document; close this plan only after runnable checks and review pass. (Livetest doc exists with a 2026-10-04 evidence run; closure is left to the coordinator after the verifier passes.)

## Risk

The governor will no longer impose a hidden independent count ceiling unless a caller explicitly configures one. Its garbage collection and bounded memory reclamation remain unchanged. No sessions, settings, or unrelated working-tree edits are removed. Source/build verification cannot change the already-running installed app. The supported AIO repair CLI environment is absent in this Codex chat; do not bypass authentication or edit live settings by hand.

## Current verification evidence and blockers

- Actual source governor with a real InstanceStateManager holding 60 hibernated records: before fix, cap 50 and `instance-limit`; after fix, cap 0 and no rejection. Explicitly configured cap still rejects at its boundary. The same admission smoke passes against the compiled production modules.
- Focused governor, async-work-hibernation, and instance-manager creation tests: 57 passed. Independent fresh reviewer also ran these directly through Vitest: 57 passed.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and `npm run build:renderer`: all exit 0, independently repeated by the fresh reviewer.
- Full `npm run test:quiet`: exit 1; 28,464 passed, 1 failed, 3 pending (28,468 total). Failure: `src/main/review/local-review-tool-runner.spec.ts` / `LocalReviewToolRunner terminates stuck Git enumeration promptly on aggregate expiry`, test timeout. Raw report: `_scratch/test-results.pid-78580.json`; log: `_scratch/test-run.pid-78580.log`.
- Isolated rerun of the unchanged review-runner spec: exit 1, same expiry test timeout, 65 passed and 1 failed. Log: `_scratch/test-run.pid-45144.log`. The testing guide's documented FIFO timeout is a different test; do not dismiss this persistent failure as a known flake.
- The unrelated failing spec and implementation are unchanged by this task. No timeout, assertion, test configuration, or verification gate was weakened. This unresolved agent-runnable check blocks closing the plan; it cannot be moved into a live-test deferral.
- Independent fresh completion review returned `VERDICT: FAIL` solely because the full-suite expiry test also fails in isolation. It found no introduced actionable code findings, confirmed no dependency connection between the governor delta and the unchanged failing runner, and independently reproduced the fixed admission behavior. Canonical verification remains blocked; no completion claim is made.
- Installed-app rebuild/install/restart and composer validation remain pending in [the live checklist](2026-10-01-hidden-resource-governor-cap_livetest.md). This checklist does not waive the failed automated gate.
- No commits, branches, worktrees, live settings writes, session termination, or app restart performed. The spec's pre-existing staged type-safety edits were preserved; only the separate unstaged task delta was changed.

## As-built and queue-worker verification — 2026-10-06

Worktree: `.worktrees/queue/2026-10-01-hidden-resource-gov-19addb` (branch `queue/2026-10-01-hidden-resource-gov-19addb`). No new code changes were needed: the fix already landed on the base branch in commit `877222f38`.

- As built: `src/main/process/resource-governor.ts` `DEFAULT_CONFIG.maxTotalInstances` is `0` (unlimited), with a comment explaining why; `getCreationBlockReason()` still returns `instance-limit` only when a caller configures a positive cap. Startup (`src/main/app/late-runtime-initialization-steps.ts:268`, `getResourceGovernor().start({...})`) injects dependencies only and never calls `configure()`, so production runs uncapped; creation admission reads it via `instance-manager-logging.ts:97-99`. The orchestration limit from AppSettings (`instance-orchestration.ts`) is unchanged.
- Regression tests in `resource-governor.spec.ts`: no default cap at 50/51/500 sessions, explicit cap 50 rejects at 50, explicit 0 is unlimited, `configure()` toggles the cap at runtime, plus the existing memory-recovery tests.
- Compiled `dist/main/process/resource-governor.js` after `build:main` contains `maxTotalInstances: 0`.
- Focused tests: `resource-governor.spec.ts` + `instance-manager.create.spec.ts` 54 passed; `async-work-hibernation.spec.ts` 3 passed.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`: all exit 0 (logs `_scratch/gate-*.log` in the worktree).
- Previous blocker resolved: `local-review-tool-runner.spec.ts` "terminates stuck Git enumeration promptly on aggregate expiry" was made hermetic on the base branch in `f1c4ad82d` (2026-10-03): the real `git rev-parse` metadata probes are now pre-recorded outside the 250 ms budget and replayed, so native Git startup no longer eats the expiry window. In this worktree the spec passed 3 of 3 isolated runs (66/66 each). No timeout or assertion was weakened by this task.
- Not run by the worker (by queue rule): the full `npm run test:quiet` suite and the independent completion review. Both belong to the verifier.
- Live check still open in [the live checklist](2026-10-01-hidden-resource-governor-cap_livetest.md): a composer retry in the installed app with at least 50 retained sessions. Startup already logs `maxTotalInstances: 0` in the installed build (2026-10-04 evidence).

## Verifier round 1 fix — 2026-10-06

Finding: the verifier's full `npm run test:quiet` in this worktree failed 1 of 29,833 tests, `scripts/__tests__/dependency-compatibility.spec.ts` "keeps the installed production tree valid", with `npm ls` reporting the whole tree extraneous/missing.

- Root cause (reproduced): queue worktrees get a `node_modules` of per-entry symlinks into the root checkout's install (`.worktreeinclude` → `src/main/workspace/git/worktree-include.ts`). `npm ls --omit=dev --all` run in the worktree reported 11,389 problems; the same command in the root checkout (byte-identical `package-lock.json`) reported 6, all of which the spec's existing classifier accepts. `docs/testing.md` already recorded this as a known worktree-only failure; it is unrelated to the governor change (this branch has no diff to `package.json` or the lock).
- Fix: the spec now follows `node_modules/.package-lock.json` (npm's install marker) to the checkout that owns the install and runs `npm ls` there, reading that checkout's lock. It fails closed, naming the owning checkout, unless that checkout's `package.json` and `package-lock.json` are byte-identical to this one's. A normal install (CI, root checkout) resolves to `cwd`, so behaviour there is unchanged. The fail-closed classifier, its contract test, and every other assertion are untouched. Added a test covering real install → self, linked install → owner, no install → self, and manifest drift detection. `docs/testing.md` note updated to describe the new behaviour.
- Checks: the spec passes 3 of 3 runs in this worktree (5/5 tests each, real `npm ls` against the root install); the edited file type-checks standalone under `--strict`; `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` all exit 0. Full suite left to the verifier per queue rules.

## Closure — 2026-10-06

- Independent verifier (round 2): PASS, no findings. Gates run in the item worktree, each exit 0: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`.
- Landed on `main` as `81ae5a218` (the dependency-compatibility spec fix and its `docs/testing.md` note; the governor change itself was already in `877222f38`).
- The verifier reported `document_complete: false` although every criterion held and every gate passed. That came from the verifier prompt, whose example sets `document_complete: false` and gives plans no rule for when to set it true; it is not a remaining item. The coordinator therefore landed the code without closing this document, and it was closed by hand under the AGENTS.md live-test deferral rule.
- Deferred live check: the installed-app composer retry in [the live checklist](2026-10-01-hidden-resource-governor-cap_livetest.md). It needs a rebuilt and restarted app, so it is not claimed as verified here.
- After all five Plan Queue items landed, the same seven gates were rerun on the combined `main` (`1b06fffee`): every one exited 0; the quiet suite ran 2,370 files / 29,885 tests.
