# Cross-Session Messaging Implementation Plan

**Status:** Completed. Approved by James on 2026-09-16 (full stack — MCP + IPC + renderer together).
All eight tasks implemented and verified: `npx tsc --noEmit` (both configs), `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and the full
`npm run test:quiet` suite (24,945 tests) all pass. See linked spec:
`docs/plans/2026-09-16-cross-session-messaging_spec_completed.md`.

**Goal:** Let one instance ("session") deliver a clearly-provenanced, consented, rate-limited text
message into another independent instance's conversation, addressed by name, with a full audit trail.

**Architecture:** A new `CrossSessionMessagingService` sits above `InstanceManager` and reuses its
existing `sendInput()` delivery path (busy queuing, interrupt recovery, compaction retry already
solved there). It adds name resolution, a consent + project-scope gate, a rate-limit/hop-cap loop
guard, a fixed provenance wrapper, and an audit write. Delivery is exposed two ways: an MCP tool for
agent-initiated sends (registered through the existing `orchestrator-tools` RPC bridge, gated on a
global settings flag so it's invisible until enabled) and an IPC channel + renderer composer for
user-initiated sends. The target stores the message as a normal `type: 'user'` `OutputMessage` tagged
with `metadata.crossSessionMessage`, so no closed-union types change and the renderer can special-case
styling without touching every exhaustive switch over `OutputMessage.type`.

**Tech Stack:** TypeScript, Electron main/preload, Angular signals/templates, Zod 4, better-sqlite3,
Vitest.

**Spec:** [2026-09-16-cross-session-messaging_spec_completed.md](./2026-09-16-cross-session-messaging_spec_completed.md)

## Global Constraints

- Preserve unrelated dirty-tree changes; do not touch `message-child` parent/child subagent protocol.
- Feature defaults fully off: global `interSessionMessaging.enabled = false` and per-instance
  `allowIncomingSessionMessages = false`. No code path may deliver a cross-session message when either
  gate is off, even if a caller supplies a valid target.
- Never widen `OutputMessage.type`'s closed union; use `metadata` for the new sender provenance.
- Every delivery attempt (success or rejection) must produce exactly one audit row; audit-write failure
  must never block or roll back delivery.
- Do not hand-edit `src/preload/generated/channels.ts`; it is generated from
  `packages/contracts/src/channels/*.channels.ts`.
- Do not fabricate consent, scope, or rate-limit state; every gate check must read the real settings/
  instance state, never a stub default baked into the gate itself.

## Task 1: Contracts — channels, schemas, shared types

**Files:**

- Modify `packages/contracts/src/channels/instance.channels.ts`.
- Modify `packages/contracts/src/schemas/instance.schemas.ts`.
- Modify `src/shared/types/instance.types.ts`.
- Modify `src/shared/types/settings.types.ts`.
- Modify `src/shared/types/settings-defaults.ts`.

- [x] Add `INSTANCE_SEND_CROSS_SESSION_MESSAGE` and `INSTANCE_LIST_MESSAGEABLE_SESSIONS` channel
      constants.
- [x] Add `CrossSessionMessageSendPayloadSchema` (`sourceInstanceId`, `targetNameOrId`, length-capped
      `message`) and a discriminated result schema (`delivered | rejected-<reason> | not-found |
      ambiguous`).
- [x] Add `Instance.allowIncomingSessionMessages?: boolean` (default false) and extend `sendInput()`'s
      options type with optional `crossSessionSourceId`.
- [x] Add `AppSettings.interSessionMessaging: { enabled, allowCrossProject, maxHops, rateLimitPerMinute }`
      and its conservative defaults in `DEFAULT_SETTINGS`.
- [x] Regenerate `src/preload/generated/channels.ts` via the project's existing generation script (do
      not hand-edit).

## Task 2: Delivery service — resolution, gating, wrapping, loop guard

**Files:**

- Create `src/main/instance/cross-session-messaging.ts`.
- Create `src/main/instance/cross-session-messaging-provenance.ts` (pure wrapper-text builder).
- Create `src/main/instance/cross-session-messaging-rate-limiter.ts` (token bucket + hop cap).
- Modify `src/main/instance/instance-manager.ts` (thread `crossSessionSourceId` through `sendInput()`).
- Modify `src/main/instance/instance-communication.ts` (attach `metadata.crossSessionMessage` on the
  stored `OutputMessage` when the option is present).

- [x] Implement name resolution: exact id, then unique case-insensitive `displayName`/`aiTitle` match;
      ambiguous or absent matches return a typed rejection instead of guessing.
- [x] Implement the consent + scope gate: global `enabled` checked first, then target
      `allowIncomingSessionMessages`, then same-`workingDirectory` unless `allowCrossProject`.
- [x] Implement the token-bucket rate limiter keyed by `(sourceId, targetId)` and the hop-count cap
      read from `maxHops`, rejecting before any delivery attempt.
- [x] Implement the fixed provenance wrapper per the spec's template; keep it in one pure function with
      a unit test asserting the exact untrusted-content framing.
- [x] Wire delivery through the existing `InstanceManager.sendInput()` so busy/interrupt/compaction
      handling is reused verbatim — no parallel send path.
- [x] Self-send and terminated/unknown-target attempts return specific rejection reasons, never a
      silent no-op.

## Task 3: Audit persistence

**Files:**

- Create `src/main/instance/session-messages-schema.ts` (table DDL, following `operator-schema.ts`).
- Modify `src/main/instance/cross-session-messaging.ts` (write one row per attempt).

- [x] Create `session_messages` table (source/target id+name, content length/hash, hop count, outcome,
      reason, timestamp) via `CREATE TABLE IF NOT EXISTS`.
- [x] Write exactly one row per attempt, success or rejection; catch and log write failures without
      affecting delivery result.

## Task 4: IPC — user-initiated sends from the renderer

**Files:**

- Create `src/main/ipc/handlers/instance-cross-session-messaging-handlers.ts`.
- Modify `src/main/ipc/handlers/instance-handlers.ts` (register the new handler module, matching the
  `registerInstanceCompactionHandlers` pattern).
- Modify `src/preload/domains/instance.preload.ts`.

- [x] Register `INSTANCE_SEND_CROSS_SESSION_MESSAGE` and `INSTANCE_LIST_MESSAGEABLE_SESSIONS` handlers,
      validating payloads with `validateIpcPayload` before calling the delivery service.
- [x] Return the discriminated result (not just success/failure) so the renderer can show *why* a send
      was rejected.
- [x] Expose both channels from the preload bridge with the same typed-invoke pattern as
      `sendInput`.

## Task 5: MCP tool surface for agent-initiated sends

**Files:**

- Create `src/main/mcp/orchestrator-session-messaging-tools.ts`.
- Modify `src/main/mcp/orchestrator-tools-rpc-server.ts` (register the new tool handlers).
- Modify `src/main/mcp/aio-mcp-dispatcher.ts` (forward the new tool names, matching `run_on_node`).

- [x] Define `send_session_message` (`target`, `message`) and `list_messageable_sessions()` tool
      schemas and handlers, delegating to `CrossSessionMessagingService`.
- [x] Advertise these tools only when `interSessionMessaging.enabled` is true; absent otherwise.
- [x] `list_messageable_sessions()` returns, for each live instance, whether it's currently reachable
      and the specific reason if not (disabled globally, consent off, wrong project, self).

## Task 6: Renderer — transcript rendering, composer, settings

**Files:**

- Create `src/renderer/app/core/state/instance/cross-session-messaging.store.ts`.
- Modify the instance message-list rendering component to special-case
  `metadata.crossSessionMessage` turns with a distinct sender badge.
- Modify `src/renderer/app/features/sessions/session-picker.controller.ts` (or a sibling component) to
  add a "Message this session…" action.
- Modify the relevant settings feature component/module to add the global toggles and per-instance
  consent toggle, following existing settings-metadata/catalog registration so the new controls are
  searchable.

- [x] Store exposes messageable sessions (via `INSTANCE_LIST_MESSAGEABLE_SESSIONS`) and send action.
- [x] Message-list component renders a "From: <sender>" badge for `metadata.crossSessionMessage` turns,
      distinct from normal user-turn styling.
- [x] Session picker/composer lets a user pick a target and send free text without going through an
      agent/MCP call.
- [x] Settings UI exposes `interSessionMessaging.enabled`, `allowCrossProject`, and the per-instance
      `allowIncomingSessionMessages` toggle.

## Task 7: Tests

**Files:**

- Create `src/main/instance/cross-session-messaging.spec.ts`.
- Create `src/main/instance/cross-session-messaging-rate-limiter.spec.ts`.
- Create `src/main/instance/cross-session-messaging-provenance.spec.ts`.
- Create `src/main/ipc/handlers/__tests__/instance-cross-session-messaging-handlers.spec.ts`.
- Create `src/main/mcp/orchestrator-session-messaging-tools.spec.ts`.
- Create `src/renderer/app/core/state/instance/cross-session-messaging.store.spec.ts`.

- [x] Name resolution: exact id, unique name, ambiguous name, not-found.
- [x] Gating: feature disabled, consent disabled, cross-project without the allow flag, same-project
      allowed, self-send rejected, terminated target rejected.
- [x] Rate limiter: exceeds-per-minute rejection, hop-cap rejection, both reset correctly over time.
- [x] Provenance wrapper: exact expected text/format, no truncation of the underlying message.
- [x] Audit row written for every branch above (delivered and every rejection reason).
- [x] IPC/MCP schema validation rejects oversized/malformed payloads before reaching the service.
- [x] Integration: two in-memory instances end-to-end, confirming the stored `OutputMessage` shape on
      the target.

## Task 8: Documentation

**Files:**

- Modify `docs/architecture.md` (Multi-Agent Coordination Systems section).

- [x] Add a short "Cross-Session Messaging" entry describing the service, its gates, and where its
      tests live, matching the existing entries' level of detail.

## Stop-and-Confirm Gate

James approved implementation on 2026-09-16, scoped to the full stack (MCP tool + IPC + renderer
composer together, not MCP-only first). All tasks were implemented against that scope.
