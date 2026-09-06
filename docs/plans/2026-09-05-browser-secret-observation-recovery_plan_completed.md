# Browser secret observation recovery implementation plan

Status: implementation verified and complete on 2026-09-05. Windows deployment and actual-profile recovery are deferred to the linked live-test document. No commit or deployment is authorised by this plan.

## Goal
Fix repeated misleading Browser Gateway secret-taint failures without exposing protected credentials. Temporary inspection failure must not permanently assign an unrelated origin to a tab. Confirmed origin, opener and frame lineage stays protected; uncertainty during a protected fill remains conservative.

## Implementation
- Frame inspection failure/timeout blocks the current observation with a fixed unavailable message, without persisting an unrelated flag. Inventory suppresses page-controlled URL/title/text/screenshots while inspection is unavailable.
- Only extension-created pre-dispatch guard errors can say the command did not run. A WeakSet authenticates these errors; page-derived exceptions and ambiguous protected writes retain opaque non-retryable errors.
- The actual extension toolbar popup provides operator recovery. Gateway must be off, real command execution idle, and the operator must explicitly acknowledge reviewing affected tabs and stored site data, including any secrets still present.
- Popup sender authentication and a state-bound, five-minute, single-use review token protect reset. New fills invalidate review. No browser-tool reset or automatic declassification exists.
- Recovery, tab removal, target classification and inventory share the observation boundary. The execution counter remains active after a watchdog timeout until the real operation settles.
- Recovery saves gateway OFF and cleared protection together before clearing memory. Storage failure retains in-memory protection. Startup settings-read failure stays OFF until an explicit operator enable action.
- Recovery heading, disclosure and status text use adaptive CanvasText for readable dark/light presentation. Reset leaves website data and browser sessions intact.
- Extension version is 0.2.19, with the background asset hash recorded in the existing version test.

## Scope
- resources/browser-extension/{background.js,popup.js,popup.html,manifest.json}
- src/main/browser-gateway/browser-extension-{assets,origin-bound-secret}.spec.ts
- src/main/browser-gateway/browser-secret-{recovery.testutil.ts,observation-recovery.spec.ts,operator-recovery.spec.ts,recovery-popup.spec.ts}

Unrelated dirty-tree work is excluded. Exact pre-edit source copies are in `_scratch/browser-secret-recovery-baseline/`. Another shared-checkout session staged source/test files; this implementing agent did not stage, commit, push, create a branch/worktree or deploy.

## Acceptance checklist
- [x] Reproduce unrelated persistent taint and misleading ambiguous-write errors.
- [x] Implement transient uncertainty, inventory redaction and authenticated guard errors.
- [x] Preserve confirmed/write-time secret protection.
- [x] Implement authenticated explicit operator recovery and durable OFF state.
- [x] Reproduce and fix concurrent persistence, failed-OFF-write and startup-read failure cases.
- [x] Verify actual Chrome worker and trusted toolbar popup, including dark-mode presentation.
- [x] Add regression coverage without deleting, weakening or skipping existing assertions.
- [x] Both TypeScript checks, lint, LOC and build:main pass.
- [x] Final full-suite result after UI correction.
- [x] Fresh independent task-completion-gate PASS with no actionable findings.
- [x] Close this plan after runnable gates pass; Windows live checks remain separately deferred.

## Current verification evidence
- Full suite after all runtime changes: 1,977 files / 21,706 tests passed, exit 0, `_scratch/test-run.pid-12296.log` and matching JSON (one pre-existing skipped test).
- Full suite after UI correction passed: 1,977 files / 21,706 tests in 387.1 seconds, exit 0, `_scratch/test-run.pid-83754.log` and matching JSON. The adjacent status-colour correction also received another focused popup/assets run plus lint, main build and actual Chrome check.
- Focused runtime suites: 5 files / 120 tests passed, `_scratch/test-run.pid-11336.log`. Latest popup/assets: 2 files / 62 tests passed, `_scratch/test-run.pid-19287.log`.
- Both `npx tsc --noEmit` invocations (including tsconfig.spec.json), lint, LOC, main build and diff whitespace checks passed. Main build includes asset sync and preload bundling.
- `_scratch/browser-secret-recovery/live-probe.cjs` runs shipped extension JS in isolated real Chrome for Testing and operates the actual toolbar popup with trusted input. It checks transient inspection recovery, both reset races, failed OFF persistence, startup-read failure and explicit reset. Only obvious TEST_ONLY fixtures are used. The disposable manifest omits its public key to prevent installed native-host connections; temporary browser profiles are removed after shutdown.
- Actual popup screenshots: `_scratch/browser-secret-recovery/popup-before-reset.png` and `popup-after-reset.png`. Source fingerprint: `_scratch/browser-secret-recovery/verified-source-hashes.json`.

## Independent review remediation
1. Tab removal could restore old origins during reset acknowledgement: serialized through the observation boundary, reproduced then verified in real Chrome, added restart regression.
2. Command target classification could race reset before execution counting: serialized through the same boundary, verified both orderings and restart persistence.
3. Failed earlier OFF persistence could leave saved ON after reset: reset now persists OFF with cleared flags, verified real popup and restart regression.
4. Startup settings-read rejection defaulted ON: now fails closed; verified actual Chrome and restart regression, retaining explicit operator enable.
5. New heading inherited insufficient dark contrast: switched to CanvasText. Adjacent recovery status text was also corrected after measured 3.95:1 contrast; regenerated actual screenshots confirm readable text.

## Final independent verification
Fresh agent `secret_recovery_gate6` returned `VERDICT: PASS`, no unresolved actionable findings. It independently reran both TypeScript checks, lint, LOC, main build, 120 focused tests (`_scratch/test-run.pid-11094.log`) and the actual Chrome probe; inspected full-suite JSON/log 83754, all four asset hashes and both dark-mode screenshots. Clean installation was intentionally excluded to preserve the shared checkout. Source fingerprints matched after verification.

## Deferred live validation
[Windows deployment and operator recovery checks](2026-09-05-browser-secret-observation-recovery_livetest.md) record exact steps and asset hashes. Windows preflight reported `windows-pc` disconnected and no remote extension channels. No shared-profile protection reset or worker deployment was performed. The existing installation must receive version 0.2.19 before the fix is live there.
