# Browser input controls: verification round three, 27 October 2026

**OPEN / PARTIAL. No repaired Windows acceptance or completion-gate PASS.**

The running Windows extension is 0.2.43; this branch contains the 0.2.45 repair. Current
remote-transfer metadata makes Documents read-only, including the installed extension folder.
The earlier refused write was not bypassed. Installing/reloading the repair requires an
authorised route before checks 1–5 can close. Dingley check 6 remains specifically restricted.

## Every check

| Check | Current result |
| --- | --- |
| 1: Tab / Shift+Tab / Enter | OPEN: repaired bundle not installed; harmless fixture unreachable from Windows. |
| 2: tablet / window bounds | OPEN: no repaired Windows layout, persistence, responsive control or bounds-read evidence. |
| 3: Chrome zoom | OPEN for repaired-bundle regression; original 0.2.43 PASS is historical only. |
| 4: retries / failure / restoration | OPEN: successful same-key/new-key activation and active-baseline failure need repaired Windows execution. |
| 5: regression smoke / credential guard | OPEN for repaired-bundle retained-debugger regression. Current local focused tests pass; original Windows smoke was 0.2.43. |
| 6: Dingley | NOT RUN: James's explicit rerun authority is still absent. No page, KPI or handover was changed. |

## New evidence

`windows-receipts.json` records fresh/deliverable remote health, the new exact fixture tab,
its actual `chrome-error://chromewebdata/` page and ERR_EMPTY_RESPONSE, and confirmed closure
of that tab. An unrelated same-host/different-port tab offered by preflight was not reused.
`roster.log.txt` records current extension version and file-transfer roots. This is a healthy
Gateway connection with an unusable fixture and an old extension, not a worker-offline claim.

`fixture-reachability.log.txt` records HTTP 200/expected fixture text on loopback and failed
requests over the Mac's network addresses. The live Windows read is the second vantage point.
No cause for the network-path failure was established; it is not filed as a new product defect.
No control mutation or restoration claim was made against the error page.

The prescribed isolated dev app was built/launched from this worktree, with user data at
`/tmp/aio-lt-queue-07419a7c`, debug port 9752 and its freshly built renderer served on 4752.
`dev-app-probe.json` records focus emulation before DOM assertions, hidden=false, rendered
app-root and successful health IPC. The visibility-override command is unsupported and recorded
as such. The empty isolated worker roster is not presented as the real Windows connection.
`runtime-verified-stopped.json` confirms the app/supervisor gone and all three owned ports closed.

## Local gates

The branch-lock install used `npm ci --ignore-scripts --no-audit --no-fund` inside the worktree.
Original dependency links were preserved; exact-version existing Electron 42.11.18 and
better-sqlite3 12.11.1 native artifacts were reused read-only. Native ABI verification passes.
No install hook or native rebuild touched shared state.

Both typechecks, lint, source-length/UI-hint checks and main/renderer builds exit 0.
The renderer retains its nonfatal initial-bundle budget warning.
The corrected seven-file focused selection passes 230 tests, including native-finality's
previously failing cases. Dependency compatibility and git-batch specs also pass (8 tests).
No source, timeout, assertion, expectation or skip was changed in this round. The initial
focused command named two nonexistent selectors and ran four files (192 tests); corrected
coverage is explicitly bound to the seven existing paths in `focused-recovery.log.txt`.
These isolated passes do not prove the cause of round two's native-finality failures.

`command-receipts.jsonl` binds actual commands, timestamps and exit status to the logs. Existing
`.log` files were relocated to harvestable `.log.txt` paths; `log-relocation.json` records the
mapping and receipts retain their original names under `recordedLog` where relevant.
No failure result is inferred from truncation or silence.

Full-suite outcome, final artifact inventory and cleanup are appended after execution.

## Ownership and remaining authority

The canonical livetest and active follow-up are edited only at their absolute root-checkout
paths. Source/register/evidence stay in the AIO-owned queue worktree. That split is required by
the task. The final integration manifest inventories/hashes both groups and names every
required LT-997/998/999 anchor. Actual coordinated harvest and final landing-link validation
remain the coordinator's responsibility; the worker has no merge/root-register-write authority.
The stale worktree owner must not be harvested instead of the current root owner.

This is not a completion claim. No independent PASS is asserted. The existing queue verifier
owns the next review. No commit, stash, branch/worktree creation/switch, release, extension
deployment, saved-login fill, Dingley action or `_completed` rename occurred.

## Resumed run, 27 October 2026, 15:34 UTC onward

The earlier full-suite attempt has no final receipt or JSON report and is interrupted with
unknown outcome. A new full suite runs with two workers under `resumed-full-suite.log.txt`.
The final result will be appended after its exit. Current Windows health is deliverable, but
extension 0.2.43 remains installed and its Documents destination is read-only. The resumed
preflight selected an unrelated different-port tab, which was not touched. The scoped receipt
is `resume-windows-preflight.json`. No refusal was bypassed; checks 1–5 remain OPEN and
Dingley check 6 remains NOT RUN. Implementation/test hashes match the round-two seal.

The historical backlog explicitly forbids adding current status, so the owner receives the
updates. No completed plan was modified. Final manifest and cleanup remain to be recorded.

### Final resumed full-suite result — 2026-10-27T16:13:06.977488+00:00

The unfiltered default full suite finished with exit 1: **FAIL**,
35374 passed, 1 failed, 9 pending of
35384 reported tests. The command used two workers and disabled the optional
model summary. It did not alter test selection, timeouts, assertions, skips or source.
`round3/resumed-full-suite-result.json` binds the final result to its command receipt and
redacted compressed JSON/full output. The prior interrupted attempt remains outcome unknown.

The earlier round-three static/build/focused receipts remain evidence for these exact source
hashes; they are not represented as newly executed during the resume. Windows checks 1–5
remain OPEN because the installed extension is still 0.2.43 and the configured destination
is read-only; check 6 remains NOT RUN under the Dingley restriction. No repaired Windows
acceptance or independent PASS is claimed. No new product defect was reproduced on a live
app during this resume.

`round3/integration-manifest.json` records current root-owned and queue-owned hashes, defect
anchors and coordinated harvest requirements. It does not claim integration. The source seal
is an integrity record, not a completion verdict. `round3/cleanup-receipt.json` records actual
deletion and process/port checks after the report and seal are written. The document remains
active, at its original absolute root-checkout path, with no completion rename.

Whole-suite acceptance remains **OPEN**. The raw failure messages are retained in the
redacted JSON and full log; no failure was suppressed. All six previously failing files
have passing summaries within this run (`prior-failure-full-run-progress.json`). A new
unchanged capability-reporter test hit its existing five-second timeout. Source tracing
finds real local-model probes and an unmocked OpenCode account-name lookup on its path;
that is not proof of which operation caused this timeout. The separate isolation command's
actual result is in `resumed-capability-isolation.log.txt` and its command receipt. A passing
isolated result does not explain the cause or turn this failed full run into a pass.
