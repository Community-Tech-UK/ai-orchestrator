# Settings navigation exception found during MiMo live testing

Status: implementation and worker checks finished; ready for independent queue verification (2026-11-03). The shared route-snapshot fix is already present in the queue base; this follow-up verifies it and adds rendered-control navigation coverage. Active root-checkout follow-up, untracked. Full-suite/independent acceptance and the explicitly deferred Electron integration check remain pending.

Origin: [MiMo saved-session live test](2026-10-11-mimo-saved-usage-session_livetest.md#evidence-run--2026-10-27). Register: [LT-711](livetest-remediation-register.md#lt-711). Evidence: `docs/plans/evidence/2026-10-27-mimo-saved-usage-session/normal-settings-navigation-uncached.json` in the queue worktree until harvest.

## Implementation status

- [x] Rule out the earlier synthetic history navigation and the test static-server cache failure: reload at the root, disable only the isolated test cache, then click the normally rendered Open settings button.
- [x] Confirm a fresh production-renderer runtime exception: `Cannot read properties of undefined (reading 'data')` at `ControlSurfaceShellComponent.findActiveSurfaceId`. Settings still renders; no claim that Accounts is inaccessible.
- [x] Trace to the constructor’s synchronous `startWith(null)` subscription and the unconditional `current.snapshot.data` traversal. Runtime proves at least one traversed route has no snapshot at that moment; it does not identify which route without another instrumented run.
- [x] Read affected source/callers/tests and confirm the shared route-lifecycle fix is already integrated. Add meaningful rendered-control navigation regression coverage.
- [x] Re-run normal button/link navigation in a fresh production renderer (headless browser preview, with the limits below), uncached targeted tests, both typechecks, lint, size/UI-hint checks, main/renderer builds and generators.
- [ ] Queue verifier: run the full suite and the independent task-completion gate against the final diff. These checks are reserved for the verifier by the worker assignment.

The full Electron integration check is recorded in [the live checklist](2026-10-27-mimo-campaign-settings-navigation_livetest.md); it remains unverified.

This active follow-up carries new remediation status because the historical remediation plan is completed and cannot acquire new scope. The original campaign changed no product code or tests; the follow-up below records the current implementation work.

## As-built investigation — 2026-11-03

- No separate specification is linked. The two unchecked items above are the acceptance scope.
- The supplied queue base already contains the shared fix in `src/renderer/app/shared/control-surface/control-surface-shell.component.ts:130`: traverse `this.route.snapshot` and its snapshot children, rather than traversing live routes whose child snapshots have not yet been assigned. Keep synchronous initialization and NavigationEnd updates. No second product fix is needed.
- The source was integrated by the earlier queue remediation (`b277e3f39`, `2026-10-27-control-surface-route-snapshot-remediation_plan`). Existing real-router tests already cover the missing live-child snapshot, Settings/Local AI/Automations direct loads, deepest recognized metadata, shell reuse/recreation, headings, help and active navigation. Those tests pass uncached before this follow-up's edits.
- Follow-up regression: use the real shell's rendered Settings/Automations links and Back button, checking URL, title, active navigation, contextual help and absence of RxJS route errors across two shell visits. No product wording, layout or route metadata changes.
- A newly built production renderer passed an automated headless navigation run using the real dashboard Settings button and shell controls. Plain-browser dashboard mode intentionally displays the preview notice; `?bench=1` exposes the real dashboard controls. The test uses that supported preview path and disposable first-run-completed storage. It does not exercise Electron preload or real account services. A missing pre-existing favicon returns 404; that resource error is retained separately from runtime exceptions. No source/rendering overrides are used.
- Evidence, command receipts, final report and integrity seal are retained in the assigned worktree at `docs/plans/evidence/2026-11-03-mimo-settings-navigation/`. The worker report records the exact remaining verifier/live checks.

## Worker verification — 2026-11-03

- Baseline: the shell and route tests pass uncached before changes. Final: the shell, route and registry specs pass uncached (26 tests). The new rendered-control regression fails with the original live-route traversal restored, collecting the exact `Cannot read properties of undefined (reading 'data')` TypeError. The production source was then restored byte-for-byte and the focused tests passed again. Mutation and restore hashes are recorded in `mutation.json`.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, and `npm run build:renderer` all exit 0. Spec typecheck and lint also pass after the final test edit. The renderer retains the existing initial-bundle warning (1.65 MB against a 1 MB warning budget; below the 2 MB failure budget). `generate:aliases` and `generate:ipc` exit 0 with no generated changes.
- The successful production-renderer receipt contains two dashboard Settings-button visits, Settings/Automations shell navigation, Back controls, and direct Settings/Automations loads. Every recorded page has the correct heading, navigation and shell-help state, `document.hidden === false`, and no stored renderer crash. Runtime exceptions are absent. The sole resource error is the already-missing favicon; the harness retains it in the raw evidence and makes no claim of a clean console.
- Earlier headless attempts are retained as failures: the first browser closed before viewport setup; subsequent plain-browser runs showed the expected dashboard preview notice instead of a workspace rail. The final run used the supported benchmark-preview path without changing application code or forcing Angular rendering. This is production-renderer evidence, not Electron/preload/account integration evidence.
- Self-review: the diff adds one focused navigation test plus imports; existing tests, expectations, application settings and dependencies are unchanged. The RxJS error hook is restored in `finally`, and each navigation awaits a real NavigationEnd. No production source difference remains. Renderer wording review: All clear.
- [Worker report](evidence/2026-11-03-mimo-settings-navigation/report.md), `command-receipts.ndjson`, `production-navigation.json`, `mutation.json`, `cleanup-receipt.json`, and `seal.json` are retained in this queue worktree until harvest. The report distinguishes the successful checks, expected mutation failure and deferred integration check.
- No full test suite, independent PASS, real account login, release, deployment, commit, branch/worktree change or document closure is claimed. The coordinator owns the final verifier and lifecycle; neither this plan nor its live checklist has been renamed or copied into the worktree.
