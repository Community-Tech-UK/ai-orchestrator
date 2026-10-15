# Windows PC outage visibility and no silent Mac browser fallback

Status: implemented and verified 2026-10-08. Live checks that need the rebuilt
Harness and a redeployed worker are deferred to
[the livetest doc](2026-10-08-windows-pc-outage-visibility_plan_livetest.md).

## Why

On 2026-10-07 the `windows-pc` worker dropped six times (investigation:
memory note `windows-pc-outages-2026-10-07`). James saw none of the existing
critical "Worker node disconnected" desktop notifications, and while the PC was
gone the Browser Gateway silently ran browser work on the Mac, taking over his
mouse and keyboard while he was working.

James's decisions (2026-10-08):

1. Browser work always runs on the Windows PC unless he asks for the Mac or an
   agent asks him first. Added to every provider's global instructions on
   2026-10-08; this plan adds the code-level guard.
2. He wants to know when the Windows PC drops, and wants the cause investigated.
3. Approved all four items below.

Causes found on 2026-10-07: two network-unreachable drops (worker process alive),
one Windows-update restart, one hard hang that James power-cycled, plus routine
one-second worker child restarts. Open suspects: `mtkbtsvc` holding ~127k
handles, and two Tcpip 4266 UDP-port-exhaustion events.

## Items

### 1. Can't-miss in-app warning while the browser computer is offline

- Remember on each paired node identity that it has reported browser
  automation (`hasBrowserMcp`), persisted with the identity like `platform`.
  The flag is sticky until the node is unpaired, so a browser computer whose
  browser side breaks never lets work fall back silently to the Mac.
  Without this, an offline node has no capabilities and cannot be recognised as
  the browser computer.
- Roster entries expose `browserComputer`.
- A non-dismissable shell banner shows while no paired browser computer is
  connected and healthy: each one's name, last-seen time (or "not
  responding" when degraded), and that agents will not use this Mac's browser
  without asking. Clears itself on reconnect.
- The disconnect desktop notification body says the same.

### 2. "Back online" alert with how long and why

- The worker reports its host boot time (`workerAgent.hostBootedAt`).
- The coordinator remembers, per node, the last-heard time, worker process start
  and host boot time when a node is announced disconnected. On reconnect it
  classifies: PC restarted (boot time moved), worker program restarted (process
  start moved), network (same process throughout), or unknown (old worker).
- Raises a critical-urgency "<name> is back online" notification (like the
  disconnect alert, so quiet hours and the per-kind cooldown cannot drop it)
  with the duration and the reason, and logs the outcome.

### 3. Host-health monitor on the Windows worker

- Windows-only sampler every 5 minutes: UDP endpoints in use (with top owning
  processes) and the processes holding the most handles. Logged as
  `[HostHealth]` in the worker log; latest sample reported in capabilities.
- The coordinator keeps the last sample from before a drop and adds a plain
  warning to the back-online alert when it was abnormal (UDP ports > 5,000, or
  any process > 50,000 handles).

### 4. No silent Mac browser fallback

- `routeBrowserGatewayRequest`: when remote nodes and browser auto-offload are on,
  no browser computer is connected, and a paired browser computer exists:
  unscoped discovery calls and opening a coordinator-local managed profile throw
  `browser_remote_computer_offline`, naming the offline computer and telling the
  agent to ask the user. An explicit `computer: "local"` still works (that is
  the "James said yes" path).
- The Browser Gateway system prompt tells every provider what to do with that
  error.

## Behaviour notes

- The browser-computer flag is persisted and sticky. After a Harness launch
  with the PC offline, the banner shows and agent browser calls are refused
  until the PC reconnects. A connected browser computer that stops reporting
  browser automation shows as "not ready for browser work" and also blocks the
  fallback. A retired PC, or one whose browser automation was deliberately
  switched off, keeps doing this until it is unpaired.
- The banner and the guard use the same availability test: no paired browser
  computer is connected and reporting browser automation. The guard additionally needs remote nodes
  and browser auto-offload switched on; with auto-offload off the banner still
  shows but promises nothing about this Mac. A degraded (silent but still
  registered) browser computer counts as unavailable ("not responding").
- One-time upgrade gap: a PC paired before this build has no browser flag until
  it first connects to the new Harness. If the Harness starts with it offline,
  there is no banner and no guard until it has connected once.
- The back-online notification is critical, and shares the 5-minute per-node
  dedupe, so a node flapping inside five minutes produces one alert.
- "Network" means the same worker process throughout; a sleeping or frozen
  computer looks identical, and the wording says so.
- A host-health sample older than 15 minutes when the node was last heard
  from is left out of the back-online alert.
- Fixed in passing: the notification digest titled every kind "Agent
  finished"; other kinds now digest as "More Harness notifications".
- "Did not do a full restart" (not "stayed on"): Windows Fast Startup keeps
  the boot clock running across a shutdown.
- The sampling script was run on windows-pc (PowerShell 5.1, -EncodedCommand,
  766 ms) and its output parsed by the worker parser on 2026-10-08.
  `mtkbtsvc` grew from 127,519 to 132,873 handles in about 45 minutes.

## Not changing

- Setups with no paired browser computer keep today's local behaviour.
- Target-scoped calls on a local target that was opened with an explicit
  `computer: "local"` keep working.
- Phone push: APNs is not configured (`pushConfigured: false` in app.log), so not
  in scope.

## Verification

- Focused specs for each touched module, then `tsc --noEmit`, `typecheck:spec`,
  `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, `test:quiet`.
- Independent completion-gate review.
- Live checks: deferred to the livetest doc linked above.

## Progress

- [x] 1. Browser computer identity flag, roster field, banner, disconnect copy
- [x] 2. Host boot time + outage tracker + back-online notification
- [x] 3. Windows host-health sampler + abnormal-sample warning
- [x] 4. Offline guard in the offload policy + system prompt line
- [x] Gates, fresh-eyes review, livetest doc

## As built

- Gates (final run, 2026-10-08): `tsc --noEmit`, `typecheck:spec`, `lint`,
  `check:ts-max-loc`, `build:main`, `build:worker-agent`, `build:renderer` all
  exit 0; `test:quiet` 2,380 files / 29,974 tests passed.
- Independent completion gate: four fresh reviews; the first three returned
  FAIL and every finding was fixed (list tool fields, banner/guard alignment,
  failing sampler queries, wording, digest title, stale samples, sticky flag,
  a safety-net test that could not fail); the fourth returned PASS. Its two
  low notes: flag doc comments (fixed), and the generic "retry with computer:
  local" advice on `browser.recover_extension` (left as is; the agent still
  has to ask first).
- Files: `node-outage-tracker.ts`, `host-health-sampler.ts`,
  `browser-computer-offline-banner.component.ts` (new, with specs), plus
  changes to the offload policy, node identity/auth, roster, RPC schemas,
  capability reporter, gateway init step, list tool, notification digest and
  Browser Gateway system prompt.
