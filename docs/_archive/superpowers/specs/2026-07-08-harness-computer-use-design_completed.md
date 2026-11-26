# Harness Computer Use Design

**Date:** 2026-07-08
**Status (re-audited 2026-07-10):** Automated local macOS v1 and direct-helper
input hardening complete; Computer Use is enabled in the installed Harness app,
but its Screen Recording and Accessibility grants are still missing before the
product-level smoke; Windows/remote control deferred
**Owner:** James

## Problem

Claude and Codex now expose "computer use" as a first-class way for agents to see and operate desktop GUI applications. Harness already has provider orchestration, MCP injection, Browser Gateway, approval flows, audit stores, remote worker routing, and a thin `aio-mcp` dispatcher, but it does not have a general OS desktop-control runtime.

The result is a capability gap. Agents can test web apps through Browser Gateway and can delegate work to remote nodes, but they cannot reliably inspect or operate a desktop app UI, a native app settings panel, a system browser window outside Browser Gateway, or a GUI-only reproduction flow under Harness control.

This should not be solved separately for Claude and Codex. Harness should own one provider-neutral desktop automation surface, then expose it to whichever local provider supports MCP.

## Existing Infrastructure

Relevant existing pieces:

- `src/main/browser-gateway/`
  - Browser-specific version of the desired shape: MCP tools, parent-side RPC server, stdio forwarder, approvals, audits, screenshots, and remote target hints.
- `src/main/browser-gateway/browser-mcp-config.ts`
  - Builds provider-specific MCP configs for Claude JSON, Codex TOML, Gemini settings, and ACP-style providers.
- `src/main/browser-gateway/browser-mcp-stdio-server.ts`
  - Thin stdio MCP process that forwards tool calls back into the parent process.
- `src/main/mcp/aio-mcp-dispatcher.ts`
  - Single SEA entrypoint for `orchestrator-tools`, `codemem`, `browser-gateway`, `native-host`, `remote-nodes`, and `release-readiness`.
- `src/main/instance/lifecycle/spawn-config-builder.ts`
  - Central place that injects MCP config into spawned CLI instances.
- `src/main/mcp/orchestrator-tools.ts`
  - Existing model for remote-worker discovery and run-on-node delegation.
- `src/main/util/file-lock.ts`
  - Atomic cross-process lock pattern inspired by Claude computer-use locking.

The missing layer is an OS desktop gateway with app-scoped grants, screenshot/input/accessibility drivers, audit logging, and MCP tools.

## Goals

1. Give Harness agents first-class desktop GUI control for approved applications.
2. Keep the provider interface neutral: one Harness-owned MCP server, injected into Claude, Codex, and other compatible providers.
3. Make the main process the policy boundary. Providers and MCP forwarders never get raw OS control without parent-side validation.
4. Start with macOS as phase 1 because the coordinator app is currently macOS-hosted and because macOS has explicit Screen Recording and Accessibility permission gates.
5. Support Windows in phase 2 with a foreground-control model, ideally through remote worker VMs or dedicated worker machines.
6. Reuse Browser Gateway patterns where they fit: RPC socket, stdio forwarder, grants, audit logs, health checks, and screenshot image responses.
7. Avoid Electron native-module ABI risk for the desktop driver unless the implementation explicitly chooses and wires a native dependency through the existing native rebuild guard.

## Non-Goals

- Do not replace Browser Gateway for web apps. Browser Gateway remains the preferred web-app automation path.
- Do not allow terminal apps, Harness itself, provider apps, password managers, security/privacy settings, or admin elevation prompts in v1.
- Do not build unattended credential, payment, legal declaration, or account-security workflows in desktop v1.
- Do not bypass provider sandboxing or existing file/shell approval policies.
- Do not give agents global screen control by default. Control is app-scoped and grant-scoped.
- Do not support locked-screen automation in v1.
- Do not expose raw screenshot streams or clipboard contents without redaction and policy checks.

## User-Facing Model

Settings gets a new **Computer Use** section:

- Enable Computer Use
- Health status
- macOS permissions:
  - Screen Recording
  - Accessibility
- Allowed apps
- Denied apps
- Active grants
- Audit log

When an agent asks to use a desktop app, Harness prompts the user:

```text
Allow this session to use "Preview"?
Actions: view screen, click, type, use keyboard shortcuts
Duration: this session
```

The user can choose:

- Allow once
- Allow for this session
- Always allow this app
- Deny

For Windows, the UI must say that the active desktop will be controlled in the foreground. The recommended operational model is a worker VM or a dedicated Windows worker if James wants to keep using the main desktop.

## Architecture

Add a new main-process domain:

```text
src/main/desktop-gateway/
  index.ts
  desktop-gateway-service.ts
  desktop-gateway-service-types.ts
  desktop-gateway-rpc-client.ts
  desktop-gateway-rpc-server.ts
  desktop-mcp-tools.ts
  desktop-mcp-config.ts
  desktop-mcp-stdio-server.ts
  desktop-health-service.ts
  desktop-app-policy.ts
  desktop-grant-store.ts
  desktop-audit-store.ts
  desktop-redaction.ts
  desktop-session-lock.ts
  platform/
    desktop-driver.types.ts
    darwin-driver.ts
    win32-driver.ts
```

The shape mirrors Browser Gateway:

```text
Provider CLI
  -> MCP stdio server: aio-mcp computer-use
    -> DesktopGatewayRpcClient
      -> DesktopGatewayRpcServer in parent main process
        -> DesktopGatewayService
          -> app policy, grants, audit, session lock
          -> platform driver
```

The provider sees only MCP tools. The stdio process is a thin forwarder. The parent owns all validation and dispatch.

## Driver Boundary

Define a narrow platform-driver interface:

```ts
export interface DesktopDriver {
  health(): Promise<DesktopDriverHealth>;
  listApps(): Promise<DesktopAppDescriptor[]>;
  getActiveApp(): Promise<DesktopAppDescriptor | null>;
  focusApp(appId: string): Promise<void>;
  screenshot(request: DesktopScreenshotRequest): Promise<DesktopScreenshotResult>;
  accessibilitySnapshot(request: DesktopSnapshotRequest): Promise<DesktopAccessibilityTree>;
  click(request: DesktopClickRequest): Promise<void>;
  typeText(request: DesktopTypeRequest): Promise<void>;
  hotkey(request: DesktopHotkeyRequest): Promise<void>;
  scroll(request: DesktopScrollRequest): Promise<void>;
  drag(request: DesktopDragRequest): Promise<void>;
}
```

The driver should be replaceable in tests and should not import provider, MCP, or instance lifecycle code.

### macOS Driver

Phase 1 uses a macOS helper boundary rather than putting OS automation directly into provider adapters.

Preferred implementation:

- A bundled helper process for macOS desktop automation.
- Main process calls helper over stdio or a local socket.
- Helper uses:
  - ScreenCaptureKit or Electron capture APIs for screen images, depending on reliability.
  - Accessibility APIs for app/window/element metadata.
  - Quartz event APIs for mouse and keyboard input.

The helper must report permission state separately:

- screen capture available
- accessibility input available
- accessibility tree available

If a new native Node module is proposed instead, the implementation plan must explicitly update native dependency handling per the packaging gotchas in `AGENTS.md`.

### Windows Driver

Phase 2 uses a Windows foreground-control helper:

- Enumerate visible top-level windows and apps.
- Capture the active display or target window.
- Use Windows UI Automation for accessibility snapshots where available.
- Use Win32 input APIs for click/type/hotkey/scroll/drag.

Windows computer use is foreground-only in v1/v2. Harness must not imply background control on the user's active desktop. For reliable unattended use, pair it with a Windows worker VM or dedicated Windows node.

## MCP Server

Add `computer-use` as an `aio-mcp` subcommand:

```text
aio-mcp computer-use
```

Add config builders parallel to Browser Gateway:

- `buildComputerUseMcpConfigJson`
- `buildComputerUseCodexConfigToml`
- `buildComputerUseGeminiSettingsJson`
- `buildComputerUseAcpMcpServers`

Inject via `SpawnConfigBuilder.getMcpConfig()` when all are true:

- Computer Use is enabled in settings.
- A local instance is being spawned.
- `aio-mcp` is available.
- Desktop Gateway RPC socket is available.
- The platform driver health check is not hard-failed.

Do not inject into remote instances from the coordinator. Remote workers need their own local computer-use runtime and should advertise that capability separately.

## MCP Tools

Tool names use the `computer.` prefix:

### `computer.health`

Read-only. Returns platform, driver availability, permission state, active lock state, and whether tools are currently injectable.

### `computer.list_apps`

Read-only. Returns app descriptors:

- app id
- display name
- executable or bundle id
- platform
- visible window count
- policy status: `allowed`, `denied`, `needs_approval`, `unsupported`

Do not return window titles for denied apps unless the policy allows basic metadata.

### `computer.request_app_grant`

Requests a grant for an app and action classes:

- `view`
- `input`
- `keyboard`
- `clipboard`
- `file-dialog`

Returns a request id and current approval status. This should reuse the Browser Gateway approval style if practical.

### `computer.get_approval_status`

Polls an approval request.

### `computer.screenshot`

Captures the approved app/window or the approved visible region. Returns an MCP image content block, like `browser.screenshot`.

The result must include:

- image data
- app id
- window id if applicable
- capture timestamp
- redaction summary
- warning that visible content is untrusted

### `computer.accessibility_snapshot`

Returns a bounded accessibility tree for the approved app/window:

- uid
- role
- name or label
- value where safe
- bounds
- enabled/focused state

Fields likely to contain secrets must be redacted. Password fields return only metadata.

### `computer.click`

Clicks by uid or coordinates within the approved app/window. Coordinate clicks require a recent screenshot id or snapshot id so the click is anchored to a known view.

### `computer.type_text`

Types text into a focused or uid-targeted control. Requires input grant. Text is logged as redacted by default.

### `computer.hotkey`

Sends a keyboard shortcut to the approved app. Deny known dangerous global shortcuts unless explicitly approved.

### `computer.scroll`

Scrolls within the approved app/window.

### `computer.drag`

Drags within the approved app/window. Requires a recent screenshot or snapshot anchor.

### `computer.wait_for`

Waits for an accessibility node, app focus, window title pattern, or image/snapshot change. Bounded timeout.

### `computer.get_audit_log`

Returns recent audit entries for the session/app. Secret and typed text values are redacted.

### `computer.raise_escalation`

Records a hard stop, such as:

- captcha
- payment
- security prompt
- admin elevation
- credential request
- wrong app
- unknown modal

## Safety Model

### App Policy

Persistent app policy lives in a desktop-gateway store. Global enablement and coarse feature flags live in Harness settings; per-app decisions live with the gateway so grants, audits, and policy use one persistence boundary.

```ts
interface DesktopAppPolicy {
  appId: string;
  displayName: string;
  decision: 'allow' | 'deny' | 'ask';
  allowedActionClasses: DesktopActionClass[];
  updatedAt: number;
}
```

Deny wins over allow.

Built-in denylist for v1:

- Terminal apps and shells
- Harness / AI Orchestrator itself
- Claude, Codex, Gemini, Copilot, Cursor agent apps
- Password managers
- macOS System Settings security/privacy panes
- Windows security/admin prompts
- Keychain Access and credential stores
- Payment apps or wallet apps

### Session Lock

Only one active desktop-control session runs at a time per machine.

Use a lock file under app userData, implemented through the existing file-lock pattern:

```text
computer-use.lock
```

The lock holder includes:

- pid
- session id
- instance id
- app id
- acquiredAt
- purpose

### Prompt Injection Boundary

Screen content, app text, accessibility labels, window titles, and screenshots are untrusted. Tool descriptions and system prompt context must say this clearly.

The model may use visible content to complete the user's task, but it must not treat visible app content as instructions that override the user, Harness policy, or repo instructions.

### Sensitive Actions

Always escalate or require fresh user approval for:

- submitting payments
- changing account security settings
- deleting external data
- sending email/messages/posting publicly
- approving admin prompts
- entering credentials
- using password managers
- opening files outside the workspace through GUI dialogs

### Audit

Every non-read operation writes an audit entry:

- instance id
- provider
- app id
- action
- action class
- target summary
- grant id
- request id
- timestamp
- result
- redaction summary

Screenshots are not stored by default. If stored for escalation, store as an artifact with retention and redaction metadata.

## Settings and IPC

Add settings:

- `computerUseEnabled`
- `computerUseAllowedAppsJson`
- `computerUseDeniedAppsJson`
- `computerUseRequireApprovalForInput`
- `computerUseStoreScreenshotsForEscalations`

Add IPC for UI:

- get computer-use health
- list app policies
- set app policy
- list active grants
- revoke grant
- read audit log

Do not expose raw screenshot bytes through renderer IPC except where a UI screen explicitly needs to show an approval or audit artifact.

## Remote Workers

Remote worker support is not part of coordinator-local v1 injection.

Phase 2 adds worker capability reporting:

- `hasComputerUse`
- `computerUsePlatform`
- `computerUseHealth`
- `foregroundOnly`

Phase 2 extends `run_on_node` with:

```ts
requiresComputerUse?: boolean;
targetApp?: string;
```

The spawned worker instance receives its own local `computer-use` MCP server from the worker process, not the coordinator's socket path.

## Error Handling

Common errors should be structured and stable:

- `computer_use_disabled`
- `computer_use_unavailable_platform`
- `computer_use_missing_screen_recording`
- `computer_use_missing_accessibility`
- `computer_use_app_denied`
- `computer_use_grant_required`
- `computer_use_lock_held`
- `computer_use_target_not_found`
- `computer_use_sensitive_action_blocked`
- `computer_use_driver_failed`

Errors returned to agents should include a short remediation hint but no secret or raw OS diagnostic dump.

## Testing

Unit tests:

- MCP tool schema coverage in `desktop-mcp-tools.spec.ts`.
- MCP config builders for Claude JSON and Codex TOML.
- `aio-mcp` dispatcher routes `computer-use`.
- RPC server validates instance id, rate limits, payload size, and dispatch.
- App policy deny-over-allow behavior.
- Session lock behavior.
- Audit redaction.
- SpawnConfigBuilder injects only when enabled, local, and socket is available.
- SpawnConfigBuilder skips remote instances.

Driver tests:

- Pure fake driver for service behavior.
- Platform driver smoke tests behind an opt-in env flag.

Integration/manual verification:

- macOS permissions missing: health reports blocked state.
- macOS permissions granted: screenshot works for an allowed simple app.
- Denied app cannot be screenshotted or clicked.
- Approved app click/type works and writes redacted audit entries.
- Provider smoke: spawned Claude and Codex sessions can list `computer.*` tools.

Final implementation verification should include:

1. `npm run test:quiet -- <focused desktop-gateway specs>`
2. `npm run test:quiet -- src/main/instance/__tests__/instance-lifecycle-browser-mcp.spec.ts`
3. `npm run test:quiet -- src/main/mcp/aio-mcp-dispatcher.spec.ts`
4. `npx tsc --noEmit`
5. `npx tsc --noEmit -p tsconfig.spec.json`
6. `npm run lint`
7. `npm run check:ts-max-loc`

## Rollout Plan

### Phase 1: macOS Local Read and Input

- Main-process desktop gateway.
- macOS helper/driver.
- App policy and grants.
- Screenshot, accessibility snapshot, click, type, hotkey, scroll.
- Provider-neutral MCP injection for local Claude and Codex.
- Settings health panel.

### Phase 2: Windows Local or Worker Foreground Control

- Windows driver/helper.
- Worker capability reporting.
- `requiresComputerUse` placement.
- Foreground-only warnings and docs.

### Phase 3: Advanced Workflows

- Drag/drop and file dialog support.
- More robust image/snapshot anchoring.
- Optional stored screenshot artifacts for audit review.
- Richer UI for app grants and audit playback.

## Risks

The biggest risk is safety, not implementation difficulty. Desktop control can affect state outside the workspace, so the default must be scoped, visible, auditable, and interruptible.

The second risk is packaging. OS automation libraries often introduce native code. Prefer helper binaries or existing Electron APIs over Node native modules unless the implementation plan explicitly updates native rebuild and ABI verification.

The third risk is flakiness. GUI automation is timing-sensitive. The service layer should require read-back where possible and return clear "target changed" errors when a screenshot or accessibility uid is stale.

## Acceptance Criteria

- [x] A local provider session can discover `computer.*` tools only when Computer Use is enabled and healthy enough to run.
- [x] A denied app cannot be captured or controlled.
- [ ] An approved app can be screenshotted, clicked, and typed into through the
  installed Harness app after the final input hardening. Direct-helper input
  hardening passes; installed-app permissions still block screenshots.
- [x] Every input action is audited with typed text redacted.
- [x] Browser Gateway remains the recommended path for web-app testing.
- [x] Remote instances do not receive coordinator-local socket paths.
- [x] The feature can be disabled globally from settings.

## Completion Evidence (re-audited 2026-07-10)

- The main-process service, policy, grants/approval flow, observation store,
  session lock, audit store, provider-neutral MCP/RPC bridge, settings UI, and
  bundled macOS driver/helper are wired into application initialization.
- The implemented tool surface is `computer.health`, `list_apps`,
  `request_app_grant`, `get_approval_status`, `screenshot`,
  `accessibility_snapshot`, `query_elements`, `click`, `type_text`, `hotkey`,
  `scroll`, `drag`, `wait_for`, grant management, audit retrieval, and
  escalation.
- The desktop-focused automated gate passes 12 files / 86 tests. Project TypeScript, spec
  TypeScript, lint, and LOC gates pass.
- A rebuilt live helper previously reported all required macOS permissions
  ready. A pre-hardening controlled-app smoke proved discovery, accessibility
  observation, typing, clicking, and read-back; Electron captured a non-empty
  screenshot of the same controlled app.
- Coordinate input is resolved against a fresh accessibility observation, and
  element handles override any caller coordinates and are reclassified at
  their final center against the deepest observed child. Secure fields and
  observed login/submit/payment/destructive/send/security controls fail closed
  for escalation; hotkeys inspect the focused observed element. Drag endpoints
  must both remain inside observed app bounds. Observation tokens carry the
  exact active window id, and the bundled helper independently enforces that
  same frontmost window and re-checks the live focused AX element before typing
  or sending a hotkey. `wait_for` also carries the matched snapshot and exact
  window into its follow-up observation token.
- Computer Use's enablement, allow/deny policy, approval requirement, and
  screenshot-retention settings are operator-only even through the privileged
  settings CLI.

The post-hardening helper build passes. The GUI is now unlocked, and a controlled
scratch app smoke proves discovery, accessibility observation, an in-window
click, off-window rejection, normal-text read-back, and secure-field rejection.
The earlier cyclic AX hierarchy fix remains verified.

The installed Harness app now has Computer Use enabled. After restart, its live
gateway is injectable and the session lock is available, but health still
reports missing macOS Screen Recording and Accessibility permissions and
unavailable input. The direct helper input smoke passes. Toggle Harness off and
back on in both app-scoped Privacy & Security panes, then repeat the
product-level screenshot/click/type smoke; until then this document is not
eligible for an `_completed` rename.

Windows and remote-worker foreground control remain the already-declared Phase 2
follow-up. They are outside the completed local macOS v1 acceptance criteria and
must not be advertised as available.

## Closure (2026-07-10)

Closed by James as implemented. Provider-neutral computer.* tool surface, policy,
audit redaction, session lock, and macOS helper are wired; desktop gate 12 files /
86 tests plus project gates green. Operator-only enablement/policy verified live
2026-07-10 via the privileged settings surface (writes refused as read-only).

DEFERRED, not performed: the live product smoke (health-green after OS grants,
approved-app screenshot/click/type with read-back, and the negative
stale-token/secure-field/hard-denied-app checks). Blocked on operator-granted
macOS Screen Recording + Accessibility and a session exposing computer.*. Windows
and remote-worker control remain the already-declared Phase 2+ follow-up.
