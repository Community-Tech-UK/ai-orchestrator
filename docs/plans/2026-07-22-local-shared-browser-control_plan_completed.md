# Local + remote shared-browser control — implementation plan

**Status:** code complete. All five phases implemented and verified in-loop.
Live validation is deferred to
[2026-07-22-local-shared-browser-control_livetest.md](./2026-07-22-local-shared-browser-control_livetest.md).

| Phase | Scope | State |
|---|---|---|
| 1 | Local channel parity, health, fast-fail | **done, verified** |
| 2 | Semantic action classification (both classifiers) | **done, verified** |
| 3 | Computer Use window activation | **done, verified** |
| 4 | Deferred tool-reveal durability | **done, verified** |
| 5 | Preflight selection, capability check, docs, e2e fixture | **done, verified** |

Gates: `tsc --noEmit` clean, `tsc -p tsconfig.spec.json` clean, `npm run lint` clean,
`npm run check:ts-max-loc` clean, `npm run test:quiet` **15321 tests across 1551 files**.
Builds: `build:desktop-helper`, `build:aio-mcp-dist`, `build:worker-dist`, `build:main` all
succeed. The Chrome extension source was not modified, so it needs a reload but not a repackage.

**Not verified, by design:** anything needing a rebuilt/restarted app, a human sharing a real
Chrome tab, a real multi-window macOS app, or `windows-pc`. All eight such checks are recorded
in the livetest doc with exact steps and expected results.

**Created:** 2026-07-22
**Brief:** `local-shared-browser-control_prompt.md` (repo root, untracked)

Canonical live task: withdraw from one ProContract tender so its notifications stop,
with an action-time approval immediately before the unsubscribe/withdraw mutation.

---

## 1. Reproduced failures and evidence

### 1.1 The local extension channel has no contact tracking at all (primary)

`BrowserExtensionContactState.markExtensionContact()` is called from exactly one
place in main code:

- `src/main/browser-gateway/remote-extension-bridge.ts:239` — `markExtensionContact(nodeId, …)`

Verified by `rg -n "markExtensionContact" --glob '!*.spec.ts'`: the only other hit is
the declaration at `browser-extension-contact-state.ts:74`.

The **local** extension channel reaches the app over a different path —
`browser-extension-native-host.ts` → unix socket → `BrowserGatewayRpcServer` — and
none of its handlers record contact:

- `browser-gateway-rpc-server.ts:349` `handleExtensionAttachTab`
- `browser-gateway-rpc-server.ts:362` `handleExtensionPollCommand`
- `browser-gateway-rpc-server.ts:371` `handleExtensionCommandResult`
- `browser-gateway-rpc-server.ts:379` `handleExtensionCommandReceived`

Only the **disconnect** side is tracked for local, under the reserved id `'local'`
(`browser-gateway-rpc-server.ts:120-122`). So the coordinator records when the local
channel dies but never when it is alive.

Consequences, all matching the observed evidence:

- `browser.health` has no local-extension section whatsoever. `getRemoteExtensionHealth()`
  (`browser-health-service.ts:394-446`) enumerates `workerNodeRegistry.getAllNodes()` only.
- `find_or_open { computer: "local" }` has **no freshness precheck**. The precheck at
  `browser-target-discovery-operations.ts:277-288` is guarded by `if (target.nodeId && …)`,
  which is false for `localOnly`. The call therefore goes straight to `sendCommand` with
  `undeliveredWaitMs: BROWSER_EXTENSION_CHANNEL_RECOVERY_WAIT_MS` (90 s,
  `browser-extension-command-store.ts:49`) before failing
  `browser_extension_command_not_delivered`. That is the ~90 s wait in the brief.
- `list_targets` cannot distinguish "no local extension installed", "installed but not
  polling", and "healthy, nothing shared" — all three return `data: []`. The one honesty
  hook that exists, `describeInventoryRefreshFailures()`
  (`browser-gateway-refresh-support.ts:67-83`), **deliberately suppresses** local refresh
  failures unless local extension targets are already cached (`reportLocalFailure` requires
  `targets.some(t => t.driver === 'extension' && !t.nodeId)`). With zero shared tabs that
  is always false, so a dead local channel reports as a clean empty list.

### 1.2 Native-host stale-socket outage (contributing, evidence on disk)

`~/Library/Application Support/harness/browser-gateway/native-host/native-host-error.log`
contains repeating entries, e.g. a ~40-minute block on 2026-07-10:

```
[2026-07-10T09:16:11.473Z] socket connect failed: connect ENOENT …/harness/bg-a9332208ea82.sock
… (repeats every ~2.5 min through 09:54) …
[2026-07-19T17:52:17.097Z] socket connect failed: connect ENOENT …/harness/bg-33c71cc41e67.sock
```

Each app start writes a **new random socket path** into `runtime.json`
(`browser-gateway/index.ts:223-249` → `prepareBrowserExtensionNativeHostRuntime`). The
native host reads `runtime.json` **once at process start**
(`browser-extension-native-host.ts:205-221`). A native-host process that outlives an app
restart therefore holds a dead socket path and every RPC fails, while Chrome still shows
the port as connected. From the coordinator's side this is indistinguishable from
"extension not installed" — exactly the reported symptom.

Current local state on this Mac is healthy (manifest → wrapper → `runtime.json` →
socket all present and the socket exists), so the outage is intermittent, not permanent.

### 1.3 Word-substring action classification (two independent classifiers)

**Computer Use** — `src/main/desktop-gateway/desktop-input-controller.ts:630-639`:

```ts
const description = [candidate.role, candidate.label, candidate.value]
  .filter(Boolean).join(' ').toLowerCase();
return /…|payment|purchase|…|delete|…|send|post|publish|sign\s*in|…|submit|confirm|…/.test(description);
```

A navigation link labelled `PA23 - 07A - Publish Tender Pack (Auto Invite)` matches
`publish` and is blocked as `computer_use_sensitive_action_blocked`, regardless of its
`role` being `AXLink`.

**Browser Gateway** — `src/main/browser-gateway/browser-action-classifier.ts:130-140,282-290`
has the same defect: `SUBMIT_WORDS` contains `publish`, `invite`, `send`, `review`, and
`DESTRUCTIVE_WORDS` contains `delete`, `price`, `security`. `textFromContext()`
(`:292-312`) flattens role, name, visible text, attributes and nearby text into one
string and `hasAny()` does a bare `includes()`. The same breadcrumb classifies as
`submit` on the browser path too.

Both classifiers have the signals needed to do better but ignore them:
`BrowserElementContext` carries `role`, `formAction` and `attributes`
(`packages/contracts/src/types/browser.types.ts:138-149`); `DesktopElementCandidate`
carries `role` (`src/shared/types/desktop-gateway.types.ts:276-285`).

### 1.4 No way to foreground an observed window (Computer Use)

`computer_use_target_not_active` is produced by the bundled Swift helper and mapped at
`src/main/desktop-gateway/platform/darwin-helper-client.ts:366-367`. It is thrown by
`assertTargetActive()` (`resources/desktop-helper/DesktopHelper.swift:257-263`) and
`requireRequestedWindowActive()` (`:265-276`), which require the target app to be
frontmost and the requested window to be the app's first (frontmost) window.

The helper command set (`platform/desktop-helper-protocol.ts:15-24`) is
`health | requestAccessibility | listApps | accessibilitySnapshot | click | typeText |
hotkey | scroll | drag`. There is **no** activate/raise command, and no MCP tool for it
(`desktop-mcp-tools.ts:7-25`). Observations already carry `windowId`
(`desktop-observation-store.ts:11-18`), so the data exists — only the operation is missing.

Swift source is in-repo (`resources/desktop-helper/DesktopHelper.swift`), `swiftc` 6.3.3
is available, and `npm run build:desktop-helper` exists, so this is implementable.
Note `desktop-helper-protocol.ts:132` rejects on protocol-version **inequality**, so a
version bump couples the helper and app rebuilds.

### 1.5 Deferred tool reveal is not durable

- Reveal state lives in an in-memory `Map` in the parent, keyed by `instanceId`
  (`browser-tool-reveal-store.ts:36-63`). Not persisted — lost on app restart.
- On forwarder restart, `fetchPreviouslyRevealedToolNames()`
  (`browser-mcp-stdio-server.ts:28-49`) restores the set, but a **1.5 s timeout silently
  degrades to `[]`** (`:31-33`, `:48`), dropping the whole revealed surface with no error.
- Hidden tools remain dispatchable (`browser-mcp-deferral.spec.ts:139-151`), so a lost
  reveal is a *visibility* failure, not a capability failure.

### 1.6 Skills referencing `node_repl` are not in this repo

`rg -c "control-chrome|node_repl|browser-client.mjs|computer-use-client.mjs"` over the
repo (excluding `node_modules`) matches **only** `local-shared-browser-control_prompt.md`.
No `node_repl` tool, no `chrome:control-chrome` / `computer-use:computer-use` skill source,
and no such skills installed under `~/.claude/plugins` or `~/.codex/skills`.

The skills in the observed evidence therefore come from the **agent CLI's own plugin
environment**, not from AIO. AIO cannot edit them. What AIO *can* own is a startup
capability check plus first-party skills that use the managed tools.

---

## 2. Traced end-to-end architecture

**Local Mac.** Chrome + Harness extension (`resources/browser-extension`, v0.2.1) runs two
native bridges (`background.js:1-5`): `com.ai_orchestrator.browser_gateway` (kind `local`)
and `…_relay` (kind `relay`). The local bridge → `aio-mcp native-host`
(`browser-extension-native-host.ts`) → unix socket → `BrowserGatewayRpcServer` →
`BrowserExtensionCommandStore` queue key `'local'`
(`browser-extension-command-store.ts:151`).

**Remote worker.** Same extension, relay bridge → `worker-extension-relay.ts` → WebSocket →
`remote-extension-bridge.ts` (which *does* call `markExtensionContact`) → command store
queue key `node:<nodeId>` (`browserExtensionQueueKeyForNode`).

**Routing.** `resolveBrowserComputerTarget()` (`browser-computer-target.ts:32-104`) maps
`computer: "local"` → `{ localOnly: true }` and a node name → `{ nodeId }`.
`matchesBrowserComputerTarget()` (`:106-114`) treats `localOnly` as "descriptor has no
nodeId". So local **is** already a first-class route; it is the health, freshness and
error-reporting layers that are node-only.

**Agent surface.** `aio-mcp browser-gateway` / `aio-mcp computer-use` SEA subcommands
(`src/main/mcp/aio-mcp-dispatcher.ts`) stdio-forward to those RPC servers; configs are
injected per spawn by `src/main/instance/lifecycle/spawn-config-builder.ts`.

---

## 3. Root causes

| # | Root cause | Site |
|---|---|---|
| R1 | Local extension contact is never recorded | `browser-gateway-rpc-server.ts:349-387` |
| R2 | Health reports only worker nodes | `browser-health-service.ts:394-446` |
| R3 | `find_or_open` freshness precheck is `nodeId`-gated | `browser-target-discovery-operations.ts:277-288` |
| R4 | Local refresh failures suppressed when no tabs cached | `browser-gateway-refresh-support.ts:72-73` |
| R5 | Native host caches `socketPath` for process lifetime | `browser-extension-native-host.ts:205-221` |
| R6 | Substring classifier ignores role/destination (Computer Use) | `desktop-input-controller.ts:630-639` |
| R7 | Substring classifier ignores role/destination (Browser) | `browser-action-classifier.ts:130-140,282-290` |
| R8 | No window-activation operation anywhere in the stack | `DesktopHelper.swift`, `desktop-helper-protocol.ts:15-24` |
| R9 | Reveal store is in-memory; restore degrades silently to `[]` | `browser-tool-reveal-store.ts:36-63`, `browser-mcp-stdio-server.ts:31-48` |
| R10 | No skill/tool-surface capability check | (absent) |

---

## 4. Change set, risks, tests

Phases are ordered so each is independently verifiable and shippable.

### Phase 1 — Local channel parity, health and fast-fail (R1–R4) — **DONE**

As built:

- `browser-extension-contact-state.ts`: added `BROWSER_LOCAL_EXTENSION_CHANNEL_ID`
  (`'local'`, matching the command store's default queue key) plus
  `markExtensionRuntime()` / `getExtensionRuntime()` so the extension's self-reported
  version and service-worker start time are retained for the local channel.
- `browser-gateway-rpc-server.ts`: every authenticated local extension message
  (`attach_tab`, `poll_command`, `command_result`, `command_received`) now records contact
  and build evidence via a new injectable `onExtensionContact`. `extension_disconnected`
  deliberately does **not** — a disconnect is not proof of liveness. Contact is recorded
  only after token auth passes.
- New `browser-local-extension-health.ts`: probes manifest ownership → wrapper →
  `runtime.json` → socket and resolves one of `unknown | not_installed |
  registration_broken | silent | ready`, with a per-state remediation string. Exposes
  `isLocalExtensionChannelProvablyDown()` (true only for `not_installed` /
  `registration_broken`) so a merely `silent` channel still gets the recovery wait it was
  designed for. The user-data path comes from a provider set by
  `initializeBrowserGatewayRuntime`, so the module never reaches for `electron.app` and
  degrades to `unknown` (never a false failure) when unset.
- `browser-health-service.ts`: `localExtension` is now a required field on every report,
  and a degraded-but-installed local channel raises a warning.
- `browser-target-discovery-operations.ts`: `find_or_open` fails fast with
  `browser_local_extension_unreachable` + the exact repair (in `reason`, which is what the
  agent actually sees) instead of burning the 90 s wait; `confirmExistingCandidate` skips
  the pointless local refresh; `list_targets` appends a degraded-local-channel sentence so
  an empty list is no longer ambiguous — while staying silent for a healthy channel and
  for a never-installed one unless local was explicitly requested.

Tests: `browser-local-extension-health.spec.ts` (7), `browser-gateway-local-channel.spec.ts`
(6), 2 new cases in `browser-gateway-rpc-server.spec.ts`.

### Phase 1 (original scope)
- Record local extension contact + version on every inbound local extension RPC.
- Add a `localExtension` block to `BrowserGatewayHealthReport`: installed / registered /
  polling / lastContactAt / contactAgeMs / queue / extensionVersion / sharedTabCount /
  lastDisconnect / remediation.
- Fast-fail `localOnly` `find_or_open` when the channel is provably silent, with an exact
  repair string instead of a 90 s wait.
- Make `list_targets` report a degraded local channel distinctly from "healthy, nothing
  shared", without falsely alarming machines that never had a local extension.

*Risk:* false "not polling" on a machine whose extension is healthy but idle — mitigated by
keying off the same 90 s freshness window the remote path already uses, and by only
fast-failing when there has been **no** contact ever or contact is stale.
*Tests:* contact-state, health-service, discovery-operations, refresh-support specs.

### Phase 2 — Semantic action classification (R6, R7) — **DONE**

As built:

- `browser-action-classifier.ts`: a semantic gate runs after every hard stop and before
  the keyword pass. An element is downgraded to `navigate` only on positive proof — link
  role **and** a navigable `href` **and** no `formAction` — and never when its own
  name/text/destination contains an effectful word. Absence of evidence keeps the old
  gated behaviour.
- `desktop-input-controller.ts`: the single flat regex is split into
  `ALWAYS_SENSITIVE_PATTERN` (secrets/payment/elevation, any role),
  `STATE_CHANGE_PATTERN` (checked against label **and** destination, never exemptible) and
  `COMMAND_ACTION_PATTERN` (exemptible only by a provable navigation link).
- New signal: the Swift helper now emits `url` from `kAXURLAttribute`, threaded through
  `DesktopAccessibilityNode` → `DesktopElementCandidate`. Additive and
  backward-compatible — no protocol-version bump — and an older helper that omits `url`
  simply never earns the exemption.

**Under-gating found and fixed while writing the adversarial tests:** `unsubscribe`,
`opt out` and `withdraw` matched *no* pattern in either classifier, so the final and most
consequential step of the ProContract journey classified as ordinary `input` and would
have run under a plain input grant. Both classifiers now gate them (browser: added to
`DESTRUCTIVE_WORDS`; desktop: `STATE_CHANGE_PATTERN`). This strengthens policy, as brief
§5 requires.

Tests: 18 new cases in `browser-action-classifier.spec.ts`, 2 new cases in
`desktop-gateway-service.spec.ts`, covering labels containing `invite`/`send`/`delete`/
`unsubscribe`, buttons vs links, missing/`javascript:` destinations, form-submitting
links, and harmless-label/effectful-destination links.

### Phase 2 (original scope)
- Role/destination-aware gating: an element that is demonstrably a navigation control
  (link role, in-page/same-origin destination, no form submit semantics) is not promoted to
  `submit`/`destructive`/sensitive purely on label words.
- Keep real invite-send, unsubscribe, submit, destructive, credential and payment gated.
- Add `AXURL`/subrole to the Swift accessibility node so the desktop classifier has a
  destination signal.
- Adversarial tests: labels containing `invite`, `delete`, `send`, `unsubscribe` on
  demonstrable navigation links must pass; the same words on buttons/forms must still gate.

*Risk:* weakening a safety gate. Mitigated by requiring positive navigation evidence
(role **and** destination) rather than merely absent evidence, and by leaving the default
(unknown role, no destination) on the gated path.

### Phase 3 — Computer Use window activation (R8) — **DONE**

As built, end to end: `DesktopHelper.swift` gained an `activateWindow` command (app activation
plus an `AXRaise` on the specific window, then a bounded verification poll that the app is
frontmost and the requested window is its front window) → protocol `1.2.0` → `DesktopHelperClient`
→ `DesktopDriver` / `DarwinDesktopDriver` → new `desktop-window-activation.ts` (policy) →
`DesktopInputController.activateWindow` → service → RPC (`computer.activate_window` +
`DesktopActivateWindowRequestSchema`) → MCP tool.

Design decisions worth recording:

- The AX window is matched to its CoreGraphics window by **frame** (1px tolerance), not by the
  private `_AXUIElementGetWindow` SPI. Best-effort: if no AX window matches, plain app activation
  still ran and the verification poll decides whether that was enough.
- The observation token is validated against the **observed** window, not the app's current front
  window — requiring the target to already be frontmost is precisely the deadlock being removed.
- A caller-supplied `windowId` must belong to the granted app (`appOwnsWindow`), so this can never
  raise another application's window. Denied apps are refused by the same policy as observation.
- No new observation token is minted: tokens are bound to the snapshot they came from, so the
  result carries `reobserveRequired: true` rather than a token that could not resolve elements.
- `list_apps` now exposes the full `windows` array (front-most first, with titles and bounds).
  The helper always returned this; the TS layer was discarding all but the first id.

Tests: 6 activation cases in `desktop-gateway-service.spec.ts` (multi-monitor targeting, default
to observed window, foreign window refused, denied app refused, invalid token, driver refusal).

### Phase 3 (original scope)
- New helper command + protocol bump, darwin client, driver, input controller (fresh
  observation token + granted app + denied-app refusal), service, RPC, MCP tool.
- Return and verify the newly active window; support multi-window/multi-monitor.
- Activation is a navigation prerequisite only; the action policy for subsequent input is
  unchanged.

*Risk:* protocol-version lockstep between helper binary and app.

### Phase 4 — Deferred tool durability (R9) — **DONE**

The root cause was a mistranslation, not a missing store: `fetchPreviouslyRevealedToolNames`
raced a single 1.5 s timeout and returned `[]` on loss, which is indistinguishable from "the
parent says nothing was revealed". A busy Electron main process at exactly the moment a forwarder
restarts therefore silently dropped the entire revealed surface, with no diagnostic anywhere.

As built: bounded retry (3 × 2 s + backoff) returning a `RevealRestoreOutcome`
(`{ names, restored, attempts }`) so a transport failure can never masquerade as an empty list;
a loud `logger.warn` on failure; `revealRestoreFailed` propagated through
`report_tool_surface` → reveal store → `browser.health` warnings, so the degradation is
reportable. Hidden-but-revealed tools were already dispatchable and now have a test proving it —
a lost reveal costs *visibility*, never capability.

Tests: `browser-tool-reveal-continuity.spec.ts` (reveal in cell A → call in cell B → forced
reconnect → call in cell C; dispatchable-while-hidden; a hung parent does not wipe the parent
record) plus 3 new cases in `browser-mcp-stdio-server.spec.ts`.

Deliberately **not** done: persisting the reveal store across an app restart. The observed
failure is within one app lifetime, and instanceIds do not meaningfully outlive the app.

### Phase 4 (original scope)
- Persist the reveal store; replace the silent 1.5 s `[]` degradation with bounded retry
  and a loud parity signal; keep revealed-but-unrunnable tools present with a capability
  error rather than removing them.
- Integration test: reveal in cell A, call in cell B, force reconnect, call in cell C.

*Known limit:* whether a Codex "functions execution cell" re-snapshots `ALL_TOOLS` after a
`tools/list_changed` is client-side and cannot be fixed from AIO. Record as a limitation.

### Phase 5 — Preflight, capability check, docs, e2e fixture — **DONE**

- **`browser.preflight_target`** (new `browser-target-preflight.ts` + tool + RPC + schema):
  picks the best existing logged-in tab for a URL and returns a typed rejection with an
  explanation for every alternative. `identifyBrowserTarget` labels each target
  `local-extension` / `remote-extension` / `managed-profile` with a `computer` and
  `usesRealUserSession`. A managed profile is **reported, never selected** — the "silently
  driving a signed-out automation profile" failure is now structurally impossible.
- **Skill/tool capability check** (`skill-tool-capability-check.ts`), wired into
  `SkillDiagnosticsService` so it surfaces through AIO Doctor with no new plumbing. It flags a
  skill that *mandates* an absent tool (`node_repl`, `scripts/browser-client.mjs`,
  `scripts/computer-use-client.mjs`) and names the managed alternative. Deliberately requires a
  mandate cue — a passing mention of a tool is not flagged, so the check stays trustworthy.
  The exposed surface is computed from the same factories the forwarders register, so the
  diagnostic cannot drift from what it checks against.
- **Acceptance fixture** (`mock-tender-activity.fixture.ts` +
  `browser-tender-withdrawal.spec.ts`): the ProContract journey driven against the real
  classifier, real preflight selector and real gateway approval flow over the parsed DOM —
  breadcrumb navigation, stop-notifications vs withdraw-interest, one action-time approval,
  execute-once, persisted read-back, denied-approval path, and the free-text message field.
- **Docs**: `/Users/suas/work/aio-remote-browser-gotchas.md` rewritten with preflight-first
  guidance, the local-Mac channel section (including the stale-socket trap), the semantics-based
  classification rules and the newly gated verbs, and the window-activation contract.

**Second under-gating found here:** the live control is worded "Stop notifications for this
activity", which matched no pattern in either classifier — it is an unsubscribe under a friendlier
label. Both classifiers now gate `stop notifications`, `turn off notifications`, `stop emails`,
`stop receiving` and `unfollow`, and check the link destination as well as the label (a "Manage
notifications" link pointing at `/account/unsubscribe` is an unsubscribe).

### Phase 5 (original scope)
- Preflight operation that picks the best existing logged-in target for a URL and explains
  rejections; richer driver/computer metadata on targets.
- Startup capability check that fails loudly when installed skill instructions reference a
  tool surface that is not exposed.
- Deterministic ProContract-shaped local fixture covering the acceptance path and the
  failure paths listed in the brief.
- Update `/Users/suas/work/aio-remote-browser-gotchas.md` and AIO Doctor docs.

---

## 5. Verification gates

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Rebuilds required before live use: app, `build:desktop-helper`, `build:aio-mcp-dist`,
worker dist, extension reload. Anything needing a rebuilt/restarted app, a human, Chrome
tab sharing, or `windows-pc` goes into `<stem>_livetest.md` per `AGENTS.md`.
