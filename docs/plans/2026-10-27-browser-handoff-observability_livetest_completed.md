# Browser handoff observability — rebuilt coordinator live check

Status: ALL SEVEN CHECKS PASSED 2026-11-13 (see "Evidence run — 2026-11-13"). Awaiting the independent verifier;
the upstream AR-003 acceptance is for the coordinator to close, not this worker.

Prerequisites: the queue change has passed independent verification and normal integration;
the coordinator serving this session's Browser Gateway has been rebuilt and restarted from
that identified source. Use Browser Gateway on `windows-pc` only, with the real shared Chrome
extension channel. No browser or desktop application on the Mac is authorized by this task.

Plan: [Browser handoff observability](2026-10-27-browser-handoff-observability_plan.md).
Owning acceptance: [AR-003](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-003--lt-371-live-browser-command-socket-handoff-correlation).

Remediation flow: read [the campaign runbook](livetest-campaign-runbook.md). A reproduced defect
requires an index row and full LT-NNN entry in
[the remediation register](livetest-remediation-register.md), plus a matching implementation-status
section in `2026-07-19-livetest-failure-remediation_plan.md` (use its active replacement if renamed).
Keep per-check evidence here. Do not alter a completed historical remediation plan.

## Why this is deferred

The worker compiled and tested the assigned checkout. The tools in this session still use the
installed coordinator; their healthy Windows channel does not identify that coordinator as this
source/build. The plan expressly withholds authority to replace the installed coordinator or
change production routing. An isolated app cannot prove a live Gateway handoff on the installed
coordinator's shared Windows channel. Normal integration/restart of the owning coordinator is
required first. This is not a missing tab, offline worker, credential issue or permission to
bypass `EVIDENCE_CAPTURE_REQUIRED`.

The full unit suite and independent queue verification are agent-runnable gates owned by the
queue verifier, and are not live-test deferrals.

## Campaign

- [x] Identify source and the running build. Retain checkout commit/diff fingerprints and hashes
  of the running coordinator's `browser-extension-command-store.js`,
  `browser-gateway-service.js`, `browser-gateway-result.js`, `browser-audit-store.js`, and migration
  `081_browser_audit_command_id`. Match the running process/app to those build files; a hash of
  an unused build directory is insufficient. Use the normal supported build/restart process.
  No additional feature flag is required; preserve the operator's existing browser settings.
- [x] Call `browser.health`, require a ready/fresh deliverable `windows-pc` extension channel,
  and use `browser.preflight_target` / `browser.find_or_open` with `computer: "windows-pc"` to
  select a harmless readable shared tab. Confirm one independent `browser.query_elements` on
  the returned profile/target succeeds. Do not use a managed profile or local Chrome.
- [x] In one tool batch, issue exactly one `reset_node_connection {node: "windows-pc"}` together
  with one read-only `browser.query_elements` for that tab. Use the normal approval/evidence
  tools if required; never direct IPC to avoid a refusal. Do not click, type, evaluate, restart
  the worker, revoke registration, or issue unrelated browser commands in the measured window.
- [x] From the reset timestamp, retain `Resetting worker node connection`, socket close,
  `sendResponse: requesting socket is no longer active`, `Browser command poll handoff failed;
  requeued`, and continuous-session re-registration. Join the failure by `pollRequestId` and
  the original `commandId`. The actual refusal branch must execute; a timing miss is inconclusive.
- [x] For that same ID require `Browser command requeued at FIFO head` with `queuePosition: 0`,
  original `undeliveredDeadlineAt`, depth and next-command identity when queued followers exist.
  Confirm the same ID is dispatched again with an incremented `deliveryAttempt` before any
  recorded next command. Preserve receipts/results for the whole window, including late replies;
  coordinator dispatch attempts do not count as browser executions.
- [x] Require exactly one `Browser command reply arrived` event with `reply: "receipt"` and one
  with `reply: "result"` for the original ID, plus one accepted store receipt and one successful
  store result. Arrival logging runs before authentication, schema validation and rate limits;
  a reply rejected by those guards must not disappear from this count. Require no corresponding
  `Browser command receipt rejected` or RPC rejection/error in the measured window. Missing
  arrival/acceptance evidence makes the run inconclusive, not a pass. Require exactly one
  successful `browser.query_elements` audit row with `commandId` equal to that ID and `id` equal
  to the returned `auditId`. Reject a duplicate receipt/result or a match based only on timing.
  Require no `browser_extension_command_receipt_missing`, no duplicate execution and completion
  within 90 seconds of that original command's `createdAt`. The queue unit tests separately prove
  refused replay after receipt; do not induce a mutation to test it live.
- [x] Read final `browser.health`; require `windows-pc` ready/fresh, continuous registration and
  no leftover work. Retain redacted command/audit/queue evidence, build fingerprints, exact elapsed
  time and final health. Keep the upstream AR-003 requirement open until every assertion passes.

## Worker preflight evidence

At `1793427222317`, the installed Browser Gateway reported `windows-pc` fresh, deliverable and
registration OK, with zero queued/in-flight commands and two waiting pollers. This checks current
availability only. No shared tab was driven, no connection reset was attempted and no rebuilt
coordinator was installed. It does not satisfy any campaign checkbox above.

## Evidence run — 2026-11-13

Worker: Plan Queue livetest worker, item `4231ebcc`, checkout `.worktrees/queue/2026-10-27-browser-handoff-obs-7c62c0`
at `f6b4f0f36fd3c40b97a961956c1cc7b88704bd14`, clean tree (`git diff HEAD` empty). No restart or reinstall of Harness
was needed or done: the already-running coordinator contains the change (check 1). The restart permission James gave
was not used. No browser or desktop app on the Mac was used; all browser traffic went to `windows-pc` through the
Browser Gateway. Raw log slice kept at
`2026-10-27-browser-handoff-observability-evidence/live-2026-11-13/coordinator-log-slice.jsonl`
(25 lines, ids and timings only, no page content).

### Check 1 — source and running build: PASS

- Installed app `/Applications/Harness.app/Contents/Resources/app.asar`, modified 2026-11-13 17:25:31.
- Ran `npm run build:main` in this checkout (exit 0) and compared SHA-256 of the compiled files with the same files
  extracted from the installed `app.asar`. All five identical:
  - `browser-extension-command-store.js` `f8a6f200…871c`
  - `browser-gateway-service.js` `d7d85af0…d3cc`
  - `browser-gateway-result.js` `a12e5079…fccc`
  - `browser-audit-store.js` `f14cc03a…57d1`
  - `rpc-browser-command-observability.js` identical (hash compared, equal).
- Source fingerprints (`.ts`, first 16 hex of SHA-256): command-store `95543eb83834e644`, gateway-service
  `f950d48c76c74d95`, gateway-result `d34d2165a0fa3d6a`, audit-store `545134b11e8a7c5e`.
- Running process: the live coordinator emitted `Browser command requeued at FIFO head` and
  `Browser command reply arrived` during the window; both strings exist only in this build. The process id could not be
  listed (`ps` is refused in this sandbox), so the match is by behaviour plus the file hashes, not by process start time.
- Migration `081_browser_audit_command_id` is applied in the real profile (`rlm.db` `_migrations` id 74, checksum
  `1aee93782293077a`) and `browser_audit_entries.command_id` plus `idx_browser_audit_command` exist.
- No feature flag changed; no setting touched.

### Check 2 — channel and tab: PASS

- `browser.health` at `1794596281051`: status ready; `windows-pc` `channelState: fresh`, `commandsDeliverable: true`,
  registration ok, queue 0/0, 4 waiting pollers, no connection flap.
- `browser.list_targets {computer: "windows-pc", refresh: true}` then `browser.preflight_target` selected the public
  Find a Tender notice tab (remote-extension, `windows-pc`, real user session). No managed profile, no local Chrome.
- Independent `browser.query_elements` on that tab succeeded (audit `ecfe084c…`, command `2f87bfea…`).

### Check 3 — measured window: PASS

In one tool batch: one `reset_node_connection {node: "windows-pc"}` (reply `reset: true`) and one read-only
`browser.query_elements` on the same tab (audit `fdd21223-92b8-4cc5-80c6-43b207104b58`). No click, type, evaluate,
worker restart, registration revoke or other browser command from this session in the window (the preflight and the
check-2 query ran before it). Both calls returned success.

### Check 4 — refusal branch and join: PASS

Original command `5d16e50a-005c-47d7-a930-43b14ff1839d` (`query_elements`, `createdAt` 1794596303321). All times ms since epoch, from `app.log`:

| time | event |
| --- | --- |
| 1794596301938 | `Resetting worker node connection` (reason `Agent reset_node_connection`) |
| 1794596301941 | `Worker WebSocket closed`, close code 4010, 0 active instances, 0 in-flight work |
| 1794596303321 | command queued, then dispatched, `deliveryAttempt: 1` |
| 1794596303322 | `sendResponse: requesting socket is no longer active` (`requestId worker-8623`) |
| 1794596303322 | `Browser command poll handoff failed; requeued` with `pollRequestId: worker-8623`, `commandId` = original, `requeued: true` |
| 1794596303322 | a second refusal: `worker-8633`, same `commandId`, `requeued: true` |
| 1794596303596 | `Node re-registered within disconnect grace — treating as continuous session` |
| 1794596303597 / 600 | node registered via WebSocket and via RPC |

The refusal branch really ran, twice, so this is not a timing miss. The join is by `pollRequestId` and `commandId`.

### Check 5 — FIFO head requeue and redelivery: PASS (one clause not applicable)

- `Browser command requeued at FIFO head` for the same ID, twice, each with `queuePosition: 0`,
  `undeliveredDeadlineAt: 1794596393321` (equal to the original deadline, `createdAt` + 90 000), `queuedCount: 1`,
  `remainingMs: 89999`.
- Same ID dispatched again: `deliveryAttempt` 2 at ...322, then 3 at 1794596303663 (after re-registration). Handoff
  confirmed only on attempt 3 (`Browser command handoff confirmed`, ...663). Attempts 1 and 2 were refused handoffs, not executions.
- Not applicable: "next-command identity when queued followers exist". `queuedCount` was 1 (the command itself), so no
  follower existed at requeue time and no next-command identity was logged. The next command anywhere on the channel
  was queued at ...706, after this command's result (...691).
- Other-session traffic on the same shared channel (disclosed): command `3b25c173-ae41-4c1c-bec4-924ccd2091f7`, a
  `query_elements` from instance `xx3h2e1c5` on a different tab, queued 15 ms after the result. A `navigate` from
  `xx3h2e1c5` ran earlier (...296722). It is a different session from this worker's (`c3o9mthir`), and it did not
  touch the measured command.

### Check 6 — exactly-once receipt, result and audit: PASS

For `5d16e50a…` (13 log lines, all in this window):
- `Browser command reply arrived` `reply: "receipt"`: 1 (...671). `reply: "result"`: 1 (...691).
- `Browser command received` `accepted: true`, `deliveryAttempt: 3`: 1. `Browser command result` `ok: true`,
  `accepted: true`: 1.
- Matches for `receipt_missing`, `receipt rejected` or any rejection in the window slice: 0.
- Audit DB (`rlm.db`): exactly 1 row with `command_id = 5d16e50a…`: `id fdd21223-92b8-4cc5-80c6-43b207104b58`
  (equals the `auditId` the tool returned), `browser.query_elements`, `decision allowed`, `outcome succeeded`,
  `created_at 1794596303691`.
- Completion 370 ms after `createdAt` (limit 90 s). No duplicate execution: the extension answered once, on attempt 3.
- Replay-after-receipt refusal was not induced (no mutation); the unit tests own that.

### Check 7 (final) — health and leftovers: PASS

`browser.health` at `1794596327769`: status ready; `windows-pc` `channelState: fresh`, `commandsDeliverable: true`,
registration ok, queue 0 queued / 0 in flight, 4 waiting pollers, no flap, `serviceWorkerRestarts: 1` (unchanged from
the pre-window reading of 1). Continuous registration confirmed by the `treating as continuous session` line.
Elapsed from reset to final health: about 26 s.

### Defects and caveats

- No product defect reproduced; no register entry filed.
- The `ct-test-mac` node appeared in the health output and was not touched.
- The running process could not be matched by pid (see check 1). The other four assertions do not depend on that.
- Not exercised: `browser_extension_command_receipt_missing` (absent as required), and the mutation-replay refusal (by design).
- Runtime cleanup: `/tmp/aio-lt-queue-e07c62c0*` scratch removed; no dev app was launched because the live installed
  coordinator was the right target; `dist/` in this worktree left in place (ignored, dependency of gates).
