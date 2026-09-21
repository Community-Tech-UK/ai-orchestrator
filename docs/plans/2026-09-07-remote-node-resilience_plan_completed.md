# Remote node resilience — mDNS failover, disconnect alerting, launcher ownership

**Status:** completed (code + ops verified; 5 runtime checks deferred to the livetest doc)
**Date:** 2026-09-07
**Trigger:** windows-pc was offline 09:31–13:28 (3h57m) and nobody was told. Root
cause was Tailscale stopping on the coordinator Mac; the outage was *prolonged*
by two independent defects found while investigating.

## Evidence

Coordinator log (`~/Library/Application Support/Harness/logs/app.log`):

```
09:31:53  Worker WebSocket closed   closeCode 1006, sessionMs 41213081, heartbeatAgeMs 33818
09:32:23  Node deregistered         windows-pc
09:47:23  hard timeout — instance i5epf304e marked failed
13:28:27  Node registered           (only after a manual `tailscale up`)
```

Both machines are on the same LAN — Mac `192.168.0.95`, windows-pc
`192.168.0.199`; Tailscale itself reports `direct 192.168.0.199:41641`. A LAN
path to the coordinator existed the entire time and was never used.

## Findings

### F1 — the coordinator never advertises over mDNS on a normal start

`DiscoveryService.publish()` (`src/main/remote-node/discovery-service.ts:24`)
is called from exactly one place: the `REMOTE_NODE_START_SERVER` IPC handler
(`src/main/ipc/handlers/remote-node-handlers.ts:96`), i.e. only when the user
manually starts the server from Settings.

The normal boot path
(`src/main/app/remote-gateway-initialization-steps.ts:88`) calls
`connection.start(...)` and never publishes. Verified against the log: **zero**
`mDNS service published` entries and zero publish failures — the call never ran.

Consequence: the worker's continuous mDNS browser
(`src/worker-agent/worker-agent.ts:199`, kept running for the worker's lifetime)
has nothing to discover. `buildCoordinatorCandidates()`
(`src/worker-agent/coordinator-network-readiness.ts:11-20`) therefore only ever
yields the pinned tailnet URL, and the worker retries it with capped backoff
forever. The documented "if the coordinator restarts or its IP changes, the
worker detects it and reconnects automatically" cannot work after a normal app
start.

### F2 — no alert on node disconnect

`registry.on('node:disconnected')` is already handled twice in
`remote-gateway-initialization-steps.ts` (failover at :57, renderer event at
:74). Neither notifies the operator. `NotificationService`
(`src/main/notifications/notification-service.ts:139`) already provides
cooldown, fingerprint dedupe and quiet hours, and is used for
`notifyOnAgentCompletion` / `notifyOnLoopTerminal`. It was never wired here.

### F3 — the running worker is orphaned from its scheduled task (ops, not code)

windows-pc process chain: `cmd.exe 16904` (parent 2700, gone) → supervisor
`25768` (Sun 21:46) → child `52336`. No `wscript.exe`, so the worker was not
started by the task. The task itself is correct and armed (action
`wscript.exe "C:\Users\shutu\.orchestrator\run-worker-hidden.vbs"`,
`State: Ready`, `LastTaskResult 0`, 5-minute repeat). Because
`run-worker-hidden.vbs` uses `shell.Run(cmd, 0, True)` — blocking — a
task-started worker keeps the task instance `Running` for its lifetime, which is
how Task Scheduler is meant to track liveness. The orphan defeats that.

**No installer re-run and no elevation are required** — the deployed launcher
and task registration are already correct. Only the orphaned chain needs
replacing.

## Changes

### C1 — publish mDNS from the startup path

`src/main/app/remote-gateway-initialization-steps.ts`: after
`connection.start(...)`, call
`getDiscoveryService().publish(config.serverPort, config.namespace, config.namespace)`,
matching the IPC handler's existing call exactly.

`src/main/remote-node/discovery-service.ts`: make `publish()` idempotent by
unpublishing first. Without this, a Settings toggle after boot would call
`publish()` a second time and leak the previous `Bonjour` instance — a
pre-existing hazard that C1 makes reachable on every run.

### C2 — notify on node disconnect

New setting `notifyOnNodeDisconnect` (boolean, default `true`, `open()`),
following `notifyOnAgentCompletion`. Touches:

- `src/shared/types/settings.types.ts`
- `src/shared/types/settings-defaults.ts`
- `src/shared/types/settings-metadata-integrations.ts`
- `src/shared/types/settings-surfacing.ts`
- `src/main/core/config/settings-control-policy.ts`

**Not** `src/shared/types/settings-profiles.ts`. An earlier draft of this plan
listed it. That was wrong: the profiles file is a deliberately curated `Pick<>`
of ~5 keys for the Overnight/Interactive switch
(`src/shared/types/settings-profiles.ts:26-31`), and the closest sibling setting,
`notifyOnAgentCompletion`, is absent from it too. Three of the five sites above
are exhaustive by construction (`DEFAULT_SETTINGS: AppSettings`,
`SETTINGS_TOOL_POLICY ... satisfies Record<keyof AppSettings, …>`, and
`SETTING_SURFACING`), so a genuinely missing registration is a compile error
rather than a silent gap.

Call site: the existing `node:disconnected` listener in
`remote-gateway-initialization-steps.ts`. Gate with `!== false` (default-on) and
resolve the node name from the emitted payload — `deregisterNode()` deletes the
node from the map before emitting, so `getNode()` would return `undefined`.

Raised at `urgency: 'critical'`. That is the built-in escape hatch, not a hack:
`notification-service.ts:167,173` skip quiet hours and the per-kind cooldown for
critical only. The fingerprint dedupe at `:162` is checked *before* those
branches, so per-node dedupe is preserved and a single flapping node still
collapses into one alert. An overnight drop is the case most worth surfacing —
the incident behind this plan ran 09:31→13:28 unnoticed, and a night-time one
would simply have run longer.

**Accepted tradeoff (raised by review, not an oversight left standing).** The
dedupe is keyed `{kind, nodeId}` while the cooldown that `critical` skips is
keyed by `kind` alone. So *N different* nodes disconnecting together produce N
notifications, each with forced sound, and no digest — the digest path is only
reachable from the cooldown branch that critical bypasses. This is accepted: a
simultaneous multi-node drop is a larger event than a single one, and collapsing
it would hide the blast radius. It is bounded in practice (three registered
nodes, rarely more than two connected). Revisit if this ever runs against a
large fleet. `notificationSoundMode: 'never'` still wins over critical
(`notification-sound.ts:34`), so an explicit full mute is respected.

Note also that Electron's `Notification.urgency` is Linux-only, so on macOS the
OS-level field is inert. That does not affect this change: the quiet-hours and
cooldown bypass is app-level logic in `notify()`, identical on every platform.

### C3 — candidate list on windows-pc (ops)

Tailscale addresses are and should remain the primary: the MagicDNS name
`ws://macbook-pro.tail4fc107.ts.net:4878` is stable across DHCP changes and
works when the machines are not on the same LAN at all. That was never the
problem.

The problem is **failure domains**. The as-found list was:

```
primary:   ws://macbook-pro.tail4fc107.ts.net:4878   needs Tailscale
fallback:  ws://100.68.10.5:4878                     needs Tailscale
fallback:  ws://192.168.0.156:4878                   stale — Mac is now .95
```

Three entries, but only two domains, and the single non-Tailscale entry had
rotted. So when Tailscale stopped there was no surviving candidate — the list
gave the *appearance* of redundancy while having none.

A hardcoded LAN IP cannot be the answer, because it rots on every lease change;
that is exactly how `.156` died. mDNS is the durable second domain: it resolves
the coordinator's current address with nothing hardcoded, which is why C1
matters more than any config entry.

Actions: drop the stale `.156`; keep `.95` only as a crutch until LT-C proves
mDNS failover works on this network, then drop it too and let discovery carry
the non-Tailscale path. A DHCP reservation for the Mac would be the alternative
if mDNS turns out to be blocked on the Windows firewall.

### C4 — re-own the worker (ops)

Kill the orphaned chain (supervisor first, then child, both re-derived at kill
time — not by stale PID) and let the task's 5-minute repeat start a chain it
owns. Verify afterwards that `wscript.exe` appears in the new parent chain.

## Verification

- Targeted tests for the changed areas, then the canonical checklist:
  `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`,
  `npm run test:quiet`.
- C1 runtime proof: `mDNS service published` appears in app.log on next start,
  and `dns-sd -B _ai-orchestrator._tcp` sees the service.
- C3/C4 proof: node reconnects; new chain contains `wscript.exe`.

## Deferred / live-test

Four runtime checks are deferred to
[2026-09-07-remote-node-resilience_livetest.md](2026-09-07-remote-node-resilience_livetest.md).

## Not in scope

- Attributing who stopped Tailscale at 09:31 (unified log does not reach back
  past the 13:16 reboot — unprovable, documented in conversation).
- Rotating the Tailscale auth key found in plaintext in `~/.zsh_history`.
  Flagged to James; his call.
