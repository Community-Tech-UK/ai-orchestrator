# Browser-Extension Channel Flapping (LT-371) — Live Test

## Status — completed by consolidation 2026-09-27
Open: 0 · Closed: 3 · Transferred: 1 · Failed: 0

The final rebuilt-runtime correlation is now [AR-003](../../plans/2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-003--lt-371-live-browser-command-socket-handoff-correlation). Its safe fixture is known, but this session's direct reset call is blocked by the runtime evidence-capture gate.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-08-23-browser-extension-channel-flapping_plan_completed.md](2026-08-23-browser-extension-channel-flapping_plan_completed.md)

**Prerequisites:** rebuild and restart the packaged Mac app so its Electron main process contains the
LT-371 coordinator changes (already satisfied as of 2026-08-24/25, see Closed checks). No extension or
native-host deployment is required: neither changed.

James must explicitly approve and perform (or supervise) any Chrome restart, worker restart, network
toggle, or extension interaction on `windows-pc`. Do not control the local Mac UI or restart the live
packaged app without approval. Unit regressions already cover the exact 30-second boundary, response
handoff boolean, bounded same-id requeue, no replay after receipt, node queue-key translation, and RPC
router wiring — the checks below exist to prove those mechanisms live on real transport events.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 1 — a short worker-socket loss does not become a browser-channel disconnect | 2026-08-25 | Natural code-1006 close 15:29:19.355Z → `Node re-registered within disconnect grace` 15:29:29.224Z (9,869 ms gap, inside 30 s grace); zero reliability events until the unrelated 15:39 supersede; exhaustive event scan `_scratch/lt-2026-08-25/lt371-log-scan.mjs` |
| 3 — a sustained outage still takes the true-disconnect path (all 3 expectations) | 2026-08-30 (restore half); first two expectations 2026-08-25 | 2026-08-25: close 16:06:44.992Z → `Node WebSocket disconnected` 16:07:14.993Z (30,001 ms, exactly at boundary), one `node_disconnect`/`attachment_suspended {count:30}`. 2026-08-27 natural cycle (found 2026-08-30): disconnect at 31.731 s, `attachment_restored {count:36}`/`node_reconnect` at 385.278 s — 36 of 36 restored, no duplicates |
| 4 — superseded browser-session generations are pruned (closes remote-node doc check 6) | 2026-08-25 | `attachment_superseded {nodeId: bb62e3ee…, count:24, lagMs:600000}` at 15:39:20.228Z; windowId transition `771551880`→`771552943` (24 vs 30 tabs); lag 623,086 ms ≈ 600,000 ms constant + one sweep interval; no suspension/outage overlapped the prune |

**Note carried forward from the evidence runs:** the sweep deletes the *attachment* but tombstones the
*target* as `status: "closed"` rather than removing it (`browser-extension-tab-store.ts:265-268`,
`browser-target-registry.ts:48-58`). A future runner who reads "only generation B remains" literally
may see stale `closed` rows from generation A in `browser.list_targets` and mistake a correct prune for
a failure.

## 2. A poll response lost before socket handoff is delivered by the next poll — TRANSFERRED

**Why deferred:** reproducing the exact no-open-socket instant needs the rebuilt coordinator (now
satisfied) and either a James-approved bounded network interruption timed to coincide with an in-flight
long-poll, or a natural transport loss that happens to land while a real (non-mutating) Browser Gateway
command is already queued. Unit tests provide deterministic proof of the mechanism without risking an
ambiguous browser mutation, but this check needs the live handoff observed end to end.

**Steps**

1. Use a harmless read-only command (`browser.query_elements` or `browser.snapshot`) with the extension
   actively long-polling.
2. With diagnostic logging enabled, have James briefly interrupt the worker route after the old poll
   begins, restore it inside 30 seconds so a replacement socket registers, then let a harmless command
   resolve the old poll. Do not use click/type/evaluate or another potentially mutating command.
3. Correlate the command id in coordinator diagnostics across the failed response handoff and the next
   extension poll/receipt/result.

**Expected**

- The first response attempt reports `requesting socket is no longer active`; it is not written onto
  the replacement socket under the old request id.
- The same command id is returned to the head of the node queue and delivered once after
  re-registration; later commands remain behind it in FIFO order.
- The call resolves normally; there is no `browser_extension_command_receipt_missing` and no duplicate
  command execution.

**Fails if:** the command disappears after `sendResponse: node not connected`, exceeds its original
90-second undelivered budget, receives a new id, executes twice, or raises receipt-missing.

**Progress so far (do not re-derive, but do not treat as closing evidence):**

- 2026-08-30 evening: a full retained-log search found a real, clean `sendResponse: requesting socket
  is no longer active` sequence on 2026-08-30 (`1788085885699`–`1788085900944`, 15.245 s recovery) —
  proving the refusal branch fires live, not just in unit coverage. But a read-only query of
  `browser_audit_entries` for the surrounding 45-second window returned zero rows: no Browser Gateway
  tool command was queued at the moment the branch fired, so there was nothing to correlate a command
  id, FIFO position, or once-only execution against. The two failed responses were empty/internal
  long-poll responses, not a scoreable command.
- Net position: the coordinator-side mechanism this check is about has fired live and behaved as
  designed on an *empty* poll; what remains is observing it fire while a real read-only command is
  in flight, which needs either a repeat natural occurrence with better timing or James approving a
  bounded interruption per the steps above.

Current execution and final evidence now belong to AR-003 rather than this historical source.

## Status update — 2026-09-24

At that date: Open: 1 · Closed: 3 · Failed: 0
Check 2 no longer needs James or a lucky natural outage. The product's own `reset_node_connection`
tool is a bounded, non-revoking socket drop. Fired together with a read-only Browser Gateway command,
it reproduced the check's condition on 2026-09-24. The one missing piece of evidence was a log line
tying the failed `sendResponse` to the command it carried. That line now exists in code
([LT-616](../../plans/livetest-remediation-register.md)), so check 2 is agent-runnable after a
rebuild: repeat the method below and read the new line.

## Evidence run — 2026-09-24 (orchestrating session, packaged app built 2026-09-23 21:12)

Method, reusable, needs nobody:

1. `reset_node_connection {node: "windows-pc"}` and a read-only
   `browser.query_elements` against a shared public tab, issued in the same tool batch.
2. Read `app.log` from the reset timestamp onwards, and the command's `browser_audit_entries` row.

Observed:

- `1790211907737` `Resetting worker node connection` (reason `Agent reset_node_connection`), then
  `1790211907739` `Worker WebSocket closed` (`closeCode 4010`).
- `1790211907761`: **two** `sendResponse: requesting socket is no longer active`, for poll request
  ids `worker-12053` and `worker-12054`. This is the refusal branch the check is about. As expected,
  nothing was written onto the replacement socket under those ids.
- `1790211909165` `Node re-registered within disconnect grace — treating as continuous session`.
- The query's audit row (`5feafa87-3258-4acf-bb5d-35af8319a6fb`) was written at `1790211909374`
  with `outcome: succeeded`: 1.6 s after the socket closed and 209 ms after re-registration. There
  was one audit row, no `browser_extension_command_receipt_missing`, and no second execution.

Why this does not close check 2: the command was demonstrably in flight across the drop and resolved
exactly once afterwards, but no log line says *which* command a failed poll response carried.
`RpcEventRouter.handleBrowserExtPollCommand` called `requeueUndeliveredCommand` silently, so "same
command id returned to the head of the queue" could not be shown by correlation. That is fixed in the
working tree (LT-616): the requeue now logs `Browser command poll handoff failed; requeued` with
`commandId` and `pollRequestId`. After a rebuild, repeat the method and match `pollRequestId` against
the `sendResponse` warning.

## Transfer evidence — 2026-09-27

`browser.health` showed `windows-pc` ready on extension v0.2.36. A read-only
`browser.query_elements` call against an existing Calendly tab succeeded. The bounded
`reset_node_connection {node:"windows-pc"}` call was attempted through the supported orchestrator
tool but rejected before mutation with `EVIDENCE_CAPTURE_REQUIRED`; the paired first query used a
stale/error-page target, and the later independent query proved the browser path itself healthy.
Do not bypass the evidence gate through production-app internals. AR-003 records the exact supported
rerun once a Harness evidence-owning session is available.
