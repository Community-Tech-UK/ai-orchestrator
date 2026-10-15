# MiMo quota warning opens Accounts: direct session completed

Status: implemented and independently verified on 2026-10-13. Changes remain uncommitted.

## Delivered behaviour

- Clicking the orange MiMo/OpenCode usage reauthentication warning opens `/settings#provider-accounts` through the existing app-shell route.
- The quota popover closes before navigation is requested, including when Accounts is already selected.
- Legacy and additional accounts use native `type="button"` warnings, retaining warning text and account labels, with pointer, hover and keyboard-focus styles.
- Other provider warnings retain their existing instructions. Quota Refresh keeps details open and does not navigate.

The direct-session code diff is limited to `provider-quota-chip.component.ts`, its adjacent spec, and `app.component.html`. The app-shell spec is unchanged. No credential, sign-in, dependency, IPC, configuration, commit, push, branch, or worktree operation was added by this direct session.

## Verification

All canonical gates passed. A genuinely fresh reviewer independently used `task-completion-gate` and returned **VERDICT: PASS**, with no unresolved actionable findings.

- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and `npm run build:renderer`: independent exit 0 for each; `_scratch/mimo-banner-independent-gates.json` records commands, logs and results.
- Unfiltered `npm run test:quiet`, using the repository-pinned Node v24.15.0: exit 0, 2,414 files, 31,107 passed, six existing skipped, zero failed. `_scratch/mimo-banner-independent-full-suite-node24-result.json`, `_scratch/mimo-banner-independent-full-suite-node24.log`, `_scratch/test-run.pid-17458.log`, and `_scratch/test-results.pid-17458.json` retain actual results.
- The final suite includes 38 quota tests, 15 existing app-shell tests, and 40 existing Settings tests. New regression cases cover legacy/additional MiMo warnings, close-before-output ordering and Refresh isolation; no existing assertions were weakened.
- Real Browser Gateway verification on preflighted `windows-pc` confirmed warning-to-Accounts navigation, popover closure, `Connect usage` visibility, disabled additional-account labelling and native keyboard focus. Physical Enter/Space activation is not claimed by this direct session. `_scratch/mimo-banner-root-browser-evidence.md` retains the returned observations.
- `_scratch/mimo-banner-final-review.md` retains the independent review. Task hashes remained unchanged throughout verification, and `git diff --check` passed.

Earlier full runs failed on concurrent unrelated evidence work and then on a review shell using ambient Node 26. The evidence fixture was corrected by its owner; the review shell was pinned to the existing project Node. The final unfiltered run passed without weakening or skipping tests. Earlier failure logs remain retained.

Test-created Windows tabs were closed and the disposable development server stopped. No task-specific live check remains deferred. Verification used the development renderer; the running desktop application was not restarted or repackaged.

## Shared plan ownership

The background Plan Queue independently picked up [the original active plan](2026-10-13-mimo-quota-banner-accounts_plan.md) and added evidence for its own managed worktree. That variant has a different four-file diff and test coverage. Its coordinator owns its verification, integration, closure and rename. This completed record closes only the direct root-checkout implementation; it does not close, merge or promote that queue item. The shared active plan and its queue annex remain intact.
