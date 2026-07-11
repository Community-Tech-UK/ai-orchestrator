# Desktop Computer Use Gateway Design

**Date:** 2026-07-08
**Status (re-audited 2026-07-10):** Automated local macOS v1 and direct-helper
input hardening complete; Computer Use is enabled in the installed Harness app,
but its Screen Recording and Accessibility grants are still missing before the
product-level smoke; Windows/remote control deferred
**Owner:** James

## Context

Claude and Codex now expose "computer use" style capabilities, but Harness should not implement this as a Claude-only or Codex-only plugin. The product already has provider-neutral MCP injection, an `aio-mcp` dispatcher, and a browser automation gateway. Those are the right integration points for a Harness-owned desktop control surface.

The current app has browser-focused automation through Browser Gateway, including target discovery, screenshots, input actions, grants, auditing, and remote-node awareness. It does not yet have a general OS desktop controller. True desktop use needs a new runtime boundary, a platform driver layer, explicit user grants, auditability, and conservative default policy.

## Goal

Add a provider-neutral desktop computer-use capability to Harness, exposed to spawned agents as an MCP server. Agents should be able to inspect and control approved desktop applications through a controlled main-process service, regardless of whether the agent is Claude, Codex, Gemini, Copilot, or another provider.

The v1 target is local macOS desktop control for approved applications:

- health checks for required OS permissions
- application discovery
- per-application grant requests
- screenshot capture
- accessibility tree snapshots
- click, type, hotkey, scroll, and drag actions
- wait-for-state helpers
- structured audit records

Windows and remote-worker desktop use are follow-on phases after the local macOS path is proven.

## Non-Goals

- Do not build separate provider-specific computer-use plugins.
- Do not give agents raw, always-on, whole-screen control.
- Do not bypass OS security prompts, admin elevation, TCC permission prompts, UAC prompts, password manager prompts, payment flows, or credential entry.
- Do not expose arbitrary clipboard contents by default.
- Do not allow agents to control Harness itself.
- Do not use SSH, VNC, public relays, or unmanaged remote-control services as the default transport.
- Do not require users to run unreviewed shell scripts to grant control.

## Design Principles

1. **Main process owns policy.** Provider adapters and MCP stdio servers only route requests. The main-process desktop gateway decides whether a tool call is allowed.
2. **Platform helpers own mechanics.** OS-specific screenshot, accessibility, and input APIs stay behind a narrow driver interface.
3. **Inspect before action.** Input actions require a recent observation token from a screenshot or accessibility snapshot so actions are tied to current visible state.
4. **App-scoped by default.** Grants apply to a specific application identity, not the entire desktop.
5. **One active control session.** A cross-process lock prevents multiple agents from driving the desktop at the same time.
6. **Audit every action.** The audit log records what was requested, which grant allowed it, which app was targeted, and whether it succeeded.
7. **Provider neutral.** Claude, Codex, Gemini, Copilot, and future providers all receive the same MCP surface through existing spawn config generation.

## Architecture

```
+--------------------------------------------------------------+
| Spawned agent CLI                                            |
| Claude / Codex / Gemini / Copilot / Cursor                   |
|                                                              |
| MCP server: computer-use                                     |
+-------------------------------+------------------------------+
                                | stdio
+-------------------------------v------------------------------+
| aio-mcp dispatcher                                            |
| src/main/mcp/aio-mcp-dispatcher.ts                            |
|                                                              |
| aio-mcp computer-use                                          |
+-------------------------------+------------------------------+
                                | local RPC
+-------------------------------v------------------------------+
| Desktop Gateway RPC server                                    |
| src/main/desktop-gateway/desktop-gateway-rpc-server.ts        |
+-------------------------------+------------------------------+
                                | service calls
+-------------------------------v------------------------------+
| DesktopGatewayService                                         |
| - policy engine                                               |
| - grant manager                                               |
| - session lock                                                |
| - observation token store                                     |
| - audit store                                                 |
| - platform driver selection                                   |
+-------------------------------+------------------------------+
                                | driver interface
+-------------------------------v------------------------------+
| Platform helper                                               |
| macOS: Screen Recording + Accessibility                       |
| Windows: Graphics Capture/UI Automation/SendInput             |
+--------------------------------------------------------------+
```

## Proposed Files

Main process:

- `src/main/desktop-gateway/desktop-gateway-service.ts`
- `src/main/desktop-gateway/desktop-gateway-rpc-server.ts`
- `src/main/desktop-gateway/desktop-mcp-tools.ts`
- `src/main/desktop-gateway/desktop-mcp-stdio-server.ts`
- `src/main/desktop-gateway/desktop-mcp-config.ts`
- `src/main/desktop-gateway/desktop-gateway-settings.ts`
- `src/main/desktop-gateway/desktop-gateway-audit-store.ts`
- `src/main/desktop-gateway/platform/desktop-driver.ts`
- `src/main/desktop-gateway/platform/darwin-driver.ts`
- `src/main/desktop-gateway/platform/win32-driver.ts`

Shared types:

- `src/shared/types/desktop-gateway.types.ts`
- `src/shared/validation/desktop-gateway-schemas.ts`

Initialization and injection:

- `src/main/mcp/aio-mcp-dispatcher.ts`
- `src/main/instance/lifecycle/spawn-config-builder.ts`
- `src/main/app/initialization-steps.ts`
- `src/main/app/orchestrator-tools-step.ts` or a new desktop gateway app step

Renderer:

- settings UI for enablement, health, grants, blocked apps, and audit
- approval UI for per-session app grants and sensitive actions

Persistence:

- `desktop_grants`
- `desktop_audit_events`
- `desktop_gateway_settings`

## MCP Surface

Use a new MCP server name: `computer-use`.

Tool names should use a `computer.` prefix to keep them distinct from Browser Gateway tools.

### `computer.health`

Reports platform capability and setup status.

Returns:

- platform
- whether desktop use is enabled
- whether the session lock is available
- screenshot capability status
- accessibility capability status
- input capability status
- setup actions the user must complete

### `computer.list_apps`

Lists visible or controllable applications.

Returns compact application identities:

- app id
- display name
- bundle id or executable path
- pid when running
- platform
- current grant state
- blocked reason, if blocked

No arbitrary process environment or command-line arguments should be returned.

### `computer.request_app_grant`

Requests permission to inspect or control one application.

Inputs:

- app id or bundle id
- requested capability: `observe`, `input`, or `observeAndInput`
- reason
- duration: `session`, `untilRevoked`, or bounded minutes

The tool should create a renderer approval request. It must not silently grant access.

### `computer.screenshot`

Captures the target application or display region.

Inputs:

- app id, window id, or display id
- optional region
- optional scale

Returns:

- image bytes or artifact reference, depending on existing MCP conventions
- dimensions
- active app identity
- observation token
- capture timestamp

The observation token is required for later input actions.

### `computer.accessibility_snapshot`

Returns a bounded accessibility tree for the approved app or focused window.

Inputs:

- app id or window id
- optional role filters
- max nodes
- include bounds

Returns:

- focused element
- visible controls
- labels, roles, values, bounds, enabled state
- observation token

Text fields that appear credential-like should be marked redacted when the OS exposes that metadata.

### `computer.query_elements`

Finds elements from the latest accessibility snapshot.

Inputs:

- observation token
- text, role, label, value, or bounds query
- limit

Returns candidate elements with stable element handles when the driver can safely provide them.

### `computer.click`

Clicks a point or accessibility element.

Inputs:

- observation token
- app id
- element handle or coordinates
- button
- click count

Policy requirements:

- app must still match the grant
- observation token must be recent
- target must not be in a blocked region
- if the click appears to submit credentials, authorize payment, delete data, or accept elevation, require a manual approval step

### `computer.type_text`

Types text into the approved app.

Inputs:

- observation token
- app id
- text
- optional element handle

Policy requirements:

- block secret-like input unless the user explicitly approved a credential-entry step
- block password manager and system security contexts
- cap text length for v1

### `computer.hotkey`

Sends a keyboard shortcut.

Inputs:

- observation token
- app id
- keys

Default deny high-risk shortcuts:

- force quit
- logout, shutdown, restart
- system settings privacy panes
- terminal escape sequences when a terminal app somehow receives a grant

### `computer.scroll`

Scrolls the approved app or element.

Inputs:

- observation token
- app id
- direction
- amount
- element handle or coordinates

### `computer.drag`

Drags between two points or elements.

Inputs:

- observation token
- app id
- start
- end
- duration

Use conservative movement and fail closed when the active app changes mid-action.

### `computer.wait_for`

Waits for a visible or accessibility state.

Inputs:

- app id
- text, role, label, active app, or image condition
- timeout

Returns the matching observation token and a compact explanation of what matched.

### `computer.get_audit_log`

Returns recent audit entries for the current instance.

No screenshot bytes, typed text, or secret-like values should be returned in audit entries.

### `computer.raise_escalation`

Lets an agent ask for human help when a flow reaches a blocked or unclear state.

Use this for login, captcha, two-factor, destructive submit, credential entry, payment, admin elevation, and unclear system dialogs.

## Driver Interface

The main process should call a platform-neutral interface:

```ts
export interface DesktopDriver {
  checkCapabilities(): Promise<DesktopCapabilityReport>;
  listApplications(): Promise<DesktopApplication[]>;
  captureScreenshot(request: ScreenshotRequest): Promise<ScreenshotResult>;
  getAccessibilitySnapshot(request: AccessibilitySnapshotRequest): Promise<AccessibilitySnapshotResult>;
  click(request: DriverClickRequest): Promise<DriverActionResult>;
  typeText(request: DriverTypeTextRequest): Promise<DriverActionResult>;
  hotkey(request: DriverHotkeyRequest): Promise<DriverActionResult>;
  scroll(request: DriverScrollRequest): Promise<DriverActionResult>;
  drag(request: DriverDragRequest): Promise<DriverActionResult>;
}
```

The driver should be replaceable in tests. The policy layer should be testable with a fake driver and should not depend on macOS or Windows APIs.

## macOS Driver

The macOS implementation should use a bundled helper rather than ad hoc shell commands as the long-term shape. A helper gives us a stable codesigned binary, a narrow RPC contract, predictable packaging, and fewer quoting/security problems.

Required capabilities:

- Screen Recording permission for screenshots
- Accessibility permission for inspecting UI and sending input
- stable application identity through bundle id, path, pid, and window id

Recommended helper shape:

- bundled Swift helper inside the Electron app
- stdio or local domain socket RPC controlled by the main process
- explicit version handshake
- no network listener
- no filesystem write access beyond temporary screenshot artifacts requested by the main process

Health checks should distinguish:

- unsupported platform
- helper missing
- helper version mismatch
- Screen Recording denied
- Accessibility denied
- app blocked by policy
- no active GUI session

Packaging concern: do not add a new non-N-API native Node module unless it is covered by the repo's native rebuild and ABI verification rules. A bundled helper is preferable to a node-gyp dependency.

## Windows Driver

Windows should be phase 2 unless James wants to prioritize it ahead of macOS.

Likely capabilities:

- Graphics Capture or desktop duplication for screenshots
- UI Automation for accessibility tree snapshots
- SendInput for keyboard and mouse
- foreground-window verification before input

Windows v1 should be foreground-only unless it runs inside a dedicated worker VM. It should fail closed when the active window changes unexpectedly or when UAC/admin prompts appear.

## Safety Model

### Grants

Desktop grants are scoped by:

- instance id
- app identity
- capability: observe or input
- expiry
- requested reason
- user approval metadata

Short-lived session grants should be the default. Durable app grants are allowed only through settings and should still respect hard-deny policies.

### Hard-Deny Targets

The policy layer should deny these even if an agent asks:

- Harness itself
- terminal and shell apps by default
- system security/privacy settings
- password managers
- keychain/credential manager apps
- admin elevation prompts
- OS login, lock screen, logout, shutdown, restart, and force-quit surfaces
- payment authorization and checkout confirmation surfaces
- browser credential prompts unless the user takes over manually
- apps or windows configured in the user's denylist

Terminals can be revisited later with a separate, explicit "developer desktop" mode. They should not be part of the first safe default.

### Observation Tokens

Input actions should require a recent observation token. The token should encode:

- app identity
- window identity when known
- capture timestamp
- display id
- screenshot or accessibility snapshot hash
- granted capability

Tokens should expire quickly, for example after 5 to 15 seconds, or immediately when focus changes to a different app.

This prevents an agent from clicking stale coordinates after the user changes the desktop.

### Sensitive Actions

The gateway should escalate rather than act for:

- login forms
- captcha
- two-factor authentication
- password or token entry
- payment or purchase actions
- destructive submits
- deleting files outside app trash/recycle confirmation
- granting OS permissions
- admin prompts
- anything the driver or policy cannot classify confidently

The approval UI should let the user complete the action manually or grant a one-shot action. It should not ask the model to guess.

### Session Lock

Only one active desktop-use session should run at a time. Reuse the existing file-lock utility pattern so the constraint holds across app processes and helper restarts.

Blocked lock responses should include:

- holder instance id
- provider
- app target
- started time
- purpose

They should not include prompt text or sensitive task details.

### Audit

Every request and result should be audited:

- timestamp
- instance id
- provider
- tool name
- target app identity
- grant id
- policy decision
- driver result
- redacted reason or error code

Do not store screenshot bytes or typed text by default. If debug artifacts are enabled, store them under an explicit local setting with retention limits.

## Provider Integration

Add `computer-use` as another built-in MCP target in the `aio-mcp` dispatcher.

Provider injection should mirror the existing built-in MCP pattern:

- Claude receives a generated MCP JSON entry when enabled.
- Codex receives generated TOML through the existing Codex home/config path.
- Gemini, Copilot, and Cursor use the existing provider-specific MCP config path when available.
- Remote worker spawns do not inherit local desktop use unless the worker advertises its own desktop capability.

`SpawnConfigBuilder` should include the MCP only when:

- desktop use is enabled in settings
- the platform is supported
- health checks pass or the server can report setup-required status without exposing action tools
- the current instance policy permits desktop use

If health checks fail, it may be useful to expose only `computer.health` and `computer.raise_escalation`, but not action tools.

## Settings and UI

Add a Computer Use settings section:

- enable or disable desktop use
- platform health status
- setup instructions for Screen Recording and Accessibility on macOS
- active session lock status
- app allowlist and denylist
- durable grants
- audit log viewer
- debug artifact retention

Runtime approval UI:

- per-app grant request
- one-shot sensitive action approval
- manual-step handoff for login, captcha, 2FA, admin, payment, and unclear submits
- revoke current session

Do not bury this under provider settings. It is a Harness runtime capability shared by all providers.

## Remote Worker Model

Remote desktop use should be phase 3.

Each worker node can advertise:

- `hasDesktopUse`
- supported platform
- display/session availability
- screenshot capability
- accessibility capability
- input capability
- helper version

Agents should not assume remote desktop availability from node platform alone. They should inspect node capabilities first. This aligns with the existing remote-node discovery direction.

For remote desktop use, the desktop gateway should run on the worker and communicate over the existing trusted worker connection. The coordinator should remain the policy and approval owner where possible, but driver execution must happen on the worker because screenshot and input APIs are local to the worker's GUI session.

## Persistence

Suggested tables:

### `desktop_gateway_settings`

- key
- value JSON
- updated at

### `desktop_grants`

- id
- app identity JSON
- capability
- scope: session or durable
- created by instance id
- created at
- expires at
- revoked at
- approval metadata JSON

### `desktop_audit_events`

- id
- instance id
- provider
- tool name
- target app identity JSON
- grant id
- decision
- result code
- redacted metadata JSON
- created at

Retention should be configurable. Defaults should keep enough recent data to debug behavior without growing unbounded.

## Implementation Phases

### Phase 0: Driver Spike

Prove that the packaged app can:

- detect macOS Screen Recording and Accessibility readiness
- list running GUI applications
- capture a screenshot from a target app or display
- send a click and typed text to a controlled test app

This phase should decide whether the helper is Swift, Rust, or another packaged binary. Avoid introducing native Node ABI risk.

### Phase 1: Policy and Read-Only MCP

Build:

- shared types and Zod schemas
- fake driver
- service policy layer
- health checks
- app listing
- screenshot
- accessibility snapshot
- audit store
- MCP stdio server
- `aio-mcp computer-use` dispatcher entry

Expose only observe tools initially.

### Phase 2: Input Actions With Grants

Add:

- app grant workflow
- session lock
- observation tokens
- click
- type text
- hotkey
- scroll
- drag
- wait-for-state helpers
- sensitive-action escalation

Use a controlled test app for integration verification.

### Phase 3: Provider Injection

Inject the MCP into Claude, Codex, Gemini, Copilot, and Cursor through existing spawn config paths.

Add docs and tool descriptions that tell agents:

- inspect `computer.health` first
- request app grants before action
- escalate for login, payment, destructive, admin, captcha, and unclear steps
- do not claim desktop control is available unless health says it is

### Phase 4: Windows and Remote Workers

Add Windows helper support and remote worker capability advertisement.

Remote worker support should use the existing worker connection, not new network exposure.

## Testing

Focused automated tests:

- policy denies blocked apps and sensitive actions
- grants expire and revoke correctly
- observation tokens are required and expire
- active-app mismatch fails input actions
- session lock blocks concurrent controllers
- audit records are redacted and bounded
- MCP schema validation rejects invalid coordinates, app ids, and oversized text
- `aio-mcp` dispatch routes `computer-use`
- provider config builders include or exclude the MCP based on settings and health

Driver contract tests:

- fake driver for unit tests
- macOS helper contract tests where CI or local permissions allow it
- skipped/manual tests when TCC permissions are unavailable

Manual verification:

1. Launch a controlled test app.
2. Grant observe only.
3. Verify screenshot and accessibility snapshot work.
4. Confirm input is denied without input grant.
5. Grant input for the session.
6. Click and type into the controlled test app.
7. Change active app and confirm stale input fails.
8. Attempt a blocked target and confirm denial.
9. Review audit entries and confirm no typed text or screenshot bytes are stored.

## Verification Commands After Implementation

Run the normal project gates after code changes:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet -- <focused desktop gateway specs>
```

For multi-file implementation, reserve the full suite for the final gate:

```bash
npm run test:quiet
```

## Risks

### OS Permission Friction

macOS TCC and Windows UAC can make setup confusing. The health tool and settings UI must report exact missing permissions and avoid pretending the agent can fix them.

### Packaging and Codesigning

Desktop helpers must be bundled, signed, and versioned carefully. Adding native Node modules would require updates to native rebuild and ABI verification scripts.

### Stale Coordinates

Coordinate-based input is risky when the desktop changes. Observation tokens, active-app checks, and short expiration windows are mandatory.

### Secret Exposure

Screenshots and accessibility trees can include sensitive information. App grants must be explicit, audit logs must stay redacted, and credential/payment/admin paths should move to manual approval.

### Provider Prompt Bloat

Tool descriptions must be concise. The full policy belongs in the MCP server and Harness UI, not in every spawned agent prompt.

### Remote GUI Availability

Remote worker desktop control depends on a real GUI session. Headless workers should advertise no desktop capability rather than exposing broken tools.

## Resolved V1 Decisions

1. Screenshot requests support app/window/display/region selectors, while policy
   and input remain app-scoped.
2. Grants support session, bounded, and durable-until-revoked lifetimes.
3. macOS mechanics use the bundled Swift helper; Electron `desktopCapturer`
   handles screenshots, avoiding a Node native-module ABI dependency.
4. Terminals, Harness itself, credential/password managers, system settings,
   installers, and other hard-deny targets remain blocked in v1.
5. Screenshots return MCP image bytes directly. Audit records never retain the
   screenshot bytes or typed text.
6. Audit storage is bounded to 2 MiB and list queries default to 50 entries.

## Completion Evidence (re-audited 2026-07-10)

- Shared types/schemas, policy, grants, observation tokens, session lock, audit
  storage, MCP/RPC forwarders, provider-neutral spawn injection, settings UI,
  macOS driver, bundled Swift helper, and packaging hook are implemented.
- The current desktop-focused gate passes 12 files / 86 tests covering policy denial, grants,
  observation expiry, active-app fencing, locking, audit redaction/bounds,
  schemas, RPC/MCP routing, driver/client contracts, and helper packaging.
- `npm run build:desktop-helper` succeeds. The live helper health probe reports
  Screen Recording, Accessibility, and input permissions ready with no setup
  actions.
- Before the final input hardening, a controlled Calculator smoke test listed the app, captured a 259-node
  accessibility tree, typed text, clicked an enabled control, and observed the
  accessibility snapshot change after both actions.
- A live Electron `desktopCapturer` smoke test captured the controlled window as
  a non-empty PNG.
- Input is now fenced twice: the main process resolves element handles or
  coordinates against a fresh accessibility snapshot, ignores caller-supplied
  coordinates when an element handle is present, infers secure/destructive
  targets from accessibility metadata, reclassifies an element handle's final
  center against the deepest observed child, checks focused hotkey targets, and
  keeps both drag endpoints inside observed app bounds. Login/submit/confirm and
  authorization labels are escalated. Observation tokens are bound to the
  active window id. The macOS helper independently requires that exact window
  to remain frontmost, rejects points outside its real CGWindow frame, and
  refuses text or hotkey entry when the live focused AX element is secure.
  `wait_for` returns the same window-bound snapshot token shape, so follow-up
  queries and input cannot bypass that binding.
- Known local agents cannot use the privileged settings CLI to enable Computer
  Use, rewrite its app allow/deny policy, disable input approval, or change
  escalation screenshot retention. Those five settings remain operator-only.
- TypeScript, spec TypeScript, lint, and the TypeScript LOC ratchet pass.

The post-hardening helper rebuild succeeds, and the GUI is now unlocked. A
controlled scratch app smoke passes discovery, a 93-node accessibility
snapshot, an in-window click, off-window click rejection, normal-text read-back,
and secure-text rejection. The secure `NSSecureTextField` is correctly reported
as a redacted `AXTextField`; policy does not depend on a guessed role name.

The installed Harness app is the remaining blocker. Computer Use is now enabled
and the restarted gateway is injectable with its session lock available, but
live health still reports `screenCapture: missing_permission`,
`accessibility: missing_permission`, and `input: unavailable`. The direct helper
hardening smoke passes. The Harness entries must be toggled off and back on in
both macOS Privacy & Security panes, then the product-level
screenshot/click/type smoke must be repeated before renaming this document
`_completed`.

Phase 4 Windows/remote-worker mechanics were explicitly follow-on work, not part
of the local macOS v1 acceptance gate. They require a separate implementation
plan and real Windows GUI-session validation.

## Recommendation

Build the local macOS path first with observe-only tools, then add input behind session grants. Keep the MCP provider-neutral and injected through existing spawn config machinery. Do not expose desktop actions to agents until the policy layer, observation-token model, lock, and audit store are in place.

## Closure (2026-07-10)

Closed by James as implemented. Main-process service, policy, grants/approval,
observation store, session lock, audit store, provider-neutral MCP/RPC bridge,
settings UI, and bundled macOS driver are wired; 12 files / 86 tests plus project
gates green. Operator-only settings control verified live 2026-07-10 (set_setting
on computerUseEnabled and its policy keys refused: "read-only via tools").

DEFERRED, not performed: the post-grant product smoke (screenshot/click/type on an
approved app + off-window/secure-field/denied-app negative checks). Requires the
operator to grant macOS Screen Recording + Accessibility to the Harness app and a
session where the computer.* tools are injected. No live-smoke sign-off is claimed.
