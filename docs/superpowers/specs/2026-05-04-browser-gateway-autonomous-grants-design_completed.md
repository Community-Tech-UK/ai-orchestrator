# Browser Gateway Autonomous Grants - Design

**Date:** 2026-05-04
**Status:** Completed, validated 2026-05-07
**Owner:** James (shutupandshave)

This design is retained as the Browser Gateway grant/approval architecture record. The implementation now includes grant storage, approval requests, action classification, upload policy, mutating browser actions, grant-aware auditing, renderer grant controls, and MCP/RPC forwarding through the Browser Gateway service.

## 1. Overview

The first Browser Gateway milestone gives agents managed Chrome profiles with read-only and navigation tools. The next milestone adds controlled mutation so unattended workflows can continue after the user steps away.

The product requirement is practical: a user should be able to approve browser control once for a bounded session, then let an agent keep working overnight. The system must also support a stronger explicit autonomous mode for cases where the user wants final submit, publish, send, or delete actions to execute without another prompt.

This milestone introduces **Browser Gateway grants**:

- **Per-action approval:** one risky action requires one approval.
- **Session grant:** one approval covers selected origins, profiles, action classes, and expiry.
- **Autonomous grant:** a session grant with explicit permission for unattended execution of selected high-risk action classes.

All grant modes still route through Browser Gateway policy, audit, redaction, and the main-process driver. Provider MCP bridge processes must not gain direct Puppeteer, CDP, SQLite, profile path, or debug endpoint access.

## 2. Goals

- Add a safe path for `browser.click`, `browser.type`, `browser.fill_form`, `browser.select`, and `browser.upload_file`.
- Let the user approve once for a bounded browser session instead of approving every low-risk input step.
- Let the user opt into unattended autonomous execution, including submit/publish/delete when explicitly enabled.
- Preserve hard boundaries for credentials, 2FA, CAPTCHA, account/security settings, and origins outside the grant.
- Audit both grant decisions and every browser action executed under a grant.
- Keep Browser Gateway as the only execution path for managed logged-in profiles.
- Make `requestId` mandatory for every `requires_user` result in this slice so agents and the UI have a stable resume/poll token.

## 3. Non-Goals

- Do not expose raw Puppeteer/CDP methods, page JavaScript evaluation, cookie access, local storage dumps, or raw coordinate-only clicking to agents.
- Do not make autonomous grants global or indefinite.
- Do not allow remote workers to control local browser profiles in this slice.
- Do not implement Existing Tab Mode or the Chrome extension/native messaging host in this slice.
- Do not bypass 2FA, CAPTCHA, anti-automation, or platform review gates.

## 4. Grant Modes

### 4.1 Per-Action Approval

Per-action approval is the conservative fallback. Browser Gateway returns `requires_user` with a request ID, records an audit entry, and stores a pending approval request. The renderer shows the action context and the user can allow or deny it.

An approved per-action grant is single-use. The first matching execution consumes it, records `consumedAt`, and excludes it from future grant matching.

Use this when:

- no matching grant exists,
- the action is classified as unknown,
- the action touches a sensitive field,
- the action is outside the current session grant,
- the action requires a stronger autonomous grant than the active grant provides.

### 4.2 Session Grant

A session grant covers a bounded set of actions for one agent/session. Scope includes:

- `instanceId`,
- provider,
- profile ID,
- optional target ID,
- allowed origin patterns,
- allowed action classes,
- optional upload roots,
- expiry timestamp,
- whether cross-origin navigation within the profile allowlist is allowed.

Session grants are the default ergonomic mode. They should be easy to approve from the Browser page when the user starts a managed profile workflow.

Default suggested expiry: 8 hours.

### 4.3 Autonomous Grant

An autonomous grant is a session grant with unattended execution enabled. It has explicit toggles for dangerous action classes:

- input,
- file upload,
- submit/publish/send,
- delete/destructive,
- cross-origin navigation within the profile's existing allowlist.

The user may explicitly allow submit/publish/delete actions for the session. The UI must present those toggles separately from ordinary input so that enabling autonomous browsing does not silently include high-risk operations.

Default suggested expiry: 8 hours. Maximum expiry for this milestone: 24 hours.

The profile allowlist remains the upper bound. An autonomous grant may allow navigation from one approved origin to another approved origin, but it must not widen `profile.allowedOrigins`.

## 5. Hard Stops

Browser Gateway must still stop and require the user for these cases in this milestone:

- password, token, recovery code, 2FA, passkey, or CAPTCHA entry,
- account/security settings changes,
- payment method changes,
- origin outside the profile allowlist or outside the grant,
- file upload outside approved roots,
- local secret/profile/system paths,
- raw coordinate-only click requests with no element context,
- driver uncertainty where the target element cannot be matched to the approved action context.

If the user explicitly allowed destructive or submit classes in autonomous mode, those actions may execute only when classification and element context match the grant. Unknown destructive-looking actions remain `requires_user`.

## 6. Action Classification

Every mutating action must be classified before execution.

Inputs used by the classifier:

- current URL and origin,
- profile ID and target ID,
- requested tool name,
- selector or element reference,
- accessible role/name when available,
- visible text near the element when available,
- input type/name/placeholder/label for typing and form filling,
- file path and detected file type for uploads,
- action verb requested by the agent.

Trust ranking:

1. Browser Gateway-observed state: current URL, origin, profile, target, and resolved element metadata.
2. Driver-inspected DOM/accessibility context: role, accessible name, input type, labels, form action, nearby controls, and element attributes.
3. Upload metadata resolved in the main process.
4. Agent-supplied action hints.

Agent-supplied action hints are never authoritative. If the agent hint conflicts with inspected element context, classify as `unknown`.

Action classes:

- `input`: ordinary non-secret typing, selection, checkbox/radio changes, low-risk clicks,
- `credential`: password/token/2FA/recovery-code/passkey/CAPTCHA fields,
- `file-upload`: selecting a local file,
- `submit`: save, submit, publish, send, invite, purchase, confirm,
- `destructive`: delete, remove, revoke, reset, archive when irreversible, price/account/security changes,
- `unknown`: insufficient context or ambiguous action.

Classification is intentionally conservative. If labels conflict or the element cannot be inspected, classify as `unknown`.

Benign page labels must not de-escalate risky cues. The classifier should scan role/name/text, form action, URL path, IDs/classes/names, `aria-*` attributes, sibling buttons, and nearby destructive words. Any destructive or submit cue escalates the class. A page can still mislabel a dangerous action with no observable cue; that is an accepted residual risk and why submit/destructive classes require explicit autonomous toggles.

For `fill_form`, classify every field independently. If any field classifies as `credential` or `unknown`, the whole request returns `requires_user` and no fields are modified.

Driver support required before classification:

- Add a main-process-only element inspection method to `PuppeteerBrowserDriver`.
- Mutating payloads must identify an element by selector or future Browser Gateway element reference; raw coordinate-only requests are denied.
- Missing element inspection data classifies as `unknown`.

## 7. Data Model

Replace the existing exported browser grant contract with a v2 grant shape. The first milestone defines `BrowserPermissionGrant` in contracts but does not persist or execute grants, so this slice should update the contract before any consumer depends on the old singular `actionClass`/`originPattern` shape.

New or replacement concepts:

- `BrowserGrantMode`: `per_action`, `session`, `autonomous`.
- `BrowserPermissionGrant.mode`: grant mode.
- `BrowserPermissionGrant.allowedActionClasses`: action class array. Per-action grants use an array with one class.
- `BrowserPermissionGrant.allowedOrigins`: `BrowserAllowedOrigin[]`. These origins must be a subset of `profile.allowedOrigins`.
- `BrowserPermissionGrant.allowExternalNavigation`: boolean.
- `BrowserPermissionGrant.uploadRoots`: optional approved roots for upload actions.
- `BrowserPermissionGrant.autonomous`: boolean.
- `BrowserPermissionGrant.expiresAt`: required.
- `BrowserPermissionGrant.revokedAt`: optional timestamp.
- `BrowserPermissionGrant.consumedAt`: optional timestamp for single-use per-action grants.
- `BrowserPermissionGrant.decidedBy`: `user`, `timeout`, or `revoked`. Do not emit `auto_policy` for browser grants in this slice.
- `BrowserApprovalRequest`: pending request record with request ID, grant proposal, action context, decision status, and expiry.
- `BrowserGatewayResult`: make `requestId` required when `decision === "requires_user"`.
- `BrowserAuditEntry`: add `grantId?: string` and `autonomous?: boolean`.

`BrowserApprovalRequest` fields:

- `id` / `requestId`,
- `instanceId`,
- `provider`,
- `profileId`,
- `targetId`,
- `toolName`,
- `action`,
- `actionClass`,
- `origin`,
- `url`,
- `selector` or element reference, redacted before persistence,
- safe element context,
- optional file path and detected file type for uploads,
- proposed grant scope,
- status: `pending`, `approved`, `denied`, `expired`,
- `grantId` when approval created a grant,
- `createdAt`, `expiresAt`, `decidedAt`.

The migration should not overload the generic permission-decision table. Browser grants and browser approval requests should remain browser-specific persistence.

Reserve migration `024_browser_gateway_grants_and_approvals` for:

- `browser_permission_grants`,
- `browser_approval_requests`,
- `grant_id` and `autonomous` columns on `browser_audit_entries`,
- indexes for active grants by instance/profile/origin/expiry and approval requests by status/created time.

The grant schema must enforce `expiresAt - createdAt <= 86_400_000` for autonomous grants.

## 8. Execution Flow

For a mutating tool call:

1. Validate IPC/RPC/MCP payload with Zod.
2. Resolve profile and target.
3. Verify the current origin is allowed by the profile.
4. Inspect the target element or input context.
5. Classify the action.
6. Check for a matching active grant.
7. If no matching grant exists, create a pending approval request and return `requires_user`.
8. If a matching grant exists, re-check the grant immediately before execution to catch revocation, expiry, consumption, or live-origin changes.
9. Execute through `PuppeteerBrowserDriver`.
10. Refresh target metadata after execution.
11. Record audit entry with the grant ID, action class, decision, outcome, origin, URL, and redacted summary.

Approval resolution:

1. Renderer approves or denies a pending request.
2. Browser Gateway records the decision.
3. If approved, Gateway creates a grant according to the selected scope.
4. The original MCP call does not block waiting for approval. Approval never auto-executes the original browser action. The agent polls request status or retries the original tool call with the returned request ID after approval.

If a grant is revoked, consumed, expires, or the live page origin changes between classification and the driver call, Browser Gateway must not execute. It returns a non-running result and records an audit entry.

## 9. Tool Surface

Add provider-facing tools:

- `browser.click`
- `browser.type`
- `browser.fill_form`
- `browser.select`
- `browser.upload_file`
- `browser.request_grant`
- `browser.get_approval_status`
- `browser.list_grants`
- `browser.revoke_grant`

Renderer-only or trusted IPC operations:

- get approval request status,
- list pending approval requests,
- approve request,
- deny request,
- revoke grant,
- create a session/autonomous grant from the Browser page.

Agent tools may request a grant, but only the renderer/user can approve it.

Add Browser IPC channels and Zod schemas for:

- `browser:list-approval-requests`,
- `browser:get-approval-request`,
- `browser:approve-request`,
- `browser:deny-request`,
- `browser:get-approval-status`,
- `browser:create-grant`,
- `browser:list-grants`,
- `browser:revoke-grant`.

Provider RPC may expose status/list/revoke/request tools, but approval and direct grant creation stay trusted-renderer-only.

Provider-visible approval status is scoped by `instanceId`. A provider/instance cannot read or infer another instance's approval requests, even if it guesses or receives a request ID.

## 10. Upload Policy

Uploads require file-path validation before approval or execution.

Rules:

- resolve symlinks before comparing roots,
- allow only workspace roots or user-approved roots,
- block Electron `userData`, Chrome profile directories, SSH keys, shell history, keychains, password manager exports, `.env` files, and common secret filenames,
- do not auto-upload hardlinked files under session/autonomous grants; `stat.nlink > 1` requires per-action approval because the source path cannot be proven from the approved root alone,
- detect file type with magic bytes where possible, not extension alone,
- include exact file path and detected file type in the approval UI,
- never return file contents to the agent as part of the approval result.

File paths are resolved in the Electron main process. `~` expands relative to the local OS user running Orchestrator; relative paths resolve against the relevant workspace root, not the MCP bridge child process.

## 11. Renderer UX

The Browser page should add:

- pending approval queue,
- active grants list with expiry and revoke controls,
- session grant creation control,
- autonomous mode toggle with separate dangerous-action toggles,
- persistent "autonomous active" indicator,
- one-click revoke-all control for active browser grants,
- grant scope preview showing profile, origins, action classes, upload roots, and expiry,
- recent audit entries filtered by grant/request ID.

The UI must not hide dangerous scopes behind a single generic "YOLO" switch. The user can choose YOLO, but final submit/publish/delete must be an explicit selected capability inside that mode. Enabling submit or destructive autonomous classes must require a typed confirmation using the profile label.

## 12. Audit and Redaction

Audit entries must record:

- action class,
- grant ID or request ID,
- instance/provider,
- profile/target,
- origin and URL,
- decision and outcome,
- redacted action summary,
- whether autonomous execution was used.

Audit summaries must not contain:

- typed credential values,
- uploaded file contents,
- cookies,
- authorization headers,
- local storage values,
- CDP debug endpoints or ports.

For ordinary text input, record field labels/selectors and value length, not the full value. Selectors can contain sensitive attribute values, so selectors must pass through existing Browser Gateway redaction helpers before persistence or agent return.

## 13. Threat Model Updates

Session/autonomous grants increase blast radius. Mitigations:

- grants are scoped by instance, provider, profile, origins, action classes, and expiry,
- grants are local-user scoped and revocable,
- MCP bridge remains a thin RPC client with no direct browser or DB access,
- risky action classes require explicit toggles,
- unknown actions require approval,
- all execution is audited,
- origin policy is checked before classification and before execution,
- upload paths are validated after symlink resolution,
- approval requests are rate-limited more tightly than ordinary RPC calls.

The system accepts that a local process running as the same OS user can inspect local profile data. This is the same trust boundary as managed Chrome profiles and Electron `userData`.

## 14. Testing Strategy

Unit tests:

- classifier maps common labels and input types to expected classes,
- credential/2FA/CAPTCHA fields are hard stops,
- grants match only correct instance/profile/origin/action/expiry,
- autonomous grants require explicit dangerous-action classes,
- upload path validation allows approved roots and blocks secrets/profile paths,
- upload validation rejects autonomous hardlinked uploads and uses magic-byte detection when available,
- `requestId` is required for `requires_user` schema results,
- approval status polling returns pending/approved/denied/expired without executing the original action,
- per-action grants are consumed after one matching execution,
- approval requests return `requires_user` without executing driver calls,
- revocation between classification and execution prevents the driver call,
- live-origin changes between classification and execution prevent the driver call,
- approved grants execute through the driver and audit the result,
- MCP bridge exposes mutating tools but still routes through main RPC.

Integration tests:

- BrowserGatewayService returns `requires_user` for ungranted click/type/upload,
- approving a session grant allows subsequent input action,
- autonomous grant with submit enabled allows a classified submit action,
- autonomous grant without submit enabled returns `requires_user`,
- audit log includes request/grant IDs and no sensitive values,
- classifier treats conflicting agent hints as `unknown`.

Manual smoke:

- launch managed profile,
- create session grant for a local test page,
- type into a harmless field,
- upload a harmless file from an approved temp/workspace root,
- verify revoke blocks the next mutation,
- verify YOLO submit executes only when submit class is enabled,
- use a prompt-injection test page where a destructive control is labeled as benign but has destructive DOM cues, and verify the classifier escalates or stops,
- verify a revoked grant blocks an action that was classified before revocation.

## 15. Implementation Slices

### Slice A: Contracts and Persistence

- Add schemas/types/channels for grants, approval requests, approval status, audit `grantId`/`autonomous`, and mutating tool payloads.
- Tighten `BrowserGatewayResult` so `requestId` is required for `requires_user`.
- Add RLM migration `024_browser_gateway_grants_and_approvals` and stores for browser grants and approval requests.
- Add safe DTO helpers.

### Slice B: Classification and Grant Policy

- Add classifier and grant matcher.
- Add upload path validator.
- Add element inspection DTOs and service tests for `requires_user`, grant match, expiry, revocation races, request status, and hard stops.

### Slice C: Mutating Driver Methods

- Add Puppeteer driver methods for click/type/fill/select/upload with post-action target refresh.
- Keep driver methods internal to main-process Browser Gateway.

### Slice D: BrowserGatewayService and RPC/MCP Wiring

- Add service methods and RPC method routing.
- Expose MCP tools through the existing stdio bridge.
- Keep approval resolution on trusted IPC only.

### Slice E: Renderer Approval and Grant UI

- Add pending approvals, active grants, revoke, and autonomous grant controls to the Browser page.
- Keep dangerous toggles explicit and auditable.

## 16. Success Criteria

- A user can approve a session grant once and let an agent perform repeated low-risk browser input actions within the scoped profile/origins until expiry or revoke.
- A user can explicitly enable autonomous submit/publish/delete for a session, and Browser Gateway can execute those classified actions without another prompt.
- Credential, 2FA, CAPTCHA, out-of-origin, secret upload, and unknown actions still stop for user approval.
- Every grant decision and execution outcome is visible in audit logs.
- Full typecheck, lint, contract checks, Browser Gateway targeted tests, and full Vitest pass.
