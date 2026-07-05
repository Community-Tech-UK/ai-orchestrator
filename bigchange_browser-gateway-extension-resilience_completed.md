# Bigchange: Browser-Gateway Extension Resilience (Remote Relay Hardening)

**Date:** 2026-07-04 (v2 — revised after cross-model review; anchors verified against source)
**Status:** LOCAL IMPLEMENTATION COMPLETE — repo gates passed on 2026-07-05. The two-machine Windows E2E checks in §5/§6 remain deployment validation to capture on `windows-pc`.
**Predecessor:** `bigchange_remote-browser-extension-relay_completed.md`. This plan fixes the failure modes that plan's risk register predicted (esp. risk 10) plus new ones found in a live incident.

---

## 1. Incident (2026-07-04) — post-mortem, root causes verified in source

Remote control of the user's real Chrome on `windows-pc` died silently: every `browser.*` command → `browser_extension_command_timeout`; `browser_health` still said `remoteExtensions ready: 1`; `list_targets` served a ~2 h-stale cache as fresh; the extension icon said "has access"; a tab "share" went to the wrong gateway with no feedback.

### Root cause A (the trigger) — test run polluted the real Windows registry. CONFIRMED.

`prepareBrowserExtensionNativeHostRuntime` (`src/main/browser-gateway/browser-extension-native-runtime.ts:42`) writes runtime.json + wrapper under `<userDataPath>/browser-gateway/native-host/`, writes the Chrome manifest into `chromeNativeMessagingDir`, **and then unconditionally calls `registerWindowsNativeMessagingHost(manifestPath)`** (`:88`, impl `:120-140`) which does `reg ADD HKCU\...\NativeMessagingHosts\com.ai_orchestrator.browser_gateway /d <manifestPath>`.

`browser-extension-native-runtime.spec.ts:15` uses `fs.mkdtempSync(os.tmpdir(), 'browser-native-runtime-')` and passes `chromeNativeMessagingDir` inside that temp dir (`:22`). Running the suite **on a Windows machine** therefore points the real registry at a manifest inside a soon-deleted temp dir. The dangling value found on windows-pc was literally `...\Temp\browser-native-runtime-20f5OO\Chrome\NativeMessagingHosts\com.ai_orchestrator.browser_gateway.json`. On Windows, Chrome resolves native hosts **via registry only** → every `connectNative()` failed → extension stuck in its ≤30 s reconnect loop forever.

### Root cause B (the standing hazard) — one shared name, one shared manifest file, three uncoordinated writers.

All installs share `BROWSER_EXTENSION_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway'` (`browser-extension-native-runtime.ts:6`) and write the **same** manifest path (`browserExtensionNativeHostManifestPath()`, default Chrome dir) and the same registry key. Callers of the helper:

1. `src/worker-agent/worker-agent.ts:783` (`prepareExtensionNativeHostRuntime`, invoked after relay lifecycle actions) — **no ownership check**.
2. `src/worker-agent/cli/service-cli.ts:181` (`install-extension-relay`) — the only guarded path (`assertExtensionRelayManifestWritable`, `:229-247`: refuses to overwrite a manifest whose `path` is outside `<userDataPath>/browser-gateway/native-host`, unless `--force`).
3. `src/main/browser-gateway/index.ts:95` — the **Harness desktop app** (Electron), which regenerates a per-boot random pipe + token and reinstalls — **no ownership check**.

So on a machine running both the app and the worker relay (windows-pc is exactly that), whichever wrote last owns the extension; the loser's commands time out with zero signal. This is predecessor-doc risk 10, observed live.

### Root cause C (why it stayed invisible)

- `browser_health.remoteExtensions.ready` = "relay socket listening" (`browser-health-service.ts:268-285` reading `WorkerExtensionRelay.getSummary()`, `worker-extension-relay.ts:114-125`, `running = server?.listening`). No extension-contact signal exists anywhere.
- `list_targets` serves the push-updated `browser-extension-tab-store` cache with no age/staleness marking (`browser-gateway-service.ts:514-534`).
- The worker log (`~/.orchestrator/logs/worker-agent.log`) contained **zero** relay/native-host/poll lines.
- The popup (`resources/browser-extension/popup.{html,js}`) shows no connection state at all.

### Root cause D (latent extension wedge, found by inspection)

`pollForCommand()` sets `pollInFlight = true` (`background.js:262-271`). If the native host **hangs without disconnecting** (no reply, no `onDisconnect`), nothing ever resets the flag: the 1-minute alarm's `pollForCommand()` no-ops (`:263`), reconnect never fires → **permanent total silence**. Distinct from the `{ok:false}`-reply wedge fixed 2026-06-11 (`:169-171` now resets); this is the no-reply case.

### Interim manual fix applied on windows-pc (2026-07-04)

Hand-written manifest at `C:\Users\shutu\.orchestrator\browser-gateway\native-host\com.ai_orchestrator.browser_gateway.json` (points at the relay wrapper); registry re-pointed at it. **Fragile**: the next `prepare...Runtime()` call from the Harness app (or the worker) rewrites the registry to the shared standard-dir manifest. Phases 1–2 make this structural.

### Also observed (secondary)

- A `submit`-class page action (LinkedIn "Post" inside the create-post dialog) executed under a standing grant without per-action approval. Review `browser-action-classifier` coverage for `role=button` named Post/Send/Publish inside `role=dialog`.
- `find_or_open` gives a generic timeout when the extension is unreachable — should fail fast and distinctly (Phase 4).

---

## 2. Goals / non-goals

**Goals**
1. Test/ephemeral installs can never touch the real OS registration again (kills root cause A).
2. Harness app and worker relay **coexist on one Chrome, simultaneously** — structurally, not by arbitration (kills root cause B).
3. Truthful health + stale-marking + distinct `browser_extension_unreachable` error (kills root cause C).
4. Extension never wedges silently; user-visible status in the popup with a red badge when dead (kills root cause D + James's "there should be a connected view").
5. Observability: worker-log lines for every lifecycle/repair event.
6. Safe, ordered deployment with explicit version-skew behaviour (no partial-deploy dead zones).

**Non-goals**
- No change to poll/attach/result RPC semantics or the coordinator↔worker WS relay (`browser.ext.*` methods).
- No multi-Chrome-profile or non-Chrome browser work.
- The previously sketched **host-side multiplexer with a gateways.d registry is dropped** — replaced by extension-side dual-port fan-in (Phase 2), which is smaller, has no held-command buffer, and no cross-gateway command routing table.

---

## 3. Design decision: dual native-host names + dual ports in the extension

Chrome allows an extension to hold **multiple native-messaging ports**. Instead of two gateways fighting over one host name:

- **Legacy name** `com.ai_orchestrator.browser_gateway` → stays owned by the **Harness desktop app** (local gateway). Its installer keeps working exactly as today.
- **New name** `com.ai_orchestrator.browser_gateway_relay` → owned **exclusively by the worker relay**. Own wrapper, own runtime.json (unchanged location), own manifest file (`<name>.json`), own registry key. Nobody else ever writes it.
- **Extension** opens a port per name and runs an independent bridge (poll loop, reconnect/backoff, outbox) per port. Commands from both gateways execute through the **single existing `commandChain`** (`background.js:166`) so execution stays strictly serialized — the property that prevents double `chrome.debugger` attach. Results return on the port that delivered the command (trivial routing — no commandId→gateway map needed). `attach_tab` / `tab_inventory` are posted to **every connected port**.

Why this beats the host-side multiplexer: no shared fan-out budget inside a 10 s poll, no held-command expiry semantics, no new endpoint-discovery file format, no change to either native host's single-socket model, and ownership boundaries become structural (each writer touches only its own name — the reviewer's overwrite-foreign-manifest concern disappears by construction rather than by checks).

**Security boundaries (explicit, per review):**
- Each port authenticates to its own gateway with its own token (unchanged per-install `runtime.json`); tokens are never shared across gateways.
- Command **authorization stays on each coordinator** (grants/approvals/audit are per-gateway, as today); the extension does not gain any new privileges — it already executes for whichever gateway owns the single port today.
- Tab sharing: `share_active_tab` broadcasts to all **connected** ports (both gateways are the same user's own coordinators). The popup must *display* which gateways received the share (Phase 5), and the audit record on each coordinator already attributes actions per-gateway. If a future third gateway kind appears, add a per-port share opt-in in the popup before allowing it to register.
- Poll responses/commands from one gateway are never echoed to the other; the only cross-port artefact is tab inventory, which is the user's own tab metadata going to the user's own two coordinators.

**Version-skew matrix (drives rollout order in §6):**

| Extension | Worker | Harness app | Result |
|---|---|---|---|
| old (1 port) | old | old | today's behaviour (last-install-wins) |
| old | **new** | old | new worker registers `_relay` name only; old extension still talks to legacy owner → **remote dead** ⇒ worker keeps a `legacyNameRegistration` transitional config flag (default **on**) that preserves today's legacy-name install until the extension is confirmed updated; turn off per-machine afterwards |
| **new** | old | old | `_relay` connect fails instantly (no manifest) → port marked absent, retried on alarm cadence; legacy port works as today. Safe. |
| **new** | **new** | old/new | both ports live; steady state. App upgrade only改 its own name; never disturbs `_relay`. |

---

## 4. Phases

Order: 0 → 1 → 2 → 3 (all P0) → 4 → 5 → 6 (P1) → 7 (P2). Each is a separately verifiable commit; 0/1/3 are small, 2 is the core, 4–6 are plumbing + UI.

### Phase 0 (P0, S) — stop ephemeral installs touching the real OS registration

- `browser-extension-native-runtime.ts`: `registerWindowsNativeMessagingHost` runs **only when** `chromeNativeMessagingDir` was defaulted (or new option `registerInOS: true` is explicitly passed). The spec's temp-dir install then writes zero registry.
- Belt-and-braces: refuse `registerInOS` when the manifest path resolves under `os.tmpdir()`.
- Regression spec: mock `execFileSync`; assert **no** `reg` invocation for a temp-dir install; assert invocation for a default-dir install (win32-gated, mock `process.platform`).
- Sweep other specs/CLI paths constructing installer options for the same hazard (`grep -rn "prepareBrowserExtensionNativeHostRuntime" src test`).

### Phase 1 (P0, M) — relay-owned `_relay` registration with self-heal

- Add `BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway_relay'`. Parameterise the installer over host name (manifest name, manifest filename, registry key, wrapper filename) — same file, no behavioural change for legacy callers.
- `worker-agent.ts` `prepareExtensionNativeHostRuntime()` (`:777-795`) installs under the **relay name** (plus legacy name while `legacyNameRegistration` is on — see matrix). Keep `assertExtensionRelayManifestWritable` semantics for the **legacy** transitional write only; the `_relay` name needs no assertion (sole writer) but still does read-compare-write to avoid churn.
- **Repair loop**: on relay start and every 60 s (fold into the existing worker heartbeat timer), validate: registry key exists → manifest file exists → parses → `path` points at our wrapper → wrapper exists. Repair + log on any mismatch. **Flap guard**: if repaired more than 3× in 10 min, keep repairing but escalate one warn-level log and set `registration: 'contested'` in the summary (feeds Phase 4 health) instead of log-spamming.
- Registry ops via a small `windows-native-messaging-registry.ts` (wraps `reg.exe` query/add; injectable exec for tests; HKCU only, never elevated; failure logs and degrades, never throws out of the relay).
- Surface `registration: 'ok' | 'repaired' | 'contested' | 'error'` + `lastRegistrationCheckAt` in `WorkerExtensionRelay.getSummary()` → capability report.

### Phase 2 (P0, M-L) — extension dual-port bridges

`resources/browser-extension/background.js`:
- Extract per-port state into a `createBridge(hostName)` factory: `{ nativePort, pollInFlight, reconnectAttempts, reconnectTimer, outbox }` per bridge — today's globals (`:13-20`) become two instances (legacy + `_relay`).
- Shared: `commandChain` (execution serialization), tab-event listeners and `reportTabInventory`/`reportTab` (post to all connected bridges), alarm handler (per-bridge inventory+poll kick).
- `runBrowserCommand(command, bridge)` replies on the delivering bridge's port.
- A bridge whose `connectNative` fails immediately (name not installed) marks itself `absent` and retries only on the 1-minute alarm — no hot 30 s loop against a name that isn't installed.
- Poll responses may carry optional `meta` (ignored if absent) — reserved, not required by this phase.
- MV3 note: any open native port keeps the SW alive; two ports don't change lifetime semantics. Persist per-bridge status snapshots to `chrome.storage.session` for the popup (Phase 5).

### Phase 3 (P0, S — promoted from P2 per review) — poll no-reply watchdog

- Record `pollStartedAt` per bridge when a poll goes out. A `setTimeout(POLL_TIMEOUT_MS + 5000)` watchdog (plus the 1-min alarm as backstop, since MV3 timers can die with the SW) checks: poll still in flight past deadline → reset `pollInFlight`, disconnect the port, `scheduleReconnect()`, count a `silentPollCount`. This converts "host alive but mute" from *permanent silence* into a ≤35 s self-heal. The alarm-based backstop must do the same check independently of `setTimeout` survival.
- Unit-test the state machine with fake timers (extract poll/watchdog logic into a pure module if needed for vitest).

### Phase 4 (P1, M) — truthful health, stale cache, distinct errors

- Worker: relay records `lastExtensionContactAt` (any successful extension RPC on its socket) → `getSummary()` → capability report (`capability-reporter.ts`).
- Coordinator: `RemoteBrowserExtensionBridge` independently records last relayed poll per node (gives the signal even before workers redeploy).
- `browser_health.remoteExtensions` (`browser-health-service.ts:268-285`): `ready` requires contact within **90 s** (extension polls ~10 s cadence + 1-min alarm floor); add `silent` count and per-node `lastContactAt`, `registration` state from Phase 1.
- `list_targets`: annotate entries `stale: true` when the owning node is silent; include `lastSeenAt` in the payload.
- `browser-extension-command-store.ts` / `browser-gateway-service.ts`: when the target node is silent, fail fast with **`browser_extension_unreachable`** (new reason; `browser_extension_command_timeout` then strictly means "delivered but not completed"). Audit log carries the reason and the `lastContactAt`.
- **Post-deploy semantics verification is part of this phase's DoD** (see §5 E2E-6/7): health JSON asserted in all three states (fresh / silent / contested) on the real two-machine setup, not just unit tests.

### Phase 5 (P1, M) — popup status view + badge

- `background.js`: `getStatus` message handler (next to `share_active_tab`, `:51-63`) returning per-bridge `{ hostName, kind: 'local'|'relay', state: connected|reconnecting(n)|absent|dead, lastPollAckAt, lastError, silentPollCount }` + shared-tab list + extension version.
- `popup.{html,js}`: status rows per gateway ("worker relay — ● ok, 2 s ago" / "Harness app — ○ absent"), shared tabs, **Reconnect now** button (drops ports, `startBridge()`), existing Share button; show which gateways will receive a share (security disclosure from §3).
- Toolbar badge: red `!` when **all** bridges dead/absent > 60 s; amber when exactly one of two expected is dead. Clear on recovery. (During the incident this alone would have been the 5-second diagnosis.)

### Phase 6 (P1, S) — observability

- Worker (tee'd to `~/.orchestrator/logs/worker-agent.log`): relay start/stop (socket path), registration install/repair/contested events, extension first-contact / contact-lost (>90 s) transitions, per-500-poll heartbeat line. No per-poll spam.
- Native host: fatal-init failures (unreadable runtime.json, socket connect refused at spawn) append one line to `<nativeDir>/native-host-error.log` (64 KB cap) — today it dies invisibly inside Chrome.
- Coordinator: bridge logs node poll-resume/poll-lost transitions.

### Phase 7 (P2, S) — nice-to-haves

- `report_inventory` queued command type + `list_targets { refresh: true }` (≤3 s wait) for live listings.
- Review `browser-action-classifier` for dialog-scoped Post/Send/Publish buttons executing under standing grants (§1 "Also observed").

---

## 5. Verification

Gates per repo standard: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, targeted `npm run test:quiet -- <spec>` per phase, full `test:quiet` before calling the plan done. **Never run the vitest suite on a Windows box until Phase 0 lands** (it's the incident trigger).

**Unit/spec (new):**
1. Phase 0 guard: temp-dir install ⇒ zero `reg` calls; default-dir ⇒ exactly one (mocked exec, platform-gated).
2. Installer name-parameterisation: legacy vs `_relay` produce disjoint manifest paths/registry keys/wrapper names.
3. **Registry-flap convergence** (review item): fake external writer rewrites the `_relay` key every tick; assert repair each cycle, `contested` after threshold, exactly one escalated warn, no unbounded log growth, and that repair never writes the *legacy* key while a live foreign manifest owns it.
4. Ownership: repair loop never modifies a manifest whose `path` is outside our nativeDir except via the explicit legacy-transitional path (mirrors `assertExtensionRelayManifestWritable` semantics — same predicate extracted and shared, not duplicated).
5. Dual-bridge: command from port A replies on port A; tab report posted to both; port B absent doesn't affect port A cadence; serialized execution across ports (single chain).
6. Watchdog: no-reply poll → flag reset + port recycle at timeout+grace; alarm-backstop path with dead `setTimeout` (fake timers).
7. Health rollup: fresh/silent/contested inputs → expected `ready`/`silent` counts; command send to silent node → `browser_extension_unreachable` without waiting 30 s.

**Two-machine E2E on windows-pc (DoD for the whole plan):**
1. Cold start (worker + Chrome) → health ready, fresh `lastContactAt`; `find_or_open` round-trip works via `_relay`.
2. **Incident replay**: point `_relay` registry key at a bogus temp path → repaired ≤ 60 s, extension recovers hands-off, repair line in worker log.
3. **Coexistence**: launch Harness app on windows-pc → both its local browser tools and remote relay commands work in the same Chrome session, simultaneously; quit app → relay unaffected; relaunch → still unaffected (`_relay` key untouched by the app).
4. **Silent-host wedge replay**: suspend the native host process → badge red/amber ≤ 60 s, health `silent`, commands fail fast `browser_extension_unreachable`; resume → recovery ≤ 1 min, contact-resumed log line.
5. Popup shows truthful per-gateway rows through 1–4; Reconnect button forces immediate recovery in step 4.
6. **Health-semantics post-deploy check** (review item): capture `browser_health` JSON in each state (fresh, silent, contested) and diff against the documented schema; stale-flagged `list_targets` verified while worker stopped 5 min.
7. Version-skew spot-checks from the §3 matrix: new-extension+old-worker (before worker redeploy) and old-extension+new-worker with `legacyNameRegistration=on`.

## 6. Deployment runbook (ordered; each step verified before the next — review's partial-deploy item)

1. **Mac coordinator** (app rebuild): Phases 4/6 coordinator pieces + Phase 0/1 shared installer code. Verify: `browser_health` shows new fields (nodes may all be `silent`-capable only after worker redeploy — the coordinator-side poll signal covers the gap).
2. **windows-pc worker**: `git pull` in `Documents\Work\orchestrat0r\ai-orchestrator`, rebuild worker dist, restart worker agent. Verify: worker log shows `_relay` registration install line; `reg query` shows the `_relay` key; legacy key still present (transitional flag on).
3. **Chrome on windows-pc**: `chrome://extensions` → Reload unpacked extension (files already updated by the pull). Verify: popup shows two gateway rows; remote `find_or_open` works; if Harness app is running, its local tools also work.
4. **Harness desktop app on windows-pc**: at next packaged build it simply keeps owning the legacy name (no coexistence dependency on its release cadence). After confirming steps 2–3 on every worker machine, flip `legacyNameRegistration=off` in worker config(s) so the worker stops competing for the legacy name entirely; delete the 2026-07-04 hand-written interim manifest + its registry value at this point.
5. Record final state in the worker log and update this doc → `_completed` with verification evidence (audit IDs, log excerpts), per repo convention.

## 7. Risks

- **Two live control planes on one Chrome**: mitigated by single `commandChain` serialization (unchanged invariant) + per-gateway tokens/audit + popup disclosure. Revisit share-broadcast default if a gateway kind that isn't user-owned ever appears.
- **`reg.exe` failures/permissions**: HKCU needs no elevation; helper degrades to log + `registration: 'error'`; relay keeps serving an already-registered extension.
- **MV3 SW restarts** mid-watchdog: alarm-based backstop performs the same stuck-poll check; per-bridge status persisted to `chrome.storage.session` keeps the popup truthful across restarts.
- **Transitional flag forgotten on** (`legacyNameRegistration`): harmless but keeps last-install-wins alive for the legacy name; health `contested` state + runbook step 4 make it visible/actionable.
- **File-size ratchet** (`check:ts-max-loc`): background.js refactor and native-runtime parameterisation may need module splits; plan for `background/` extraction if the ratchet trips (extension JS is plain files, unaffected; the TS worker/main changes are).

## 8. Effort

| Phase | Size |
|---|---|
| 0 | S |
| 1 | M |
| 2 | M-L (the core; extension refactor + careful review) |
| 3 | S |
| 4 | M |
| 5 | M |
| 6 | S |
| 7 | S |

First PR: **Phases 0+1+3** (trigger closed, relay self-owns `_relay`, wedge fixed) — small, independently shippable, and removes both known total-outage modes. Second PR: Phase 2. Third: 4+5+6 together (visibility). The dual-name design means nothing user-visible regresses between PRs (legacy behaviour persists via the transitional flag).
