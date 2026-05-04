# AI Orchestrator Browser Gateway - Design

**Date:** 2026-05-03
**Status:** Draft, validation fixes applied, v1 driver/bridge decision recorded
**Owner:** James (shutupandshave)

## 1. Overview

AI Orchestrator should expose browser access as a provider-neutral capability, not as a Claude-only Chrome feature. The main use case is controlled access to logged-in browser sessions for operational workflows such as Google Play Console, App Store Connect, TestFlight-related tasks, Stripe dashboards, and similar sites. A secondary use case is isolated browser testing for local apps, QA flows, and reproducible automation.

The recommended product shape is an **AI Orchestrator Browser Gateway**. Claude, Codex, Gemini, Copilot, and future agents should ask Orchestrator for browser tools. Orchestrator then decides which browser target is available, whether the domain and action are allowed, whether the user must approve the next step, and which underlying implementation should execute the action.

The first implementation should prioritize **managed persistent Chrome profiles**. These profiles keep their own cookies, storage, and login state, separate from the user's daily Chrome profile. The extension bridge for "attach to the Chrome tab I already have open" should come second because it is more convenient but has a wider permission surface.

## 2. Goals

- Give every provider access to the same browser capability surface.
- Make logged-in session access ergonomic for high-frequency operational workflows.
- Keep browser access explicit, inspectable, and revocable.
- Avoid exposing the user's normal Chrome profile by default.
- Support "pause for user" flows for 2FA, CAPTCHA, sensitive review, and manual-only steps.
- Preserve a useful audit trail of agent browser actions.
- Build on the existing MCP and browser automation code instead of replacing it.

## 3. Non-Goals

- Do not build a general-purpose browser automation framework from scratch in v1.
- Do not grant agents silent access to the user's default Chrome profile.
- Do not let agents publish releases, change prices, delete resources, submit reviews, or send messages without an explicit approval boundary.
- Do not solve remote-worker browser access in v1. Local browser sessions live on the machine running Chrome.
- Do not attempt to bypass 2FA, CAPTCHA, anti-automation, app-store review gates, or platform policy checks.

## 4. Current Codebase Anchors

The repo already has useful building blocks:

- `docs/BROWSER_AUTOMATION_SETUP.md` documents Chrome DevTools MCP setup for Claude and authenticated sessions.
- `src/main/browser-automation/browser-automation-health.ts` detects browser automation readiness, browser runtime availability, Node availability, and existing Claude browser MCP config.
- `src/main/mcp/mcp-manager.ts` is a central MCP client that can add servers, connect, discover tools, call tools, and expose state.
- `src/main/mcp/provider-mcp-config-discovery.ts` discovers MCP configs for Claude, Codex, Gemini, Copilot, and Orchestrator bootstrap config.
- `src/main/ipc/handlers/mcp-handlers.ts` already exposes MCP server management, tool calls, and browser automation health over IPC.
- `src/main/instance/instance-lifecycle.ts` injects Orchestrator MCP config into spawned local Claude instances and deliberately avoids local config paths for remote workers.
- `src/main/cli/adapters/claude-cli-adapter.ts` always passes `--chrome` to Claude CLI instances.
- `src/main/cli/adapters/codex-cli-adapter.ts` currently strips MCP servers from Codex exec-mode homes for performance and context-size reasons, so browser MCP availability for Codex depends on Codex runtime mode.
- `src/main/mcp/mcp-server.ts` is currently an in-process MCP request handler, not a provider-callable transport. A Browser MCP server needs a real stdio, HTTP, or SSE bridge. `src/main/codemem/mcp-stdio-server.ts` is the closest existing stdio pattern.
- `src/renderer/app/features/mcp/mcp-page.component.ts` currently offers a raw `chrome-devtools` MCP preset. That must remain legacy/uncontrolled automation or be hidden for managed logged-in sessions so child agents cannot bypass Browser Gateway.
- New browser IPC contracts should follow the existing `packages/contracts` pattern. If a new `@contracts/schemas/browser` subpath is added, update `packages/contracts/package.json`, `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts`, and `src/main/register-aliases.ts` together so packaged Electron runtime resolution does not break.

These anchors imply that v1 should add a browser gateway service and browser-specific MCP surface on top of the existing MCP subsystem, rather than bolt browser control into each provider adapter independently.

## 5. V1 Decision Record

For the first managed-profile milestone, use **direct Puppeteer/CDP in the Electron main process** as the v1 driver for read-only and navigation operations. Chrome DevTools MCP remains a future internal driver option behind Browser Gateway, not the v1 provider-facing or profile-owning driver.

Reasons:

- The repo already depends on `puppeteer-core`.
- Orchestrator must own Chrome launch, profile directories, target registry, policy, and audit in one process.
- The provider-facing MCP bridge runs as a separate stdio child process, so it cannot safely call main-process singletons directly and must not open its own Puppeteer or SQLite access.

Provider MCP bridges call the main-process gateway over a local JSON-RPC socket or named pipe. The bridge process holds no Puppeteer handle, no SQLite handle, and no Chrome DevTools endpoint.

## 6. External Reference Findings

Current external docs support this direction:

- Chrome's agent docs say Chrome DevTools MCP works with agents that support MCP servers, including Gemini CLI, Claude Code, Codex, and more. They also publish direct install commands for Gemini, Claude, and Codex. Source: https://developer.chrome.com/docs/devtools/agents
- The `chrome-devtools-mcp` package exposes live Chrome automation, screenshots, console/network inspection, file upload, and performance tools. It supports persistent `--userDataDir`/`--user-data-dir`, temporary `--isolated`, `--browserUrl`/`--browser-url` for an existing debug target, and `--autoConnect`/`--auto-connect` for supported running Chrome instances. Source: https://github.com/ChromeDevTools/chrome-devtools-mcp
- The same package warns that MCP clients can inspect, debug, and modify browser data, and that a remote debugging port allows local applications to control the browser. It also enables usage statistics and CrUX URL lookups by default, and network header redaction is opt-in. Source: https://github.com/ChromeDevTools/chrome-devtools-mcp
- MCP tools are model-controlled, but the spec recommends visible exposed tools, tool invocation indicators, confirmation prompts for sensitive operations, input validation, access control, rate limiting, output sanitization, timeouts, and audit logging. Source: https://modelcontextprotocol.io/specification/2024-11-05/server/tools
- Chrome DevTools Protocol is the underlying protocol for instrumenting, inspecting, debugging, and profiling Chrome/Chromium-based browsers. Source: https://chromedevtools.github.io/devtools-protocol/
- Chrome extension native messaging can connect an extension to a native host process over stdio, which is the appropriate bridge shape for an installed Orchestrator extension. Source: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Playwright browser contexts provide isolated sessions, which remains useful for disposable test mode, but persistent logged-in profiles are better for the user's dominant operational workflow. Source: https://playwright.dev/docs/browser-contexts

## 7. Product Modes

### 7.1 Session Browser Mode

Session Browser Mode is the default for the user's expected 95 percent case. It uses managed persistent Chrome profiles owned by AI Orchestrator.

Examples:

- `Google Play` profile: logged into Google Play Console and related Google developer surfaces.
- `Apple Developer` profile: logged into App Store Connect and developer.apple.com.
- `Finance/Ops` profile: logged into Stripe, analytics, or support dashboards when explicitly configured.

Each profile has:

- stable profile ID,
- human label,
- user data directory path,
- allowed domains,
- optional default start URL,
- remote debugging port assigned by Orchestrator,
- current process status,
- open target list,
- last manual-login check,
- last agent access time.

Agents can open a profile, list pages, navigate within allowed domains, inspect the page, take screenshots, and pause for manual login or review through the gateway. Typing, clicking, form filling, and file upload are only exposed after Browser Gateway has action classification, approvals, audit logging, and redaction in place. Sensitive submit-like actions always require approval.

### 7.2 Isolated Browser Mode

Isolated Browser Mode is for tests, local apps, reproductions, and lower-trust browsing. It launches temporary profiles or Playwright-style contexts that do not retain cookies/storage between runs unless explicitly saved as a fixture.

Examples:

- test a local Angular app at `localhost`,
- reproduce a layout issue,
- run a Lighthouse/performance check,
- validate a form without real account data,
- let a child agent explore without touching logged-in accounts.

### 7.3 Existing Tab Mode

Existing Tab Mode attaches to a real tab already open in the user's Chrome profile through an Orchestrator Chrome extension and native messaging host. This is convenient for "use the tab I am looking at", but it is v2 because it has the broadest privacy and permission implications.

The extension should not grant blanket browser access. It should expose only selected tabs after user action from the extension popup or Orchestrator UI.

## 8. Architecture

```
Claude / Codex / Gemini / Copilot / child agents
        |
        | MCP tools, Orchestrator tools, or provider-native MCP
        v
Browser MCP stdio bridge
        |
        | local JSON-RPC socket / named pipe
        v
AI Orchestrator Browser Gateway
        |
        | target registry, profile registry, policy, permissions, audit
        v
Browser Driver Layer
        |
        | Puppeteer/CDP in main process, future Chrome DevTools MCP, Playwright, extension native host
        v
Chrome managed profiles / isolated sessions / selected existing tabs
```

### 8.1 Main Process Services

`BrowserProfileRegistry`

- Stores configured managed profiles.
- Owns profile metadata and allowed-domain lists.
- Does not store browser cookies itself; Chrome owns profile state in `userDataDir`.

`BrowserTargetRegistry`

- Tracks active browser processes, CDP endpoints, pages/tabs, selected targets, and target health.
- Normalizes targets across managed profiles, isolated sessions, and extension-attached tabs.

`BrowserGatewayService`

- Provider-neutral facade for browser operations.
- Applies domain and action policy before executing operations.
- Routes to Chrome DevTools MCP, direct CDP/Puppeteer, Playwright, or extension bridge.
- Converts underlying tool results into stable Orchestrator results.

`BrowserPermissionService`

- Classifies actions as read, input, navigation, file upload, destructive, publish/submit, credential, or unknown.
- Requires user approval for risky classes.
- Maintains short-lived grants scoped by instance, profile, domain, action class, and expiry.

`BrowserAuditLog`

- Records who did what, where, and when.
- Stores high-level action summaries and optional screenshot references.
- Redacts field values by default, especially password, token, auth, cookie, and payment fields.

`BrowserMcpServer`

- Exposes stable browser tools to any model that can use MCP.
- Calls the main-process `BrowserGatewayService` over a local JSON-RPC socket or named pipe; it does not talk to Chrome directly.
- Allows Orchestrator to enforce policy centrally even when the calling provider supports native MCP.
- Provides a concrete provider-callable stdio transport patterned after `src/main/codemem/mcp-stdio-server.ts`, then registers that bridge in provider MCP configs. Registering tools only in the in-process `McpServer` singleton is not sufficient.
- Holds no Puppeteer, CDP, SQLite, or Chrome DevTools MCP access. This prevents the bridge from bypassing main-process origin policy, target ownership, and audit logging.

`BrowserGatewayRpcServer`

- Runs in the Electron main process.
- Opens a per-app-run random local socket path under `userData` on Unix or a named pipe on Windows.
- Exposes only the `BrowserGatewayService` public surface.
- Validates every request with the same Zod schemas used by browser IPC handlers.
- Rejects oversized payloads and unauthenticated bridge calls.

`BrowserGatewayRpcClient`

- Runs in the MCP stdio bridge child process.
- Reads `AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET` and `AI_ORCHESTRATOR_BROWSER_INSTANCE_ID` from the environment.
- Forwards one MCP tool call to one main-process JSON-RPC request and returns the structured gateway result.

### 8.2 Renderer UI

Add a Browser page or settings tab with these sections:

- Profiles: create, launch, stop, login/check, allowed domains, default URL.
- Active sessions: browser process status, selected target, open tabs, screenshots.
- Permissions: pending approvals, active grants, recent denied actions.
- Audit: recent browser actions, instance/provider source, target, result.
- Health: Node, Chrome, Browser Gateway MCP bridge, child Chrome DevTools MCP or CDP driver, extension bridge, profile state.
- Legacy browser MCP: clearly label any direct `chrome-devtools` server as uncontrolled/raw browser automation, not a managed session capability.

The UI should prefer operational density over a marketing-style layout. This is a control surface for repeated work.

## 9. Tool Surface

The gateway should expose a small stable tool set even if the underlying driver has more tools.

Read and session tools for the first safe milestone:

- `browser.list_profiles`
- `browser.open_profile`
- `browser.close_profile`
- `browser.list_targets`
- `browser.select_target`
- `browser.snapshot`
- `browser.screenshot`
- `browser.console_messages`
- `browser.network_requests`

Navigation tools for the first safe milestone:

- `browser.navigate`
- `browser.wait_for`

Gated input and mutation tools, exposed only after policy, approvals, audit, and redaction are implemented:

- `browser.click`
- `browser.type`
- `browser.fill_form`
- `browser.select`
- `browser.upload_file`

Human-in-the-loop tools:

- `browser.request_user_login`
- `browser.request_approval`
- `browser.pause_for_manual_step`

Diagnostics:

- `browser.health`
- `browser.get_audit_log`

Tool results should include enough structured data for agents to continue, but should avoid returning raw cookies, local storage dumps, authorization headers, CDP WebSocket URLs, debug ports, debug endpoints, or full sensitive page text unless explicitly requested and approved. Agent-facing profile, target, health, and audit DTOs must use redacted/safe projections.

The gateway should not expose raw coordinate-click tools, raw page JavaScript evaluation, extension-install tools, cookie/local-storage dumps, or unfiltered network details to logged-in session profiles. If a lower-level driver requires one of those internally, only `BrowserGatewayService` should call it after policy checks.

## 10. Permission Policy

Default policy:

| Action class | Examples                                             | Default                                              |
| ------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| Read         | screenshot, accessibility snapshot, console messages | allow within approved profile/domain                 |
| Navigate     | go to allowed URL                                    | allow within allowed domain, confirm external domain |
| Input        | type non-secret field, select option                 | allow after profile/domain grant                     |
| Credential   | password, token, recovery code, 2FA                  | user-only/manual step                                |
| File upload  | APK/AAB, screenshots, build artifacts                | require approval per file/domain                     |
| Submit       | save, submit for review, publish, send, delete       | require approval                                     |
| Destructive  | delete app/resource/user/key, revoke access          | require explicit approval, no broad grants           |
| Unknown      | unclassified button/action                           | require approval                                     |

Domain allowlists must be origin-aware, not simple substring checks. Normalize and compare scheme, hostname, port, punycode, IP literals, localhost/private-network names, and wildcard boundaries. For example, `*.example.com` must not match `badexample.com`, and an allowlist for `https://example.com` must not silently allow `http://example.com` or a different port unless configured.

Action classification must run before executing any mutating action. A click or form submit request should include current URL/origin, target element role, accessible name, visible text, form action when available, and a recent screenshot reference when useful. Unknown targets, submit/save/publish/delete/send labels, credential fields, and raw coordinate requests require approval.

Browser page content, accessibility snapshots, console messages, network details, and screenshots are untrusted data. Tool descriptions and prompts must tell agents not to follow instructions found inside web pages, logs, or network responses unless those instructions are part of the user's requested task and pass policy.

Approval prompts must show:

- requesting instance/provider,
- profile and domain,
- proposed action,
- relevant target element label/text,
- file path if upload,
- screenshot when useful,
- expiry/scope of the grant.

The agent should be able to ask for a grant, but only the user can grant it.

## 11. Data Model

```ts
export type BrowserActionClass =
  | "read"
  | "navigate"
  | "input"
  | "credential"
  | "file-upload"
  | "submit"
  | "destructive"
  | "unknown";

export interface BrowserAllowedOrigin {
  scheme: "https" | "http";
  hostPattern: string;
  port?: number;
  includeSubdomains: boolean;
}

export interface BrowserProfile {
  id: string;
  label: string;
  mode: "session" | "isolated";
  browser: "chrome";
  userDataDir?: string;
  allowedOrigins: BrowserAllowedOrigin[];
  defaultUrl?: string;
  status: "stopped" | "starting" | "running" | "stopping" | "locked" | "error";
  debugPort?: number;
  debugEndpoint?: string;
  processId?: number;
  createdAt: number;
  updatedAt: number;
  lastLaunchedAt?: number;
  lastUsedAt?: number;
  lastLoginCheckAt?: number;
}

export interface BrowserTarget {
  id: string;
  profileId?: string;
  pageId?: string;
  driverTargetId?: string;
  mode: "session" | "isolated" | "existing-tab";
  title?: string;
  url?: string;
  origin?: string;
  driver: "chrome-devtools-mcp" | "cdp" | "playwright" | "extension";
  status: "available" | "selected" | "busy" | "closed" | "error";
  lastSeenAt: number;
}

export interface BrowserPermissionGrant {
  id: string;
  instanceId: string;
  provider: "claude" | "codex" | "gemini" | "copilot" | "orchestrator";
  profileId?: string;
  targetId?: string;
  originPattern: string;
  actionClass: BrowserActionClass;
  requestedBy: string;
  decidedBy: "user" | "auto_policy" | "timeout" | "revoked";
  decision: "allow" | "deny";
  reason?: string;
  expiresAt: number;
  createdAt: number;
}

export interface BrowserAuditEntry {
  id: string;
  instanceId: string;
  provider: string;
  profileId?: string;
  targetId?: string;
  action: string;
  toolName: string;
  actionClass: BrowserActionClass;
  origin?: string;
  url?: string;
  decision: "allowed" | "denied" | "requires_user";
  outcome: "not_run" | "succeeded" | "failed";
  summary: string;
  redactionApplied: boolean;
  screenshotArtifactId?: string;
  requestId?: string;
  createdAt: number;
}
```

Storage should use the existing better-sqlite3 persistence layer for metadata and audit entries. Chrome profile data stays in Chrome user data directories. Add explicit migrations and stores for profiles, active target metadata, grants, and audit entries; do not overload the existing generic permission-decision table with browser-specific state.

`debugPort` and `debugEndpoint` are internal/runtime fields. They may be shown to the local human operator in the renderer, but they must be stripped from all agent-facing MCP results and audit summaries.

## 12. Driver Strategy

### 12.1 v1 Driver

Use direct Puppeteer/CDP in the Electron main process as the v1 driver for managed profiles. This is the resolved first-milestone decision, replacing the earlier open question about whether Chrome DevTools MCP or direct CDP should lead v1.

Orchestrator owns Chrome process launch, profile directory selection, remote debugging port assignment, target tracking, and shutdown. Browser Gateway records the debug endpoint internally, but provider-facing tools never receive it.

Use Chrome DevTools MCP later only as an internal driver behind the same gateway, if it proves better than direct CDP for specific operations. If a future slice adopts it, start the child Chrome DevTools MCP server with privacy-oriented flags where supported:

- `--redact-network-headers=true`
- `--no-usage-statistics` or `--usage-statistics=false`
- `--no-performance-crux` or `--performance-crux=false`

Raw Chrome DevTools MCP tools must still not be handed directly to every provider. Raw DevTools tools are powerful and too broad for logged-in operational sessions.

Do not wait for human approval inside a long-running child MCP tool call. Browser Gateway should return `requires_user` with a request ID quickly, let the renderer resolve the approval, then let the agent retry or continue. The existing MCP client manager has a fixed 30 second request timeout, so approval flows must not depend on blocking a child MCP request indefinitely.

### 12.2 Chrome DevTools MCP Adapter

Add Chrome DevTools MCP later only where the gateway benefits from its higher-level tools. It must connect to an Orchestrator-launched browser and remain behind the same policy/audit path.

### 12.3 Playwright Adapter

Use Playwright for isolated testing when it is already the better fit: reproducible contexts, local app flows, and screenshot-based regression checks. It is not the primary logged-in session mechanism.

### 12.4 Extension Adapter

Use a Chrome extension plus native messaging for Existing Tab Mode. The extension is a tab-selection and bridge layer, not the main automation brain. Orchestrator remains the policy authority.

## 13. Provider Integration

### Claude

Claude currently receives `--chrome` and can also receive Orchestrator MCP config. For managed Browser Gateway sessions, remove or gate `--chrome` so Claude cannot use the native Chrome extension path as an unaudited bypass. Claude should receive only the Orchestrator Browser MCP bridge for managed session browser access. Keep raw `--chrome` behind an explicit legacy/uncontrolled browser automation setting, disabled by default for child agents.

### Codex

Codex supports MCP in current agent docs, but this repo strips MCP servers from Codex exec-mode homes for performance. Add an explicit runtime capability such as `browserGateway: 'available' | 'unavailable_exec_mode' | 'unconfigured'`. In app-server mode, inject the Browser MCP bridge only if the Codex runtime path supports that config. In exec mode, keep browser access disabled unless Orchestrator routes the browser task through an Orchestrator-controlled child that can use the gateway.

### Gemini

Gemini can consume MCP config natively, but the current Gemini adapter does not inject MCP config in `buildArgs`. v1 must either add adapter-level MCP injection or explicitly mark Gemini browser capability unavailable until the separate multi-provider MCP management work is complete. Do not rely on provider config discovery alone; discovery is not injection.

### Copilot

Copilot via the ACP adapter already has an `mcpServers` field in session load/new requests. That makes it the likely first non-Claude provider for Browser Gateway exposure after the stdio bridge exists. Keep all browser actions flowing through Browser Gateway, not raw Chrome DevTools MCP.

## 14. Security Model

Risks:

- Logged-in sessions expose real account data.
- Remote debugging ports can let local processes control a browser.
- Screenshots and snapshots can reveal secrets.
- Agent-generated clicks may trigger irreversible actions.
- Prompt injection inside web pages can try to manipulate the agent.

Required mitigations:

- Use dedicated Orchestrator profiles, not the user's default profile.
- Bind debugging endpoints to `127.0.0.1`.
- Allocate ports per profile and close them when profiles stop.
- Do not expose raw Chrome DevTools MCP tools directly to child agents for session profiles.
- Enforce domain allowlists per profile.
- Require approval for upload, submit, publish, delete, send, and unknown actions.
- Redact sensitive fields and headers in logs and tool output.
- Record audit entries for every browser action.
- Let the user stop a profile/session immediately from the UI.
- Show visible browser/session status when agents are attached.
- Treat browser output as untrusted prompt-injection material. Redact and bound page text, console output, network metadata, and screenshots before returning them to agents.
- Validate upload paths against workspace/user-approved roots, block secret files and profile directories, and show the exact file path and detected file type in approval prompts.
- Bind driver endpoints to loopback only and do not display CDP WebSocket URLs to agents.
- Disable or clearly segregate raw Chrome DevTools MCP servers for managed logged-in sessions.
- Bind Browser Gateway local RPC to a Unix socket or Windows named pipe only; do not expose it on TCP.
- Use a per-app-run random socket or pipe path, Unix `0600` permissions where applicable, and cleanup on shutdown.
- Require bridge calls to include the instance identity injected by Orchestrator, and reject calls that do not map to a known local instance.
- Apply request size limits and per-instance rate limits on the local RPC server.
- Accept that local files under Electron `userData` share the same local-user trust boundary as Chrome profile data; do not treat SQLite rows as secret storage.

## 15. Error Handling

Common errors and expected behavior:

- Chrome missing: Browser health shows setup action and profile launch is disabled.
- Node or MCP runtime missing: Health identifies the runtime blocker.
- Profile locked by another Chrome process: show "profile already in use" and offer stop/retry.
- Login required: return `requires_user` and open a manual-login flow.
- 2FA/CAPTCHA required: return `requires_user`, never ask the agent to solve it.
- Domain blocked: deny action and show allowed domains.
- Approval timeout: fail the tool call with a clear timeout result.
- Driver crashed: mark target error, close process handle, preserve audit entry.
- Provider unsupported: surface a provider capability status explaining whether MCP injection is unavailable, disabled by exec mode, or blocked by settings.
- Raw browser tool requested: deny for managed profiles and point the agent to the Browser Gateway tool surface.
- Prompt-injection suspected: return a bounded/redacted result and require user confirmation before following page-provided instructions that alter the task.
- Browser Gateway RPC unavailable: MCP bridge tools return a structured denied/not-run result with reason `browser_gateway_unavailable`. No audit entry is expected because the bridge has no database access.
- Browser Gateway RPC unauthorized: reject the call before reaching the gateway service and log the local RPC failure in the main process.

## 16. Testing Strategy

Unit tests:

- profile registry CRUD and path validation,
- origin allowlist matching, including scheme, port, wildcard, punycode, IP, localhost, and private-network cases,
- action classifier,
- permission grant expiry and scope matching,
- audit redaction,
- Browser MCP tool schema validation,
- contract schema validation and package export/alias coverage if adding `@contracts/schemas/browser`,
- upload path validation and secret/profile directory blocking,
- child driver timeout handling and non-blocking approval request behavior.
- Browser Gateway RPC schema validation, socket/pipe availability, oversized payload rejection, and unavailable-gateway bridge behavior.
- agent-safe DTO projection that strips `debugPort`, `debugEndpoint`, and CDP WebSocket URLs.

Integration tests:

- launch isolated Chrome profile and take screenshot,
- launch persistent test profile and verify state persists,
- deny blocked-domain navigation,
- return `requires_user` for submit/upload action without executing it,
- verify MCP tool call routes through gateway service,
- verify raw Chrome DevTools MCP tools are not exposed to managed session agents,
- verify provider config injection for the first supported provider.
- verify the MCP bridge has no Puppeteer, CDP, SQLite, or Chrome DevTools access and reaches browser tools only through the local RPC client.

Manual verification:

- Google Play profile login pause and resume,
- App Store Connect profile login pause and resume,
- file upload dry run with a harmless local test page,
- stop profile from UI while an agent is attached,
- provider capability status for Claude, Codex, Gemini, and Copilot.

Standard verification after implementation:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- targeted Vitest specs for modified services, stores, IPC handlers, and provider adapters

## 17. Implementation Slices

### Slice 0: Contracts and MCP Bridge Groundwork

- Add browser schemas/types under `packages/contracts` or `src/shared` using the repo's existing IPC contract pattern.
- If using a new `@contracts/schemas/browser` subpath, update `packages/contracts/package.json`, `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts`, and `src/main/register-aliases.ts`.
- Add a provider-callable Browser MCP stdio bridge patterned after `src/main/codemem/mcp-stdio-server.ts`.
- Add the main-process Browser Gateway local RPC server and child-process RPC client.
- Register only read-only placeholder tool schemas at this stage; handlers should return `unavailable` until `BrowserGatewayService` exists.

### Slice 1: Browser Profile Registry and Health

- Add persisted profile metadata.
- Add IPC to list/create/update/delete profiles.
- Add health checks for Chrome, Node, Chrome DevTools MCP availability, and profile lock state.
- Add basic UI for profiles and health.
- Classify direct `chrome-devtools` MCP health as legacy/raw automation, not managed Browser Gateway readiness.

### Slice 2: Managed Session Launch

- Launch Chrome with dedicated `userDataDir`, `127.0.0.1` debugging port, and default URL.
- Track process lifecycle and active target list.
- Add manual login/check flow.
- Implement direct Puppeteer/CDP as the v1 managed-profile driver. Orchestrator must own the Chrome process.

### Slice 3: Policy, Permissions, Audit, and Redaction

- Add `BrowserGatewayService`.
- Add action classification.
- Add permission grants and approval UI.
- Add audit persistence and redaction.
- Add origin canonicalization and allowlist matching.
- Add non-blocking `requires_user` approval flow.
- Add prompt-injection handling guidance in tool descriptions and result shaping.

### Slice 4: Read-Only Browser Gateway Tools

- Add stable tool contracts and handlers for list/open/close/select/navigate/snapshot/screenshot/console/network/wait.
- Enforce domain allowlists and audit every call.
- Expose Browser Gateway through the Orchestrator Browser MCP bridge to one provider.
- Verify raw Chrome DevTools MCP tools are not exposed for managed session profiles.

### Slice 5: Gated Input and Upload Tools

- Add `browser.click`, `browser.type`, `browser.fill_form`, `browser.select`, and `browser.upload_file`.
- Require approval for upload/submit/destructive/unknown action classes before execution.
- Validate file upload paths and block secret/profile directories.
- Audit both approval decision and execution outcome.

### Slice 6: Provider Fan-Out

- Wire into provider spawn/config paths where safe: Claude via Orchestrator MCP config with raw `--chrome` gated off, Copilot/ACP via `mcpServers`, Codex only where runtime mode supports it, Gemini only after adapter injection exists.
- Surface capability status per provider, especially Codex app-server vs exec mode.

### Slice 7: Existing Tab Extension

- Build Chrome extension and native messaging host.
- Add selected-tab attach flow.
- Apply the same policy and audit path as managed profiles.

## 18. Open Decisions

- Exact profile storage location: likely under Electron `userData/browser-profiles/<profileId>`, but packaged-app behavior should be verified.
- Whether permission approvals reuse existing deferred permission UI or get a browser-specific approval panel. The approval shape must still include browser-specific origin, target element, file path, screenshot, and grant expiry fields.
- Whether raw page snapshots should be stored in audit logs or only transiently returned to agents.
- How much provider-native MCP config fan-out should be bundled with this feature versus relying on the separate MCP multi-provider management design. Copilot/ACP is the likely first non-Claude target because the adapter already accepts `mcpServers`.

## 19. Recommended First Milestone

Build **Session Browser Mode for managed profiles**, with one profile that can:

1. launch a dedicated Chrome profile,
2. pause for the user to log in,
3. navigate within an allowed domain,
4. take screenshot/snapshot,
5. record an audit trail for every browser action,
6. return `requires_user` for actions outside the read-only/navigate surface,
7. expose the read-only capability to at least one non-Claude provider through the Browser Gateway MCP surface.

That milestone proves the core value for Google Play and App Store Connect without taking on the extension bridge, broad provider fan-out, or mutating actions immediately. Add click/type/upload only in the next milestone after policy, approval UI, audit, redaction, and upload validation are verified.
