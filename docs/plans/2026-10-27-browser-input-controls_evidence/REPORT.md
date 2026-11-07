# Browser input controls live evidence, 27 October 2026

Result: **2 checks pass, 3 fail or partly fail, 1 remains deferred.** All six original checks
have a dated disposition in the root-owned live-test document. This report is observation
evidence for the queue verifier, not a completion-gate PASS or a claim that defects are fixed.

Owner: `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-14-browser-gateway-input-controls_livetest.md`.
The owner was edited only at that root path and was not copied into this checkout or renamed.
Active implementation status: root-owned `2026-10-27-browser-input-controls-remediation_plan.md`.
The three findings are indexed in this checkout's standing remediation register.

| Check | Outcome | Evidence |
| --- | --- | --- |
| 1: keyboard | FAIL, LT-997 | `gateway-001/002/003/006/007.json`; empty trusted named-key identity, unchanged focus, two failed distinct Enter attempts. |
| 2: tablet | FAIL, LT-998; bounds capture LT-999 | `gateway-004/009.json`; emulation lost between commands, desktop media-query/layout; all scope-window reads report zero bounds. |
| 3: zoom | PASS | `gateway-005/006.json`, `gateway-screenshot.json`, `zoom-200.jpg`; real factor 2/per-tab persists, returns to 1/per-origin. |
| 4: failure/retry | PARTIAL/FAIL, LT-997 | `gateway-003/007.json`; failed same-key attempt safely deduplicates, stale target denied, new key still cannot activate. Successful-first-attempt dedupe remains unverified. |
| 5: existing operations | PASS within fixture/negative-guard scope | `gateway-008.json`, screenshot; click/navigation/type/fill/query/snapshot work, unauthorised credential fill is denied before running. No real successful saved-login fill is claimed. |
| 6: Dingley | DEFERRED, explicit rerun authority absent | No Dingley action or KPI edit. James must explicitly instruct the deferred script rerun. |

## Environment and executing paths

The existing packaged coordinator controlled the real shared Windows Chrome tab, computer
`windows-pc`, node `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`, extension 0.2.43, fixture target
ending `771588757`. A small worktree-owned server served only a harmless page/metrics at
`http://192.168.0.96:18752/`; all browser actions targeted Windows. Fixture-cookie continuity
is not an assertion about a real account. Normal click generated one server activation;
both Enter attempts generated zero. `runtime-receipts.jsonl` retains the server requests.

The checkout's main build and dev renderer were also launched locally as explicitly requested,
using `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-07419a7c`, renderer port 4752 and debug port 9752.
The initial standard launch failed with an OS sandbox-extension message and exited 0 despite
not exposing CDP. `--no-sandbox --disable-gpu --js-flags=--max-old-space-size=8192` made startup
work; `--prebundle=false` made Angular render. Initial failures are retained, not rewritten as
passes. A nonessential thin-client port collision with another app was logged; the run did
not stop or reconfigure its owner. The isolated dev main/renderer and the packaged Windows
connection are different runtime paths; this empty dev profile had no paired remote worker.

`dev-app-cdp3.json` proves the final setup UI rendered, hidden=false, visibility=visible,
health IPC success/ready and all three controls advertised. Focus emulation was enabled
before evaluating the DOM. The optional visibility-override CDP method returns -32601;
that unsupported method is retained in the receipt. No real profile/provider session was
created or changed. The standard and prebundle-enabled attempts remain in earlier CDP/log
receipts. The worker did not replace or restart the packaged app.

`activation-authority.json` is a read-only query of three exact fixture grant IDs: each
Enter/dedupe action was allowed by per-action YOLO auto-approval. The ordinary browser grant
did not authorize credential filling: the live negative request was denied. No real vault
item, credential lookup, secret entry or manual approval occurred.

`windows-source-comparison.json` compares read-only downloads of the Windows extension files
with local source. Its disk version matches relay health. Full scripts differ (local version
0.2.44), but the native dispatch, debugger lifecycle and viewport implementation blocks are
byte-identical. This is configured-file evidence, not in-memory script attestation. The
downloaded source is deleted with the runtime; only comparison hashes remain.

## Reproduction and restoration

Use a benign shared Windows fixture containing a link, two text controls and an <=800px
responsive menu/table. Focus the link, use native Tab/Shift+Tab, then Enter with an expected
URL change. The failed Enter key used `lt-20261027-enter-one`; its same-key retry was failed,
deduplicated and unapplied. A fresh key `lt-20261027-enter-two` also failed. Fixture event
listeners observed trusted events with numeric key codes but empty named key/code values;
they did not cancel or synthesize input. Ordinary clicking on the link succeeds.

The stale-target rejection was tested at the original zoom without an active override. It
does not prove retention of active restoration baselines during a mid-dispatch failure;
that failure subcase remains unverified alongside successful activation/idempotency.

Set a tab viewport to 768×1024, then inspect it in a subsequent Gateway call. The requested
mode may be reported even though actual layout is back at 2558px desktop width. Reset was
called after each relevant sequence. No shared-window resize was attempted. All window-bound
reads were unusable zeros, so exact window restoration is not asserted.

The real zoom mutation/reset succeeded, restoring factor 1 and per-origin scope. Resets in
sequences that had only read zoom report `restorationFailed: browser_zoom_baseline_lost`
(receipts 003/004/007/009). These flags are preserved and are not called successful baseline
restorations. Independent reads remain at the original factor/scope. Native debugger banner
presence changes content height by 56px; both observed desktop heights are retained.

## Commands and limits

`command-receipts.jsonl` records actual command results and log files. Focused controls,
classifier and credential-dispatch-boundary tests pass unchanged; main build and both
typechecks exit 0. The Angular dev build also succeeds. Production source and tests were
not edited. Full-suite, lint and production renderer-build checks were not rerun for this
documentation/evidence campaign; no claim is made that those gates ran. No source fix,
independent fresh-agent verdict, commit, staging, stash, branch switch or worktree creation
occurred. The coordinator owns independent verification and document closure.

The frozen historical backlog says not to add current status. The historical completed July
plan cannot receive new requirements. Current status therefore lives in the owner, this
checkout's register additions and the new active root plan. These choices preserve the
current documentation rules instead of modifying the closed documents named by the older
runbook. The heap-safe spec typecheck script supersedes its bare-compiler example.

## Cleanup and integrity

The created fixture tab was closed successfully (`fixture-close.json`); no other tab was
closed or resized. `process-cleanup.json` checks every owned Electron/renderer PID and
process group and finds none alive. The supervised server process also exited.

After this report, command receipts and source seal were written, the run-owned isolated
profile, dist build, Angular compile cache, downloaded extension source and scratch scripts
were removed. `cleanup-receipt.json` records the deletion and final port/process checks.
The dependency installation existed before this run and is preserved; no new dependencies,
database server, browser binary or checkout copy were installed. Only this small report,
receipts, logs, screenshot and seals remain. `source-check-seal.json` hashes the retained
evidence/source/owner documents and explicitly does not certify acceptance PASS.

The owner currently resides in the root checkout while these receipts reside in the queue
checkout. Integration must preserve the evidence directory and rewrite temporary absolute
owner links before AIO removes its worktree. Unrelated concurrent register entries, including
the root's newer LT-708/LT-709 mapping, must survive integration; this campaign did not copy
them over the older queue base.
