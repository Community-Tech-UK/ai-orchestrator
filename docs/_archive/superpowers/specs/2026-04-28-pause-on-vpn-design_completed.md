# Pause on VPN — Design

**Status:** Completed on 2026-04-29
**Authoring sessions:** 2026-04-27, 2026-04-28
**Reviewers (cross-model):** consumed twice; reconciliation log at §13

---

## 1. Goal & non-goals

## Implementation status

The design has shipped in code and is marked complete after the 2026-04-29 validation pass. Completion evidence:

- Pause settings, fail-closed startup defaults, network detector/interceptor, coordinator persistence, renderer pause UI, and pause IPC are implemented under `src/main/pause/`, `src/main/network/`, `src/main/app/pause-feature-bootstrap.ts`, `src/preload/domains/pause.preload.ts`, and `src/renderer/app/core/state/pause/`.
- The high-risk fixes from the review log are covered in code: `pauseTreatExistingVpnAsActive` defaults to `true`, `INPUT_REQUIRED_RESPOND` gates before all permission branches, queued seeded prompts preserve `seededAlready`/`skipUserBubble`, queue persistence is gated by both `pauseFeatureEnabled` and `persistSessionContent`, and browser/runtime queues do not persist dropped attachment bytes.
- Operator documentation exists at `docs/pause-on-vpn.md`.
- Automated validation is recorded by pause, VPN detector, network gate, queue persistence, settings validator, IPC handler, and bootstrap specs plus the full Wave 7 gate in `docs/runbooks/wave-7-smoke-results.md`.

The empirical VPN calibration playbook remains an operator procedure because interface names are environment-specific; no default regex change was required by the automated validation pass.

### Goal

When the user connects to a corporate VPN, the AI Orchestrator must stop sending AI-provider traffic until the VPN is no longer active or the user explicitly resumes. User statement: *"I want to not push things over the VPN, it might get me in trouble."*

This is a **safety/privacy** feature. Single purpose: prevent user content (queries, code, conversation history, attachments) from traversing the work VPN.

### Master kill switch (`pauseFeatureEnabled`)

A single user setting controls whether **any** of this feature's machinery is active. This is distinct from `pauseOnVpnEnabled` (auto-detection toggle) and from the master pause button (manual reason). The kill switch exists so that if the feature ever causes timeouts, false-pauses, or any other problem, the user can fully disable it without uninstalling the app or rolling back a release.

**When `pauseFeatureEnabled = true` (default):** all components active — detector polls, interceptor installed, coordinator tracks reasons, UI shows banner / button / queued indicators, queue persistence runs (subject to `persistSessionContent`).

**When `pauseFeatureEnabled = false`:** the feature behaves as if it doesn't exist. Specifically:

- **Network interceptor is NOT installed.** Zero overhead on outbound HTTP calls. No patches applied to `http.request`, `http.get`, `https.request`, `https.get`, or `globalThis.fetch`.
- **VPN detector does not start.** No polling, no probe attempts.
- **Pause coordinator** is initialised but stays at empty `reasons` permanently. `isPaused()` always returns `false`. No events emitted.
- **Master pause button hidden** in the title bar.
- **Pause banner** never rendered.
- **Per-instance queued indicators** revert to existing baseline behaviour (only show counts during `busy`/`respawning` etc., not during the never-occurring "paused" state).
- **Queue persistence service** is not initialised. Queues remain purely in-memory (the existing pre-feature behaviour).
- **Adapter gate** in `BaseCliAdapter.sendInput` does check the coordinator, but `isPaused()` always returns `false`, so the gate is a no-op pass-through. Same for the renderer-side gates.
- **Settings UI** shows only the master toggle (with explanatory text) when the feature is off; the rest of the Network tab is collapsed under a *"Enable to configure"* note.

**Toggle behaviour without restart:**

- **`true → false`:** uninstall the network interceptor (the install function returns an uninstaller — see §5.G); stop the detector timer; clear all reasons (atomically resuming any active pause); broadcast `pause:state-changed` so the renderer hides UI; clear the queue-persistence service. End state: app behaves as if the feature was never built. **No restart required.**
- **`false → true`:** install the interceptor; start the detector; load any persisted pause-state (which would have been retained on disk through the off period — but per-row checks ignore stale data older than configurable threshold); start queue persistence. UI elements re-appear.

If the feature is **mid-paused** (banner up) and the user toggles the kill switch off, the immediate consequence is "all reasons cleared → resumed." Any queued messages drain via the existing watchdog. No data loss; the queue still exists in-memory regardless of the feature flag.

This makes the feature **fully removable at runtime** — exactly the safety guarantee asked for. It also enables a clean fall-back path if a bug ever ships: the user toggles the kill switch and the app reverts to baseline behaviour with no provider-bound code paths newly affected.

### What "pause" means in this design

Three layers of defense, applied in order from outermost (UX) to innermost (final gate):

1. **Renderer queue gate** — refuses pre-IPC: user-typed input lands in the existing per-instance queue and never crosses into the main process while paused.
2. **CLI-adapter gate** — `BaseCliAdapter.sendInput()` throws when paused. Catches every `adapter.sendInput()` call site, including direct ones (initial prompts, resume-fallback history replay, mode-change continuity preambles, all 14+ sites in `instance-lifecycle.ts`).
3. **Process-level network interceptor** — Layer 3 is the safety guarantee. Patches `globalThis.fetch`, `http.request`, `http.get`, `https.request`, and `https.get` at app init **in memory** (no node_modules modification). Any non-allow-listed outbound network call from the Electron main process throws `OrchestratorPausedError` while paused. This catches:
   - The Anthropic SDK (`@anthropic-ai/sdk` 0.71 uses `globalThis.fetch` per `internal/shims.js`)
   - All `https.request` callers (`model-discovery.ts`, `semantic-search.ts` Exa)
   - All `protocol.get` callers (`remote-config.ts:124` — verified in §5.G)
   - All `fetch` callers (RLM services, indexing reranker, orchestration embedding service, cross-model review service, etc.)
   - Future provider integrations added by us or by plugins

Non-allow-listed = anything not on the local-host list (§5.G).

In-flight active CLI turns are interrupted via the existing `adapter.interrupt()` path on the `pause` event — the CLI keeps its session, and on resume fresh input is sent through the normal `sendInput` path. We accept losing in-progress assistant streams.

### Non-goals

- Not a per-instance pause. Threat model is global.
- Not a Strict mode that hibernates CLI processes. Deferred unless requested.
- Not file-system patching of `node_modules/`. The interceptor is a runtime in-memory patch of the imported module objects, not a write to any installed package.
- Not interception of CLI-process child traffic. Those are separate processes the Electron main process cannot directly intercept; they are gated upstream via §1 layers 1–2.

### What the feature explicitly cannot guarantee

Stated honestly in user-visible copy and documentation:

1. **A small in-flight window.** Between VPN coming up and the detector triggering interrupts, there is a window of up to ~2 s plus an OS-level TCP-buffer drain of ms-to-s. The master button mitigates this when used proactively. The interceptor (§5.G) closes this gap *for new requests*, but does not retroactively stop bytes already in OS-level buffers.
2. **Heuristic detection.** If the user's VPN does not manifest as a new network interface, the interface poller alone misses it. The reachability probe is a configurable second signal. Calibration mode logs everything we see for empirical tuning.
3. **CLI compliance with interrupt.** `adapter.interrupt()` relies on the CLI honouring its standard interrupt; non-compliance is surfaced via the existing `interrupting`/`cancelling` state-machine timeouts as a warning.

---

## 2. Architecture

```
┌─ Main process ──────────────────────────────────────────────────────┐
│                                                                       │
│   Network interceptor (installed at app init, in-memory only)        │
│   ────────────────────────────────────────────────────────────────   │
│   Patches globalThis.fetch / http.request / http.get /               │
│   https.request / https.get to                                       │
│   consult PauseCoordinator for non-local hosts.                      │
│                                                                       │
│   VpnDetector            PauseCoordinator (singleton)                │
│   ─────────────          ─────────────────                            │
│   polls every 2 s   ─▶   state = idle | paused                       │
│   diff network IFs       reasons = Set<'vpn'|'user'|'detector-error'>│
│   optional probe         persisted to electron-store                 │
│   emits 'changed'        emits 'pause' / 'resume' / 'change'         │
│                                                                       │
│   Manual toggle  ─────▶  addReason('user') / removeReason('user')    │
│   (IPC from UI)                                                       │
│                                                                       │
│           Layer 2 fast-fail consumers:                               │
│           ─────────────────────────────────                           │
│           • BaseCliAdapter.sendInput()  — throws when paused         │
│             (catches every adapter.sendInput call site)              │
│           • InstanceManager.on('pause') — adapter.interrupt() on     │
│             active turns                                             │
│                                                                       │
│           Layer 3 (interceptor) is the safety net for everything     │
│           else (SDK calls, https.request, fetch).                    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                          │ IPC: pause:state-changed (broadcast)
                          ▼
┌─ Renderer ──────────────────────────────────────────────────────────┐
│                                                                       │
│   PauseStore (Angular signal-based)                                  │
│   ▸ isPaused, reasons, source                                        │
│   ▸ setManual(boolean) — IPC to main coordinator                     │
│                                                                       │
│   ▸ Master PAUSE toggle in title bar                                 │
│   ▸ Top-of-app banner explaining state                               │
│   ▸ Resume toast: "Sending N queued messages…"                       │
│   ▸ Per-instance queued-count indicator                              │
│   ▸ Detector-error confirmation modal                                │
│                                                                       │
│   instance-messaging.store gates (Layer 1):                          │
│   ▸ sendInput            — `if (paused) queue and return`            │
│   ▸ processMessageQueue  — `if (paused) return` (covers ALL drain    │
│                            paths: watchdog, batch-update, retry)     │
│   ▸ persistence          — snapshot queues on change (gated by       │
│                            persistSessionContent setting)            │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Three-layer defense.** Layer 1 (renderer queue) handles UX correctly; Layer 2 (adapter gate) handles fast-fail for user content; Layer 3 (interceptor) is the architectural correctness primitive — it doesn't matter whether a future remote-call site is added in `model-discovery.ts`, a new RLM service, a plugin, or via a third-party SDK; if it goes through Node's HTTP primitives or `globalThis.fetch`, the interceptor refuses it. That's the safety claim.
- **Single source of truth.** `PauseCoordinator` is the only thing that decides "are we paused?" — every layer just consults.
- **In-memory interceptor only.** We modify the `request` property on the imported `http` and `https` module objects and the `fetch` property on `globalThis`. No write to `node_modules/`, no patch-package, no source rewriting.
- **Local-call allow-list.** Ollama (`localhost:11434`), `127.0.0.1`, `::1`, `0.0.0.0`, and the user's own remote-nodes (configured via existing `remoteNodesServerHost` setting) are exempt. Allow-list is conservative; we'd rather pause an obscure local-network call than leak.
- **Persistence-safe restart.** Failure-closed: if we don't know our state at boot, we start paused.

### IPC contracts

New file: `packages/contracts/src/channels/pause.channels.ts`:

```typescript
export const PAUSE_CHANNELS = {
  PAUSE_STATE_CHANGED: 'pause:state-changed',     // main → renderer broadcast
  PAUSE_GET_STATE:     'pause:get-state',         // renderer → main, request
  PAUSE_SET_MANUAL:    'pause:set-manual',        // renderer → main, request
  PAUSE_DETECTOR_RECENT_EVENTS: 'pause:detector-recent-events', // renderer → main
  PAUSE_DETECTOR_RESUME_AFTER_ERROR: 'pause:detector-resume-after-error', // renderer → main
} as const;
```

New file: `packages/contracts/src/schemas/pause.schemas.ts`:

```typescript
export const PauseReasonSchema = z.enum(['vpn', 'user', 'detector-error']);

export const PauseStateSchema = z.object({
  isPaused: z.boolean(),
  reasons: z.array(PauseReasonSchema),
  pausedAt: z.number().nullable(),
  lastChange: z.number(),
});

export const PauseSetManualPayloadSchema = z.object({
  paused: z.boolean(),
});

export const PauseDetectorEventSchema = z.object({
  at: z.number(),
  interfacesAdded: z.array(z.string()),
  interfacesRemoved: z.array(z.string()),
  matchedPattern: z.string().nullable(),
  decision: z.enum(['no-change', 'pause', 'resume', 'flap-suppressed', 'detector-error']),
  // Note: NO URLs, NO probe targets, NO request paths/headers (privacy).
  note: z.string().optional(),
});

export const PauseDetectorRecentEventsResponseSchema = z.object({
  events: z.array(PauseDetectorEventSchema),
});
```

Path-alias entries added to `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts` per AGENTS.md packaging-gotcha #1.

All renderer→main payloads validated at the IPC boundary using `validateIpcPayload`.

#### Full IPC integration (corrected post-review)

The previous draft listed only the path-alias entries. The actual integration touches more places — verified by reading `packages/contracts/src/channels/index.ts:39-51`, `packages/contracts/package.json:24-46`, `src/preload/preload.ts:14-50`, and `src/preload/domains/`:

1. **`packages/contracts/src/channels/index.ts`** — re-export `PAUSE_CHANNELS` and merge it into the aggregated `IPC_CHANNELS` const (alongside the existing `INSTANCE_CHANNELS`, `INFRASTRUCTURE_CHANNELS`, etc.).
2. **`packages/contracts/package.json` `exports` map** — add subpath entries for `./channels/pause` and `./schemas/pause` matching the existing per-domain pattern (lines 7–46 in current package.json).
3. **`src/preload/generated/channels.ts`** — auto-generated by `scripts/generate-preload-channels.js`, which runs in `prestart`/`prebuild` (verified at `package.json:14-15,44`). No manual edit needed; it picks up the new channels via the `IPC_CHANNELS` aggregate above. The implementation plan must run `npm run generate:ipc` at least once during dev so the renderer's IPC types reflect the new channels before any renderer-side code that references them is tested.
4. **Preload domain** — add `src/preload/domains/pause.preload.ts` mirroring the factory pattern of the existing 11 domain files, returning typed `invoke`/`on` methods for the new channels. Compose it into `src/preload/preload.ts` alongside the others (line 50ish).
5. **Aliases** — already mentioned in the prior draft: `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`. These remain.

6. **Main-process handler registration (post-review).** Adding new IPC channels is not enough — they need actual `ipcMain.handle()` registration. Verified at `src/main/ipc/ipc-main-handler.ts:171` (the `registerHandlers()` method invokes per-domain `registerXxxHandlers` factories) and `src/main/ipc/handlers/index.ts:6-24` (re-exports each `registerXxxHandlers`). Both are required for new handler files. The work for this feature:
   - Re-export `registerPauseHandlers` from `src/main/ipc/handlers/index.ts`.
   - Invoke `registerPauseHandlers({ windowManager: this.windowManager, coordinator: getPauseCoordinator() })` from `IpcMainHandler.registerHandlers()`.
   - For instance-queue channels (`INSTANCE_QUEUE_SAVE`, `INSTANCE_QUEUE_LOAD_ALL`), add the handlers to the existing `registerInstanceHandlers` factory in `src/main/ipc/handlers/instance-handlers.ts` rather than a new file (these are instance-scoped). The handlers read/write a dedicated `instance-message-queue` electron-store namespace; `INSTANCE_QUEUE_INITIAL_PROMPT` is a main → renderer broadcast (no handler needed; emitted via `webContents.send`).

`generate:ipc` and `verify:ipc`/`verify:exports` scripts run automatically in `prestart`/`prebuild` and will fail the build if any of these are missing or out of sync.

---

## 3. VPN Detection Service

New file: `src/main/network/vpn-detector.ts`. EventEmitter-based singleton.

### Layered detection (corrected from review)

**Layer 1 — interface polling (always on, primary signal).** Polls `os.networkInterfaces()` every 2 s.

**Layer 2 — reachability probe (opt-in, independently OR-ed signal — corrected).** If the user has configured a probe host AND a probe mode, we periodically attempt a TCP connect (no payload). Probe mode is required when host is set:

| Mode | Meaning |
|---|---|
| `disabled` (default) | Probe not used. Detection is interface-only. |
| `reachable-means-vpn` | User configures an internal-only host. **TCP connect succeeds → VPN active.** |
| `unreachable-means-vpn` | User configures a public host known to be blocked by the work VPN. **TCP connect fails → VPN active.** |

Layer 1 OR Layer 2 → `vpn-up`. **Earlier "AND-only" wording was self-contradictory and is removed.** A probe failure (timeout, DNS error) does *not* mean VPN-down; only "non-affirmative this tick." A configured probe that has been non-affirmative for 2 consecutive intervals stops contributing — no inference is made about VPN state from probe absence.

**Layer 3 — default-route inspection.** Deferred to v1.5 if calibration shows interface polling alone has gaps.

### Detection algorithm (rewritten — third revision)

The previous algorithm had three bugs found by review:

1. `pauseTreatExistingVpnAsActive=true` had no init-time effect (the algorithm only filtered out baselined interfaces from `newMatches` regardless of the setting).
2. After a successful disconnect, a baseline-matched interface name reconnecting was permanently missed because `!baseline.has(n)` excluded it from `newMatches`.
3. Probe-only state transitions were impossible: `vpn-down` only emitted inside the `goneMatches` branch, so a probe-only `vpn-up` could never resume.

Fixed by separating signal state from interface tracking:

```text
state vars:
  pattern:                 RegExp
  treatExistingAsVpn:      boolean
  activeVpnIfaces:         Set<string>      // currently believed-VPN interface names
  knownNonVpnIfaces:       Set<string>      // matching interfaces present at startup that we explicitly chose NOT to treat as VPN; populated only when treatExistingAsVpn=false
  interfaceSignalActive:   boolean          // = activeVpnIfaces.size > 0
  probeSignalActive:       boolean          // updated by probe loop independently
  probeKnown:              boolean          // false until first probe result arrives; for restart reconciliation
  probeNonAffirmativeCount: number = 0      // for 2-result debounce on probe non-affirmative
  lastEmittedVpnUp:        boolean = false  // memoised last broadcast state; explicit init to avoid undefined !== false spurious emits
  removalTickCount:        number = 0       // 2-tick flap suppression on interfaces

on init (called once at startup, AFTER coordinator persistence is read):
  current   = Object.keys(os.networkInterfaces())
  matching  = current.filter(name => pattern.test(name))

  // The coordinator-persistence layer may set forceVpnTreatmentForFirstScan=true
  // (see §4) when restoring from a previously-paused-with-vpn state. That flag
  // overrides the user setting for the first scan only.
  const treatAsVpn = forceVpnTreatmentForFirstScan || treatExistingAsVpn

  if (treatAsVpn):
    activeVpnIfaces     = new Set(matching)
    knownNonVpnIfaces   = new Set()
  else:
    activeVpnIfaces     = new Set()
    knownNonVpnIfaces   = new Set(matching)

  recomputeAggregateAndEmit()

on tick (every 2 s):
  current   = Object.keys(os.networkInterfaces())
  matching  = current.filter(name => pattern.test(name))

  // Drop disappeared known-non-vpn names so a future reappearance
  // is treated as a fresh match (closes the reconnect bug).
  for n of [...knownNonVpnIfaces]:
    if !current.includes(n):
      knownNonVpnIfaces.delete(n)

  // New matches: anything that matches now but isn't already accounted for.
  newMatches   = matching.filter(n =>
                   !activeVpnIfaces.has(n) && !knownNonVpnIfaces.has(n))

  // VPN interfaces that disappeared.
  goneVpn      = [...activeVpnIfaces].filter(n => !current.includes(n))

  if (newMatches.length > 0):
    newMatches.forEach(n => activeVpnIfaces.add(n))
    removalTickCount = 0
  else if (goneVpn.length > 0):
    removalTickCount += 1
    if (removalTickCount >= 2):                            // ~4 s flap suppression
      goneVpn.forEach(n => activeVpnIfaces.delete(n))
      removalTickCount = 0
  else:
    removalTickCount = 0

  recomputeAggregateAndEmit()

on probeResult(affirmative: boolean):
  probeKnown = true
  if (affirmative):
    probeSignalActive = true
    probeNonAffirmativeCount = 0
  else:
    probeNonAffirmativeCount += 1
    if (probeNonAffirmativeCount >= 2):       // ~2 probe intervals before clearing
      probeSignalActive = false
      probeNonAffirmativeCount = 0
    // else: keep probeSignalActive at its previous value (debounced)
  recomputeAggregateAndEmit()

function recomputeAggregateAndEmit():
  interfaceSignalActive = activeVpnIfaces.size > 0
  vpnUp = interfaceSignalActive || probeSignalActive

  // SUPPRESS-VPN-DOWN-DURING-UNKNOWN-PHASE (post-review fix):
  // If a probe is configured but probeKnown is still false, we don't yet
  // know whether the probe will say VPN-active. Emitting 'vpn-down' now
  // (just because interface is also clear) would prematurely resume the
  // app for users on probe-only configs.
  // The `lastEmittedVpnUp` value also starts at `false`, so this guard
  // ensures we don't fire a spurious vpn-down on the first
  // recomputeAggregateAndEmit() call when nothing has actually changed.
  if (!vpnUp && probeMode !== 'disabled' && !probeKnown):
    return  // hold; wait for first probe result

  if (vpnUp !== lastEmittedVpnUp):
    if (vpnUp):
      emit('vpn-up', { sources: signalSources() })
    else:
      emit('vpn-down', { sources: signalSources() })
    lastEmittedVpnUp = vpnUp

function signalSources(): Array<'interface' | 'probe'>:
  return [interfaceSignalActive ? 'interface' : null,
          probeSignalActive ? 'probe' : null].filter(Boolean)
```

Properties of the corrected algorithm:

- **Startup-as-VPN works**: `treatExistingAsVpn=true` (post-review default) seeds `activeVpnIfaces` from matching baseline interfaces, immediately yielding `vpn-up`.
- **Reconnect after disconnect works**: when an interface disappears, it's removed from `activeVpnIfaces`. If it ever reappears, it's a fresh `newMatches` because nothing tracks it anymore.
- **Probe-only transitions work**: aggregate `vpnUp = interfaceSignalActive || probeSignalActive` is the source of truth. A probe going from affirmative to non-affirmative emits `vpn-down` if (and only if) the interface signal also says down. Symmetric for the up direction.
- **Idempotent emits**: `lastEmittedVpnUp` ensures we don't broadcast the same transition repeatedly when both signals fluctuate.
- **`forceVpnTreatmentForFirstScan` flag** integrates with §4's fail-closed-restart logic: a previous paused-with-`vpn` session forces the first scan to treat existing matching interfaces as VPN, regardless of the user's `treatExistingAsVpn` setting.
- **Probe non-affirmative does NOT mean VPN-down on its own** — `probeSignalActive=false` only contributes to "no probe signal." If the interface signal is also absent, then aggregate is down. If interface is up, the probe is silently irrelevant.

### Edge cases handled

- **Already-connected at startup, normal launch:** `pauseTreatExistingVpnAsActive` controls whether matching interfaces present at boot count as VPN-active. **Default changed from `false` to `true` (post-review).** Rationale: the cost of a false-positive on launch is low (banner, master-button-resume), but the cost of a false-negative is "leaks traffic on first launch while connected" — exactly the threat the feature exists to prevent. This default also closes the fail-closed-restart gap (see §4).
- **Already-connected at startup, restored-from-paused state:** see §4 "Failure-closed restart" — when persistence indicates the previous session was paused under `vpn`, the detector's first scan **always** treats matching interfaces as VPN, regardless of the user setting. This is the fail-closed reconciliation guarantee.
- **Flap.** VPN drops 800 ms then comes back. Pause→resume gated by 2 consecutive ticks (~4 s); pause itself is immediate (1 tick). Bias toward safe.
- **Detector throws.** Caught at the timer boundary; emits `error` to coordinator → adds `detector-error` reason. Fail closed.
- **Detector timer dies silently.** Heartbeat: coordinator polls `detector.lastTickAt`; older than 10 s → marks `detector-error`.

### Diagnostic mode (privacy-aware)

`pauseDetectorDiagnostics: true` enables verbose logging. The 50-entry in-memory ring buffer and the persisted `recentTransitions` log **only**:

- timestamps,
- interface name diffs (e.g., `+utun5`, `−utun5`),
- the matched pattern,
- the decision (`pause`, `resume`, `flap-suppressed`, `no-change`, `detector-error`).

**Never logged:**

- Probe target host or port.
- Probe results (just an aggregated boolean: "probe affirmative this tick").
- IP addresses.
- Any URL, header, body, or path from the network interceptor (interceptor logs hostname only at `info` level when refusing a call; full URLs and headers are redacted).

A note on the Network settings page: *"Detection events are stored locally and never exported. Probe target hosts are stored as a normal user setting (and included in `settings:export` if you choose to export your settings); they are never written to detection-event logs, ring buffers, or refusal-log entries."*

(Reviewer-corrected R8: previous wording "Probe targets are never recorded in logs or diagnostics" was ambiguous because `pauseReachabilityProbeHost` *is* a persisted `AppSetting` — it lives in `settings.json` and flows through `settings:export` like any other user-config field. The privacy guarantee is specifically about *logs and detection-event diagnostics*, not about the user's own settings file.)

---

## 4. Pause Coordinator

New file: `src/main/pause/pause-coordinator.ts` (singleton). New file: `src/main/pause/pause-persistence.ts`.

### State

```typescript
type PauseReason = 'vpn' | 'user' | 'detector-error';

interface PauseState {
  isPaused: boolean;        // = reasons.size > 0
  reasons: Set<PauseReason>;
  pausedAt: number | null;
  lastChange: number;
}
```

### Reason refcount semantics

| Action | Before | After | App state |
|---|---|---|---|
| Detector reports VPN up | `{}` | `{vpn}` | paused |
| User clicks master button while VPN is up | `{vpn}` | `{vpn,user}` | paused |
| VPN drops | `{vpn,user}` | `{user}` | **still paused** |
| User clicks master button | `{user}` | `{}` | running |
| Detector errors | `{}` | `{detector-error}` | paused |
| User confirms detector-error resume | `{detector-error}` | `{}` | running |

### Public API

```typescript
class PauseCoordinator extends EventEmitter {
  isPaused(): boolean
  getState(): Readonly<PauseState>

  addReason(source: PauseReason, meta?: Record<string, unknown>): void
  removeReason(source: PauseReason): void

  on('pause',  (state: PauseState) => void)
  on('resume', (state: PauseState) => void)
  on('change', (state: PauseState) => void)
}
```

### `pauseFeatureEnabled` (master kill switch) lifecycle

The kill switch is read **before** any other pause-related component initialises. The bootstrap sequence in `src/main/index.ts`:

```text
1. Read pauseFeatureEnabled from settings (synchronous; no IPC).
2. Construct PauseCoordinator (always — minimal cost; reads persisted state).
3. If pauseFeatureEnabled === true:
     a. Install network interceptor (returns uninstaller; stored on coordinator).
     b. Construct VpnDetector and start polling.
     c. Start queue persistence service in renderer (via initial PauseStore state).
     d. Subscribe InstanceManager / CrossModelReviewService / ProviderQuotaService listeners.
   Else:
     a. Coordinator stays at empty reasons; isPaused() always returns false.
     b. No interceptor, no detector, no listeners that produce side effects.
```

When the user toggles `pauseFeatureEnabled` at runtime:

- **`true → false`:**
  1. Coordinator emits `kill-switch-disabling` (internal event, before changes).
  2. Network interceptor uninstaller called → `http.request` / `http.get` / `https.request` / `https.get` / `globalThis.fetch` restored to originals.
  3. Detector timer cleared; probe interval cleared.
  4. All listeners (InstanceManager interrupt, CrossModelReviewService abort, etc.) unsubscribed.
  5. All reasons cleared atomically; `pause:state-changed` broadcast (so renderer hides UI).
  6. Queue persistence service stops; in-memory queue continues to function as the existing pre-feature behaviour.

- **`false → true`:**
  1. Network interceptor installed.
  2. Detector started (with current setting values).
  3. Listeners re-subscribed.
  4. Queue persistence resumed.
  5. Coordinator persistence file is read; if it has stale `vpn` reasons (older than 24 h), they are discarded. Fresh state.

Restart is **never required** for either direction. The cost of the toggle is a few microseconds (property reassignment) plus event emission.

### `pauseOnVpnEnabled` lifecycle (added post-review)

The setting `pauseOnVpnEnabled` controls whether the **detector** runs and contributes `vpn` reasons. It does not affect the manual master button. Toggling it while a `vpn` reason is currently held is honoured (resolved post-review — earlier wording about "not retroactive" was contradicted by the toggle bullet and is removed):

- `true → false` toggle while paused under `vpn`: the existing `vpn` reason is **removed immediately**. If `user` reason remains, app stays paused; otherwise it resumes. The detector unsubscribes / suspends polling.
- `false → true` toggle: detector starts; performs a fresh scan; if VPN currently matches and `pauseTreatExistingVpnAsActive=true`, adds `vpn` reason.
- `pauseOnVpnEnabled=false` does **not** disable the network interceptor — that's still active for any other reason holders (manual `user` reason). The interceptor only gates when `pauseCoordinator.isPaused()` is true.

### `pause` / `resume` event handlers

`pause` (registered once at app init in `src/main/index.ts`):

1. **InstanceManager** — for every instance in `busy`/`processing`/`thinking_deeply`, call `adapter.interrupt()`. Do not terminate.
2. **CrossModelReviewService** — abort active `AbortController`s; gate flag flips so new calls return `{ skipped: true, reason: 'orchestrator-paused' }`.
3. **ProviderQuotaService** (`src/main/core/system/provider-quota-service.ts` and `src/main/core/system/provider-quota/*`) — full pause via service-level `isPaused` flag (corrected R8: do **NOT** clear the timers). Verified at `provider-quota-service.ts:130-144`: the service stores only timer handles in `this.timers`, not the configured intervals; clearing the timers on pause would lose the interval values, and renderer-driven re-arming via `QUOTA_SET_POLL_INTERVAL` is not guaranteed to fire on resume.

   **Strategy: leave timers installed; the timer tick calls `refresh()`, which now checks `this.isPaused` first.**

   - Timer tick → `refresh(provider)` → if `this.isPaused`, return early without making a network call (no-op tick).
   - `refresh()`, `refreshAll()`, IPC handlers `QUOTA_REFRESH`/`QUOTA_REFRESH_ALL` — same gate: no network, no new snapshot emitted (per §5.F).
   - In-flight probe `AbortController`s aborted on the `pause` event so any currently-streaming refresh stops immediately.
   - `QUOTA_SET_POLL_INTERVAL` while paused: still updates the timer normally (calls `startPolling`, which clears + reinstalls with the new interval). The new timer also no-ops on tick while paused. On resume, refreshes resume with the up-to-date interval.

   This avoids the timer/interval-loss class of bug entirely.
4. **Renderer** — receives `pause:state-changed`; `PauseStore` flips. The existing `processMessageQueue` watchdog refuses to drain (Layer 1 gate covers the watchdog AND the batch-update path).

`resume`:

1. Re-arm timers; clear service-level pause flags.
2. Renderer receives `pause:state-changed`; `PauseStore` flips. Existing watchdog drains queued messages on the next 2-s tick. **Resume toast** is emitted from the resume handler (one-shot at the moment of resume).

### Persistence & failure-closed restart (corrected)

State persists to a dedicated electron-store namespace `pause-state`:

```json
{
  "reasons": ["user"],
  "persistedAt": 1717890000000,
  "recentTransitions": [
    { "at": 1717889000000, "from": [], "to": ["vpn"], "trigger": "vpn-interface-detected" }
  ]
}
```

On app start, the coordinator reads this *before* the detector starts:

| Persisted state | Startup state |
|---|---|
| File missing (first-ever launch) | running |
| File present, valid, `reasons` empty | running |
| File present, valid, includes `'user'` | paused with `'user'` |
| File present, valid, `'vpn'` only (no user) | **paused with `'detector-error'` AND `forceVpnTreatmentForFirstScan=true`** until detector confirms |
| File present, valid, `'detector-error'` only | paused with `'detector-error'`; flag also set |
| **File present but corrupted/unparseable** | **paused with `'detector-error'`; `forceVpnTreatmentForFirstScan=true`; log warning** |

**Corrupted-state handling (corrected post-review):** earlier draft treated corrupted as equivalent to missing (start running) — that contradicted the fail-closed claim. Corrupted state is precisely "we don't know what state we should be in," which is exactly the case fail-closed exists for. Corrupted persistence now starts paused under `detector-error` and the user resumes via the confirmation modal once they've verified network state. A clean rewrite of `pause-state.json` happens after the user resumes; subsequent launches behave normally.

The distinction missing vs corrupted is deliberate: the missing case is dominated by *first launches* (legitimate running state); the corrupted case is dominated by *prior corruption events* (unknown state that warrants caution).

The `forceVpnTreatmentForFirstScan` flag tells the detector's first post-startup scan to treat any matching interface as VPN-active **regardless of `pauseTreatExistingVpnAsActive`**. After this single first-scan, normal behaviour resumes. This closes the fail-closed-restart gap: a relaunch while still on VPN reconciles to `vpn` reason, never to clean.

**Probe-aware reconciliation (post-review):** the first interface scan runs synchronously on init; the probe (if configured) runs on its own asynchronous interval. If we cleared `detector-error` on a probe-only setup *before* the probe had a chance to report, we'd resume while still on VPN — exactly the failure case fail-closed exists to prevent.

The reconciliation rule is therefore:

| First-scan outcome | Probe configured? | Probe state | Reconciliation |
|---|---|---|---|
| Matching interface found | — | — | Swap `detector-error` → `vpn` |
| No matching interface | No (mode `'disabled'`) | — | Clear `detector-error` → resume |
| No matching interface | Yes (mode reachable/unreachable) | First probe result NOT yet received | **Stay in `detector-error`**; `lastEmittedVpnUp` reflects unknown |
| No matching interface | Yes | First probe affirmative | Swap `detector-error` → `vpn` |
| No matching interface | Yes | First probe non-affirmative | Clear `detector-error` → resume |

The detector exposes a `probeKnown: boolean` flag that flips true after the first probe attempt completes (success or failure). The reconciliation function at end-of-init defers its final decision until either (a) probe is disabled, or (b) `probeKnown === true`. A subscription on the detector emits a `'first-probe-completed'` event that the coordinator uses to trigger reconciliation.

`recentTransitions` bounded to last 20; trimmed on every write.

### Why a coordinator (not a settings field)

(Unchanged from prior draft; rationale on event semantics, settings noise, detector-error not being a user toggle, matches existing `HibernationManager`/`MemoryMonitor` pattern.)

---

## 5. Subsystem hooks

### A. Renderer message queue (Layer 1)

Three changes to `src/renderer/app/core/state/instance/instance-messaging.store.ts`:

```typescript
// 1. sendInput — pause check in the existing gate
if (this.pauseStore.isPaused() || isTransientQueueStatus(instance.status)) {
  // queue (existing code path unchanged)
  return;
}

// 2. processMessageQueue — refuse to drain while paused.
//    This covers ALL drain paths (watchdog, batch-update from instance.store.ts,
//    and the retry path) by gating the function itself. Earlier draft put this
//    in drainAllReadyQueues only — review correctly identified that the batch-
//    update path in instance.store.ts:302,389 also calls processMessageQueue.
processMessageQueue(instanceId: string): void {
  if (this.pauseStore.isPaused()) return;       // ← NEW
  // ... rest unchanged
}

// 3. getRetryDisposition — recognise the orchestrator-paused error
//    Existing shape is { shouldRetry: boolean; nextStatus?: InstanceStatus }
//    (no `requeue` field — earlier draft was wrong).
//    For OrchestratorPausedError, shouldRetry=true causes the existing retry
//    path (lines 338-352) to re-queue automatically; nextStatus stays the
//    pre-send status so we don't get stuck in a fake 'busy'.
if (normalized.includes('orchestrator-paused')) {
  return { shouldRetry: true, nextStatus: status };
}
```

The existing 2-s watchdog naturally becomes the resume-drainer. Resume toast is emitted from the IPC `pause` listener at the moment of state change, not from the watchdog.

### B. Renderer queue persistence (post-review addition)

The existing queue is in-memory only; an app crash loses queued messages. With pause potentially holding messages for hours, this is a real gap.

**Privacy-respectful design (post-review, hardened R7):** queue persistence is **gated by the existing `persistSessionContent` AppSetting** (`src/shared/types/settings.types.ts:40`) at **both** the renderer service AND the main-process IPC handler. Defense in depth.

- `persistSessionContent=true` (default): queues snapshot to `instance-message-queue` electron-store namespace, debounced 250 ms; restored on startup before any UI can `sendInput`.
- `persistSessionContent=false`: queues remain in-memory only.
  - Renderer `queue-persistence.service.ts` does not initialise the save loop or call the load IPC.
  - Main-process `INSTANCE_QUEUE_SAVE` handler **also** checks `settings.get('persistSessionContent')` first; if false, returns success without writing (no-op). `INSTANCE_QUEUE_LOAD_ALL` returns `{ queues: {} }`. This guarantees the privacy contract even if a renderer is buggy or if a future code path attempts a save outside the persistence service.
  - When `persistSessionContent` flips from `true` to `false`, the main handler **also clears the `instance-message-queue` namespace** (deletes the file). The user expects the setting change to take effect — leaving stale plaintext on disk would be a privacy bug. Triggered by subscribing to `setting:persistSessionContent` in the persistence handler init.

Either way: per-instance UI surfaces the queue state and queue depth, so a user with `persistSessionContent=false` knows their queue is volatile.

**Attachments are intentionally not persisted** (binary data is the wrong shape for electron-store JSON). Restored entries flagged accordingly; the per-instance indicator shows: *"This queued message had attachments; reattach before resuming."* This is **content loss for the attachments** and is documented as such in `docs/pause-on-vpn.md` rather than glossed over.

Files: new `src/renderer/app/core/state/instance/queue-persistence.service.ts`. **Three new IPC channels** (`INSTANCE_QUEUE_SAVE`, `INSTANCE_QUEUE_LOAD_ALL`, `INSTANCE_QUEUE_INITIAL_PROMPT`) — these need the **same full integration treatment as the pause channels** (post-review):

1. **Constants and Zod schemas** added to `packages/contracts/src/channels/instance.channels.ts` (existing file — these are instance-scoped, not pause-scoped) and a new section of `packages/contracts/src/schemas/instance.schemas.ts`.
2. **`packages/contracts/src/channels/index.ts`** — already re-exports `INSTANCE_CHANNELS`; new channel constants flow through automatically.
3. **`packages/contracts/package.json`** — `./channels/instance` and `./schemas/instance` already exported; no new subpath needed.
4. **`src/preload/domains/instance.preload.ts`** — add typed `invoke` methods for `INSTANCE_QUEUE_SAVE` (renderer → main), `INSTANCE_QUEUE_LOAD_ALL` (request/response), and `INSTANCE_QUEUE_INITIAL_PROMPT` (main → renderer broadcast — uses `on(channel, listener)` pattern).
5. **Renderer IPC service** — `src/renderer/app/core/services/ipc/instance-ipc.service.ts` gains the typed wrappers.
6. **`npm run verify:ipc`** and **`npm run verify:exports`** — must pass after additions.

Schemas (live in `packages/contracts/src/schemas/instance.schemas.ts` extension). **Attachments are stripped at the persistence boundary**: the in-memory `QueuedMessage` (renderer signal) carries `File[]`; the `INSTANCE_QUEUE_SAVE` payload uses a separate `PersistedQueuedMessageSchema` that has *no* attachment data — only a `hadAttachmentsDropped` boolean. This prevents binary user content from being written to `instance-message-queue.json` (verified concern: `FileAttachment.data` is a base64 data URL — `src/shared/types/instance.types.ts:172-177`).

```typescript
// On-disk schema (no binary attachment data; just a flag)
export const PersistedQueuedMessageSchema = z.object({
  message: z.string(),
  hadAttachmentsDropped: z.boolean(),
  retryCount: z.number().int().min(0).max(10).optional(),
  seededAlready: z.boolean().optional(),  // for initial-prompt entries — see §5.C
});

export const InstanceQueueSavePayloadSchema = z.object({
  instanceId: z.string(),
  queue: z.array(PersistedQueuedMessageSchema),   // ← uses persisted schema
});

export const InstanceQueueLoadAllResponseSchema = z.object({
  queues: z.record(z.string(), z.array(PersistedQueuedMessageSchema)),
});

// The initial-prompt routing payload (main → renderer) DOES carry
// attachments because the message is heading INTO the in-memory queue,
// not onto disk. Persistence happens only via INSTANCE_QUEUE_SAVE,
// which strips them.
export const InstanceQueueInitialPromptPayloadSchema = z.object({
  instanceId: z.string(),
  message: z.string(),
  attachments: z.array(FileAttachmentSchema).optional(),
  seededAlready: z.literal(true),
});
```

The `queue-persistence.service.ts` is responsible for translating between the in-memory shape (with `File[]`) and the on-disk shape: when serialising for save, it drops the `files` array and sets `hadAttachmentsDropped = (files?.length ?? 0) > 0`. When restoring from disk, the `hadAttachmentsDropped` flag drives the per-instance "reattach before resuming" hint in the UI. Test added (§9.1) — verify saved payloads contain no `data:` URL substrings.

### C. CLI adapter gate (Layer 2 — template-method refactor required)

**Critical correction.** `BaseCliAdapter` has no `sendInput` method; each of the 7 concrete adapters defines its own (`claude-cli-adapter.ts:856`, `codex-cli-adapter.ts:466`, `copilot-cli-adapter.ts:934`, `gemini-cli-adapter.ts`, `cursor-cli-adapter.ts`, `acp-cli-adapter.ts:430`, `remote-cli-adapter.ts:159`). Adding a `sendInput` method to base would be shadowed by all subclass overrides — the gate would do nothing.

**The gate requires a template-method refactor across all concrete adapters.** This is part of this feature's scope, not a deferral.

#### The refactor

In `src/main/cli/adapters/base-cli-adapter.ts`, add a non-virtual concrete `sendInput` that delegates to a protected abstract `sendInputImpl`:

```typescript
// In BaseCliAdapter (new):
public async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
  if (getPauseCoordinator().isPaused()) {
    throw new OrchestratorPausedError(`adapter.sendInput refused while paused`);
  }
  return this.sendInputImpl(message, attachments);
}

protected abstract sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void>;
```

In each concrete adapter, rename `async sendInput(...)` to `protected async sendInputImpl(...)` and add `override` (TS strict mode requires it). Visibility changes from `public` to `protected`; signature is otherwise identical.

#### Files to refactor (full enumeration, post-verification)

| File | Current method | Renamed to |
|---|---|---|
| `src/main/cli/adapters/claude-cli-adapter.ts:856` | `async sendInput` | `protected override async sendInputImpl` |
| `src/main/cli/adapters/codex-cli-adapter.ts:466` | same | same |
| `src/main/cli/adapters/copilot-cli-adapter.ts:934` | same | same |
| `src/main/cli/adapters/gemini-cli-adapter.ts` | same (line at impl time) | same |
| `src/main/cli/adapters/cursor-cli-adapter.ts` | same | same |
| `src/main/cli/adapters/acp-cli-adapter.ts:430` | same | same |
| `src/main/cli/adapters/remote-cli-adapter.ts:159` | same | **special case — does NOT extend `BaseCliAdapter`; see below** |

#### `RemoteCliAdapter` — special-case (post-review)

Verified 2026-04-28: `RemoteCliAdapter` (`src/main/cli/adapters/remote-cli-adapter.ts:51`) extends `EventEmitter` directly, NOT `BaseCliAdapter`. Renaming its `sendInput` to `sendInputImpl` would not compile (no abstract to override) and would not gate anything. Two options:

- **(Chosen)** Add an explicit pause check at the top of `RemoteCliAdapter.sendInput` (line 159) that mirrors the base-class gate, **preserving the existing `remoteInstanceId` check** (verified at `remote-cli-adapter.ts:160` — actual property is `remoteInstanceId`, not `spawned`). One added line:
  ```typescript
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (getPauseCoordinator().isPaused()) {                                       // ← NEW
      throw new OrchestratorPausedError(`adapter.sendInput refused while paused (remote)`);
    }
    if (!this.remoteInstanceId) {                                                 // existing
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
    }
    await this.nodeConnection.sendRpc(/* ... */);                                 // existing
  }
  ```
  No rename to `sendInputImpl`; no template-method participation; the check is added as the first statement of the existing method.
- (Rejected) Refactor `RemoteCliAdapter` to extend `BaseCliAdapter`. That would be a substantially larger change touching the worker-node RPC plumbing — out of scope for this feature.

This matters because `RemoteCliAdapter.sendInput` forwards user content over the worker-node RPC path; without the explicit check, remote sends would leak while paused.

#### Test-file impacts

Every adapter spec that calls `adapter.sendInput(...)` directly continues to work (the public method now lives on the base class). Specs that mock or spy on `sendInput` need no changes — `sendInput` is still the public surface. Specs that subclass an adapter for testing (rare) and override `sendInput` would need to override `sendInputImpl` instead. Plan must include a final pass through:

- `claude-cli-adapter.spec.ts`
- `codex-cli-adapter.spec.ts`
- `acp-cli-adapter.spec.ts`
- `__tests__/adapter-factory*.spec.ts`
- `__tests__/claude-cli-adapter.spec.ts`

Plus an integration test in `instance-communication.spec.ts` and `instance-manager.spec.ts` to verify pause-during-send → re-queue.

#### Why this gate (Layer 2) is still useful given the interceptor (Layer 3)

Layer 3 (network interceptor) gates outbound HTTPS at the OS-level. Layer 2 (adapter gate) gates *before the message is even handed to the CLI's stdin*. Without Layer 2, the orchestrator hands a message to a CLI process; the CLI's outbound HTTPS is gated by the interceptor and fails; the CLI reports an error and the user sees a confusing failure mid-conversation. With Layer 2, the message never reaches the CLI in the first place — clean queue UX, no spurious CLI error states.

Layer 2 also covers the 14+ direct `adapter.sendInput()` call sites in `instance-lifecycle.ts` (initial prompts at 805, 823; resume-fallback history replay at 1720, 1740, 1890; mode/model change continuity at 2293, 2305, 2322, 2478, 2491, 2498, 2676, 2693, 2697; recovery at 2831). Without the refactor, gating only `InstanceCommunication.sendInput` would leak these.

#### Per-site behaviour when paused

Callers of `adapter.sendInput` receive `OrchestratorPausedError`:

- **User-typed input** (via `InstanceCommunication.sendInput`): renderer's `getRetryDisposition` recognises the error → existing retry path re-queues.
- **Initial prompt** (`sendInitialPromptWithAttachmentFallback` in `instance-lifecycle.ts:794`): the existing call sites at `:1266` (warm start) and `:1355` (cold start) wrap the call in a try/catch that calls `transitionState(instance, 'failed')` and rethrows when *any* error is caught (verified at lines 1273-1287 and 1363-1378). With the adapter gate added, an `OrchestratorPausedError` would currently mark the new instance as failed — wrong. **Required change:** in both call sites, branch on the error type before the generic catch:

  ```typescript
  } catch (error) {
    if (error instanceof OrchestratorPausedError) {
      // Don't fail the instance; the message belongs to the queue.
      logger.info('Initial prompt queued — orchestrator paused', { instanceId: instance.id });
      // Tell the renderer to seed the per-instance queue with this initial message.
      this.deps.queueInitialPromptForRenderer({
        instanceId: instance.id,
        message: initialUserMessage.content,
        attachments: config.attachments,
      });
      // Instance stays in idle; UI shows queued state.
      return;
    }
    this.transitionState(instance, 'failed');
    // ... existing error handling unchanged ...
  }
  ```

  **Bubble-duplication concern (post-review, hardened R8):** when `seededInitialUserMessage` is true, the user-message bubble is already in the output buffer (`instance-lifecycle.ts:1262,1352`). The fix wires through the existing `isRetry` mechanism in `instance-manager.ts:1266-1268,1276-1278` (verified): main-side `InstanceManager.sendInput` already gates user-bubble addition behind `if (!options?.isRetry)`. So a queued message tagged `seededAlready: true` must reach IPC with `isRetry: true`.

  **Concrete wiring** (otherwise the renderer's `sendInputImmediate(..., retryCount=0)` calls `ipc.sendInput(..., retryCount > 0)` which is `false`, and main re-adds the bubble — a real defect the reviewer correctly identified):

  1. Extend the renderer runtime queue type (in `instance-state.service.ts` `messageQueue` signal value type) with a `seededAlready?: boolean` field, alongside the existing `retryCount` and `files`.
  2. `processMessageQueue` reads `seededAlready` from the dequeued entry; when true, calls `sendInputImmediate(...)` with a new sibling parameter `skipUserBubble = true`.
  3. `sendInputImmediate` passes `skipUserBubble || retryCount > 0` as the 4th argument to `ipc.sendInput`. The main-side `isRetry` gate at lines 1266-1268,1276-1278 (and the equivalent in non-command-execution paths) then suppresses the bubble.
  4. The on-disk `PersistedQueuedMessageSchema` already carries `seededAlready` so it survives a restart-while-queued.

  Test: queue an entry with `seededAlready: true`, drain, assert `addToOutputBuffer(instance, userMessage)` is called exactly once (during the original seed at `instance-lifecycle.ts:1262/1352`), not twice.
- **Mode/model-change continuity preambles**: skipped while paused. On resume, the next user message naturally re-establishes context through the CLI's own session continuity. Re-emitting the preamble after resume is rejected because it could collide with the queued user message that drains first.
- **Resume-fallback history replay**: skipped; the instance comes up "cold" and the next user message rebuilds context.

The earlier "creating an instance has no provider traffic" claim was false when an initial prompt is supplied. Corrected here.

### D. `InstanceManager.on('pause')` — interrupt active turns

(Unchanged from prior draft.) `forEachInstance` over `busy`/`processing`/`thinking_deeply` and call `adapter.interrupt()`.

### E. Cross-model review

(Unchanged.) Subscribe to `pause` → abort active `AbortController`s; new calls return `{ skipped: true }`.

### F. Provider quota — full pause (corrected from review)

Earlier draft only cleared the polling interval. The reviewer correctly noted there are multiple entry points. The correct scope:

- Subscribe to `pause` event: set `service.isPaused = true` AND abort all in-flight probe `AbortController`s. **Leave the polling intervals installed** (corrected R8 — see §5.F detailed strategy below; clearing the timers would lose the interval values, which only renderer-driven `QUOTA_SET_POLL_INTERVAL` can restore, and re-arming on resume is not guaranteed to fire).
- All public entry points (`refresh()`, `refreshAll()`, IPC handler `QUOTA_REFRESH`, IPC handler `QUOTA_REFRESH_ALL`, auto-refresh-on-adapter-events, **and the timer tick itself**) check `service.isPaused` first; if true, **do not emit a new snapshot at all**. The previous good `ok: true` snapshot remains in the store; the UI continues to show it unchanged.

**Why no `ok: false` snapshot:** verified at `src/renderer/app/shared/components/provider-quota-chip/provider-quota-chip.component.ts:166-172` — the chip uses `firstOkSnapshot()` which filters for `s.ok === true`. An `ok: false` snapshot, even with valid `windows` preserved, would be ignored by this UI. Rather than retrofit the chip to render a "stale" state for `ok: false`, the simplest correct behaviour is "during pause, refresh is a no-op; the cached good snapshot is what the user sees." A small log line records the skipped refresh for diagnostics.

**Tests:** call `refresh()` while paused; assert no new snapshot was emitted; assert previous good snapshot is still in the store; UI test confirms the chip continues to render the prior values.
- The network interceptor would also block these calls, but service-level pause is faster and produces cleaner errors. Defense in depth.

### G. Process-level network interceptor (Layer 3 — the safety primitive)

**This is the architectural change from the previous draft.** Replaces the `providerFetch()` wrapper, which was too narrow to catch SDK calls and `https.request` callers.

**File:** new `src/main/network/install-network-pause-gate.ts`. Loaded from `src/main/index.ts` only when `pauseFeatureEnabled === true` (see §4 master-kill-switch lifecycle), immediately after `PauseCoordinator` is initialised, **before** any provider service or adapter is constructed. When `pauseFeatureEnabled === false`, the install step is skipped entirely — Node's `http`/`https`/`fetch` primitives remain pristine.

**What it patches** (corrected post-review for `.get` variants AND for TS strict-mode namespace-import readonly):

The naïve form `import * as http from 'http'; http.request = patched;` does **not** compile under this codebase's `tsconfig` (`strict: true`, `esModuleInterop: true`). Verified at `tsconfig.json:strict` and `tsconfig.electron.json:strict` and via existing namespace imports at `src/main/core/config/remote-config.ts` and `src/main/providers/model-discovery.ts`. Namespace-import bindings are read-only properties.

The correct pattern uses a `-readonly` mapped-type cast to obtain a writable handle, with the **unbound** original functions saved for restoration (not `.bind()` — that returns a different object identity that will fail strict equality checks in tests):

```typescript
import * as httpNs from 'http';
import * as httpsNs from 'https';

// Writable handles for runtime patching. -readonly mapped types remove the
// readonly modifier from namespace-import bindings.
type Writable<T> = { -readonly [K in keyof T]: T[K] };
const http  = httpNs  as Writable<typeof httpNs>;
const https = httpsNs as Writable<typeof httpsNs>;

// Save UNBOUND originals for verbatim restoration on uninstall.
const realHttpRequest  = http.request;
const realHttpGet      = http.get;
const realHttpsRequest = https.request;
const realHttpsGet     = https.get;
const realFetch        = globalThis.fetch;

export function installNetworkPauseGate(deps: {
  coordinator: PauseCoordinator;
  allowedHosts: AllowedHostMatcher;
}): () => void {
  http.request  = makeGated('http',  realHttpRequest,  deps);
  http.get      = makeGated('http',  realHttpGet,      deps);
  https.request = makeGated('https', realHttpsRequest, deps);
  https.get     = makeGated('https', realHttpsGet,     deps);
  globalThis.fetch = makeGatedFetch(realFetch, deps);

  return () => {
    http.request     = realHttpRequest;
    http.get         = realHttpGet;
    https.request    = realHttpsRequest;
    https.get        = realHttpsGet;
    globalThis.fetch = realFetch;
  };
}
```

Tests assert `http.request === realHttpRequest` after uninstall to verify identity restoration (not just behavioural equivalence).

**Why patching `.get` separately matters:** `http.get` / `https.get` capture an internal reference to `request` at module-load time inside Node's `http` module. Replacing the `request` property on the exports object does **not** affect the internal binding — verified by the existence of `src/main/core/config/remote-config.ts:124` which uses `protocol.get(url, options, callback)`, an active code path in this codebase. `.get` is patched explicitly to close this gap.

**No file-system writes. No `node_modules/` modification. No patch-package.** This is a runtime, in-memory replacement of properties on already-imported module objects. Standard interception pattern (used by Sinon, nock, and many Node test libraries).

**Why this catches the SDK:** the Anthropic SDK (`@anthropic-ai/sdk` 0.71.x, verified 2026-04-28 in `node_modules/@anthropic-ai/sdk/internal/shims.js:getDefaultFetch`) uses `globalThis.fetch` by default. Patching `globalThis.fetch` covers all SDK calls automatically. If the SDK ever switches to `undici` directly, we'd add `undici.fetch` and `undici.request` to the patch surface — checked at upgrade time as part of the dep-update process.

**Allow-list (local-call exemptions):**

| Match | Rationale |
|---|---|
| `localhost` | Local Ollama, dev servers |
| `127.0.0.1`, `::1`, `0.0.0.0` | IPv4 / IPv6 / unspecified loopback |
| `10.*`, `172.16-31.*`, `192.168.*` | RFC 1918 private — opt-in via setting (default: gated, not allowed; rationale: VPN may route private ranges) |
| User-configured `remoteNodesServerHost` | The user's own remote-nodes (existing feature) |

**Default allow-list = strictly loopback only.** RFC 1918 is **gated by default**. Reasoning: VPN often routes private ranges through the tunnel — exactly what the feature is designed to prevent. Adding a setting `pauseAllowPrivateRanges` (boolean, default `false`) lets advanced users opt in if they have a known-safe local network.

**Refusal behaviour:**

```typescript
function makeGated(scheme: 'http'|'https', real: typeof http.request, deps: ...) {
  return function gated(this: unknown, ...args: unknown[]): http.ClientRequest {
    const hostname = extractHostname(scheme, args);
    if (deps.allowedHosts.isAllowed(hostname)) {
      return real.apply(this, args as Parameters<typeof http.request>);
    }
    if (deps.coordinator.isPaused()) {
      // log: hostname only, no path, no headers, no body.
      logger.info('Network refused while paused', { scheme, hostname });
      throw new OrchestratorPausedError(`Network call refused while paused: ${scheme}://${hostname}`);
    }
    return real.apply(this, args as Parameters<typeof http.request>);
  };
}
```

`fetch` variant is async and wraps the same logic, throwing `OrchestratorPausedError` (which existing error handlers in calling services treat as a network failure — they log + bail; some retry, but the next retry hits the same gate).

**Testing the interceptor:**

- `install-network-pause-gate.spec.ts` — verify gating with a mock coordinator; verify `http`/`https`/`fetch` all gated; verify allow-list works; verify uninstaller restores originals (so tests can run normally without state leakage).
- A targeted integration test: install the gate against a mock coordinator that reports paused, then call `https.request` to a non-local host; assert the call was refused (synchronous throw on `request`; rejected promise on `fetch`).

**What it does NOT cover** (honest residual surface):

- **CLI child processes.** Claude/Gemini/Codex/Copilot CLIs run as separate processes. Their outbound HTTPS calls go through their own Node runtime and are unaffected by our patches. They are gated upstream by Layers 1–2 (renderer queue + `BaseCliAdapter.sendInput`). The CLI processes receive no new input while paused; an in-flight turn is interrupted (which closes its sockets on most CLIs).
- **Native modules with their own network stack.** If any dependency uses a native binding for network (very rare), it bypasses our interceptors. The 2026-04-28 audit found none.
- **Direct OS-level connections (`net.connect`, raw sockets).** Not currently used by any provider code in this codebase. If added, the gate would need extension. Documented.

This is the honest residual list. The interceptor is "architecturally correct for everything that goes through Node's standard HTTP modules and global fetch," which after the audit accounts for every provider-bound call path identified.

### H. Surfaces deliberately not hooked

- Local-only services (codemem, BM25, LSP, SQLite, file I/O, git, hibernation manager, channel router, history manager, session persistence except as gated by `persistSessionContent`).
- App-level networking the user doesn't typically care about: auto-update checks, telemetry. These are **also** caught by the interceptor unless they target an allow-listed host. If the user's auto-update endpoint happens to be an allowed corporate URL, it works; if it's a public CDN, it gets paused too. Acceptable — the safety promise is the primary objective.

### I. Renderer state — `PauseStore`

(Unchanged.) New file: `src/renderer/app/core/state/pause/pause.store.ts`. Signal-based, bound to `PAUSE_STATE_CHANGED` IPC event.

---

## 6. Settings & persistence

### 6.1 New AppSettings keys

Nine keys total. All in `src/shared/types/settings.types.ts` under new `'network'` category. The first key (`pauseFeatureEnabled`) is the master kill switch and gates everything else.

| Key | Type | Default | Notes |
|---|---|---|---|
| **`pauseFeatureEnabled`** | boolean | **`true`** | **Master kill switch.** When `false`, the feature is fully removed from the running process: no interceptor, no detector, no UI, queue reverts to in-memory. See §1 "Master kill switch." |
| `pauseOnVpnEnabled` | boolean | `true` | Auto-detection toggle (only meaningful when feature enabled) |
| `pauseVpnInterfacePattern` | string (regex) | `^(utun[0-9]+\|ipsec[0-9]+\|ppp[0-9]+\|tap[0-9]+)$` | Tunable |
| `pauseTreatExistingVpnAsActive` | boolean | `true` | Closes fail-closed-restart gap |
| `pauseDetectorDiagnostics` | boolean | `false` | Verbose logging |
| `pauseReachabilityProbeHost` | string | `''` | `host:port`. Empty = probe disabled |
| `pauseReachabilityProbeMode` | enum | `'disabled'` | `'reachable-means-vpn' \| 'unreachable-means-vpn' \| 'disabled'` |
| `pauseReachabilityProbeIntervalSec` | number | `30` | 10–600 inclusive |
| `pauseAllowPrivateRanges` | boolean | `false` | Opt-in to allow RFC 1918 traffic during pause |

`SettingMetadata.category` union extended to include `'network'`. The probe-mode setting reuses the existing `'select'` type (already supports enumerated `options`), avoiding a new `SettingMetadata.type` union member.

### 6.2 Settings UI architecture (unchanged from previous draft)

Settings is **not** auto-driven. Files to change:

- `src/renderer/app/core/state/settings.store.ts` — `networkSettings` computed.
- `src/renderer/app/features/settings/network-settings-tab.component.ts` — new file.
- `src/renderer/app/features/settings/settings.component.ts` — `SettingsTab` union, `NAV_ITEMS`, `@switch` case, imports.
- `src/renderer/app/features/settings/pause-detector-events-dialog.component.ts` — new modal.
- `src/shared/types/settings.types.ts` — extend `SettingMetadata.category`.

Diagnostic controls (regex restore, recent-events dialog) live as bespoke markup in the tab component, not retrofitted into `SettingMetadata`.

### 6.3 Input validation (corrected — wiring spelled out post-review)

The existing settings IPC pipeline does **not** do per-key value validation. Verified at `packages/contracts/src/schemas/settings.schemas.ts:10-12`: `SettingsUpdatePayloadSchema` accepts `value: z.unknown()`. `settings-handlers.ts:114` passes the unvalidated value straight to `settings.set()`. So a claim that "main-side schema is authoritative" without further wiring is wrong.

**Required wiring (this feature's scope):**

1. **New file:** `src/main/core/config/settings-validators.ts` — exports a map keyed by `keyof AppSettings`:

   ```typescript
   type SettingValidator<K extends keyof AppSettings> = (
     value: unknown
   ) => { ok: true; value: AppSettings[K] } | { ok: false; error: string };

   export const PAUSE_SETTING_VALIDATORS: Partial<{
     [K in keyof AppSettings]: SettingValidator<K>
   }> = {
     pauseFeatureEnabled: validateBoolean,
     pauseOnVpnEnabled: validateBoolean,
     pauseTreatExistingVpnAsActive: validateBoolean,
     pauseDetectorDiagnostics: validateBoolean,
     pauseAllowPrivateRanges: validateBoolean,
     pauseVpnInterfacePattern: (v) => validateRegexString(v, { maxLen: 200, safeRegex: true }),
     pauseReachabilityProbeHost: (v) => validateHostPort(v, { allowEmpty: true }),
     pauseReachabilityProbeMode: (v) => validateEnum(v, ['disabled', 'reachable-means-vpn', 'unreachable-means-vpn']),
     pauseReachabilityProbeIntervalSec: (v) => validateIntInRange(v, 10, 600),
   };
   ```

2. **Modify `src/main/core/config/settings-manager.ts`** `set()` method — before the existing `this.store.set(...)` call, look up the validator for the key (if any); if validation fails, throw a descriptive error. Same for `update()`. Existing settings (without validators) pass through unchanged — no regression.

3. **Modify `src/main/ipc/handlers/settings-handlers.ts`** `SETTINGS_SET` and `SETTINGS_UPDATE` handlers — already wrapped in try/catch that returns `IpcResponse` with `success: false` on throw. The new validator throws are caught here and surface to the renderer with the descriptive error message (line 124-131 already does this for any error).

4. **Renderer pre-validation** — `src/renderer/app/features/settings/network-settings-tab.component.ts` performs the same checks client-side for inline UX feedback, but trusts main as the authoritative gate. (Per project pattern in other tab components.)

| Field | Validator |
|---|---|
| `pauseVpnInterfacePattern` | length 1–200; `new RegExp(value)` must compile; `safe-regex` check (no catastrophic backtracking) |
| `pauseReachabilityProbeHost` | empty OR matches `^[a-zA-Z0-9.-]{1,253}:[1-9][0-9]{0,4}$`; port 1–65535 |
| `pauseReachabilityProbeMode` | one of `'disabled'`/`'reachable-means-vpn'`/`'unreachable-means-vpn'` |
| `pauseReachabilityProbeIntervalSec` | integer; 10–600 |
| `pauseAllowPrivateRanges`, `pauseOnVpnEnabled`, `pauseFeatureEnabled`, `pauseTreatExistingVpnAsActive`, `pauseDetectorDiagnostics` | boolean |

On regex change while detector is running, the detector recompiles defensively in `try/catch`; a regex that compiled at validation but somehow throws at use time falls back to defaults and emits `detector-error`.

**Tests required (§9.1):** `settings-validators.spec.ts` — for each validator, valid input passes, each class of invalid input rejects with descriptive error. `settings-manager.spec.ts` — extension to verify validator is invoked and throws propagate. `settings-handlers.spec.ts` — extension to verify rejection surfaces as `success: false` IPC response.

A new dependency `safe-regex` (or `safe-regex2`) added to runtime deps; choice at implementation time based on current maintenance.

### 6.4 Pause-state persistence

Lives in dedicated electron-store namespace `pause-state` (file: `<userData>/pause-state.json`). Schema in §4. Bounded last 20 transitions. **Excluded from `settings:export`.**

### 6.5 Queue persistence — privacy-respectful (corrected)

Lives in electron-store namespace `instance-message-queue`. **Gated by existing `persistSessionContent` setting**:

- `persistSessionContent=true`: queues persisted; restored on app start before any UI is shown that could `sendInput`.
- `persistSessionContent=false`: queues remain in-memory only (matches existing privacy behaviour for all other session content). On crash, queued messages are lost; user-facing UI (per-instance indicator) makes the volatility visible.

Attachments excluded from persistence; restored entries flagged. The per-instance indicator surfaces "had attachments; reattach before resuming." This is **content loss** (acknowledged) but the recovery path is explicit.

**At-rest disclosure:** the spec acknowledges that `instance-message-queue.json` contains plaintext message bodies on disk while the queue is persisted, identical to existing session-content behaviour. Encryption at rest is deferred to v1.5 (`safeStorage` consistency across platforms permitting).

### 6.6 Diagnostic data — retention & privacy (post-review hardening)

What is stored locally:

- **As normal user settings (in `settings.json`, included in `settings:export` if the user chooses to export):** `pauseReachabilityProbeHost`, `pauseReachabilityProbeMode`, `pauseReachabilityProbeIntervalSec`, `pauseVpnInterfacePattern`, the booleans. These are user configuration — same trust model as every other setting.
- **In `pause-state.json`** (excluded from `settings:export`): timestamps + interface diff (interface names only).
- **In-memory ring buffer (50 entries):** same as `pause-state.json`.

What is **never logged in detection diagnostics, refusal logs, or the ring buffer** (corrected R8/R10 — these are about *logs*, not about the `settings.json` file):

- Probe target hosts/ports.
- Probe results (only an aggregated boolean is logged: "this tick affirmative").
- Network-interceptor refused-call URLs, paths, query strings, headers, or bodies — only the **hostname** is logged, at `info` level, when a call is refused.
- IP addresses of interfaces.
- API keys (these appear in some provider `https.request` headers; the interceptor explicitly does not log headers).

Excluded from `settings:export`: `pause-state` namespace, ring buffer (in-memory anyway).
Excluded from any future log-bundle: spec calls this out so future log-bundle work doesn't regress.

### 6.7 Migration

`electron-store` `defaults` populates new keys on load. New namespaces handle missing-file as safe defaults. **One migration concern**: `pauseTreatExistingVpnAsActive` default changes from prior draft (`false`) to post-review (`true`). Since this spec is the first one to ship the feature, no migration logic needed — the default is just `true`.

---

## 7. UI

(Mostly unchanged from prior draft; listed deltas from review.)

### 7.1 Master PAUSE button (unchanged)

Title-bar overlay; toggles only `user` reason. States and tooltips unchanged.

### 7.2 Top-of-app banner (unchanged + stacking note)

Pause banner stacks **above** the existing startup banner. Both can be visible simultaneously. Pause banner: red/amber. Startup banner: neutral.

Banner content variants (`vpn`, `user`, both, `detector-error`) unchanged from prior draft. **No "Resume manually" button on the VPN-paused banner** — escape hatch is the regex edit (settings → Network) for false positives, or the master button to add a manual hold.

### 7.3 Resume toast (unchanged + N=0 suppression)

5-s auto-dismiss; one-shot per resume transition. **Suppressed when the queued-message total across all instances is 0** — silent resume is more seamless than an empty notification. The toast wording is computed from the actual count: 1 → "Resumed — sending 1 queued message"; N>1 → "Resumed — sending N queued messages"; N=0 → no toast at all (banner disappearance is sufficient signal).

### 7.4 Detector-error confirmation modal (unchanged)

Default focus on `[Cancel]`. Affirmative requires explicit click. Spelled-out warning text. On affirmative: `detector-error` reason removed; detector restarts; if VPN still active and detection recovers, user is paused again.

### 7.5 Per-instance queued-message indicator (unchanged + attachment hint)

Sidebar badge `(N queued)`; input-panel inline hint when paused: *"Queued — will send when orchestrator resumes."*

When restored entry had attachments dropped during persistence-restore: *"This queued message had attachments; reattach before resuming."*

### 7.6 Network settings tab content

The master kill switch sits at the top. When it's off, the rest of the controls are collapsed behind an explanation. When on, all rows render via `store.networkSettings()` with a Diagnostics subsection of bespoke controls.

**Feature OFF state:**

```
Network
─────────────────────────────────────────────────────────────
  ☐ Enable VPN pause feature

     When enabled, the orchestrator can detect VPN connections
     and automatically pause AI traffic. The master pause
     button also becomes available. While disabled, no related
     code is active in the app — outbound traffic is not
     intercepted, no detector polls the network, and no UI
     elements appear.
─────────────────────────────────────────────────────────────
```

**Feature ON state:**

```
Network
─────────────────────────────────────────────────────────────
  ☑ Enable VPN pause feature
     [ ⓘ Disable to fully remove this feature from the app. ]

  Auto-detection
  ────────────────────────────
  ☑ Pause on VPN
  Interface pattern (regex)
     [ ^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$        ]
  ☑ Treat existing VPN as active at startup
  ☐ Allow RFC 1918 (private ranges) during pause
  ☐ Verbose detection logging

  Reachability probe (optional)
  ────────────────────────────
     Host:port:    [ host.internal:443                       ]
     Mode:         [ Disabled ▼ ]   (or reachable=VPN / unreachable=VPN)
     Interval:     [ 30 ] seconds  (10–600)

  Diagnostics
  ────────────────────────────
     [ Restore default pattern ]
     [ Show recent detection events ]

     Detection events are stored locally and never exported.
     Probe target hosts are never recorded in detection logs or diagnostics
     (they are stored as a normal user setting in settings.json).
─────────────────────────────────────────────────────────────
```

**Toggling the kill switch** triggers the no-restart install/uninstall flow described in §1. The Settings page shows a brief inline confirmation: *"Feature enabled — interceptor active"* or *"Feature disabled — outbound traffic no longer intercepted."*

### 7.7 Not in scope

System-tray menu item; dock badge; per-instance pause overrides; pause-history page.

---

## 8. Failure modes (matrix)

| Scenario | Behaviour | Rationale |
|---|---|---|
| Detector throws | Coordinator adds `detector-error`; banner; user resumes via confirmation modal | Fail closed |
| Detector timer dies | 10 s heartbeat watchdog → `detector-error` | Fail closed |
| App crashes while paused | Persistence holds reasons; on restart, init *paused*; first detector scan force-treats matching interfaces as VPN | Restart never silently un-pauses |
| App crashes while running | Persistence empty → starts running; detector takes over within 2 s | Symmetrical |
| Persistence file corrupted | Start paused under `'detector-error'` with `forceVpnTreatmentForFirstScan=true`; log warning. User resumes via confirmation modal once network state verified | Fail closed — corrupted ≠ missing. Unknown state warrants caution |
| Persistence file missing (first-ever launch) | Start running. No log warning (this is normal) | Legitimate first-launch state |
| User toggles `pauseFeatureEnabled` to false while paused | All reasons cleared atomically; banner hides; interceptor uninstalled; detector stopped; queue persistence service stopped; in-memory queue drains via existing watchdog | Kill switch fully removes the feature without restart |
| User toggles `pauseFeatureEnabled` back to true | Interceptor re-installed; detector started fresh; persisted state older than 24 h discarded | Clean re-init |
| App crashes while feature was disabled | On restart, kill switch is still false; no interceptor installed; no detector. Persisted pause-state is read but ignored (feature disabled) | Disabling the feature persists across crashes |
| Bug in interceptor causing timeouts | User toggles kill switch off via Settings; interceptor uninstalled in microseconds; outbound traffic flows normally | Recovery path exists without uninstall/rollback |
| App restart while still on VPN | First detector scan force-treats matching interfaces as VPN regardless of `pauseTreatExistingVpnAsActive`; reconciles persisted `vpn` reason | Closes the previously identified gap |
| Race: pause fires *during* a sendInput | Renderer queues; main `BaseCliAdapter.sendInput` rejects with `OrchestratorPausedError`; `getRetryDisposition` returns `shouldRetry: true`; existing retry path re-queues | One queued message; no leak |
| Race: send fires during the polling gap, just before detect | Network interceptor catches it. Refused at the HTTP layer | Closes the in-flight window for *new* requests |
| In-flight bytes already in OS TCP buffer at pause | Cannot stop. Documented as residual ms-to-s window | Honest disclaimer |
| User mashes master button | Coordinator de-bounces the *event*; state itself is just toggling a Set member | Cosmetic only |
| Many instances at pause-time | `forEachInstance` is O(n); per-instance interrupt async; CLIs handle SIGINT independently | Sub-millisecond pause-broadcast |
| User opens a new instance while paused | Allowed. `INSTANCE_CREATE_WITH_MESSAGE` routes the initial message into the renderer queue; instance creation proceeds; first message queued | Earlier draft was wrong about this; corrected |
| User mid `waiting_for_permission` when pause fires | The permission-response IPC handler (`INPUT_REQUIRED_RESPOND` in `instance-handlers.ts:806`) has **three branches** before the generic `sendInputResponse` call: `deferred_permission` → `resumeAfterDeferredPermission` (line 820-846, respawns/resumes the CLI), `permission_denial` + `allow`/`always` → `selfPermissionGranter.grant()` (line 854-880, writes a settings rule and respawns), and the default → `sendInputResponse` → `adapter.sendRaw()` (line 962). Gating only `sendInputResponse` would miss the first two branches. **Required gate location: the top of the IPC handler, BEFORE branching.** A `pauseCheckOrThrow()` call right after `validateIpcPayload`. Renderer permission-prompt UI catches the error and shows: *"Resume orchestrator to respond to this prompt."* The CLI was already idle awaiting input, so the wait is harmless; user resumes, then clicks Allow/Deny. **Not** queued (no UI queue exists for permission prompts). Test required (§9.2). | All three permission-response branches gated at the boundary |
| Wake of hibernated instance during pause | Wake allowed (local op); first message queues normally | Same rule |
| Scheduled automation fires during pause | `automation-runner.ts:170` calls `manager.createInstance({ initialPrompt })`. The initial-prompt routing (§5.C) catches the `OrchestratorPausedError`, queues the message, and leaves the instance idle. The automation's `readyPromise.catch` (line 190-194) does NOT fire because the instance creation succeeded. Automation continues tracking the instance; on resume the queued message drains and the run proceeds. **No new code needed in automation-runner.ts** — fix is transitive via §5.C. Test required (§9.2). | Reuses existing flow + the §5.C fix |
| Detector falsely triggers (non-VPN interface) | Banner; **no one-click resume**. User adjusts regex in settings | Closes the foot-gun |
| Regex becomes invalid at apply time | Detector falls back to defaults and emits `detector-error` | Fail closed; never crashes |
| Quota refresh requested via IPC during pause | `ProviderQuotaService.refresh()` checks service-level pause flag; **does not emit a new snapshot**; the previous good `ok: true` snapshot remains in the store; quota chip continues to render unchanged | Verified `firstOkSnapshot()` in `provider-quota-chip.component.ts:166` filters for `ok: true` — emitting `ok: false` would be ignored by the chip. No-emit is the simplest correct behaviour |
| `pauseOnVpnEnabled` toggled OFF while paused-by-VPN | `vpn` reason removed; if `user` not set, app resumes | User explicitly disabled the feature; we honour it |
| `pauseOnVpnEnabled` toggled ON | Detector starts; first scan with current setting; if VPN matches and `pauseTreatExistingVpnAsActive=true` (default), adds `vpn` reason | Live reconciliation |
| Anthropic SDK call attempted while paused | Interceptor catches `globalThis.fetch` patch; SDK call rejects | SDK uses globalThis.fetch per `node_modules/@anthropic-ai/sdk/internal/shims.js:getDefaultFetch` |
| A native module makes a raw socket connection bypassing http/https/fetch | Interceptor does not catch this. Documented as residual surface | No such module currently used by codebase (audit 2026-04-28) |
| App restart with persisted queue + dropped attachments | Per-instance indicator surfaces "reattach before resuming" hint; `persistSessionContent` setting governs whether queue is persisted at all | User can recover; content loss is explicit, not silent |

### "Resume manually" override — resolved

(Unchanged from prior draft.) Removed. Escape paths: regex edit (durable), or `pauseOnVpnEnabled=false` (drastic), or detector-error confirmation modal.

### Seamless-resume guarantees (the core UX promise)

The single most important UX property of this feature is that **resume feels like nothing happened.** When VPN drops (or the user releases the master button), the orchestrator returns to a fully working state with no manual cleanup, no confused UI, and no surprise data loss. The whole design is structured to honour that. This subsection codifies the contract.

**1. Latency budget.** From the moment VPN drops at the OS level to the moment a previously-queued message is actually being processed by the CLI:

- Detector flap-suppression: up to 4 s (2 ticks × 2 s).
- Coordinator removes `vpn` reason → emits `resume` event → IPC broadcast → renderer signal updates: a few ms.
- Renderer watchdog tick + 100 ms send setTimeout: up to ~2.1 s.
- **Total worst-case to first message in flight: ~6 s.** Typically faster (interface drops are usually clean, no flap).

**2. What is preserved.**

- Every queued user-typed message (in-memory always; persisted when `persistSessionContent=true`).
- Drafts (existing `DraftService`).
- All instance state: which is selected, scroll position, output buffers, conversation history, hibernation state.
- CLI session continuity (we interrupted in-flight turns; we never terminated processes). Resume sends fresh input through the normal `sendInput` path; the CLI continues its session.
- All settings.
- Cross-model review state (in-flight calls were aborted; the user can re-trigger; review is on-demand, not background).

**3. What is lost (acknowledged trade-offs).**

- Any in-progress assistant streaming response from the moment of pause (the interrupted turn). Documented in §1 "What pause means."
- Attachments on queued messages that survive a crash (the message replays without the attachment; UI surfaces the "reattach" hint).
- `pause-state.json` if it gets corrupted (paused under `detector-error`; one click to recover).

**4. Auto-resume preconditions.** Auto-resume happens only when ALL of the following hold:

- The detector says VPN is gone (per the corrected algorithm in §3 — both interface and probe signals are false, with debounce on each).
- The kill-switch `pauseFeatureEnabled` is true (or was just toggled false, which also clears `vpn`).
- The `user` reason is NOT held (manual button hasn't been pressed).
- The detector did NOT error (no `detector-error` reason).

This is a strict AND. Any one of these failing keeps the app paused. The user never has to wonder "did it auto-resume?" — the banner answers that question every moment it's up.

**5. Manual-resume preconditions.** Clicking the master button (or hitting the keyboard shortcut) ALWAYS removes the `user` reason. If no other reason is held, the app resumes immediately. If `vpn` is still held, the banner updates to "auto-paused" instead of "manual paused" — visually obvious that one source of pause cleared but another remains.

**6. Resume drains in stable order.**

The renderer's per-instance queues drain via the existing 2-s watchdog. Each tick processes one message per ready instance (idle/ready/waiting_for_input). Queues are processed in insertion order — the user sees their messages go out in the order they were typed. There is no thundering-herd problem even with many instances queued, because the watchdog is per-instance and the CLIs themselves are independent processes.

**7. UI returns to baseline.**

- Banner disappears within one Angular signal-update tick (sub-frame).
- Master pause button returns to neutral state.
- Per-instance queued-count badges decrement as messages drain; disappear at zero.
- Resume toast appears once (suppressed when N=0 — see §7.3).
- Permission prompts that were showing the "Resume to respond" hint return to their normal interactive state.

**8. The single intentional friction point.**

After a `detector-error` (detector threw, persistence corrupted, etc.), the user sees the confirmation modal once. This is **by design** — fail-closed semantics require explicit confirmation when the system genuinely doesn't know its own state. The modal text spells out the situation and defaults focus to Cancel. This is the only UI flow that requires a click on the resume path.

**9. Test coverage for seamless resume** (in addition to per-component tests):

- Pause→queue 3 messages→resume→assert all 3 are processed in insertion order, exactly once each, with no duplicate user-bubbles in the output.
- Pause→queue 0 messages→resume→assert no toast appears, banner disappears, no system-level events emitted to renderer beyond the `pause:state-changed`.
- Pause for 60 minutes (mocked timer)→resume→assert CLI session is still alive and a fresh send works (uses the existing stuck-process detector path if needed).
- Many simultaneous queued messages across many instances→resume→assert no thundering-herd error, no missed messages, watchdog drains them all within the natural per-instance cadence.

---

## 9. Testing strategy

### 9.1 Unit (Vitest)

- `pause-coordinator.spec.ts` — reason refcount math; manual-vs-vpn semantics; persistence round-trip; fail-closed restart; first-scan-force-vpn-treatment flag; corrupted-persistence ≠ missing-persistence (post-review); idempotent add/remove; **master kill-switch lifecycle** (true→false uninstalls interceptor, clears reasons, stops detector; false→true reinstalls; persisted-state staleness pruning on re-enable). ~50 cases.
- `vpn-detector.spec.ts` — corrected algorithm coverage:
  - Startup with `treatExistingAsVpn=true` + matching interface present → emit `vpn-up` immediately on init.
  - Startup with `treatExistingAsVpn=false` + matching interface present → no emit; matching interface goes into `knownNonVpnIfaces`.
  - Disconnect-then-reconnect of the same `utun5` name (post-review fix): assert `vpn-up` emits on the second connection, not just the first.
  - Probe-only `vpn-up` followed by probe-only `vpn-down` — interface signal never asserted (post-review fix).
  - Interface up + probe up; interface drops; probe still up → no `vpn-down` emit.
  - Interface up + probe up; interface drops; probe drops → `vpn-down` emits exactly once.
  - 4 s flap suppression on interface goneVpn.
  - First-scan-force flag honoured: forces VPN treatment regardless of `treatExistingAsVpn`.
  - Pattern recompile path; throw → `detector-error`.
  - Probe modes (`reachable-means-vpn` / `unreachable-means-vpn` / `disabled`) translate correctly to `probeSignalActive`.
  - **Probe non-affirmative debounce** (post-review): single non-affirmative result while `probeSignalActive=true` does NOT clear the signal; two consecutive non-affirmative results do. Affirmative result resets the counter.
  - **Probe-known flag** (post-review): starts `false`; flips to `true` after first probe result (success or failure); coordinator's first-scan reconciliation defers final decision until probe-known when probe is configured.
  - **Probe-unknown emit suppression** (post-review): with probe configured, init runs; recompute is called; assert NO `vpn-down` emit is produced before the first probe result. After probe non-affirmative arrives, `vpn-down` emit is allowed (or NOT, if no transition needed).
  - Idempotent emits: `lastEmittedVpnUp` prevents duplicate broadcasts.
  Target ~50 cases.
- **`install-network-pause-gate.spec.ts`** — verifies all five patched primitives are gated:
  - `http.request` while paused → throws `OrchestratorPausedError` for non-allow-listed host; passes through for allow-listed.
  - `http.get` while paused → same (post-review addition).
  - `https.request` — same.
  - `https.get` — same.
  - `globalThis.fetch` — same (async; rejects with `OrchestratorPausedError`).
  - Interceptor uninstaller restores all five originals.
  - Refusal log contains hostname only (no path, query, headers, body).
  - Private-range allow setting honoured.
  - Anthropic SDK smoke test: with the SDK constructed and `globalThis.fetch` patched, `client.messages.create()` rejects when paused.
  Target ~20 cases.
- `pause-store.spec.ts` (Angular) — signal updates from IPC; computed `source`; manual-toggle IPC. ~10 cases.
- `queue-persistence.service.spec.ts` (Angular) — debounced write; restore on init; `persistSessionContent=false` skip path; attachments-dropped path; namespace clear on instance termination; **persisted payload contains no `data:` URL substring** (post-review). ~15 cases.
- **`instance-queue-handlers.spec.ts`** (post-review) — main-side IPC handlers: `INSTANCE_QUEUE_SAVE` while `persistSessionContent=false` returns success but writes nothing; `INSTANCE_QUEUE_LOAD_ALL` while `persistSessionContent=false` returns `{queues:{}}`; flipping `persistSessionContent` from `true` to `false` clears the namespace file. ~10 cases.
- Extensions to `instance-messaging.store.spec.ts` — `processMessageQueue` gate covers ALL drain paths (watchdog, batch-update from instance.store.ts:302/389, retry); `getRetryDisposition` recognises `orchestrator-paused`; drain on resume. ~10 new cases.
- Settings-schema validation tests — including pathological regex inputs that must reject; probe mode/host/interval bounds. ~15 cases.
- **`settings-validators.spec.ts`** (post-review) — for each new pause-setting validator, verify valid inputs accept and invalid inputs reject with descriptive errors. Test that `SettingsManager.set()` invokes the validator and surfaces rejection. ~15 cases.

### 9.2 Integration (Vitest + mocked adapters)

- E2E with `MockCliAdapter`: pause → in-flight turn interrupted; queue grows; resume → drains; toast emitted exactly once.
- Cross-model review: in-flight call aborts on pause; subsequent call returns `{ skipped: true }`.
- Provider-quota service: all entry points refuse during pause.
- Settings round-trip: change regex → detector re-evaluates → re-emits.
- Persistence round-trip: simulate crash by re-initialising coordinator + queue persistence service from disk; assert state restored.
- **Interceptor end-to-end:** install gate; mock coordinator paused; call `https.request` to a non-local host; assert refused. Repeat for `fetch` and `http.request`.
- **Kill-switch end-to-end:** start with `pauseFeatureEnabled=true`; verify all components active (interceptor patched, detector running, listeners subscribed). Toggle to `false`; verify all components torn down (interceptor restored, detector stopped, listeners removed, reasons cleared); make a `https.request` to a non-local host and assert it succeeds (i.e., interceptor truly gone). Toggle back to `true`; verify all components reinstalled cleanly.
- **Initial-prompt-while-paused** (post-review): create a paused state; call `manager.createInstance({ initialPrompt: 'hello' })`; assert the instance is created and stays in `idle` (NOT `failed`); assert the renderer queue receives an `INSTANCE_QUEUE_INITIAL_PROMPT` event; resume; assert the message drains and ends up sent to the CLI exactly once; assert the user-message bubble appears in `outputBuffer` exactly once (no duplicate from seed + replay).
- **Automation-while-paused** (post-review): same as above but triggered through `automation-runner.ts` `dispatchRun`; verify the automation's `readyPromise.catch` does not fire and the run remains tracked; on resume, the run completes normally.
- **Permission-response-while-paused** (post-review): instance in `waiting_for_permission`; pause; user attempts to send response via `INPUT_REQUIRED_RESPOND` covering all three branches:
  - generic (default → `sendInputResponse` → `sendRaw`),
  - `deferred_permission` (→ `resumeAfterDeferredPermission`),
  - `permission_denial` + `allow`/`always` (→ `selfPermissionGranter.grant`).
  All three return `OrchestratorPausedError` with the IPC handler's gate at line 806; assert the renderer permission-prompt UI displays the resume hint; resume; user response now succeeds.
- **Restart-with-probe-only-config** (post-review): persistence has `vpn` reason; user has probe-only config (no matching interface name); restart. Coordinator stays in `detector-error` until probe runs once. If probe affirmative → swap to `vpn` reason. If probe non-affirmative → resume. Verify the app does NOT briefly resume during the gap before the first probe result.
- **Quota refresh-while-paused** (post-review): set up an `ok: true` snapshot in the store; pause; trigger `refresh()` and `refreshAll()`; assert no new snapshot is emitted; assert the previous snapshot is still in the store; assert the chip continues to render the prior values.
- **RemoteCliAdapter pause** (post-review): set up a remote adapter; pause; call `sendInput`; assert `OrchestratorPausedError` thrown; assert no RPC was sent over the worker-node path.

### 9.3 Manual / empirical playbook (`docs/pause-on-vpn.md`)

1. App running, no VPN. Verify `running` baseline. Note interfaces.
2. Enable Verbose detection logging.
3. User connects to VPN. Read detector log; identify interface name(s); choose the regex.
4. User disconnects. Confirm clean transition.
5. Repeat with master button locked on, to verify VPN-drop does *not* auto-resume.
6. Repeat with a deliberately broken pattern (e.g., `^xyz$`) to verify the detector-error confirmation modal works.
7. Persistence test: queue 2 messages while paused; force-kill app; reopen; verify queue restored (with `persistSessionContent=true`). Then with `false`; verify queue empty after restart and no on-disk file.
8. Restart-while-on-VPN test: connect VPN; quit app; relaunch; verify it comes up paused under `vpn` reason (fail-closed reconciliation).
9. Interceptor smoke test: with an Anthropic API key configured (if user has one), verify SDK calls are refused while paused.

### 9.4 Regression

- `instance-messaging.store` tests must continue to pass; we add cases, never modify existing.
- `instance-state-machine.spec.ts` — no change expected.
- All settings tests must compile with the extended `SettingMetadata.category` union and (if added) `'enum'` type.
- **CLI adapter specs (post-review):** template-method refactor must not regress behaviour. Each of `claude-cli-adapter.spec.ts`, `codex-cli-adapter.spec.ts`, `acp-cli-adapter.spec.ts`, `__tests__/adapter-factory*.spec.ts`, `__tests__/claude-cli-adapter.spec.ts` must continue to pass with the rename. Specs that mock or spy on `sendInput` (the public method) need no change. Specs that subclass an adapter to override `sendInput` (rare) need to override `sendInputImpl` instead — implementation plan must grep for any such cases before merge.
- **IPC contract integrity:** `npm run verify:ipc` and `npm run verify:exports` (existing scripts that run in `prebuild`) must pass after the channel/preload additions.

---

## 10. "Done" definition

1. All unit + integration tests pass; `npx tsc --noEmit` and `-p tsconfig.spec.json` clean; `npm run lint` clean.
2. `docs/pause-on-vpn.md` written: feature description, what it can't promise, calibration steps, interaction with `persistSessionContent`, detector-error recovery, residual surface (CLI child processes, raw sockets if any).
3. Audit step executed: provider-bound `http`/`https`/`fetch` paths either go through the allow-list or are covered by the interceptor; raw-socket residuals remain documented.
4. Manual playbook (§9.3) is documented for the user's actual VPN. If calibration finds a better default interface pattern later, that change should be committed separately with the captured detector evidence.

---

## 11. Files touched

**New files:**

- `src/main/network/install-network-pause-gate.ts`
- `src/main/network/vpn-detector.ts`
- `src/main/network/allowed-hosts.ts` (small helper — local-host matcher with private-range opt-in)
- `src/main/pause/pause-coordinator.ts`
- `src/main/pause/pause-persistence.ts`
- `src/main/pause/orchestrator-paused-error.ts`
- `src/main/ipc/handlers/pause-handlers.ts`
- `src/main/core/config/settings-validators.ts` *(post-review addition)*
- `packages/contracts/src/channels/pause.channels.ts`
- `packages/contracts/src/schemas/pause.schemas.ts`
- `src/preload/domains/pause.preload.ts` *(post-review addition)*
- `src/renderer/app/core/state/pause/pause.store.ts`
- `src/renderer/app/core/state/instance/queue-persistence.service.ts`
- `src/renderer/app/shared/components/pause-toggle/pause-toggle.component.ts`
- `src/renderer/app/shared/components/pause-banner/pause-banner.component.ts`
- `src/renderer/app/shared/components/detector-error-modal/detector-error-modal.component.ts`
- `src/renderer/app/features/settings/network-settings-tab.component.ts`
- `src/renderer/app/features/settings/pause-detector-events-dialog.component.ts`
- `docs/pause-on-vpn.md`

**Files modified:**

Main process:

- `src/main/index.ts` — initialise `PauseCoordinator` first; install network interceptor immediately; then initialise detector; register handlers; subscribe `InstanceManager`/`CrossModelReviewService`/`ProviderQuotaService`.
- `src/main/cli/adapters/base-cli-adapter.ts` — add concrete public `sendInput` template method + `protected abstract sendInputImpl`.
- `src/main/cli/adapters/claude-cli-adapter.ts` — rename `sendInput` → `sendInputImpl` (protected, `override`).
- `src/main/cli/adapters/codex-cli-adapter.ts` — same refactor.
- `src/main/cli/adapters/copilot-cli-adapter.ts` — same.
- `src/main/cli/adapters/gemini-cli-adapter.ts` — same.
- `src/main/cli/adapters/cursor-cli-adapter.ts` — same.
- `src/main/cli/adapters/acp-cli-adapter.ts` — same.
- `src/main/cli/adapters/remote-cli-adapter.ts` — **special case (NOT same refactor)**: extends `EventEmitter` directly, not `BaseCliAdapter`. Adds an explicit pause check at the top of the existing `sendInput(...)` method; does NOT rename to `sendInputImpl`. See §5.C "RemoteCliAdapter — special-case."
- `src/main/orchestration/cross-model-review-service.ts` — abort + skip-on-paused.
- `src/main/core/system/provider-quota-service.ts` + `src/main/core/system/provider-quota/*` — service-level pause flag gating all entry points (`refresh()`, `refreshAll()`, IPC handlers, auto-refresh-on-adapter-events); abort in-flight probe `AbortController`s on `pause`.
- `src/main/instance/instance-manager.ts` — pause/resume listener; interrupts.
- `src/main/instance/instance-communication.ts` — initial-prompt routing into renderer queue when paused.
- **`src/main/ipc/handlers/instance-handlers.ts`** — pause gate added at the top of the `INPUT_REQUIRED_RESPOND` handler (line 806), BEFORE the `deferred_permission` / `permission_denial` / generic branches. Covers all three permission-response paths: `resumeAfterDeferredPermission`, `selfPermissionGranter.grant`, and `sendInputResponse` (post-review).
- **`src/main/instance/instance-lifecycle.ts`** — initial-prompt error handling (lines 1273, 1363): catch `OrchestratorPausedError` separately, route message to renderer queue via new IPC, leave instance idle (instead of `transitionState(instance, 'failed')`).
- `src/main/core/config/settings-manager.ts` — `set()` and `update()` invoke validator from `settings-validators.ts` before persisting; throws on invalid (post-review).
- `src/main/ipc/handlers/settings-handlers.ts` — already wraps in try/catch and surfaces errors as `IpcResponse { success: false }`; no code change required, but tests must verify rejection messages (post-review).
- `src/main/core/config/settings-export.ts` — exclude `pause-state` and queue-persistence namespaces.

Contracts package and preload (post-review):

- `packages/contracts/src/channels/index.ts` — re-export `PAUSE_CHANNELS`, merge into `IPC_CHANNELS` aggregate.
- `src/main/ipc/handlers/index.ts` — re-export `registerPauseHandlers`.
- `src/main/ipc/ipc-main-handler.ts` — call `registerPauseHandlers(...)` from `registerHandlers()` (line 171).
- `src/main/ipc/handlers/instance-handlers.ts` — add `ipcMain.handle()` registrations for `INSTANCE_QUEUE_SAVE` and `INSTANCE_QUEUE_LOAD_ALL` backed by a dedicated `instance-message-queue` electron-store namespace; pause gate at top of the existing `INPUT_REQUIRED_RESPOND` handler (line 806) — covers `deferred_permission`, `permission_denial`, and `sendInputResponse` branches.
- `packages/contracts/src/channels/instance.channels.ts` — add `INSTANCE_QUEUE_SAVE`, `INSTANCE_QUEUE_LOAD_ALL`, `INSTANCE_QUEUE_INITIAL_PROMPT` constants (these are instance-scoped, not pause-scoped).
- `packages/contracts/src/schemas/instance.schemas.ts` — add `QueuedMessageSchema`, `InstanceQueueSavePayloadSchema`, `InstanceQueueLoadAllResponseSchema`, `InstanceQueueInitialPromptPayloadSchema`.
- `packages/contracts/package.json` — `exports` map: add `./channels/pause` and `./schemas/pause` subpath entries (instance channels/schemas already exported, no new subpath there).
- `src/preload/preload.ts` — import + compose `createPauseDomain`.
- `src/preload/domains/pause.preload.ts` — new file (already listed under New files).
- `src/preload/domains/instance.preload.ts` — add `invoke` methods for `INSTANCE_QUEUE_SAVE` and `INSTANCE_QUEUE_LOAD_ALL`; add `on` listener for `INSTANCE_QUEUE_INITIAL_PROMPT`.
- `src/renderer/app/core/services/ipc/instance-ipc.service.ts` — typed wrappers for the three new instance-queue IPC methods.
- `src/preload/generated/channels.ts` — auto-regenerated by `npm run generate:ipc` (runs in prestart/prebuild). No manual edit; file changes as a side-effect of channels-index update.
- `src/main/register-aliases.ts`, `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts` — new contract subpaths.

Shared types:

- `src/shared/types/settings.types.ts` — 8 new keys + `SettingMetadata.category` extension; `SettingMetadata.type` may need `'enum'` (or implementation can reuse `'select'`).

Renderer:

- `src/renderer/app/core/state/instance/instance-messaging.store.ts` — `processMessageQueue` gate (covers ALL drain paths); extended `getRetryDisposition`; pause check in `sendInput`.
- `src/renderer/app/core/state/settings.store.ts` — `networkSettings` computed.
- `src/renderer/app/features/settings/settings.component.ts` — tab union, NAV_ITEMS, switch case, imports.
- `src/renderer/app/app.component.html` — pause-banner + pause-toggle slots; banner stacking.
- `src/renderer/app/app.component.ts` — pause store init.

Build:

- `package.json` — add `safe-regex` (or equivalent) runtime dep.

**Files NOT modified — the interceptor (Layer 3) gates outbound traffic transparently:**

- `src/main/rlm/llm-service.ts`, `src/main/rlm/hyde-service.ts`, `src/main/rlm/embedding-service.ts`, `src/main/orchestration/embedding-service.ts`, `src/main/indexing/reranker.ts`, `src/main/providers/model-discovery.ts` (uses `protocol.get` — gated by `http.get`/`https.get` patches), `src/main/providers/provider-doctor.ts`, `src/main/providers/anthropic-api-provider.ts` (uses Anthropic SDK — gated by `globalThis.fetch` patch), `src/main/workspace/semantic-search.ts` (uses `https.request` to Exa — gated), `src/main/core/system/health-checker.ts`, `src/main/memory/context-editing-fallback.ts`, `src/main/hooks/enhanced-hook-executor.ts`, `src/main/hooks/executor/hook-prompt.ts`, `src/main/core/config/remote-config.ts` (uses `protocol.get` — gated). **No code changes in these files.**

---

## 12. Open / deferred

- v1.5: default-route inspection (third detection signal).
- v1.5: encryption-at-rest for persisted queue contents (`safeStorage` consistency permitting).
- v1.5: persisting attachments alongside queued messages.
- v1.5: Strict mode that hibernates CLI processes on pause.

---

## 13. Review reconciliation log

Two cross-model review rounds have been consumed.

### Round 1 (2026-04-27, 19 items)

(Previous reconciliation; all items addressed in this revision.)

### Round 2 (2026-04-28, ~30 items)

Triage:

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 | `processMessageQueue` from batch-updates not gated | Accepted — gate moved into `processMessageQueue` itself; covers watchdog, batch-update, and retry paths (§5.A) |
| 2 | Initial-prompt sites bypass `InstanceCommunication.sendInput` | Accepted — gate moved to `BaseCliAdapter.sendInput` (§5.C); 14+ direct call sites enumerated |
| 3 | `AnthropicApiProvider`, consensus, multi-verify, plugins not covered | Accepted — Layer 3 interceptor covers SDK and any future site that uses Node HTTP primitives or globalThis.fetch (§5.G) |
| 4 | VPN-down pseudocode bug (baseline = current breaks 2-tick logic) | Accepted — algorithm rewritten with `activeVpnIfaces` as separate state; baseline never updated post-startup (§3) |
| 5 | `providerFetch` insufficient for `https.request`, SDK, plugins | Accepted — replaced by network interceptor (§5.G) |
| 6 | Quota refresh has multiple entry points | Accepted — service-level pause flag gates all entry points; in-flight aborts (§5.F) |
| 7 | `pauseOnVpnEnabled` lifecycle underspecified | Accepted — §4 spells out toggle-while-paused, toggle-on, etc. |
| 8 | Probe lacks polarity/mode | Accepted — `pauseReachabilityProbeMode` enum added (§3, §6.1) |
| 9 | Startup-while-VPN default false weakens safety | Accepted — `pauseTreatExistingVpnAsActive` default changed to `true` (§6.1, §3) |
| 10 | SDK/CLI provider paths uncovered | Accepted — interceptor covers SDK; CLI child processes documented as Layers 1–2 territory (§1, §5.G) |
| 11 | Plain-JSON queue persistence at-rest sensitivity | Accepted — gated by `persistSessionContent`; documented (§5.B, §6.5) |
| 12 | Diagnostics may record URLs/secrets | Accepted — privacy-aware logging: hostname only, never URLs/headers/body (§3 diagnostic mode, §6.6) |
| 13 | Probe contradicts itself (fallback vs AND-only) | Accepted — explicitly OR-ed; AND-only language removed (§3) |
| 14 | Audit returned wrong list (missing Gemini/Mistral/Groq/Exa/SDK) | Resolved — interceptor approach renders enumeration unnecessary; audit step kept as final QA (§10) |
| 15 | "No messages lost" vs dropped attachments | Accepted — content loss for attachments is explicit; recovery flow documented (§5.B, §6.5, §7.5) |
| 16 | `getRetryDisposition` shape claim wrong | Accepted — actual shape is `{shouldRetry, nextStatus?}`; spec corrected (§5.A) |
| 17 | Fail-closed restart undermined | Accepted — first-scan-force-vpn flag added to coordinator persistence (§4) |
| 18 | Probe AND-only contradicts fallback role | Accepted — same as #13 |
| 19 | Audit factually incomplete (Gemini/Mistral/Groq) | Resolved — same as #14 |
| 20 | Outbound audit misses real branches | Resolved — same as #14 |
| 21 | Search labelled local but Exa is external | Accepted — semantic-search Exa documented as covered by interceptor (§5.G); not enumerated separately because interceptor is universal |
| 22 | Queue persistence vs `persistSessionContent` | Accepted — gated (§5.B, §6.5) |
| 23 | Persisting unsent messages creates new at-rest exposure | Accepted — gated by `persistSessionContent`; encryption-at-rest deferred to v1.5 with explicit statement (§6.5, §12) |
| 24 | Encryption deferred without present-day safeguard | Partially accepted — present-day safeguard is the existing `persistSessionContent=false` path (queue stays in-memory). Encryption deferred for v1.5; documented (§6.5, §12) |
| 25 | Probe role contradiction | Resolved — same as #13 |
| 26 | Audit doesn't match repo state | Resolved — same as #14 |

All Round 2 issues either accepted (with concrete spec changes) or resolved (rendered moot by the architectural shift to the interceptor). No outright pushbacks this round.

### Round 3 (2026-04-28, 6 items — all P1/P2)

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P1) | `BaseCliAdapter` has no `sendInput`; subclasses each define their own; adding to base is shadowed | Accepted — explicit template-method refactor across all 7 adapters spelled out (§5.C). New protected `sendInputImpl` abstract on base; gate lives on the new concrete public `sendInput`. Test-impact list included. |
| 2 (P1) | `http.get` / `https.get` bypass interceptor; `remote-config.ts:124` uses `protocol.get` | Accepted — interceptor extended to patch `.get` variants; rationale documented (§5.G). Tests cover all five patched primitives. |
| 3 (P1) | Detector misses VPN reconnects after startup-on-VPN; `treatExistingAsVpn=true` had no init effect | Accepted — algorithm rewritten with separate `activeVpnIfaces` / `knownNonVpnIfaces` state; init seeds `activeVpnIfaces` when `treatExistingAsVpn=true`; gone interfaces removed from tracking so reconnects work (§3). |
| 4 (P2) | Probe-only pause has no resume path; pseudocode only emits `vpn-down` inside `goneMatches` | Accepted — algorithm uses `interfaceSignalActive || probeSignalActive` aggregate with idempotent emit; `recomputeAggregateAndEmit()` called by both interface and probe paths (§3). |
| 5 (P2) | Corrupted persistence treated as running, contradicting fail-closed | Accepted — corrupted ≠ missing. Corrupted starts paused under `detector-error`; missing (first launch) stays running. Distinction made explicit in §4 startup table and §8 failure matrix. |
| 6 (P2) | IPC integration incomplete: channels-index, package.json exports, preload domain | Accepted — full integration enumerated in §2 IPC contracts subsection and §11 files-modified list (`packages/contracts/src/channels/index.ts` re-export, `package.json` `exports` map, new `src/preload/domains/pause.preload.ts`, preload composition). |

No pushbacks this round either. All six items represented genuine defects against the codebase.

### Round 4 (2026-04-28, user request — kill switch)

| # | Item | Disposition |
|---|---|---|
| 1 | "needs to be fully able to be turned off and on in settings… don't want it half implemented and just breaking everything and causing all kinds of timeouts" | Accepted — added master kill-switch `pauseFeatureEnabled` (default `true`) that fully removes the feature from the running process when off: no interceptor installed, no detector polling, no listeners, queue reverts to in-memory. Toggle is no-restart. Documented in §1, §4, §5.G, §6.1, §7.6, §8 (failure modes), §9.1 + §9.2 (tests). |

### Round 5 (2026-04-28, 6 items — 1 P1 + 5 P2)

All six items verified against the codebase before changes; line and file evidence captured during this round.

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P1) | Initial-prompt error-handling at `instance-lifecycle.ts:1273,1363` calls `transitionState(instance, 'failed')` on ANY error — including `OrchestratorPausedError`. Also a duplicate-bubble risk on replay vs the seeded initial message. | Accepted — §5.C extended: catch `OrchestratorPausedError` separately at both call sites, route to renderer queue with `seededAlready: true` flag so drain doesn't re-render the bubble. New IPC `INSTANCE_QUEUE_INITIAL_PROMPT`. Tests added in §9.2. |
| 2 (P2) | Queue IPC channels (`INSTANCE_QUEUE_*`) lack the same contract/preload integration as PAUSE channels. | Accepted — §5.B expanded: explicit constants in `instance.channels.ts`, schemas in `instance.schemas.ts`, preload domain wiring in `instance.preload.ts`, renderer IPC service additions, `verify:ipc` coverage. |
| 3 (P2) | Automation deferral claimed but `automation-runner.ts` not in file list. | Accepted — fix is transitive via §5.C (the initial-prompt fix covers automation since automation calls `manager.createInstance({ initialPrompt })`). No code change in `automation-runner.ts`; explicit test added (§9.2 "Automation-while-paused"). Failure-modes matrix row updated to spell this out. |
| 4 (P2) | Settings validation not wired — current schema accepts `value: z.unknown()`; my "main-side authoritative" claim was unbacked. | Accepted — §6.3 expanded: new `src/main/core/config/settings-validators.ts`; `SettingsManager.set()`/`update()` invoke validator; existing `settings-handlers.ts` already surfaces errors as `IpcResponse { success: false }`. New unit-test file. |
| 5 (P2) | Quota stale flag — `ProviderQuotaSnapshot` has no `stale` field. | Accepted — use existing `ok: false` + `error: 'orchestrator-paused'` semantics with prior `windows`/`plan` preserved. No new shared-type fields needed. §5.F updated; failure-modes matrix updated. |
| 6 (P2) | Permission responses use `sendRaw`, not `sendInput`; my adapter gate doesn't catch them. | Accepted — added pause check at top of `InstanceCommunication.sendInputResponse` (`instance-communication.ts:798`); renderer permission-prompt UI shows resume hint on `OrchestratorPausedError`; not queued (no UI queue exists for permissions). Failure-modes matrix updated; test added §9.2. |

No pushbacks Round 5. All six were genuine codebase-verified defects.

### Round 6 (2026-04-28, 7 items — 3 P1 + 4 P2)

All seven items verified against the codebase before changes; line and file evidence captured during this round.

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P1) | `RemoteCliAdapter` extends `EventEmitter` not `BaseCliAdapter`; template-method refactor doesn't apply | Accepted — verified at `remote-cli-adapter.ts:51`. Special-case noted in §5.C: explicit pause check inside `RemoteCliAdapter.sendInput` rather than refactoring its base class. Test added (§9.2 "RemoteCliAdapter pause"). |
| 2 (P1) | `INPUT_REQUIRED_RESPOND` has `deferred_permission` and `permission_denial` branches that bypass `sendInputResponse` | Accepted — verified at `instance-handlers.ts:806-880`. Pause check moved to **top of the IPC handler** (before any branching). Failure-modes matrix updated; §11 modifies `instance-handlers.ts`; test extended (§9.2). |
| 3 (P1) | First-scan reconciliation can resume before probe runs (probe-only configs after restart-on-VPN) | Accepted — §4 reconciliation rule extended with `probeKnown` flag; coordinator defers final decision until probe is known when probe is configured. New state-var added to detector; test added (§9.2 "Restart-with-probe-only-config"). |
| 4 (P2) | New IPC handlers need registration in `IpcMainHandler` and re-export from `handlers/index.ts`; queue handlers need `ipcMain.handle()` registrations backed by electron-store | Accepted — verified at `ipc-main-handler.ts:171` and `handlers/index.ts:6-24`. §2 (IPC integration) and §11 (file list) extended: re-export `registerPauseHandlers`; invoke from `IpcMainHandler.registerHandlers()`; queue handlers added to existing `instance-handlers.ts` factory; pause check inside `INPUT_REQUIRED_RESPOND`. |
| 5 (P2) | `import * as http` is readonly under strict TS; `http.request = patched` won't compile | Accepted — verified at `tsconfig.electron.json:strict, esModuleInterop`. Interceptor pseudocode rewritten in §5.G to use `Writable<T>` mapped-type cast. Originals saved unbound (not via `.bind()`) for verbatim restoration. Identity-equality test added. |
| 6 (P2) | `provider-quota-chip.component.ts:166` uses `firstOkSnapshot()` filtering for `ok: true`; `ok: false` snapshots are ignored | Accepted — quota strategy changed in §5.F: during pause, **do not emit a new snapshot at all**. Cached `ok: true` snapshot remains; UI unchanged. Failure-modes matrix updated; tests updated to match. |
| 7 (P2) | Probe non-affirmative debounce specified in prose ("2 consecutive intervals") but pseudocode just sets `probeSignalActive = affirmative` | Accepted — pseudocode rewritten with `probeNonAffirmativeCount`; single non-affirmative does NOT clear the signal; two consecutive do; affirmative resets the counter. Test case added. |

No pushbacks Round 6. All seven were genuine codebase-verified defects.

### Round 7 (2026-04-28, 5 items — 1 P1 + 3 P2 + 1 P3)

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P1) | `recomputeAggregateAndEmit` could fire spurious `vpn-down` during init when probe is configured but `probeKnown=false` | Accepted — added explicit guard to suppress emits during the unknown phase; explicit `lastEmittedVpnUp = false` initialisation. Test added. |
| 2 (P2) | `QueuedMessageSchema` and `InstanceQueueInitialPromptPayloadSchema` both included `attachments`; `FileAttachment.data` is a base64 data URL — would persist binary user content | Accepted — added separate `PersistedQueuedMessageSchema` (no attachment data; only `hadAttachmentsDropped` flag); `INSTANCE_QUEUE_SAVE` payload uses persisted schema; in-memory→on-disk translation lives in `queue-persistence.service.ts`; test asserts no `data:` URLs in saved payloads. |
| 3 (P2) | Renderer-only privacy gate; main handler doesn't enforce `persistSessionContent` | Accepted — defense in depth: main `INSTANCE_QUEUE_SAVE` handler also checks `persistSessionContent`; returns no-op success on save when off; returns empty `{queues:{}}` on load. Toggling setting `true→false` clears the on-disk file. New `instance-queue-handlers.spec.ts` test file. |
| 4 (P2) | RemoteCliAdapter example used `this.spawned`; actual code uses `remoteInstanceId`. File-list also still claimed remote got the same template-method refactor | Accepted — example updated to use `remoteInstanceId` (verified at `remote-cli-adapter.ts:160`); §11 file list now explicitly says "special case (NOT same refactor)" for remote-cli-adapter. |
| 5 (P3) | Intro to `pauseOnVpnEnabled` lifecycle said "does not affect already-active vpn reasons retroactively" but the toggle bullet does exactly that | Accepted — removed the contradictory intro phrase; the toggle bullet is the canonical behaviour. |

No pushbacks Round 7. All five were verified codebase-anchored defects.

### Round 8 (2026-04-28, 4 items — 3 P2 + 1 P3)

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P2) | Seeded prompt replay sends `isRetry=false` when `retryCount=0`; main re-adds the user bubble at `instance-manager.ts:1266-1268,1276-1278` | Accepted — concrete wiring spelled out: runtime queue type extended with `seededAlready`; renderer drain maps it to `skipUserBubble = true`; `sendInputImmediate` passes that to IPC's 4th `isRetry` argument; main's existing `if (!options?.isRetry)` gate suppresses the duplicate. Test added. |
| 2 (P2) | Quota service stores only timer handles, not intervals; clearing on pause loses the value with no way to re-arm on resume | Accepted — strategy changed to "leave timers installed; tick calls `refresh()` which no-ops while `isPaused`." Avoids the lost-interval class of bug. `QUOTA_SET_POLL_INTERVAL` while paused still updates the interval. |
| 3 (P2) | "Probe targets never recorded in logs/diagnostics" was ambiguous because `pauseReachabilityProbeHost` is a persisted user setting and flows through `settings:export` | Accepted — wording corrected to "stored as a normal user setting; never written to detection logs / ring buffer / refusal-log entries." Settings page note updated. No change to export behaviour (settings export remains user-driven). |
| 4 (P3) | Top-level safety summary listed only `fetch`/`request`, missing `.get` variants that the detailed §5.G now covers | Accepted — §1 list and §2 architecture diagram updated to include `.get` variants. Audit criteria now consistent. |

No pushbacks Round 8. All four verified.

### Round 9 (2026-04-28, user reminder — seamless resume)

User: *"bear in mind what's really important about the pause is that it seamlessly resumes."*

This was a focus reminder rather than a list of defects. Acted on it by:

- **§8 added "Seamless-resume guarantees" subsection** — codifies the resume contract: latency budget (~6 s worst case), what is preserved, what is lost (with rationale), auto-resume preconditions (strict AND), manual-resume preconditions, drain ordering (insertion order, no thundering-herd), UI return-to-baseline, and the single intentional friction point (detector-error confirmation modal).
- **§7.3 toast suppression for N=0** — silent resume is more seamless than an empty notification.
- **Test plan extended** with four explicit "seamless resume" integration tests (in §8 subsection): drain ordering, N=0 silence, long-pause CLI revival, multi-instance fan-out.

No spec contradictions introduced. All other rounds' fixes remain compatible with the seamless-resume contract — verified by re-reading §5 (subsystem hooks all reuse existing primitives that were already designed for clean recovery), §4 (reason refcount cleanly removes single reasons without affecting others), and §3 (detector emits well-defined `vpn-down` exactly once per real transition).

### Round 10 (2026-04-28, 2 P2 — drift in normative sections)

The reviewer caught two cases where R8 corrections were applied to the *explanatory* prose but the older *normative* directive bullets above them still carried the original (now-wrong) instructions. An implementer reading top-down would hit the wrong instruction first.

| # | Item (paraphrased) | Disposition |
|---|---|---|
| 1 (P2) | §5.F still said "clear the polling interval" on pause despite the §5.F detailed strategy below saying "leave timers installed" | Accepted — directive bullet rewritten to match: set `isPaused`, abort in-flight probes, **leave timers installed**. Cross-reference to the rationale below. |
| 2 (P2) | §6.6 still listed "Probe target hosts/ports" under "never stored" despite the R8 correction acknowledging they're persisted as a normal user setting | Accepted — §6.6 rewritten: split "stored as normal user settings" from "never logged in detection diagnostics, refusal logs, or the ring buffer." Probe targets explicitly under stored-local. The privacy guarantee is now consistent: it's about logs, not about the user's own settings.json. |

No pushbacks Round 10. Both were stale-directive-vs-correct-rationale drift from R8.

### Self-audit (post-Round 5, before declaring spec done)

After Round 5 fixes, ran a final consistency pass — searched for:

- **Stale references to "providerFetch"** (the wrapper from a prior draft): 4 mentions remain, all in §13 reconciliation log describing the historical decision; no live reference. ✓
- **Claims about specific file/line numbers**: each cited line was re-checked against the codebase during this round (instance-lifecycle.ts:1273, 1363; instance-communication.ts:798, 830-831; settings-handlers.ts:114, 124-131; settings.schemas.ts:10-12; provider-quota.types.ts:75-94; remote-config.ts:124; base-cli-adapter.ts:226-356; instance.store.ts:302, 389; node_modules/@anthropic-ai/sdk/internal/shims.js getDefaultFetch). ✓
- **Bare `requeue` references** (the invented field from a prior draft): 0 in normative text; 1 in a code comment marking the historical mistake. ✓
- **"verified at implementation time" / TBD / TODO**: 0. ✓
- **Section cross-references** (§N.X): all targets exist. ✓
