# Browser input controls live-test remediation

Status: **worker handoff ready, 31 October 2026: repairs implemented in extension 0.2.46 and locally regression-tested; queue verification and repaired-bundle Windows acceptance remain pending.**

Origin: [browser input controls live test](2026-10-14-browser-gateway-input-controls_livetest.md).
Register: [standing remediation register](livetest-remediation-register.md).
This is the active implementation-status follow-up for the authorised review repairs. The historical July `_completed` remediation plan stays unchanged.

## LT-997 — shared-tab named keys do not perform their default actions

- Reproduced: native Tab and Shift+Tab retain focus, Enter does not navigate. Trusted key
  events have empty `key` and `code`; modifier release does work. Effect verification rejects
  Enter, and same-key retries honestly deduplicate the failure.
- Implementation: **implemented locally** in extension 0.2.45. Named key/code fields now accompany native events. Real isolated dev Chromium verifies traversal/Enter; still cover real Windows
  focus traversal and link activation, beyond the existing mocked extension assertions.
- Acceptance: owning live-test checks 1 and 4 pass, including a working NEW idempotency key,
  exactly one activation for a repeated successful key, and no secret field values in results.

## LT-998 — tab viewport emulation is lost when the command ends

- Reproduced twice: a 768×1024 request returns `tab_emulation`, but subsequent reads/snapshot
  show 2558px desktop width; the second set already reports mismatched actual dimensions.
- Implementation: **implemented locally**. Retain owned debugger sessions until reset, recover desired metrics after detach, remove the unsupported getter, reject mismatched dimensions. Local Chromium proves cross-command/failure retention and reset; Windows acceptance remains open.
- Acceptance: owning check 2 retains a real tablet layout while operating its menu and wide
  table, then resets to the original viewport. No shared-window fallback.

## LT-999 — shared-window bounds are reported as zero

- Reproduced repeatedly: the live nonzero-content Windows window reports zero width/height.
- Implementation: **implemented locally**. Read top-level Window fields; reject missing/zero dimensions; restore normal bounds before non-normal state. Chrome-shaped automated regressions cover these paths. Windows read-back/optional isolated resize remain unverified.
- Acceptance: read mode returns meaningful actual bounds; a safely isolated optional resize
  reports affected tabs and restores the exact original bounds/state, including failure paths.

## Campaign verification and remaining boundaries

The main build, both typechecks and focused controls/classifier/credential-boundary tests pass.
The isolated dev app was launched from the scoped checkout and its real health IPC was read
after focus emulation; Windows shared-tab checks use the packaged coordinator's existing worker
connection. These are distinct runtime paths. No app replacement, extension update, commit,
branch operation, KPI edit, real login or Dingley script ran. Dingley needs an explicit rerun
instruction. The source repairs and focused regressions are implemented. The new dated section in the owner records current gates and remaining deployment/live-check boundaries; no independent PASS is claimed.

Numbering: scanned remediation registers and the active July follow-up in every registered
checkout before allocating these IDs. The highest existing reference was LT-996; LT-708/LT-709
and other concurrent campaigns are preserved and not copied or renumbered.

## Review-round integration and protocol notes

The original read-only reset protocol was corrected: reset only mutated mechanisms; independently
reread unchanged state. Missing zoom baselines still fail honestly. No new product defect is
inferred from an invalid read-only reset request.

Root ownership and queue ownership must be harvested together using the round-two
`integration-manifest.json` beside the evidence report. Do not replace concurrent root register
entries with this branch's older base. The explicit worker transfer refusal blocks installing
0.2.45 by that route; rerun Windows checks after an approved installation/reload. Dingley still
requires James's explicit script-rerun instruction. The plan stays active and untracked.


## Final round-two gates and proof limits

The 0.2.45 source is locally implemented. A base-versus-repaired comparison in actual isolated
Electron Chromium reproduces the original focus failure, then proves traversal, activation,
successful/new-key/failed-key dedupe, viewport retention through an injected post-keyUp transport
error, and reset. It uses a CDP adapter, not Windows Gateway.

The branch-lock install passes dependency compatibility and normal static/build gates.
Controls plus credential/protection/recovery suites pass (222 focused tests). The full suite
remains red: 42 failures recorded; 38 harness-stub failures and the linked-install mismatch
have been repaired/retested. Unchanged native-finality command-line tests still fail in
isolation. No full rerun was launched at shared host load 325.41. Every failure is retained;
no cause or green suite result is asserted. Fresh queue verification and an approved Windows
install/reload are still required. Temporary dependencies/runtime are removed and the original
linked install restored; consult the cleanup receipt. No completion rename or commit occurred.

## Review round three — 27 October 2026

No new production/test change. A fresh branch-lock install and corrected seven-file focused
selection pass 230 tests, including all native-finality cases. Both typechecks, lint, native
ABI, source-length/UI-hint gates and main/renderer builds pass. The rebuilt isolated app
renders and answers health IPC after focus emulation; it was stopped before the full suite.
The historical timeout cause remains unproven; passing isolated runs are not a green full-suite
claim. Closing results are recorded in the owning livetest and round-three receipts.

The live Windows roster still reports extension 0.2.43 and Documents read-only. The previously
refused extension write was not bypassed. A new fixture returns HTTP 200 on loopback but the
actual Windows shared tab reports ERR_EMPTY_RESPONSE over the Mac's Tailscale address. That
tab was closed with a confirmed receipt. Current repaired-bundle acceptance for **all five**
Windows checks stays OPEN, including the zoom/smoke regression requested by the reviewer.
Dingley remains specifically unauthorised. No credential or KPI interaction occurred.

The owner/active follow-up remain root-owned; code/register/receipts remain queue-owned as
explicitly required. Round three's final manifest records the current hashes and coordinated
harvest requirements. The worker neither integrates the two checkouts nor renames documents.

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

## Current queue implementation and handoff — 31 October 2026

This section supersedes earlier present-tense implementation, installed-version and evidence
claims for this queue snapshot. Earlier dated sections remain historical records, not fresh proof.

The assigned worktree was initially clean but its 0.2.45 source still omitted DOM key/code,
called the unsupported metrics getter and detached emulation after each command, and read
nonexistent nested Chrome Window bounds. The earlier evidence directory and claimed LT-997/998/999
register rows were absent from the current snapshots. Ruling: implement against the executing
source and retain new evidence; do not treat historical status prose as harvested code, invent
replacement defect numbers, or edit the closed July plan. No new live defect was filed in this run.

### As-built implementation checklist

- [x] **LT-997:** native main-key, character and modifier events carry DOM key/code; Space has
  the correct literal key and modifiers use physical Left codes. Attempted modifiers are released
  even following synchronous/ambiguous dispatch failure. Existing secret-free focus read-back,
  success/failed-key dedupe and deliberate new-key semantics remain covered.
- [x] **LT-998:** explicit tab metrics retain an owned debugger/dialog-watch session. Recovery
  reapplies and checks desired metrics after detach/forced cleanup; mismatches fail. Reset clears
  recovery intent and reads final dimensions after cleanup. OFF/tab-close cleanup, external
  debugger ownership, pending dialogs and late callbacks are covered. Completed dialog waiters
  are removed to prevent accumulation during a retained session.
- [x] **LT-999:** read/set/readback use Chrome's top-level window fields and reject unusable
  dimensions. Reset restores and verifies normal geometry before the original non-normal state;
  failed/ignored/unreadable restoration preserves its baseline for retry. Real-window read and
  mutation remain distinct from tab emulation.
- [x] **Restoration result honesty:** viewport and zoom operations return a failed Gateway
  outcome and audit reason when the extension reports `restorationFailed`, retaining actual
  dimensions/zoom in the data instead of announcing successful restoration.
- [x] **Release identity:** manifest 0.2.46 and one new bundle-history row; historical rows
  unchanged. No extension was installed/reloaded and no app was replaced.
- [x] **Focused verification:** the final 13-file controls/classification/contracts/credential/
  recovery selection passes 480 tests. The final source hashes were stable throughout this run.
  The earlier 193-test baseline passed; new regressions first reproduced all three defects.
  Three additional failed-restoration reporting assertions also failed before their repair.
- [x] **Static/build gates:** main typecheck, `typecheck:spec`, lint, source-length/UI-hint checks,
  main build, renderer build, extension syntax and whitespace checks pass. The initial spec
  typecheck found non-callable broad Vitest mocks; concrete callable mock types fixed those
  errors without suppressions or changed assertions. Alias/IPC generators ran without source drift.
- [x] **Worker review:** reviewed production changes, callers, test integrity, ownership/error
  paths and retained-state cleanup. This is an implementation review, not an independent PASS.

### Verification ownership and remaining acceptance

Required Windows checks are kept open in
[the remediation live-test follow-up](2026-10-27-browser-input-controls-remediation_livetest.md),
including native activation/focus, persistent tablet layout, real 200% zoom, retry/failure honesty,
Gateway regression and meaningful actual bounds. These require the repaired bundle to be
installed and reloaded via an authorised route. Current health/roster reads confirm Windows is
connected and healthy on 0.2.45; its installed extension folder is in a read-only transfer root.
The source build prompt still excludes unauthorised deployment and Dingley script reruns.

The additional automated local headless smoke could not start a usable renderer: Chrome
reported sandbox initialisation denied and exited. Isolated Windows test dispatch was also
refused by `run_on_node`'s routing guard; no remote test/agent started. These are retained failed
attempts, not browser acceptance. No existing browser tab, credential or KPI value was changed.

The full suite and genuinely independent completion gate remain with the queue verifier,
as explicitly required by this worker assignment. No fresh full-suite PASS is claimed; historical
failures above were neither hidden nor represented as retested. The worker did not commit,
stage, stash, rename documents, change branches, integrate or remove AIO's worktree.

No separate active remediation spec is linked. The original Dingley build prompt was reread;
its requirements were preserved and its historical implementation link was not rewritten.

Current evidence is **queue-owned**, under
`docs/plans/2026-10-27-browser-input-controls_evidence/round4/` in the assigned worktree:
`REPORT.md`, `source-seal.json`, command receipts, focused logs and `cleanup-receipt.json`.
It is deliberately ignored raw evidence, not a root-checkout copy or a completion verdict.
Both this active plan and the new live-test follow-up remain untracked at their original
absolute root-checkout paths. The coordinator owns harvest, independent verification and closing.
