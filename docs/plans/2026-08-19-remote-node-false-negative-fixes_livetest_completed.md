# Remote-Node False-Negative Fixes (run_on_node provider guard + browser inventory honesty) — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Task: 2026-08-19 investigation "two defects that make a healthy remote worker node look broken"
(no plan/spec doc — direct task). Changed files: `src/main/app/orchestrator-tools-step.ts`,
`src/main/app/run-on-node-support.ts` (new), `src/main/browser-gateway/browser-gateway-refresh-support.ts`,
`src/main/browser-gateway/browser-target-discovery-operations.ts`,
`src/main/browser-gateway/browser-extension-tab-store.ts`, `src/main/browser-gateway/browser-reliability-events.ts`.

**Prerequisites:** rebuilt AND restarted app (all changes are main-process; the running instance
still executes the old dist). The connected node `windows-pc`
(id `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`, supportedClis antigravity/copilot/cursor — no claude)
with browser automation + extension relay running. No `build:aio-mcp-dist` needed: nothing that
ships in the aio-mcp SEA (native host, MCP dispatcher) changed.

Both defects were reproduced live on 2026-08-19 against the old build before fixing
(instance `itbw6pums` went idle with only the user message; `browser_list_targets` reported
"inventory refresh FAILED … extension last contacted 0s ago" with every target stale while
lastSeenAt values in the same payload were seconds old).

## 1. run_on_node without provider is rejected with the node's CLI list

- Steps: against the restarted app, `run_on_node({ node: "windows-pc", prompt: "Reply with exactly: LIVETEST_D1 and nothing else." })` (no `provider`).
- Expected: the tool call FAILS immediately (no instance id) with an error naming the resolved
  default provider and listing `antigravity, copilot, cursor`, telling the caller to pass
  `provider`. No orphan instance appears on the node (`list_remote_nodes` activeInstances
  unchanged).

## 2. run_on_node with an explicit missing provider is rejected

- Steps: `run_on_node({ node: "windows-pc", provider: "claude", prompt: "hi" })`.
- Expected: immediate rejection: `provider "claude" is not installed on worker node "windows-pc". CLIs available on this node: antigravity, copilot, cursor.`

## 3. run_on_node with a supported provider still works

- Steps: `run_on_node({ node: "windows-pc", provider: "cursor", prompt: "Reply with exactly: LIVETEST_D1_OK and nothing else." })`, then `read_node_output` with `waitMs`.
- Expected: assistant replies `LIVETEST_D1_OK`. Terminate the instance afterwards.

## 4. list_targets refresh no longer reports FAILED while the extension is reporting

- Steps: `browser_list_targets({ nodeId: "bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be", refresh: true })` twice, ~1 min apart, while the node's Chrome is open.
- Expected: no "inventory refresh FAILED" reason and no `stale: true` on targets whose
  `lastSeenAt` is recent, even if the `report_inventory` ack exceeds its 2.5 s execution window
  (the known behaviour on this 20+ tab node).

## 5. Refresh failures that are real now carry the underlying error

- Steps: quit Chrome on windows-pc (or disable the extension), wait >2 min so no inventory is
  arriving, then `browser_list_targets({ nodeId: "bb62e3ee-…", refresh: true })`.
- Expected: reason contains "inventory refresh FAILED for node … (<underlying error, e.g.
  browser_extension_command_timeout or browser_extension_command_not_delivered>) — extension last
  contacted …". Restart Chrome afterwards.

## 6. Superseded browser-session generations are pruned

- Steps: with Chrome open on windows-pc, note the current windowId generation in
  `browser_list_targets` profileIds (`existing-tab:n.<node>:<windowId>:<tabId>`). Restart Chrome
  on the node, wait ~15 min (prune lag is 10 min relative to the new generation's reports), then
  list targets again.
- Expected: only the new generation's profileIds remain; the pre-restart generation is gone
  (transitionally it may appear for up to ~10 min). `browser.health` reliability events include
  `attachment_superseded` for the node.

## 7. Leftover investigation tab

- Steps: one `https://example.com/` tab is open on windows-pc from the 2026-08-19 control test
  (plus possibly a second from this session's re-reproduction). Close them via the node's Chrome
  (or a browser gateway close/navigate action) when convenient.
- Expected: tab(s) gone from the next inventory; harmless either way.

## Evidence run — 2026-08-21 (batch Q1, `windows-pc` node id `bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`)

Driven via the orchestrator-tools stdio MCP helper (`node _scratch/lt-2026-08-20/batchQ1/aio-tool.mjs
call …`) against the live packaged app. `list_remote_nodes` confirmed `windows-pc` connected
throughout (`status: "connected"`, `hasBrowserRuntime/hasBrowserMcp/hasExtensionRelay: true`,
`activeInstances: 4` before and after checks 1–3, i.e. no orphan left behind).

### 1. `run_on_node` without provider is rejected — PASS

`run_on_node({node: "windows-pc", prompt: "…LIVETEST_D1…"})` (no `provider`) failed immediately with
`run_on_node rejected: no provider was given and the default resolved to "claude", which is not
installed on worker node "windows-pc". CLIs available on this node: antigravity, copilot, cursor.
Pass one of those via "provider".` — exact match to the expected wording, including the resolved
default (`claude`) and the node's real CLI list. `list_remote_nodes.activeInstances` unchanged
(4→4): no orphan instance.

### 2. `run_on_node` with an explicit missing provider is rejected — PASS

`run_on_node({node: "windows-pc", provider: "claude", prompt: "hi"})` failed immediately with
`run_on_node rejected: provider "claude" is not installed on worker node "windows-pc". CLIs
available on this node: antigravity, copilot, cursor. Pass one of those via "provider".` — matches
the doc's expected string (doc's excerpt omits the trailing "Pass one of those…" sentence; the
actual message is a strict superset, same required content).

### 3. `run_on_node` with a supported provider still works — PASS

`run_on_node({node: "windows-pc", provider: "cursor", prompt: "…LIVETEST_D1_OK…"})` returned an
instance id (`upz9nytfv`); `read_node_output` (with `waitMs`) returned the assistant reply
`LIVETEST_D1_OK` verbatim after ~10s once the CLI had actually warmed up (first poll at 60s
returned only the echoed user message — normal cold-start latency, not a failure). Terminated the
instance afterward (`terminate_node_instance` → `{"terminated":[{"instanceId":"upz9nytfv"}]}`).

### 4–7. NOT RUN — browser-gateway MCP unreachable from this subagent shell

These four checks all key off `browser_list_targets`, which lives entirely under
`src/main/browser-gateway/` and is exposed only via the browser-gateway MCP RPC server. That
server's forwarder needs `AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET`, which is genuinely absent from
this shell's environment (checked: only `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET` and
`AI_ORCHESTRATOR_INSTANCE_ID` are injected). `aio-tool.mjs list` confirms `browser_list_targets` is
not among the 44 tools reachable over the orchestrator-tools socket — this is the same
structural split the brief describes ("browser-gateway checks belong to the orchestrator; hand
them back rather than declaring the subsystem unreachable"), not a misconfiguration on this node.
`windows-pc`'s browser runtime and extension relay were confirmed healthy throughout
(`hasBrowserRuntime/hasBrowserMcp/hasExtensionRelay: true`, `extensionRelay.registration: "ok"`,
`lastExtensionContactAt` within the last few seconds of every poll), so there's no reason to expect
checks 4–7 would fail if driven with browser-gateway access — they are simply undriveable from a
subagent shell and need to be run by the orchestrating session (which does hold the browser-gateway
socket) or a future agent with that access.

### Verdict

Checks 1–3 PASS. Checks 4–7 NOT RUN (browser-gateway MCP genuinely unreachable from this shell, not
a defect). **Not renamed to `_livetest_completed.md`** — residual is exactly checks 4–7, all of
which need `browser_list_targets`/browser-gateway MCP access this subagent does not have.

## Evidence run — 2026-08-22 (orchestrator): check 4 PASS — the routing note from batch Q1 resolved

Batch Q1 correctly identified checks 4–7 as needing `browser_list_targets`, which is only reachable
from a session holding `AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET` — i.e. the orchestrating session, not
a subagent shell. Running it from here.

### Check 4 — refresh no longer reports FAILED while the extension is reporting — ✅ PASS

Two calls, `browser_list_targets({ nodeId: "bb62e3ee-…", refresh: true })`, **226 s apart**
(auditIds `40df09a2`, `0bc0e75b`). Both identical in the respects that matter:

| | Result |
| --- | --- |
| `reason` field | **absent entirely** — `describeInventoryRefreshFailures` returned `''` |
| Targets with `stale: true` | **zero**, on either call |
| Live targets | all `status: "selected"` with `lastSeenAt`/`lastConfirmedAt` within seconds of the call |
| Genuinely closed tabs | 4, correctly `status: "closed"` with ~2-day-old timestamps — labelled closed, **not** stale |

The contrast with 2026-08-19 on this same node is the whole point:

```
BEFORE: reason: "inventory refresh FAILED for node bb62e3ee-… — extension last contacted 0s ago;
                 those targets are cached and marked stale"      … all 48 targets stale: true
AFTER:  (no reason field at all)                                  … zero targets stale
```

That is exactly the false-negative this doc exists to close: a healthy, actively-reporting extension
being reported as a failed refresh because the `report_inventory` ack outran its 2.5 s window on a
20+ tab node. It no longer does.

### Checks 6 and 7 — incidental observations, **not** claimed as passes

Both need a deliberate Chrome restart on the node, which is James's machine, so neither was driven.
Recording what the two listings happen to show, clearly labelled as uncontrolled:

- **Check 6 (superseded generations pruned):** only **one** windowId generation is present
  (`771550150`). On 2026-08-19 this node served **two** concurrently (`771549022` and `771550150`),
  with the older one's tabs ~6 h stale and never re-confirmed. The old generation is now gone. That is
  consistent with pruning working — but there was no controlled restart, so it is an observation, not
  evidence. Check 6 still needs the documented restart-and-wait.
- **Check 7 (leftover investigation tab):** the `https://example.com/` tab is still in the inventory
  but as `status: "closed"` (`lastConfirmedAt` ~2 days old), alongside three other closed tabs. So it
  is closed on the node, not gone from the listing. The check calls this "harmless either way".

### Residual

**Checks 5 and 6 need James** — both require quitting/restarting Chrome on `windows-pc` (check 5:
quit Chrome, wait >2 min, list, confirm the reason now carries the *underlying* error; check 6:
restart Chrome, wait ~15 min for the 10-minute prune lag, confirm only the new generation remains).
Check 7 is cosmetic and effectively satisfied.

**Doc status: not renamed.** Checks 1–4 PASS; 5 and 6 need a Chrome restart on the node.

## Evidence run — 2026-08-23 (orchestrator): check 6 caught mid-transition after James restarted Chrome

James restarted Chrome on `windows-pc`. `list_remote_nodes` shows the worker agent itself restarted
too (`workerAgent.startedAt` and `connectedAt` both 2026-08-23T11:57:37Z), and at that instant the
`extensionRelay` block carried `running: true, registration: "ok"` but **no `extensionVersion`, no
`extensionReloadedAt` and no `lastExtensionContactAt`** — the relay was up before the extension had
reconnected.

### Check 6 — superseded generations — ◐ transition observed exactly as specified; prune not yet confirmed

`browser_list_targets({ nodeId, refresh: true })` (auditId `4e722bd9`) returned **both** generations:

| Generation | Tabs | `status` | `stale` | `lastConfirmedAt` |
| --- | --- | --- | --- | --- |
| `771550150` (pre-restart) | 21 | `closed` | **`true`** | 2026-08-22T07:03:47Z (yesterday) |
| `771551296` (post-restart) | 21 | `selected` | absent | 2026-08-23T11:58:00Z (seconds old) |

The check explicitly allows this: *"transitionally it may appear for up to ~10 min"*. So this is the
expected mid-transition state, not a failure — and the interesting part is that the old generation is
being handled **correctly** while it lingers: every one of its tabs is marked `status: "closed"` **and**
`stale: true`, so nothing stale is being presented as live.

**And there is no `reason` field on the response at all**, despite 21 genuinely-stale targets being
returned. That is the check-4 fix behaving properly under the hardest case for it: it flags the
individual stale entries without declaring a blanket "inventory refresh FAILED" over a channel that is
in fact healthy and actively reporting a brand-new generation.

**Still to confirm:** that `771550150` disappears entirely once the 10-minute prune lag elapses, and
that `browser.health` records an `attachment_superseded` reliability event for the node. Re-check due
~12:10Z.

### Check 5 — still not run, and the window was missed

Check 5 needs Chrome **absent** for >2 min so no inventory arrives at all, then a refresh, to confirm
the reason now carries the *underlying* error rather than a bare "FAILED". The restart was already
complete and the extension reporting by the time this session looked, so that window passed
unobserved. It needs a deliberate quit-and-wait, not a restart.

### Check 5 — a real refresh failure now carries the underlying error — ✅ PASS

Caught the window this time. `browser.health` showed the node had gone **silent** —
`remoteExtensions: {total: 1, ready: 0, silent: 1}`, `lastDisconnect: {reason: "node_ws_disconnected"}`,
and the warning *"Browser extension on windows-pc is not polling (last contact: never); commands to
that node cannot be delivered until it reconnects."*

`browser_list_targets({ nodeId, refresh: true })` (auditId `afc7cb53`) then returned, verbatim:

```
inventory refresh FAILED for node bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be
(browser_extension_command_not_delivered) — no extension contact recorded;
channel disconnected 194s ago (node_ws_disconnected);
those targets are cached and marked stale
```

Against the check's stated expectation, every element is present:

| Expected | Observed |
| --- | --- |
| `inventory refresh FAILED for node …` | ✅ |
| `(<underlying error>)` — e.g. `command_timeout` or `command_not_delivered` | ✅ **`(browser_extension_command_not_delivered)`** |
| `— extension last contacted …` | ✅ `no extension contact recorded; channel disconnected 194s ago (node_ws_disconnected)` |
| targets cached and marked stale | ✅ all 46 carry `stale: true`, `status: "closed"` |
| >2 min with no inventory arriving | ✅ **194 s** |

**Checks 4 and 5 together are the whole point of this doc, and they now both pass.** Check 4 proved
the gateway does *not* cry "FAILED" over a healthy, actively-reporting channel whose ack merely
outran its 2.5 s window. Check 5 proves it *does* report failure — naming the underlying cause,
the disconnect reason, and the age — when the channel is genuinely down. A false-negative fix that
only silenced the message would have passed check 4 and failed check 5; this passes both.

### Check 6 — still incomplete, and now blocked on the channel being up

Both generations (`771550150`, `771551296`) are still present, and with the channel down both are now
`stale: true`. The 10-minute prune cannot complete while no new inventory is arriving, so this
snapshot cannot close it.

**The mechanism is demonstrably real, though** — `browser.health.recentReliabilityEvents` contains an
`attachment_superseded` event for this node at 2026-08-22T20:24:03Z with
`detail: {count: 20, lagMs: 600000}`. That is the exact 10-minute lag the check describes, from an
earlier restart cycle. So check 6's expectation is not hypothetical; it just has not been observed
end-to-end in one controlled pass.

**To close it:** Chrome running on `windows-pc`, extension connected and reporting, left alone for
~10–15 minutes, then one `list_targets`. Expect only `771551296` (or a newer generation) to remain,
plus a fresh `attachment_superseded` event.

### Doc status

Checks **1, 2, 3, 4, 5 PASS**. Check 6 needs one uninterrupted 10–15 minute window with Chrome up.
Check 7 is cosmetic (the `example.com` tab shows as `closed`). **Not renamed.**

### Check 6 — still NOT observed. What happened instead was the grace-expiry path, which is a different mechanism

A later `list_targets({nodeId, refresh: true})` (auditId `c6576871`) returned **`data: []`** — every
target gone, where minutes earlier there had been 46 across two generations. The `reason` was still
correct and complete: `inventory refresh FAILED for node bb62e3ee-… (browser_extension_command_not_delivered)
— no extension contact recorded; those targets are cached and marked stale`.

**The tempting reading is "pruning worked, check 6 passes". That reading is wrong**, and the log says
why. Reliability events across the window:

```
11:59:46  attachment_suspended   {count: 21, graceMs: 900000}
11:59:46  node_disconnect        {suspendedAttachments: 21}
13:11:51  node_disconnect        {suspendedAttachments: 0}
16:15:29  node_disconnect        {suspendedAttachments: 0}
```

There is **no `attachment_superseded` event today at all**. The only one on record remains
2026-08-22T20:24:03Z (`count: 20, lagMs: 600000`).

So what emptied the list was the **15-minute suspension grace expiring** while the extension never
came back — `attachment_suspended (graceMs: 900000)` followed by later disconnects finding
`suspendedAttachments: 0`. That is the *node-went-away* path.

Check 6 asks about a different mechanism entirely: a **new generation reporting** while the
**superseded** one is pruned after a ~10-minute lag, evidenced by an `attachment_superseded` event.
With Chrome closed there is no new generation, so the supersede path cannot run. Recording the
distinction because conflating the two would put a false PASS in this doc — the same list ends up
empty either way, and only the event kind distinguishes them.

**Useful adjacent evidence, recorded as such:** the suspend-then-expire lifecycle demonstrably works.
Attachments do not leak indefinitely when a node's browser disappears — 21 suspended with a 15-minute
grace, then gone. That is a real property, just not this check's.

### What check 6 actually needs — third attempt

Chrome **running and staying running** on `windows-pc` with the Harness extension enabled, reporting
inventory, left undisturbed for ~10–15 minutes. Then one `list_targets`. Expect: only the newest
generation's profileIds present, and a **fresh `attachment_superseded`** event in
`browser.health.recentReliabilityEvents`.

Two attempts have now missed it — the first because the restart was already complete before this
session looked, the second because Chrome was closed again before the prune could run. The window is
narrow only because the channel keeps changing state; the check itself is a single call once the node
has been quietly reporting for ten minutes.

### Check 6 — mechanism read from source; why two attempts could not have worked, and the exact sequence that would

Rather than keep re-running the check hopefully, `sweepSupersededAttachments()`
(`browser-extension-tab-store.ts:251-282`) was read. It settles what the check actually requires:

- Both loops **skip suspended attachments entirely** (`if (attachment.suspendedAt !== undefined) continue`).
- Per channel it takes the newest `updatedAt` among **non-suspended** attachments, and prunes any
  non-suspended attachment lagging that by more than `SUPERSEDED_ATTACHMENT_LAG_MS` = **10 min**.
- The code comment states the intent directly: *"a channel that has gone quiet keeps everything (that
  case is the suspension flow's job, not evidence its tabs closed)."*

`SUSPENDED_ATTACHMENT_GRACE_MS` = **15 min** (`:24`).

**So `attachment_superseded` requires two generations simultaneously present and NON-suspended, the
older lagging the newer by >10 min.** That explains both failed attempts:

1. **Attempt 2** (Chrome closed): every attachment was suspended, then the 15-minute grace expired and
   they were dropped. Suspended attachments are skipped by the sweep, so the supersede path was
   structurally unreachable — the empty list came from grace expiry, a different mechanism.
2. **Attempt 3** (Chrome reopened from a cold slate): all prior attachments had already expired, so a
   fresh generation appeared against **nothing**. With no older non-suspended generation to lag behind
   it, there is nothing to supersede.

**The sequence that does produce it**, and what the 2026-08-22 event (`count: 20, lagMs: 600000`)
must have come from: Chrome running and reporting (generation A attached, non-suspended) → Chrome
**restarted** with the channel recovering inside the 15-minute grace, so A is *restored* rather than
expired and generation B begins reporting → wait >10 min → A pruned, event fires.

### Observation worth flagging separately: the node's channel is flapping

Three `node_disconnect` events inside twenty minutes (16:15:29, and 16:35:08 immediately after 21
attachments were created), on top of the 11:59 and 13:11 ones. `list_remote_nodes` shows the worker
agent itself healthy throughout (`latencyMs: 1`), so this is the **extension/native-host channel**
cycling, not the node link. Not filed as a defect — it is one node on one day and the suspension flow
handles it correctly — but it is the reason this check keeps slipping, and it would be worth a look if
it persists.

**Recommendation: stop chasing check 6 opportunistically.** The mechanism is proven (a real
`attachment_superseded` event with the exact documented 10-minute lag), the code path is now read and
understood, and the constants are confirmed. What is missing is one uninterrupted observation, which
needs a stable channel and a deliberate restart-within-grace — not another opportunistic look.

## Evidence correction — 2026-08-23 (LT-371 investigation)

The prior section's statement that the worker node link was healthy *throughout* the channel drops was
wrong. `list_remote_nodes` sampled after a drop proved that the worker had recovered by then; it did
not prove the node WebSocket stayed connected during the event.

The discriminating cross-layer check has now been run:

- `browser.health` reported `serviceWorkerRestarts: 0`;
- read-only worker logs showed continuous browser-extension poll heartbeats and no native-host errors
  across the main event window;
- the same worker logs recorded 63 coordinator-socket closes (61 WebSocket code 1006) from one
  sequential worker process;
- the coordinator log places `WorkerNodeConnection Node WebSocket disconnected` immediately before
  every one of the 30 reliability `node_disconnect` events;
- source tracing confirms `node:ws-disconnected` is the only caller that expires the remote browser
  bridge and suspends its attachments.

Therefore the dropping side is the **worker-node WebSocket transport**, not Chrome's MV3 service
worker and not the extension/native-host relay. The timing is non-periodic: re-registration gaps have
a 10.556-second median, 24/30 are within 30 seconds, and the intervals between drops vary from about a
minute to more than a day. The 53 reconnects versus 30 disconnects come from first-contact and
zero-attachment contact transitions plus replacement sockets whose superseded socket closes after
the new one is active; there is no evidence of concurrent duplicate workers.

LT-371 now owns the remediation. The coordinator fix extends the existing true-disconnect grace from
2.5 to 30 seconds and safely returns a browser poll command to its queue when its RPC response
provably could not be written to an open node socket. That prevents ordinary short transport recovery
from suspending/restoring all 21 tabs and prevents that exact pre-handoff loss from becoming a false
`browser_extension_command_receipt_missing`.

### Check 6 remains pending

This investigation does **not** close check 6. The running packaged app has not been restarted onto
the LT-371 coordinator build, and no new controlled generation-A → restart-within-grace → generation-B
transition has been observed for 10–15 uninterrupted minutes. Closing it still requires James to
restart Chrome on `windows-pc`, so it belongs in the new LT-371 implementation livetest rather than an
unapproved action in this session.

---

## Evidence run — 2026-08-24 (orchestrator): check 7 PASS; check 4 re-confirmed on the LT-371 build

**Runtime under test.** The packaged app was rebuilt at `2026-08-24 00:35` and restarted at
`00:38:07` (`ps -eo lstart` on `/Applications/Harness.app/Contents/MacOS/Harness`, pid 83885). That
build contains the LT-371 coordinator changes — verified by extracting
`dist/main/remote-node/worker-node-connection.js` out of `Contents/Resources/app.asar` and finding
the new `Node re-registered within disconnect grace — treating as continuous session` string (1
occurrence; 4 in the raw asar across sources/maps). So every observation below is against the fixed
coordinator, not the build the earlier sections ran on.

### Check 7 — leftover investigation tab — ✅ PASS

`browser.list_targets({computer: "windows-pc"})` at `1787528760` (00:46:00Z), and again with
`refresh: true` at `1787528836` (00:47:16Z, auditId `6fc40cef-7639-42f3-af1e-2dab26e6ef1c`), returned
**23 targets, none of them `example.com`**. The `https://example.com/` tabs left over from the
2026-08-19 control test and its re-reproduction are gone from the inventory. Nothing to clean up.

### Check 4 — refresh does not report FAILED while the extension is reporting — ✅ re-confirmed

The `refresh: true` call above returned `outcome: "succeeded"` with all 23 targets carrying a
`lastConfirmedAt` equal to that call's own timestamp (`1787528836407`–`1787528836425`), i.e. every
target was re-confirmed by the extension inside the refresh window rather than served stale. This
repeats the 2026-08-22 PASS on the current build.

### Check 6 — superseded generations — still PENDING, and the reason is now precise

Every one of the 23 targets is in **one** generation: `existing-tab:n.bb62e3ee-…:771551880:<tabId>`.
`sweepSupersededAttachments()` needs **two generations simultaneously present and non-suspended**,
the older lagging the newer by more than `SUPERSEDED_ATTACHMENT_LAG_MS` (10 min). With a single
generation present there is nothing to supersede, so the check is not merely unobserved — it is
structurally unreachable from the current state.

Producing the second generation requires a Chrome restart on `windows-pc`, which this session is not
authorised to perform. Check 6 is therefore owned by
[`2026-08-23-browser-extension-channel-flapping_plan_livetest.md`](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md)
check 4, where the prerequisite is recorded as James's action.

### Doc status

Checks **1, 2, 3, 4, 5, 7 PASS**. Check 6 pending on a James-performed Chrome restart on
`windows-pc`. **Not renamed.**

### Check 6 — the supersede mechanism was observed firing live at 02:13Z, on a single tab rather than a generation

A `attachment_superseded` event fired unprompted at `1787535238684`:
`{count: 1, lagMs: 600000}`, and it was the **only** reliability event in the window — no
`node_disconnect`, no `attachment_suspended`, no `attachment_restored`. Cause, from
`browser.list_targets`: one LinkedIn tab in the **same** window generation `771551880` was closed
(`…:771551889`, now `status: "closed"`, last confirmed `1787534614465`) and reopened as
`…:771552535`. Measured lag to the event: **624,219 ms ≈ 10.4 min**, matching
`SUPERSEDED_ATTACHMENT_LAG_MS` (600,000 ms) plus one sweep interval.

This settles the mechanism questions the earlier sections in this doc worked so hard on — the sweep
runs on the current build, fires with the documented lag, and does so on a healthy channel rather than
through the grace-expiry path. **It does not satisfy check 6**, which is about a whole *generation*
being pruned after a Chrome restart: the windowId never changed and `count` was 1, not ~21.

Full write-up, including a wording trap worth knowing about before the next attempt — the superseded
target stays listed with `status: "closed"` rather than disappearing, so "the pre-restart generation is
gone" must not be read literally — is in
[the LT-371 livetest](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md).

Check 6 status unchanged: **PENDING**, on a James-performed Chrome restart. Doc still 6 of 7,
**not renamed**.

---

## Evidence run — 2026-08-25 (orchestrator): check 6 PASSES — a full 24-attachment generation prune, observed live

Check 6 has been the sole open item in this doc since 2026-08-21, blocked each time on the same thing:
two generations simultaneously present and non-suspended, the older lagging the newer by >10 minutes.
That state occurred on `windows-pc` today without anyone arranging it, and the sweep did exactly what
this check describes.

**The event.** `browser.health` → `recentReliabilityEvents`, corroborated in
`~/Library/Application Support/harness/logs/app.log`:

```
2026-08-25 15:39:20.228Z  BrowserReliability
  Browser reliability event: attachment_superseded
  {nodeId: "bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be", count: 24, lagMs: 600000}
```

**Two generations, and the pruned set identified rather than inferred.** From
`browser.list_targets({computer: "windows-pc"})`:

| | generation A | generation B |
| --- | --- | --- |
| windowId | `771551880` | `771552943` |
| tabs | **24** | 30 |
| `lastConfirmedAt` | 15:28:57.119–.142Z | 16:07:14.993Z |
| `lastSeenAt` | **1787672360228** | 1787674034993 |
| `status` | `closed` | `selected` |

Generation A's 24 targets all carry `lastSeenAt: 1787672360228`, **identical to the
`attachment_superseded` event's own timestamp** — and that field is written by `markClosed()`, which
the prune path calls (`browser-target-registry.ts:48-58`,
`browser-extension-tab-store.ts:265-268`). So these 24 targets are provably the 24 the event counted.
The count matching the generation size is a second, independent agreement.

**Lag, measured:** generation A last confirmed 15:28:57.142, pruned 15:39:20.228 = **623,086 ms**, i.e.
`SUPERSEDED_ATTACHMENT_LAG_MS` (600,000 ms) plus one sweep interval. Same signature as the single-tab
prune recorded on 2026-08-24, now at generation scale.

**It was the supersede path, not grace expiry.** The complete reliability-event set on this build was
extracted (`_scratch/lt-2026-08-25/lt371-log-scan.mjs`) rather than sampled, because this is a
negative claim. The only channel outage was at **16:07:14 — twenty-eight minutes after the prune** —
and the only earlier blip (15:29:19, code 1006) re-registered inside grace at 15:29:29 with no
suspension at all. Nothing was suspended between generation A's last report and its pruning, which is
required, since `sweepSupersededAttachments()` skips suspended attachments entirely.

**The wording caveat this doc already anticipated.** Check 6 says "the pre-restart generation is gone".
The generation-A *attachments* are gone — deleted from the store, handles dead. The *targets* remain
listed with `status: "closed"`, because the prune deliberately tombstones rather than deletes. That is
the trap flagged on 2026-08-24, and it is the same cosmetic shape this doc already accepted for
check 7. Recorded as a pass on the mechanism the check exists to guarantee.

**One limit stated plainly:** the generation change was inferred from the windowId transition. Nobody
watched Chrome restart on `windows-pc`, and a window close-and-reopen is indistinguishable from a
restart at this layer. What is proven is that a whole superseded generation is pruned by the supersede
path at the documented lag on a healthy channel — which is what check 6 asks.

Full cross-referenced write-up, including checks 1 and 3 of the LT-371 doc which the same event set
closes, is in
[`2026-08-23-browser-extension-channel-flapping_plan_livetest.md`](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md).

### Doc status

Checks **1, 2, 3, 4, 5, 6, 7 — all PASS.** Renamed `_livetest_completed.md`.
