# Browser Gateway Autonomous Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scoped Browser Gateway grants so a user can approve once for a browser session, including explicit autonomous submit/delete permissions, while preserving policy, audit, and redaction.

**Architecture:** Browser Gateway remains the only privileged executor. Provider MCP bridge processes keep using the local RPC client and never import Puppeteer, CDP, SQLite, browser profile paths, or debug endpoints. Grants, approval requests, classification, upload validation, and mutating driver calls live in the Electron main process; renderer IPC is the only approval path.

**Tech Stack:** TypeScript 5.9, Electron 40 main process, Angular 21 standalone components/signals, better-sqlite3/RLM migration 024, Zod 4 contracts, Puppeteer/CDP, Vitest.

---

## File Map

### Contracts

- Modify: `packages/contracts/src/channels/browser.channels.ts`
- Modify: `packages/contracts/src/types/browser.types.ts`
- Modify: `packages/contracts/src/schemas/browser.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts`
- Regenerate: `src/preload/generated/channels.ts`

### Main Process

- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Create: `src/main/browser-gateway/browser-approval-store.ts`
- Create: `src/main/browser-gateway/browser-grant-store.ts`
- Create: `src/main/browser-gateway/browser-action-classifier.ts`
- Create: `src/main/browser-gateway/browser-grant-policy.ts`
- Create: `src/main/browser-gateway/browser-upload-policy.ts`
- Modify: `src/main/browser-gateway/browser-audit-store.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service.ts`
- Modify: `src/main/browser-gateway/browser-gateway-rpc-server.ts`
- Modify: `src/main/browser-gateway/browser-mcp-tools.ts`
- Modify: `src/main/browser-gateway/puppeteer-browser-driver.ts`
- Modify: `src/main/browser-gateway/index.ts`
- Modify: `src/typings/puppeteer-core.d.ts`

### IPC, Preload, Renderer

- Modify: `src/main/ipc/handlers/browser-gateway-handlers.ts`
- Modify: `src/preload/domains/browser.preload.ts`
- Modify: `src/preload/preload.ts` only if generated type surface requires it.
- Modify: `src/renderer/app/core/services/ipc/browser-gateway-ipc.service.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.ts`

### Tests

- Modify: `packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts`
- Create: `src/main/browser-gateway/browser-grant-store.spec.ts`
- Create: `src/main/browser-gateway/browser-approval-store.spec.ts`
- Create: `src/main/browser-gateway/browser-action-classifier.spec.ts`
- Create: `src/main/browser-gateway/browser-grant-policy.spec.ts`
- Create: `src/main/browser-gateway/browser-upload-policy.spec.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service.spec.ts`
- Modify: `src/main/browser-gateway/puppeteer-browser-driver.spec.ts`
- Modify: `src/main/browser-gateway/browser-gateway-rpc-server.spec.ts`
- Modify: `src/main/browser-gateway/browser-mcp-tools.spec.ts`
- Modify: `src/main/ipc/handlers/__tests__/browser-gateway-handlers.spec.ts`
- Modify: `src/preload/__tests__/ipc-channel-contract.spec.ts`
- Modify or add: `src/renderer/app/features/browser/browser-page.component.spec.ts`

## Task 1: Contracts and Channels

- [ ] Write failing contract tests that assert:
  - `BrowserGatewayResultSchema` requires `requestId` when `decision === "requires_user"`.
  - `BrowserPermissionGrantSchema` accepts v2 grants with `mode`, `allowedActionClasses`, `allowedOrigins`, `autonomous`, `consumedAt`, and max 24h autonomous expiry.
  - `BrowserApprovalRequestSchema` validates pending approval requests.
  - Browser channel constants include approval/grant channels and mutating action channels.
- [ ] Run:

```bash
npx vitest run packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts packages/contracts/src/channels/__tests__/browser.channels.spec.ts
```

Expected: fail because the schemas/channels are not implemented yet.

- [ ] Update `packages/contracts/src/types/browser.types.ts` with v2 grant, approval request, action payload, and result union types.
- [ ] Update `packages/contracts/src/schemas/browser.schemas.ts` with matching strict Zod schemas.
- [ ] Update `packages/contracts/src/channels/browser.channels.ts`.
- [ ] Run the same targeted contract tests and `npm run generate:ipc`.

## Task 2: Persistence and Audit Columns

- [ ] Write failing store tests for `BrowserGrantStore` and `BrowserApprovalStore`.
- [ ] Add RLM migration `024_browser_gateway_grants_and_approvals` with `browser_permission_grants`, `browser_approval_requests`, and `grant_id`/`autonomous` audit columns.
- [ ] Implement grant and approval stores with JSON-backed scope fields.
- [ ] Extend `BrowserAuditStore` to persist/map `grantId` and `autonomous`.
- [ ] Run targeted store/audit tests.

## Task 3: Classification, Grant Matching, and Upload Policy

- [ ] Write failing classifier tests for submit/destructive escalation, credential hard stops, conflicting agent hints, and atomic `fill_form` field classification.
- [ ] Write failing grant-policy tests for instance/profile/origin/action/expiry matching, per-action consumption, revocation, autonomous dangerous toggles, and live-origin recheck inputs.
- [ ] Write failing upload-policy tests for symlink resolution, blocked secret/profile paths, hardlink per-action requirement, magic-byte detection, and workspace-root path resolution.
- [ ] Implement `browser-action-classifier.ts`, `browser-grant-policy.ts`, and `browser-upload-policy.ts`.
- [ ] Run targeted policy tests.

## Task 4: Puppeteer Driver Mutations

- [ ] Write failing driver tests for element inspection, click, type, fill, select, upload, and post-action target refresh.
- [ ] Extend the local `puppeteer-core.d.ts` stub with the minimal `Page`/`ElementHandle` methods used.
- [ ] Implement main-process-only driver methods; do not expose raw evaluate/CDP to bridge code.
- [ ] Run `npx vitest run src/main/browser-gateway/puppeteer-browser-driver.spec.ts`.

## Task 5: BrowserGatewayService Mutating Flow

- [ ] Write failing service tests for ungranted `click/type/upload` returning `requires_user` with `requestId` and no driver call.
- [ ] Write failing service tests for session/autonomous grant execution, submit gated by explicit class, per-action consumption, live-origin change stop, approval status scoping, and redacted audit values.
- [ ] Inject grant/approval stores, classifier, grant policy, and upload policy into `BrowserGatewayService`.
- [ ] Add service methods for mutating tools, grant request/list/revoke/status, and trusted approve/deny/create grant.
- [ ] Run `npx vitest run src/main/browser-gateway/browser-gateway-service.spec.ts`.

## Task 6: RPC, MCP, IPC, and Preload

- [ ] Write failing MCP/RPC tests that mutating tools route through RPC and approval/direct-grant IPC is trusted-renderer-only.
- [ ] Add RPC method cases and payload validation for provider-safe tools.
- [ ] Add MCP tools for mutating actions plus `request_grant`, `get_approval_status`, `list_grants`, and `revoke_grant`.
- [ ] Add browser IPC handlers for trusted approval/grant operations.
- [ ] Add preload/browser IPC service methods and regenerate IPC channels.
- [ ] Run targeted RPC/MCP/IPC/preload tests.

## Task 7: Renderer Grant UI

- [ ] Write or update Browser page tests for pending approvals, active grants, autonomous indicator, explicit dangerous toggles, typed confirmation, and revoke controls.
- [ ] Add Browser page state/actions for approval queue and grant list.
- [ ] Add compact approval/grant UI without changing the existing profile/target workflow.
- [ ] Run Browser page tests.

## Task 8: Verification

- [ ] Run targeted Browser Gateway suite:

```bash
npx vitest run \
  packages/contracts/src/channels/__tests__/browser.channels.spec.ts \
  packages/contracts/src/schemas/__tests__/browser.schemas.spec.ts \
  src/main/browser-gateway \
  src/main/ipc/handlers/__tests__/browser-gateway-handlers.spec.ts \
  src/preload/__tests__/ipc-channel-contract.spec.ts \
  src/renderer/app/features/browser/browser-page.component.spec.ts
```

- [ ] Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run verify:ipc
npm run verify:exports
npm run check:contracts
npm run test
npm run rebuild:native
node scripts/verify-native-abi.js
npm run build
git diff --check
```

Expected: all pass. If `npm run test` rebuilds native modules for Node, always run `npm run rebuild:native` before `verify-native-abi` and `build`.
