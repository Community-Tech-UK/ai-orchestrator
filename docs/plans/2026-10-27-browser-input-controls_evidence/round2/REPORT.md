# Browser input controls: review repairs, 27 October 2026

**PARTIAL / BLOCKED. No completion-gate PASS or Windows acceptance PASS is claimed.**
The three production defects are repaired locally in extension 0.2.45. Restoration instructions
are corrected. Successful/failed retry behaviour is proven in real dev Chromium with a CDP
adapter. Windows installation, final whole-suite acceptance, independent review and coordinator
harvest remain open. Dingley remains explicitly outside the authorised harmless-fixture scope.

Owner: root checkout `docs/plans/2026-10-14-browser-gateway-input-controls_livetest.md`.
Active status: root-owned untracked `2026-10-27-browser-input-controls-remediation_plan.md`.
The owner was not copied into this worktree or renamed. No commit/stash/branch/worktree operation
or production deployment occurred.

## Review findings and implementation

| Finding | Actual status | Evidence |
| --- | --- | --- |
| 1: named keys, LT-997 | Local repair: key/code accompany native events. Real base handler fails focus traversal; repaired handler traverses and activates. Windows rerun OPEN. | `background.js:3139`; `dev-runtime-baseline.json`, `dev-runtime-final.json`. |
| 2: retained viewport, LT-998 | Local repair: retain the owned debugger while an explicit override is active; reuse it across commands, recover desired metrics after watchdog detach, release on reset/shutdown/removal. Remove unsupported getter and reject actual/request mismatch. Windows responsive menu/table acceptance OPEN. | `background.js:2751,2821,3275`; final runtime and regression tests. |
| 3: window bounds, LT-999 | Local repair: read real top-level Window fields, fail on missing/nonpositive bounds, restore normal bounds before non-normal state. Real Windows read/optional isolated resize OPEN. No user window resized. | `background.js:3323,3336`; Chrome-shaped read/reset/unavailable/maximized regressions. |
| 4: dedupe/failure proof | Real dev handler: successful same-key retry leaves activation count 1; a new key increments to 2. An injected transport error after real native keyUp increments to 3; failed same-key retry stays 3 with applied:false. Active 768x1024 survives and resets to 1400x900. Automated tests also preserve the active zoom baseline. Windows/coordinator acceptance OPEN. | `dev-runtime-final.json`; six-file focused suite. |
| 5: read-only zoom resets | Protocol corrected: reset changed mechanisms only; reread unchanged state. Missing zoom baselines still report browser_zoom_baseline_lost. This was a protocol error, not a reason to fake successful restoration or weaken loss detection. | Dated owner notes and revised restoration protocol. |
| 6: split ownership | Explicit harvest manifest binds root owner/follow-up and queue source/register/evidence. Temporary absolute artifact links removed from owner. Integration remains coordinator-owned and pending; no root tracked-register overwrite. | `integration-manifest.json`. |

The extension's 0.2.45 bundle hash is appended to its version history; old rows are unchanged.
Native input still uses the existing guards, secret-free focus reader, effect verification and
idempotency state machines. No IPC/schema/credential gate was bypassed. Holding a debugger during
an explicit viewport override is intentional; its Windows banner/other-tab effects still need
observation on the repaired Windows bundle.

The full suite exposed a second VM harness lacking chrome.debugger.onDetach. Its real API stub
was added at `browser-secret-recovery.testutil.ts:76`; no protection assertion or expectation was
weakened. The corrected suite preserves all secret-protection and recovery behaviour.

## Live runtime proof and limits

The dev app was built and launched from this checkout using the prescribed isolated profile
and port 9752. The renderer used port 4752. Focus emulation was enabled before DOM assertions;
health IPC succeeded, app-root rendered and document.hidden was false.

The runtime adapter maps the shipped functions' debugger attach/send/detach calls to actual CDP
target sessions in the isolated Electron Chromium engine. It runs the real native input/default
behaviour and session-bound metrics, not JavaScript KeyboardEvent simulation. Actual source
SHA-256 is in each receipt. It stubs tab bookkeeping/reporting around those handlers and does
**not** exercise the Windows extension, packaged coordinator, Gateway action grants or upstream
effect verification. It cannot replace the required shared-tab acceptance checks.

The baseline source is the queue base, read from Git without modifying the working tree. It
keeps focus on the link after Tab/Tab/Shift+Tab and exits 1. Final source exits 0 and covers the
native activation counters and failure/reset sequence above. Earlier startup-not-ready and
fixture-base-URL failures are retained under their explicit names; neither is filed as a product
defect. The final fixture uses an absolute same-document link to respect Angular's base URL.

## Windows and authority boundary

Gateway health/preflight showed a fresh, deliverable Windows extension channel. The running
bundle remains 0.2.43, while the repair is 0.2.45. A harmless fixture was served locally; loopback
worked but the Mac LAN URL returned an empty reply and the Windows tab rendered
ERR_CONNECTION_RESET at chrome-error://chromewebdata/. `windows-before-update.json` records that
setup failure and is not accepted as fixture keyboard/responsive evidence. No cause for the
LAN-route failure is asserted. Both local and remote observations are recorded in the owner.

The documented worker transfer route was tried for the configured extension folder and exited
1 with `remote_write_refused`. Documents is advertised read-only. No broader write grant was
created, no alternate shell bypassed the refusal, and no extension was installed/reloaded.
`windows-update-attempt.json` preserves the exact refusal. An approved install/reload route and
working Windows fixture are prerequisites to rerunning checks 1, 2 and 4. This is technical
blocked work, not a request for James to choose routine implementation details.

Original Windows checks 3 and 5 retain their earlier scoped PASS (real zoom and benign fixture/
negative credential boundary); no new successful saved-login fill is claimed. Check 6 remains
DEFERRED: only James's explicit Dingley script-rerun instruction can authorise it. No Dingley page,
KPI figure, credential or handover document was changed.

## Verification

All static/build commands below were rerun with this branch's lockfile install and exited 0:
`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`.
`command-receipts.jsonl` records timestamps, actual exits and logs. Per-check logs retain the
latest invocation; earlier receipt rows retain their actual historical exit status.

The six focused extension, input-control, credential-boundary and secret-recovery files pass:
222 tests, exit 0. A branch-lock focused run also passes dependency compatibility and those
feature tests; it exits 1 only on three native-finality command-line cases.

The full suite was run, not inferred: **exit 1, 42 failures among 35,384 tests**. Every failed name
and original diagnostic is in `full-suite-failures.json`; compressed complete output is retained
with secret-shaped fixture strings redacted. Its 38 missing-API VM failures are fixed/retested.
Its linked-install mismatch is fixed by the separate install and the dependency gate now passes.
The git batch timeout passes in isolation. Native-finality cases still vary/fail in isolation
(`additional-test-results.json`); their unchanged fixture uses a 150ms child-process window.
The cause was not proven and their production path/expectations were not edited. An earlier
fixed-two-worker full run was interrupted with exit 130 and is explicitly incomplete, not green.

A final whole-suite run after the harness/install repairs was not launched after shared host
load rose to 325.41 (`host-load-receipt.json`). Whole-suite acceptance is OPEN. No skipped-test
flag, raised assertion timeout or suppressed failure was used. Slow/external tiers were not run
because this is already an incomplete local gate and Windows acceptance is blocked.

The worker performed a fresh self-review, recorded in `local-review.json`. It is explicitly not
an independent completion-gate verdict. The queue's fresh verifier still owns that review.

## Dependency and cleanup ownership

The inherited node_modules links pointed to a root install whose manifests differ. That folder
was renamed into the owned scratch directory, then `npm ci --ignore-scripts` installed this
branch's lockfile. Version-matched pre-existing Electron/native artifacts were reused read-only;
ABI verification passes for Electron 42.11.18. No shared module was rebuilt and no install hook
changed global Git configuration. `dependency-install.json` records the exact reuse.

Before cleanup the app/renderer/supervisor and their process groups are confirmed gone; the
fixture tab closed through Gateway. Report, command receipts, integration manifest and source
seal precede deletion. `cleanup-receipt.json` records the subsequent actual deletion, closed ports
and restoration of the original linked node_modules. It is a post-seal receipt, explicitly
outside the pre-deletion seal. No success is inferred from the cleanup plan alone.

The temporary install/npm cache, dist output, scripts and isolated profile are deleted. No database
cluster, downloaded browser binary or copied checkout was created. Matching pre-existing binary
artifacts are preserved. The verifier must make its own branch-exact install; the restored shared
links are the original environment, not represented as a clean branch-specific install.
