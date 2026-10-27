# Browser multi-profile live-test evidence — 2026-10-27

Result: **2 of 8 passed; 6 remain open**. This is a partial campaign report, not a completion
verdict. Independent queue verification is pending. No implementation or test-source changes.

Owner: `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-15-browser-gateway-multi-profile_livetest.md`.
All per-check evidence was added there at that absolute root-checkout path. It was not copied
into the queue worktree or renamed.

| Check | Actual status | Evidence / next action |
|---|---|---|
| 1. Two profiles listed | Open | Refreshed Windows inventories expose only install `0b779001-ea2a-4929-9faf-3ba30930ae8a`. P2 is unavailable. |
| 2. P1/P2/P1 routing | Open, partial | Three successful snapshots across two P1 tabs. P2 required for the requested sequence. |
| 3. Six alternating reads | Open, partial | Six successful live element queries alternating P1 tabs. This is not cross-profile evidence. |
| 4. P2 closes, P1 survives | Open | Requires P2 and permission to interrupt its window/extension. No Chrome window was closed. |
| 5. P2 returns | Open | Requires permission for the same P2 close/reopen or disable/enable sequence. |
| 6. New tab opens and reads | Passed | New Example Domain target carries P1 install id; subsequent snapshot and three live queries succeeded. |
| 7. Restart count stable | Open, partial | Windows count stayed 0 before/after P1 reads. Multi-profile interleaving not performed. |
| 8. Single-profile regression | Passed | P1 A/B/A snapshots plus six live control queries succeeded; targets remained listed. One reporting profile observed. |

All Chrome work used Browser Gateway on `windows-pc`. The worker was connected, extension relay
registered, extension version 0.2.43, delivery healthy. No extension was enabled/disabled; no
worker update, relay recovery or production restart occurred. Existing global health warnings
for six other sessions' tool-reveal restoration were present before/after and are retained in
the observations. Health was not globally warning-free.

P2's absence is not a reproduced browser defect. A missing profile cannot be replaced by two tabs
sharing one `:p.<install>:` segment. Standing authority covers safe reads, not re-enabling the
profile James deliberately disabled or interrupting his existing Chrome windows. The exact
remaining human authority is permission for those identified P2 extension/window operations.
The agent can perform the technical sequence after that authority is granted.

## Runtime evidence and limits

The worktree built its own main and renderer. Its dev app used isolated profile
`/tmp/aio-lt-queue-4d6b0b93`, debug port 9659 and a renderer server on 49659. After a first launch
failed with macOS sandbox initialization `Operation not permitted` (exit signal 5), it was retried
with `--no-sandbox` and isolated thin-client port 49660. A transient context-worker migration
uniqueness error and occupied default port on the first attempt are recorded separately as
undiagnosed startup observations, not assigned a browser-routing cause.

The successful dev run enabled focus emulation before the DOM probe. The optional visibility
override method is absent in this Chromium; focus emulation itself yielded `hidden:false`,
`visibilityState:visible` and a firing animation frame. The real preload/IPC browser health and
target-list calls succeeded. The isolated profile has no paired worker or targets. Therefore
the Windows checks used the packaged coordinator's existing live worker connection; they do not
prove a freshly built worktree coordinator's remote integration.

Snapshots alone are insufficient live-page evidence because
`src/main/browser-gateway/browser-existing-tab-operations.ts:432` permits cached fallback.
The six element queries supplied live-read corroboration. Cleanup also confirmed this distinction:
a snapshot briefly returned cached content after a close, while a later live element query
reported `profile_target_or_url_not_found` and the final inventory marked both created targets
closed. No claim of a failed close is made from that cached response.

## Current verification

All recorded command exits are in `command-receipts.ndjson` with full build logs and quiet-test
summary logs. Fresh verification passed:

- `npm run build:main`
- `npm run build:renderer`
- `node node_modules/typescript/bin/tsc --noEmit`
- `npm run typecheck:spec`
- `npm run test:quiet -- src/main/browser-gateway/browser-extension-tab-store.spec.ts src/main/browser-gateway/browser-extension-command-store.spec.ts src/worker-agent/worker-extension-relay.spec.ts`: 3 files, 102 tests passed.
- `git diff --check` in the worktree and for the owner document in the root checkout.

The full suite, lint, size and UI-hint checks were not rerun: there are no implementation/test-source
changes, and these focused checks do not substitute for the six unavailable live scenarios.
No new browser defect was reproduced or entered in the remediation register. The historical
backlog says not to add current status, so current status is recorded in the owner document.

## Review and cleanup

Self-review checked each status against the retained tool response, verified the install segment
instead of counting per-tab profile handles, kept cached snapshots separate from live queries,
and kept packaged Windows evidence separate from the unpaired dev app. No independent PASS is
claimed; the queue coordinator owns that review and any document rename.

Both dev-app launches were reaped. The successful run exited 0. Both temporary Windows tabs were
closed using allowed Browser Gateway calls; final inventory confirmed both closed. Runtime
removal and checks of the three owned ports and two launch PIDs are in `cleanup-receipt.json`.
Only task-created build output, scratch files and isolated app data were removed; pre-existing
shared dependencies and the AIO-managed worktree were preserved. No dependency installation,
browser download, source checkout copy, branch, worktree, stash or commit was created.

`ps` inspection was denied by this environment (`Operation not permitted`). Cleanup therefore
uses the saved owned PIDs, successful process waits, PID absence checks and closed-port checks;
it does not claim an unrestricted whole-machine process scan.

`seal.json` hashes the retained evidence and root owner document. It attests file integrity only,
not completion or independent review.
