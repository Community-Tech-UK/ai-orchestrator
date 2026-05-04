# Conversation Ledger And Codex Native Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Orchestrator-owned durable conversation ledger and a Codex native conversation adapter foundation so AI Orchestrator can discover, index, create, resume, and continue durable Codex-backed conversations while preserving source provenance and keeping Orchestrator writable and authoritative.

**Architecture:** Add a main-process `conversation-ledger` subsystem backed by SQLite through the existing `SqliteDriver` abstraction. Store provider-neutral thread/message records in the ledger, register provider-native adapters behind a typed interface, and implement Codex first. Codex uses app-server for writable durable operations and JSONL rollout parsing for import/reconciliation. Existing `HistoryManager` remains the archive/search surface for terminated sessions; this plan adds the canonical live/native ledger beside it and bridges later.

**Tech Stack:** TypeScript 5.9, Electron 40 main process, better-sqlite3 via `src/main/db/sqlite-driver.ts`, Zod 4 for IPC schemas, Vitest, existing Codex app-server client and JSONL session scanner.

**Related Docs:**

- [`../specs/2026-05-02-ai-orchestrator-direction-draft.md`](../specs/2026-05-02-ai-orchestrator-direction-draft.md)
- [`../specs/2026-05-02-conversation-memory-local-models-research.md`](../specs/2026-05-02-conversation-memory-local-models-research.md)

---

## Scope

This plan implements Wave 1 only:

- A canonical ledger for conversations and messages.
- A provider-native adapter interface.
- A Codex adapter that can create/resume/send through app-server and import/reconcile rollout JSONL.
- Minimal IPC/preload read and action endpoints so the renderer can list and invoke the ledger later.

Out of scope for this plan:

- Memory extraction and project-memory brief changes.
- Local model execution, task routing, or worker-node model serving.
- Open Brain storage integration.
- Full renderer redesign.
- Provider-native write-back by direct file mutation.
- Claude/Gemini/Copilot adapters beyond leaving the interface ready for them.

The important product boundary is this: AI Orchestrator is writable and authoritative in v1. Codex app visibility is best-effort through durable app-server threads, not a hard guarantee that every Orchestrator conversation appears in every Codex app build.

## Codebase Reality Check

The current code already has useful pieces:

- `src/main/history/history-manager.ts` archives completed Orchestrator sessions and imports native Claude transcripts, but it is archive-oriented rather than live/writable/provider-native.
- `src/main/cli/adapters/codex/app-server-client.ts` already owns JSON-RPC connection, initialization, request/response correlation, and notification routing for Codex app-server.
- `src/main/cli/adapters/codex/app-server-types.ts` includes `thread/start`, `thread/resume`, `thread/list`, `thread/name/set`, `thread/compact/start`, `turn/start`, and `turn/interrupt`, but not the newer read/list-turn app-server methods documented upstream.
- Local validation against `codex-cli 0.128.0` with `codex app-server generate-ts` shows the checked-in app-server types are materially stale:
  - `thread/list` returns `{ data, nextCursor, backwardsCursor }`, not `{ threads }`.
  - `thread/list` supports `cursor`, `limit`, `sortKey`, `sortDirection`, `modelProviders`, `sourceKinds`, `archived`, `cwd`, `useStateDbOnly`, and `searchTerm`.
  - `thread/read` exists and requires `includeTurns: boolean`.
  - `thread/turns/list` exists but is experimental; do not make v1 depend on it when `thread/read` with `includeTurns: true` is sufficient.
  - `Thread.path` is explicitly unstable. Treat it as a hint only, never as identity.
- `src/main/cli/adapters/codex/session-scanner.ts` scans `~/.codex/sessions` but currently expects older flat JSONL fields such as `entry.cwd`, `entry.threadId`, and `entry.subtype`; current local rollout files use `entry.payload.type` for several important events.
- Local rollout key-shape validation shows current files include `session_meta`, `turn_context`, `event_msg`, and `response_item` records. The parser must cover `response_item:message`, `response_item:reasoning`, `response_item:function_call`, `response_item:function_call_output`, and `event_msg:exec_command_end`, not only `event_msg:user_message` and `event_msg:agent_message`.
- `src/main/cli/adapters/adapter-factory.ts` defaults Codex to `ephemeral: true` so Orchestrator-spawned Codex instances do not leak into standalone Codex state. That remains right for throwaway child tasks, but durable user-facing ledger conversations must opt into `ephemeral: false`.
- `src/main/persistence/rlm-database.ts` and `src/main/db/sqlite-driver.ts` provide the preferred database abstraction and migration style.
- IPC channels now live in `packages/contracts/src/channels/*` and generated preload channels are produced by `npm run generate:ipc`.
- Adding any new `@contracts/schemas/...` import requires keeping `packages/contracts/package.json`, `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts` in sync. `npm run check:contracts` catches this, and the packaged app can crash if `src/main/register-aliases.ts` is missed.

## Design Decisions

1. Orchestrator ledger is canonical.
   Provider stores are import sources and sync targets. The ledger owns stable IDs, project association, source attribution, sync status, and conflict status.

2. Provider adapters declare capabilities.
   A provider can be discoverable, readable, writable, resumable, durable, filesystem-importable, app-visible, or conflict-aware independently. Do not encode "Codex does everything" into generic code.

3. Codex app-server is the writable path.
   Do not write Codex rollout files directly in this wave. Use app-server for `thread/start`, `thread/resume`, and `turn/start`; parse JSONL only for discovery, import, and reconciliation.

4. Durable vs ephemeral must be explicit.
   User-facing conversations created from the ledger use durable Codex threads. Orchestration child tasks, debate branches, verification passes, and experiments can keep using ephemeral Codex through existing adapter paths.

5. Message provenance is non-negotiable.
   Every imported or generated message stores the provider, native IDs where available, raw JSON or a raw reference, source checksum, and sequence. Later memory work depends on this.

6. IPC is minimal.
   Add list/get/start/send/reconcile endpoints but do not build the full renderer UI in this plan. A later UI plan can decide where the conversation hub lives.

## Data Model

Create `src/shared/types/conversation-ledger.types.ts`.

Core exported types:

```ts
export type ConversationProvider =
  | 'orchestrator'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'copilot'
  | 'unknown';

export type ConversationSourceKind =
  | 'orchestrator'
  | 'provider-native'
  | 'imported-file'
  | 'history-archive';

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool' | 'event';

export type ConversationSyncStatus =
  | 'never-synced'
  | 'synced'
  | 'imported'
  | 'dirty'
  | 'conflict'
  | 'error';

export type ConversationConflictStatus = 'none' | 'external-change' | 'local-change' | 'diverged';

export type ConversationNativeVisibilityMode =
  | 'none'
  | 'app-server-durable'
  | 'filesystem-visible'
  | 'best-effort';
```

Thread records:

```ts
export interface ConversationThreadRecord {
  id: string;
  provider: ConversationProvider;
  nativeThreadId: string | null;
  nativeSessionId: string | null;
  nativeSourceKind: string | null;
  sourceKind: ConversationSourceKind;
  sourcePath: string | null;
  workspacePath: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt: number | null;
  writable: boolean;
  nativeVisibilityMode: ConversationNativeVisibilityMode;
  syncStatus: ConversationSyncStatus;
  conflictStatus: ConversationConflictStatus;
  parentConversationId: string | null;
  metadata: Record<string, unknown>;
}
```

Message records:

```ts
export interface ConversationMessageRecord {
  id: string;
  threadId: string;
  nativeMessageId: string | null;
  nativeTurnId: string | null;
  role: ConversationRole;
  phase: string | null;
  content: string;
  createdAt: number;
  tokenInput: number | null;
  tokenOutput: number | null;
  rawRef: string | null;
  rawJson: Record<string, unknown> | null;
  sourceChecksum: string | null;
  sequence: number;
}
```

Native adapter contract:

```ts
export interface NativeConversationCapabilities {
  provider: ConversationProvider;
  canDiscover: boolean;
  canRead: boolean;
  canCreate: boolean;
  canResume: boolean;
  canSendTurns: boolean;
  canReconcile: boolean;
  durableByDefault: boolean;
  nativeVisibilityMode: ConversationNativeVisibilityMode;
}

export interface NativeConversationAdapter {
  readonly provider: ConversationProvider;
  getCapabilities(): NativeConversationCapabilities;
  discover(scope: ConversationDiscoveryScope): Promise<NativeConversationThread[]>;
  readThread(ref: NativeConversationRef): Promise<NativeConversationSnapshot>;
  startThread(request: NativeThreadStartRequest): Promise<NativeConversationHandle>;
  resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle>;
  sendTurn(ref: NativeConversationRef, request: NativeTurnRequest): Promise<NativeTurnResult>;
  reconcile(ref: NativeConversationRef): Promise<ReconciliationResult>;
}
```

Export these types from `src/shared/types/index.ts` unless the repo has introduced a newer barrel pattern before implementation starts.

## Database Schema

Create `src/main/conversation-ledger/conversation-ledger-schema.ts` and use the existing `SqliteDriver` interface.

Tables:

```sql
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  native_thread_id TEXT,
  native_session_id TEXT,
  native_source_kind TEXT,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  workspace_path TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_synced_at INTEGER,
  writable INTEGER NOT NULL DEFAULT 0,
  native_visibility_mode TEXT NOT NULL DEFAULT 'none',
  sync_status TEXT NOT NULL DEFAULT 'never-synced',
  conflict_status TEXT NOT NULL DEFAULT 'none',
  parent_conversation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_threads_provider_native
ON conversation_threads(provider, native_thread_id)
WHERE native_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_threads_workspace_updated
ON conversation_threads(workspace_path, updated_at DESC);
```

```sql
CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  native_message_id TEXT,
  native_turn_id TEXT,
  role TEXT NOT NULL,
  phase TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  token_input INTEGER,
  token_output INTEGER,
  raw_ref TEXT,
  raw_json TEXT,
  source_checksum TEXT,
  sequence INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_native
ON conversation_messages(thread_id, native_message_id)
WHERE native_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_sequence
ON conversation_messages(thread_id, sequence);
```

```sql
CREATE TABLE IF NOT EXISTS conversation_sync_cursors (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  cursor_kind TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  source_path TEXT,
  source_mtime INTEGER,
  last_seen_checksum TEXT,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sync_cursors_thread_kind
ON conversation_sync_cursors(thread_id, cursor_kind);
```

```sql
CREATE TABLE IF NOT EXISTS conversation_memory_links (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES conversation_messages(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

The `conversation_memory_links` table is created now but only populated in the memory follow-on plan.

## File Structure

New files:

| Path | Responsibility |
| --- | --- |
| `src/shared/types/conversation-ledger.types.ts` | Provider-neutral ledger and native adapter types |
| `src/main/conversation-ledger/conversation-ledger-schema.ts` | SQLite DDL and migration helpers |
| `src/main/conversation-ledger/conversation-ledger-store.ts` | Transactional CRUD store for threads, messages, and cursors |
| `src/main/conversation-ledger/native-conversation-adapter.ts` | Adapter contract and shared helper types if not kept entirely in shared types |
| `src/main/conversation-ledger/native-conversation-registry.ts` | Provider adapter registry |
| `src/main/conversation-ledger/conversation-ledger-service.ts` | Main-process orchestration service |
| `src/main/conversation-ledger/codex/codex-rollout-parser.ts` | Current-shape tolerant Codex JSONL parser |
| `src/main/conversation-ledger/codex/codex-native-conversation-adapter.ts` | Codex adapter implementation |
| `src/main/conversation-ledger/__fixtures__/codex-rollout-current.jsonl` | Redacted current-shape Codex rollout fixture |
| `src/main/conversation-ledger/__tests__/*.spec.ts` | Store, parser, registry, service tests |
| `src/main/ipc/handlers/conversation-ledger-handlers.ts` | Minimal IPC handlers |
| `packages/contracts/src/channels/conversation-ledger.channels.ts` | IPC channel constants |
| `packages/contracts/src/schemas/conversation-ledger.schemas.ts` | Zod payload schemas |
| `packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts` | Schema tests |
| `src/preload/domains/conversation-ledger.preload.ts` | Renderer preload domain |

Modified files:

| Path | Change |
| --- | --- |
| `src/shared/types/index.ts` | Export conversation ledger shared types |
| `src/main/cli/adapters/codex/app-server-types.ts` | Add typed app-server methods for `thread/read`, `thread/turns/list`, and any required thread metadata responses |
| `src/main/cli/adapters/codex/app-server-types.spec.ts` | Cover the new method map entries |
| `src/main/ipc/handlers/index.ts` | Export/register ledger handlers |
| `src/main/index.ts` or the current main bootstrap file | Initialize ledger service and register handlers in the existing IPC registration path |
| `packages/contracts/src/channels/index.ts` | Include `CONVERSATION_LEDGER_CHANNELS` |
| `packages/contracts/package.json` | Export `./schemas/conversation-ledger` and `./channels/conversation-ledger` if imported directly |
| `tsconfig.json` | Add `@contracts/schemas/conversation-ledger` and any direct channel alias |
| `tsconfig.electron.json` | Add the same aliases for main-process typechecking |
| `src/main/register-aliases.ts` | Add runtime resolver aliases for new contracts subpaths |
| `vitest.config.ts` | Add test resolver aliases for new contracts subpaths |
| `src/preload/preload.ts` | Add the conversation ledger preload domain |
| `src/preload/domains/types.ts` | Add renderer-facing API shape |
| `src/preload/generated/channels.ts` | Regenerate with `npm run generate:ipc` |

Do not add a new package or a second database abstraction.

## Task Dependency Overview

```
Task 1  Shared contracts and fixture
  |
Task 2  Database schema
  |
Task 3  Store
  |
Task 4  Native adapter registry
  |
Task 5  Codex rollout parser
  |
Task 6  Codex app-server method types
  |
Task 7  Codex native adapter
  |
Task 8  Ledger service
  |
Task 9  IPC and preload
  |
Task 10 Bootstrap and verification
```

Tasks 5 and 6 can be implemented in parallel after Task 1. Task 7 depends on both.

---

## Task 1: Add Shared Ledger Contracts And Codex Fixture

**Files:**

- Create `src/shared/types/conversation-ledger.types.ts`
- Modify `src/shared/types/index.ts`
- Create `src/main/conversation-ledger/__fixtures__/codex-rollout-current.jsonl`
- Create `src/shared/types/__tests__/conversation-ledger.types.spec.ts`

- [ ] Add the provider, source, role, sync, conflict, and native visibility union types listed in the Data Model section.
- [ ] Add `ConversationThreadRecord`, `ConversationMessageRecord`, cursor types, upsert input types, list/query request types, native adapter request/result types, and reconciliation result types.
- [ ] Include `nativeSourceKind: string | null` on thread records. For Codex this stores values such as `cli`, `vscode`, `exec`, `appServer`, `subAgent`, or `unknown`; do not overload the ledger-level `sourceKind` with provider-specific source kinds.
- [ ] Include `sourceKinds?: string[]` and `includeChildThreads?: boolean` on `ConversationDiscoveryScope` so Codex discovery can include `appServer` threads without automatically importing sub-agent threads.
- [ ] Keep shared types serializable. Do not include classes, functions, `Date`, `Map`, or `Set` in shared records.
- [ ] Export the new type file from `src/shared/types/index.ts`.
- [ ] Add a small type-level Vitest spec that constructs representative thread/message records and adapter capability objects.
- [ ] Add a redacted fixture using the current Codex rollout shape. Use only fake content:

```jsonl
{"timestamp":"2026-05-02T10:00:00.000Z","type":"session_meta","payload":{"id":"thread_fixture_1","timestamp":"2026-05-02T10:00:00.000Z","cwd":"/tmp/ai-orchestrator-fixture","model_provider":"openai","originator":"codex_cli","source":"vscode"}}
{"timestamp":"2026-05-02T10:00:01.000Z","type":"turn_context","payload":{"turn_id":"turn_fixture_1","cwd":"/tmp/ai-orchestrator-fixture","model":"gpt-5.4","effort":"medium","approval_policy":"never"}}
{"timestamp":"2026-05-02T10:00:02.000Z","type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"thread_fixture_1","thread_name":"Ledger planning"}}
{"timestamp":"2026-05-02T10:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":"Plan the conversation ledger.","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"2026-05-02T10:00:04.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"pwd\"}"}}
{"timestamp":"2026-05-02T10:00:05.000Z","type":"event_msg","payload":{"type":"exec_command_end","exit_code":0,"aggregated_output":"/tmp/ai-orchestrator-fixture"}}
{"timestamp":"2026-05-02T10:00:06.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Use an Orchestrator-owned ledger first.","phase":"final"}}
{"timestamp":"2026-05-02T10:00:07.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":"final","content":[{"type":"output_text","text":"Use an Orchestrator-owned ledger first."}]}}
{"timestamp":"2026-05-02T10:00:08.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}}}
```

- [ ] Run `npx vitest run src/shared/types/__tests__/conversation-ledger.types.spec.ts`.

## Task 2: Add Conversation Ledger Schema

**Files:**

- Create `src/main/conversation-ledger/conversation-ledger-schema.ts`
- Create `src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts`

- [ ] Implement `createConversationLedgerTables(db: SqliteDriver): void`.
- [ ] Implement `createConversationLedgerMigrationsTable(db: SqliteDriver): void` with a dedicated ledger migration table.
- [ ] Implement `runConversationLedgerMigrations(db: SqliteDriver): void` with idempotent migrations. Do not mutate the RLM migration version; this plan uses a dedicated conversation ledger database.
- [ ] Enable foreign keys in the database owner, not inside each helper, matching the existing RLM pattern.
- [ ] Add schema tests that open a temporary SQLite database through the existing test driver pattern, create tables, run migrations twice, and assert the expected tables/indexes exist.
- [ ] Add a test that deleting a thread cascades messages and cursors.
- [ ] Run `npx vitest run src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts`.

Implementation choice:

- Use a dedicated database file under `app.getPath('userData')/conversation-ledger/conversation-ledger.db`.
- Mirror the `RLMDatabase` constructor pattern: injectable config for tests, WAL in production, `cache_size`, `foreign_keys = ON`, and a `_resetForTesting()` hook on the owning service.
- The database owner must create the parent directory synchronously with `mkdirSync(dir, { recursive: true })` before opening SQLite.

## Task 3: Implement `ConversationLedgerStore`

**Files:**

- Create `src/main/conversation-ledger/conversation-ledger-store.ts`
- Create `src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts`

- [ ] Constructor accepts a `SqliteDriver`; it does not import `better-sqlite3` directly.
- [ ] Implement `upsertThread(input): ConversationThreadRecord`.
- [ ] Implement `findThreadById(id): ConversationThreadRecord | null`.
- [ ] Implement `findThreadByNativeId(provider, nativeThreadId): ConversationThreadRecord | null`.
- [ ] Implement `listThreads(query): ConversationThreadRecord[]` with filters for provider, workspace path, source kind, sync status, and limit.
- [ ] Implement `upsertMessages(threadId, messages): ConversationMessageRecord[]`.
- [ ] Implement `replaceThreadMessagesFromImport(threadId, messages, cursor): ReconciliationResult`.
- [ ] Implement `getMessages(threadId, options): ConversationMessageRecord[]`, ordered by `sequence`.
- [ ] Implement `upsertSyncCursor(input)` and `getSyncCursors(threadId)`.
- [ ] Parse/stringify `metadata_json` and `raw_json` defensively. Corrupt JSON should not crash listing; return `{}` or `null` and mark the record for repair through logging.
- [ ] Use transactions for thread plus message writes.
- [ ] Define `replaceThreadMessagesFromImport` as delete-then-insert inside one transaction. If any insert fails, the original messages and cursors must remain unchanged.
- [ ] Use `crypto.randomUUID()` for generated IDs.
- [ ] Store booleans as integer `0`/`1` and map them back to booleans in records.
- [ ] Add tests for:
  - thread upsert idempotency by provider/native ID,
  - message insertion and sequence ordering,
  - duplicate native message IDs not creating duplicates,
  - metadata/raw JSON round-trip,
  - cursor upsert replacement,
  - rollback when a multi-message transaction fails,
  - rollback when `replaceThreadMessagesFromImport` fails after deleting but before all replacement messages insert, proving the original messages survive.
- [ ] Run `npx vitest run src/main/conversation-ledger/__tests__/conversation-ledger-store.spec.ts`.

## Task 4: Add Native Adapter Registry

**Files:**

- Create `src/main/conversation-ledger/native-conversation-adapter.ts`
- Create `src/main/conversation-ledger/native-conversation-registry.ts`
- Create `src/main/conversation-ledger/__tests__/native-conversation-registry.spec.ts`
- Create `src/main/conversation-ledger/index.ts`

- [ ] Keep shared serializable interface types in `src/shared/types/conversation-ledger.types.ts`.
- [ ] Put runtime-only helpers, error classes, and registry code in `src/main/conversation-ledger/*`.
- [ ] Implement `NativeConversationRegistry.register(adapter)`.
- [ ] Implement `NativeConversationRegistry.get(provider)`.
- [ ] Implement `NativeConversationRegistry.listCapabilities()`.
- [ ] Reject duplicate provider registration unless a test-only override flag is passed.
- [ ] Export `getNativeConversationRegistry()` singleton and `_resetForTesting()` if consistent with the nearby singleton pattern.
- [ ] Add tests for registration, duplicate registration, missing providers, and capability listing.
- [ ] Run `npx vitest run src/main/conversation-ledger/__tests__/native-conversation-registry.spec.ts`.

## Task 5: Implement Current-Shape Codex Rollout Parser

**Files:**

- Create `src/main/conversation-ledger/codex/codex-rollout-parser.ts`
- Create `src/main/conversation-ledger/__tests__/codex-rollout-parser.spec.ts`
- Modify `src/main/cli/adapters/codex/session-scanner.ts` after parser tests are green.
- Modify `src/main/cli/adapters/codex/session-scanner.spec.ts`.

- [ ] Parse JSONL line by line and tolerate malformed lines.
- [ ] Support current nested `payload` entries:
  - `session_meta.payload.id`
  - `session_meta.payload.cwd`
  - `session_meta.payload.timestamp`
  - `session_meta.payload.source`
  - top-level `timestamp`
  - `turn_context.payload.turn_id`
  - `turn_context.payload.model`
  - `turn_context.payload.cwd`
  - `session_meta.payload.model`
  - `event_msg.payload.type === 'user_message'`
  - `event_msg.payload.type === 'agent_message'`
  - `event_msg.payload.type === 'thread_name_updated'`
  - `event_msg.payload.type === 'token_count'`
- [ ] Support current `response_item` entries:
  - `response_item.payload.type === 'message'`
  - `response_item.payload.type === 'reasoning'`
  - `response_item.payload.type === 'function_call'`
  - `response_item.payload.type === 'function_call_output'`
- [ ] Support current tool/command event entries such as `event_msg.payload.type === 'exec_command_end'`.
- [ ] Preserve compatibility with older flat fields currently used by `session-scanner.spec.ts`.
- [ ] Return a `NativeConversationSnapshot` with a thread record candidate, normalized messages, sync cursor candidate, token totals, parser warnings, and raw source references.
- [ ] Generate deterministic message IDs when native message IDs are absent, using provider + thread ID + sequence + checksum.
- [ ] Use SHA-256 or the repo's existing hash helper for `sourceChecksum`.
- [ ] Store the original parsed line in `rawJson` for messages where it is useful.
- [ ] Map Codex roles:
  - user message -> `role: 'user'`
  - agent message -> `role: 'assistant'`
  - response item assistant message -> `role: 'assistant'`
  - reasoning response item -> `role: 'event'` unless later UI requirements need a distinct role
  - command/tool/function events -> `role: 'tool'` or `role: 'event'` when added
  - token count -> not a message unless it is attached as metadata to the nearest turn
- [ ] Deduplicate `event_msg.agent_message` and `response_item.message` when they represent the same final assistant text for the same turn. Preserve the richer raw references in metadata.
- [ ] Add parser tests for the fixture, malformed lines, flat legacy records, token-count extraction, missing cwd, missing thread ID, `turn_context` model extraction, `response_item` parsing, tool/command event parsing, assistant-message dedupe, and stable sequence ordering.
- [ ] Add scanner tests proving it can find current-shape Codex sessions by workspace and thread ID while keeping legacy flat-shape compatibility.
- [ ] Run:
  - `npx vitest run src/main/conversation-ledger/__tests__/codex-rollout-parser.spec.ts`
  - `npx vitest run src/main/cli/adapters/codex/session-scanner.spec.ts` if scanner changed.

## Task 6: Refresh Codex App-Server Types For Durable Thread Reads

**Files:**

- Modify `src/main/cli/adapters/codex/app-server-types.ts`
- Modify `src/main/cli/adapters/codex/app-server-types.spec.ts`

- [ ] Generate the installed Codex schema into a temporary directory and inspect it before editing:
  - `rm -rf /tmp/ai-orchestrator-codex-schema`
  - `mkdir -p /tmp/ai-orchestrator-codex-schema`
  - `codex app-server generate-ts --out /tmp/ai-orchestrator-codex-schema`
- [ ] Update `src/main/cli/adapters/codex/app-server-types.ts` from the generated schema shape rather than hand-guessing fields.
- [ ] Update `ThreadListParams` to include current fields: `cursor`, `limit`, `sortKey`, `sortDirection`, `modelProviders`, `sourceKinds`, `archived`, `cwd`, `useStateDbOnly`, and `searchTerm`.
- [ ] Update `ThreadListResponse` to `{ data: ThreadInfo[]; nextCursor: string | null; backwardsCursor: string | null }`. Remove the stale `threads` response shape and update any existing caller in this slice that uses it.
- [ ] Add `ThreadSourceKind` values from the generated schema: `cli`, `vscode`, `exec`, `appServer`, `subAgent`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther`, and `unknown`.
- [ ] Add `ThreadReadParams` as `{ threadId: string; includeTurns: boolean }`; `includeTurns` is required.
- [ ] Add `ThreadReadResponse` as `{ thread: ThreadInfo }`.
- [ ] Add `ThreadTurnsListParams` and `ThreadTurnsListResponse`, but keep `thread/turns/list` optional/experimental in adapter behavior. Do not make v1 depend on it.
- [ ] Extend `ThreadInfo`, `Turn`, and `ThreadItem` enough to normalize user messages, assistant messages, reasoning, command execution, file changes, MCP calls, dynamic tool calls, collab calls, web search, image view, review mode, and context compaction. Preserve unknown fields with `Record<string, unknown>` escape hatches where app-server versions vary.
- [ ] Update `ThreadStartParams` and `TurnStartParams` to match generated names where they have drifted. In `codex-cli 0.128.0`, turn reasoning is represented by generated `effort`/`summary` fields rather than the older checked-in `reasoningEffort` field.
- [ ] Do not make a broad behavioral migration of `CodexCliAdapter` in this task unless type changes require it for compilation; keep runtime changes focused and covered by existing Codex adapter tests.
- [ ] Update `AppServerClientBase.resolveDefaultTimeout()` if these read calls need control/default timeout classification.
- [ ] Add type tests or runtime tests asserting:
  - `client.request('thread/list', { sourceKinds: ['cli', 'vscode', 'appServer'], limit: 25 })` returns `.data`.
  - `client.request('thread/read', { threadId: 'thr_1', includeTurns: true })` compiles.
  - `client.request('thread/turns/list', { threadId: 'thr_1', limit: 50, sortDirection: 'desc' })` compiles but is treated as experimental by adapter code.
- [ ] Run `npx vitest run src/main/cli/adapters/codex/app-server-types.spec.ts`.

Note: if implementation finds the installed Codex app-server does not support one of these methods yet, keep the types but make the Codex adapter capability probe degrade gracefully. Unsupported read methods should set `canRead` or `readMode` accordingly, not crash service initialization. Because `thread/turns/list` is experimental, prefer `thread/read` with `includeTurns: true` for v1 readback.

## Task 7: Implement `CodexNativeConversationAdapter`

**Files:**

- Create `src/main/conversation-ledger/codex/codex-native-conversation-adapter.ts`
- Create `src/main/conversation-ledger/__tests__/codex-native-conversation-adapter.spec.ts`
- Reuse `src/main/cli/adapters/codex/app-server-client.ts`
- Reuse or wrap `src/main/cli/adapters/codex/session-scanner.ts`

- [ ] Constructor accepts dependencies:
  - app-server client factory,
  - sessions directory override for tests,
  - clock,
  - logger if needed.
- [ ] `getCapabilities()` returns Codex capabilities with:
  - `canDiscover: true`
  - `canRead: true` if app-server read probe succeeds or rollout import is available
  - `canCreate: true`
  - `canResume: true`
  - `canSendTurns: true`
  - `canReconcile: true`
  - `durableByDefault: true` for this adapter
  - `nativeVisibilityMode: 'app-server-durable'`
- [ ] `discover(scope)` combines:
  - app-server `thread/list` results when available, using explicit `sourceKinds`.
  - filesystem rollout scan results for `~/.codex/sessions`,
  - workspace filtering when `scope.workspacePath` is provided.
- [ ] For default user-facing discovery, pass `sourceKinds: ['cli', 'vscode', 'appServer']`. Include `exec` only if the product wants one-shot exec sessions in the conversation hub. Exclude sub-agent source kinds by default unless `scope.includeChildThreads` is true.
- [ ] Map `ThreadListResponse.data` into native conversation candidates. Do not read `.threads`.
- [ ] Store Codex `thread.source` as `nativeSourceKind`.
- [ ] Treat generated `Thread.path` as an unstable hint only. Never use it as a stable identity. If using it for filesystem reconciliation, first verify the path exists and still points to the expected native thread ID.
- [ ] `startThread(request)` calls `thread/start` with `ephemeral: false` unless the request explicitly asks for ephemeral. It must pass cwd, model, approval policy, sandbox, service name, and reasoning effort/personality fields using the generated 0.128.0 parameter names.
- [ ] `resumeThread(ref)` calls `thread/resume`.
- [ ] `sendTurn(ref, request)` calls `turn/start`, captures notifications, and returns normalized messages plus turn metadata. Use generated `TurnStartParams` names. Reuse existing notification parsing patterns from `CodexCliAdapter` where possible instead of duplicating a large event interpreter.
- [ ] `readThread(ref)` tries app-server `thread/read` first with `{ threadId, includeTurns: true }`. If unsupported, fall back to rollout parsing when a verified source path is known.
- [ ] Do not require `thread/turns/list` for v1 readback. If it is used for pagination later, initialize/probe experimental capability explicitly and handle JSON-RPC rejection.
- [ ] `reconcile(ref)` returns added/updated message counts, cursor updates, and conflict hints without mutating the ledger directly. The service/store owns persistence.
- [ ] Add fake-client tests for start, resume, send, discover, unsupported read fallback, and durable `ephemeral: false`.
- [ ] Add fixture-based tests for filesystem reconciliation.
- [ ] Run `npx vitest run src/main/conversation-ledger/__tests__/codex-native-conversation-adapter.spec.ts`.

Important guardrail:

- Do not change `createCodexAdapter()` default `ephemeral: true` in `src/main/cli/adapters/adapter-factory.ts`. Add durable behavior in this native conversation adapter or through an explicit option path only. Existing child-task behavior should stay isolated.

## Task 8: Implement `ConversationLedgerService`

**Files:**

- Create `src/main/conversation-ledger/conversation-ledger-service.ts`
- Create `src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`

- [ ] Implement a singleton following existing main-process service patterns:
  - `getConversationLedgerService()`
  - `ConversationLedgerService._resetForTesting()`
  - constructor injection for tests.
- [ ] Own database initialization and store construction.
- [ ] Ensure the dedicated ledger database directory exists before opening SQLite with `mkdirSync(dirname(dbPath), { recursive: true })`.
- [ ] Register the Codex native adapter during service initialization.
- [ ] Implement `listConversations(query)`.
- [ ] Implement `getConversation(threadId)` returning thread plus messages.
- [ ] Implement `discoverNativeConversations(scope)` to ask adapters for native threads and upsert thread metadata.
- [ ] Implement `reconcileConversation(threadId)` to call the provider adapter, persist message changes, and update sync cursors/status.
- [ ] Implement `startConversation(request)` for provider `codex`, creating a durable native thread and a ledger thread in one flow.
- [ ] Implement `sendTurn(threadId, request)` to resume/send through the provider adapter and persist returned messages.
- [ ] Implement error handling:
  - adapter unavailable -> typed service error,
  - provider read unsupported -> `syncStatus: 'error'` with readable error metadata,
  - reconciliation conflict -> preserve existing messages and mark `conflictStatus`.
- [ ] Add service tests with fake store/adapter or in-memory database:
  - discover imports native Codex metadata,
  - start creates durable Codex thread and ledger record,
  - send persists user and assistant messages,
  - reconcile is idempotent,
  - provider errors do not corrupt existing messages.
- [ ] Add a service-level integration test with real temporary SQLite and a fake Codex client covering: start durable thread, send one turn, persist messages, reconcile the same native data, and assert no duplicates.
- [ ] Run `npx vitest run src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`.

## Task 9: Add Minimal IPC, Contracts, And Preload Domain

**Files:**

- Create `packages/contracts/src/channels/conversation-ledger.channels.ts`
- Modify `packages/contracts/src/channels/index.ts`
- Create `packages/contracts/src/schemas/conversation-ledger.schemas.ts`
- Create `packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts`
- Modify `packages/contracts/package.json`
- Modify `tsconfig.json`
- Modify `tsconfig.electron.json`
- Modify `src/main/register-aliases.ts`
- Modify `vitest.config.ts`
- Create `src/main/ipc/handlers/conversation-ledger-handlers.ts`
- Modify `src/main/ipc/handlers/index.ts`
- Create `src/preload/domains/conversation-ledger.preload.ts`
- Modify `src/preload/domains/types.ts`
- Modify `src/preload/preload.ts`
- Regenerate `src/preload/generated/channels.ts`

- [ ] Add channels:
  - `CONVERSATION_LEDGER_LIST: 'conversation-ledger:list'`
  - `CONVERSATION_LEDGER_GET: 'conversation-ledger:get'`
  - `CONVERSATION_LEDGER_DISCOVER: 'conversation-ledger:discover'`
  - `CONVERSATION_LEDGER_RECONCILE: 'conversation-ledger:reconcile'`
  - `CONVERSATION_LEDGER_START: 'conversation-ledger:start'`
  - `CONVERSATION_LEDGER_SEND_TURN: 'conversation-ledger:send-turn'`
- [ ] Add Zod schemas for each payload. Keep payloads narrow:
  - list filters,
  - thread ID,
  - provider/workspace discovery scope,
  - start conversation request,
  - send turn request with text and optional structured input items.
- [ ] Validate IPC payloads with `validateIpcPayload`, matching existing handler style.
- [ ] Add `./schemas/conversation-ledger` to `packages/contracts/package.json` exports.
- [ ] If any code imports `@contracts/channels/conversation-ledger` directly, add `./channels/conversation-ledger` to `packages/contracts/package.json` exports and the matching aliases below. If callers only import from `@contracts/channels`, the index export is enough.
- [ ] Add `@contracts/schemas/conversation-ledger` to `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts`.
- [ ] Add `@contracts/channels/conversation-ledger` to those same alias files only if the direct channel subpath is used.
- [ ] Return existing `IpcResponse` shapes.
- [ ] Add preload methods under a `conversationLedger` domain or the current preferred naming pattern:
  - `listConversations`
  - `getConversation`
  - `discoverConversations`
  - `reconcileConversation`
  - `startConversation`
  - `sendConversationTurn`
- [ ] Run `npm run generate:ipc`.
- [ ] Run:
  - `npx vitest run packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts`
  - `node scripts/verify-ipc-channels.js`
  - `npm run check:contracts`
  - `npm run verify:exports`
  - `npx vitest run src/preload/__tests__/ipc-channel-contract.spec.ts`

## Task 10: Bootstrap, Integration Checks, And Documentation

**Files:**

- Modify `src/main/index.ts` or the current IPC bootstrap location.
- Modify `docs/superpowers/specs/2026-05-02-conversation-memory-local-models-research.md` only if implementation findings change the architecture.
- Optionally create a short user-facing internal doc under `docs/architecture/` if a conversation ledger docs section exists by then.

- [ ] Initialize `ConversationLedgerService` in the main process after app paths are available and before handlers need it.
- [ ] Register `registerConversationLedgerHandlers()` with the existing IPC handler registration flow.
- [ ] Ensure service startup failure is logged and does not crash the whole app unless the database cannot be opened due to corruption that would make the feature unsafe.
- [ ] Add a focused smoke/integration test that calls `discoverNativeConversations({ provider: 'codex', workspacePath: fixtureWorkspace })` against fixture-backed discovery and asserts at least one thread with `provider: 'codex'`, the expected `nativeThreadId`, and the expected `nativeSourceKind`.
- [ ] Confirm no existing Codex child-task path became durable unintentionally.
- [ ] Confirm durable ledger-created Codex conversations pass `ephemeral: false`.
- [ ] Run targeted tests:
  - `npx vitest run src/main/conversation-ledger`
  - `npx vitest run src/main/cli/adapters/codex/session-scanner.spec.ts`
  - `npx vitest run src/main/cli/adapters/codex/app-server-types.spec.ts`
  - `npx vitest run packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts`
  - `npx vitest run src/preload/__tests__/ipc-channel-contract.spec.ts`
- [ ] Run required project checks:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run verify:ipc`
  - `npm run check:contracts`
  - `npm run verify:exports`
- [ ] If more than IPC/type/schema files changed, run `npm run test` before calling the implementation complete.
- [ ] Do not commit unless the user explicitly asks for a commit.

## Acceptance Criteria

- AI Orchestrator has a durable conversation ledger with provider-neutral thread/message records.
- Codex native conversations can be discovered into the ledger with stable IDs and source metadata.
- A user-facing Codex conversation started through the ledger uses a durable app-server thread, not an ephemeral child-task thread.
- A ledger Codex conversation can be resumed and sent a turn through app-server.
- Codex rollout JSONL in the current nested `payload.type` shape can be parsed and reconciled.
- IPC/preload exposes minimal list/get/discover/reconcile/start/send operations.
- Existing archive/history behavior remains unchanged.
- Existing Codex child/debate/verification behavior remains ephemeral unless explicitly changed by its caller.
- All targeted tests, typechecks, lint, and IPC verification pass.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Codex app-server method support varies by installed Codex version | Capability probe and graceful fallback to rollout import for read/reconcile |
| Current JSONL shape shifts again | Parser keeps raw JSON, tolerant warnings, and fixture tests for both current and legacy shapes |
| Durable Codex threads leak child tasks into Codex app | Keep `createCodexAdapter()` default ephemeral and isolate durable behavior in the native conversation adapter |
| Ledger duplicates provider-native conversations | Unique provider/native-thread indexes plus idempotent upserts |
| Future memory work cannot trace claims | Store raw refs, raw JSON, checksums, native IDs, and message sequence now |
| IPC expands before UI decisions are made | Keep endpoints minimal and service-oriented; defer renderer UX |
| Database corruption or migration error affects startup | Service logs feature failure and handlers return typed errors rather than crashing unrelated app features where possible |

## Follow-On Plans

Create separate plan files for these waves after Wave 1 lands and current code is re-read.

### Wave 2: Ledger-To-Memory Integration

Goal: feed the memory system from canonical ledger records, with message-level provenance.

Expected scope:

- Link ledger threads/messages to `conversation-miner`, project memory briefs, wake context, and session recall.
- Populate `conversation_memory_links`.
- Add local-model-assisted extraction only as staged, reviewable memory candidates.
- Make memory retrieval cite conversation/message IDs.

### Wave 3: Local OpenAI-Compatible Model Provider

Goal: make Ollama, LM Studio, llama.cpp, and vLLM available through a common local HTTP provider.

Expected scope:

- Add OpenAI-compatible endpoint config and health checks.
- Discover Ollama models through existing `model-discovery.ts`.
- Report LM Studio as installed/offline vs online.
- Add generation APIs for bounded non-tool tasks.
- Track context length, tool support, vision support, embedding support, latency, and privacy flags.

### Wave 4: Task Placement Router

Goal: decide when a local model, cloud model, CLI, or remote node should receive a child task.

Expected scope:

- Replace keyword-only routing with task classification, risk level, required context, tool needs, privacy, cost, latency, and verification requirement.
- Start with bounded tasks: retrieval, transcript summarization, consistency checks, memory candidate extraction, first-pass review.
- Produce a visible routing explanation.
- Require stronger model verification for high-risk local outputs.

### Wave 5: Remote Model Nodes

Goal: use the Windows 5090 machine and future Mac Studio-class hardware as model-serving nodes.

Expected scope:

- Extend worker-node capabilities to advertise model-serving endpoints, GPU/VRAM, RAM, context limits, and current load.
- Route local OpenAI-compatible calls to remote nodes when appropriate.
- Add health checks and backoff.

### Wave 6: Open Brain Compatibility

Goal: interoperate with Open Brain as a memory substrate without making it the Orchestrator core.

Expected scope:

- Export selected ledger-derived memories into Open Brain-compatible records.
- Import Open Brain curated memories with provenance.
- Keep raw Orchestrator transcripts local unless explicitly exported.
- Avoid mixing embedding spaces without explicit index separation.

### Wave 7: Native Write-Back And Conflict Resolution

Goal: improve best-effort provider app visibility and reconciliation.

Expected scope:

- Add provider-specific native write-back only where a stable API/store exists.
- Detect external edits and divergence.
- Preserve both sides on conflict.
- Add UI status for synced, dirty, conflict, and provider-unsupported states.

---

## Implementation Notes For Workers

- Re-read every file listed in a task before editing it. Several of these files are actively evolving.
- Prefer adding a narrow new subsystem over stretching `HistoryManager` into live conversation sync.
- Keep migrations idempotent.
- Keep native provider adapters capability-driven.
- Do not call external cloud services in tests.
- Do not use real private Codex rollout content in fixtures.
- Do not commit or push unless the user explicitly asks.
