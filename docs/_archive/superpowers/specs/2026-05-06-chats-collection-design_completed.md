# Chats Collection Design

**Date:** 2026-05-06
**Status:** Completed, validated 2026-05-07
**Scope:** Replace the current single-thread "Orchestrator / Global Control Plane" state machine with a top-level **Chats** collection in the sidebar. Each chat is a real CLI provider session (Claude / Codex / Gemini / Copilot, selectable per chat) whose working directory is switchable mid-conversation. Project-pinned chats inside the existing Projects sidebar group continue to work as today.

This spec supersedes the conversational, planning, and acknowledgement portions of the earlier Global Operator Control Plane draft. The persistence layer, run-graph schema, and `git-batch` executor described there are retained and repositioned as **tools** the chat's CLI can invoke.

## Summary

The current "Orchestrator" surface is a deterministic state machine. Every user message goes through:

1. A regex-based `buildAcknowledgement()` that produces one of four canned replies.
2. A regex-based `planOperatorRequest()` that classifies intent.
3. A mechanical project resolver that can fuzzy-match known names/paths/aliases, but still cannot interpret natural language like "the root of the minecraft project" unless that phrase happens to match registered project metadata.

There is no AI involved in the chat itself. This produces the failure mode shown by the user: typing "list files in the root of the minecraft project" produces a canned acknowledgement followed by `Blocked: Could not resolve project: root of the minecraft`.

The fix is to make Orchestrator a real chat — actually, **a collection of real chats**. Each chat is backed by the same CLI provider machinery the app already uses for project sessions (`InstanceManager`), with one new capability: the chat's working directory is switchable at runtime, with the durable transcript living in the conversation ledger and the CLI process being a disposable runtime that can be re-spawned in a new cwd on demand.

The user-visible result:

- A **Chats** sidebar group above Projects, holding project-fluid chats (switchable cwd).
- A **Projects** group (already exists) holding project-pinned chats (cwd locked to the project), unchanged in v1.
- Both kinds of chat share the same underlying primitive — only the cwd policy differs.

## Glossary

- **Chat**: A persistent, named conversation with a CLI provider. Has a stable identity (chat id + ledger thread) and a current cwd. The CLI process backing it is disposable.
- **Chat thread / transcript**: The durable message history for a chat. Stored in the existing conversation ledger.
- **Project-fluid chat**: A chat whose `current_cwd` is switchable. Lives in the Chats sidebar group.
- **Project-pinned chat**: A chat whose `current_cwd` is locked to a known project's working directory. Lives in that project's group in the Projects sidebar.
- **Instance**: An `InstanceManager`-managed CLI session. In this design, a chat's currently running Instance is its disposable runtime.
- **Operator** (existing term): The internal namespace housing the current Global Control Plane code. Most of it gets repositioned or deleted by this design.

"Orchestrator" as a top-level UI label is retired. The sidebar header becomes **Chats**.

## Goals

- A user typing into a chat reaches a real LLM, not a regex.
- A user can have many concurrent persistent chats, each with its own provider, model, and current cwd.
- A chat can change which project it's working on without losing its visible transcript.
- Project-pinned chats inside the existing Projects sidebar group continue to work exactly as today.
- The genuinely mechanical operations preserved from the prior spec (`git-batch` for "pull all repos") remain available as a structured MCP tool for Claude-backed chats; non-Claude chats can still do equivalent work through their shell tools.
- The data layer leaves room for a future "items / Jira-board" feature that references chats but does not change them.
- App restart preserves chat identity and transcripts; CLI runtimes re-spawn lazily.

## Non-Goals

- Do **not** build a project-fluid-per-message routing layer (option C from brainstorming). v1 uses cwd-switch-via-UI; per-message routing can be added later if needed.
- Do **not** ship the items / Jira-board feature in this design. Plan for it; do not build it.
- Do **not** ship cross-chat search, status icons (clock / unread / running), or a "Board" sidebar entry. These appear in the reference screenshot but are out of scope for v1.
- Do **not** rebuild the existing project-instance data model. Project-pinned chats in v1 remain `Instance` records grouped by working directory, exactly as today.
- Do **not** preserve the deterministic intent classifier and acknowledgement Mad Lib. They are deleted.

## Existing App Context

Pieces this design reuses:

- `src/main/instance/instance-manager.ts` — already creates, runs, and recovers CLI provider sessions with a working directory. Chat runtimes are Instances.
- `src/main/conversation-ledger/` — already supports `provider: "orchestrator"` threads (added by the prior spec). Chat transcripts use this. The ledger thread id is the durable chat transcript.
- `src/renderer/app/features/instance-detail/InstanceDetailComponent` — already renders transcript, composer, child agents, MCP, etc. Chat detail reuses this surface with a swapped header (project picker instead of fixed working directory).
- `src/renderer/app/features/instance-list/instance-list.component.*` — already renders the project sidebar groups. We add a new top-level "Chats" group above it.
- `src/main/operator/operator-database.ts` — existing `userData/operator/operator.db`. We reuse it for the new `chats` table.
- `src/main/operator/git-batch-service.ts` (already implemented per the prior spec's Wave 3) — preserved and exposed as an MCP tool.
- `src/main/mcp/orchestrator-mcp-repository.ts` and `src/main/mcp/orchestrator-injection-reader.ts` — already inject configured MCP servers into spawned CLI sessions. We keep that path and add a built-in orchestrator-tools MCP config for `git_batch_pull`.

Pieces this design retires:

- `src/main/operator/operator-thread-service.ts::buildAcknowledgement()` — deleted.
- `src/main/operator/operator-planner.ts` regex intent classifier — deleted. The CLI is the planner now.
- `src/main/operator/operator-engine.ts` — deleted. Tool invocation is MCP-driven from the chat's CLI; there is no residual engine.
- The current `OperatorPageComponent` single-thread UI — replaced by chat list + chat detail.

## Architecture

### 1. The Chat Aggregate

A chat is the durable identity. The CLI Instance is its runtime.

```
┌─ Chat (durable) ───────────────────────────────┐
│ id, name, provider, model, current_cwd,         │
│ project_id (nullable),                          │
│ ledger_thread_id  ────────► Conversation Ledger │
│ current_instance_id (nullable, runtime hint)    │
│ created_at, last_active_at, archived            │
└────────────────┬────────────────────────────────┘
                 │ spawns / despawns
                 ▼
┌─ Instance (disposable, InstanceManager) ───────┐
│ id, provider, model, workingDirectory,          │
│ transcript output buffer, child agents, MCP, …  │
└─────────────────────────────────────────────────┘
```

The chat record points to its ledger thread (durable) and optionally to a currently-running Instance (transient). The Instance does **not** talk to the ledger directly today; the required `ChatTranscriptBridge` in Architecture §4 is responsible for copying settled Instance/user turns into the ledger and rehydrating chat detail from that ledger transcript.

Switching cwd:

1. Mark `current_instance_id = null` on the chat record.
2. Gracefully terminate the old Instance.
3. Append a system event to the ledger: `Project switched to /path/to/<new>`.
4. Spawn a new Instance with the new cwd, same provider/model, link it via `chat.current_instance_id`.
5. On the first user turn after the switch, prepend a transcript-replay block to the user's message before sending it to the new Instance.

The new Instance does **not** inherit the prior CLI's in-memory context. The user-visible transcript stays intact because it lives in the ledger.

**Transcript replay policy (concrete v1):**

- On the first turn after a cwd switch (and only that turn), prepend a single context block of the form:
  > `[Context from prior conversation, working directory was /path/to/<old>:]`
  > `<the last K user/assistant turn pairs, in chronological order, plain text>`
  > `[Continue, working directory is now /path/to/<new>.]`
- `K` defaults to **10 turn pairs** and is capped by a per-provider character budget (provider-specific; e.g., 24 KB for Claude). If the budget is hit before K pairs fit, drop the oldest until it fits.
- This is a heuristic; we surface it as a chat-level setting with a sensible default. If users complain that the new Instance doesn't have enough context, we can grow K or move to a summarization-based replay later.

Tradeoff to be aware of: replay inflates the new Instance's first turn by up to ~24 KB and may bias the model toward continuing the prior conversation rather than fresh-engaging the new project. The alternative (no replay) makes the model feel like it has amnesia from the user's point of view, which is worse. We pick replay.

### 2. The Two Configurations

| | Project-fluid chat | Project-pinned chat |
|---|---|---|
| Sidebar group | **Chats** (new) | **Projects** (existing) → project group |
| `current_cwd` | switchable via UI | locked to the project's cwd |
| `project_id` | `null` | non-null FK to project record |
| Implementation | new `chat-service` + new sidebar component | **unchanged in v1**: existing project sessions continue to be `Instance` records with no chat aggregate around them |

Project-pinned chats remain `Instance`-only in v1. We are not refactoring the existing project session data model. The user already gets the multi-chat-per-project experience because the existing project group supports multiple instances.

In a later iteration we can unify (give every project session a `Chat` record too) but that is **not** part of this spec.

### 3. Conversation Ledger: Per-Chat Threads

The conversation ledger as it exists today cannot give each chat its own thread. The internal orchestrator adapter returns a singleton native thread id:

```ts
// src/main/conversation-ledger/internal-orchestrator-conversation-adapter.ts
export const INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID = 'orchestrator-global';

async startThread(...) {
  return {
    nativeThreadId: INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
    nativeSessionId: INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
    ...
  };
}
```

`ConversationLedgerService.startConversation()` then upserts by `(provider, nativeThreadId)`, so every `provider: 'orchestrator'` start collapses into the same row. **Multiple chats are impossible without changes here.**

Required changes:

1. **Adapter generates a unique native thread id per call.** `InternalOrchestratorConversationAdapter.startThread()` returns `nativeThreadId = 'orchestrator-chat-${randomUUID()}'`, with `nativeSessionId` mirroring it. The legacy constant `INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID = 'orchestrator-global'` is preserved for **migration lookup only** (so we can find the existing single thread). New chats never reuse it.
2. **Resume path stays valid.** `resumeThread()` already takes a `ref.nativeThreadId` from the caller, so unique-per-thread already works there. No changes needed beyond what (1) implies.
3. **Adapter accepts a per-call seed.** `NativeThreadStartRequest.metadata` may carry `chatId`; the adapter uses it to set deterministic `nativeThreadId = 'orchestrator-chat-${chatId}'` instead of a random uuid, so the chat record and the ledger thread are correlated by construction. (This is preferable to the chat-record holding the ledger thread id as a separate FK; both work, but a deterministic id makes recovery and debugging easier.)
4. **Migration:** the existing single thread keeps `nativeThreadId = 'orchestrator-global'`. The migrated chat row stores `ledger_thread_id` = the existing thread's ledger id (the upsert key on disk), not a new id. Old transcript is preserved.

This is a small change to one adapter file plus a thread-start contract addition; nothing in `ConversationLedgerService` or the ledger schema needs to change.

### 4. Transcript Bridge: Instance Output ↔ Ledger

Today, instance output flows to the per-instance output buffer (`InstanceCommunication.addToOutputBuffer`) and provider runtime events. **It does not flow to the conversation ledger.** The current Orchestrator surface fakes a transcript by writing user/assistant entries directly to the ledger via `ConversationLedgerService.sendTurn()` and `appendMessage()` — there is no real CLI behind it. For chats, where a real Instance backs the conversation, we need an explicit bridge.

A new service `src/main/chats/chat-transcript-bridge.ts` performs the bridging:

**Outbound (Instance → Ledger):**

- Subscribes to the existing instance output / runtime event streams for any Instance linked to a chat (the chat-service supplies the `chatId` ↔ `instanceId` link).
- Translates each event into a ledger message:
  - Streaming assistant output is coalesced by stable `nativeMessageId` when provider updates reuse the same message id; the durable transcript ends with the settled assistant turn, while intermediate streams still drive live rendering through the output buffer.
  - Tool calls and tool results become `role = 'tool'` ledger messages with `phase = 'tool_call' | 'tool_result'`, `metadata.kind = 'tool_call' | 'tool_result'`, and `metadata.toolUseId` for correlation.
  - Errors become assistant messages with `metadata.kind = 'error'`.
  - Native `instance:state-changed` and similar lifecycle events are not bridged; the chat detail surface still subscribes to instance events directly for live UX.
- Uses `ConversationLedgerService.appendMessage()` (which already exists for orchestrator-thread writes), not `sendTurn()`. The bridge is the producer; the CLI is the source.

**Inbound (User → Ledger → Instance):**

- The chat composer sends `chat:send-message` to the main process.
- The chat-service appends a user message to the ledger thread first (so the transcript reflects the user's intent even if the Instance hasn't started yet), then forwards the text to the Instance via the existing instance-input path.
- **Duplicate-message avoidance:** the transcript bridge never appends `OutputMessage` entries whose type is `user`. User turns are persisted only by `chat-service`; Instance user echoes are live renderer artifacts and are intentionally ignored at the bridge boundary. Chat-created Instances are spawned without `initialPrompt`; the first chat message always goes through `chat:send-message` so the ledger write happens exactly once.

**Renderer reads from the ledger, not the instance buffer:**

- Chat detail rehydrates from `ConversationLedgerService.getConversation(threadId)`, not from `Instance.outputBuffer`. The output buffer continues to drive in-flight streaming UX (typing animation, partial chunks), exactly as project-session detail does today, but the persistent transcript shown after a turn settles is the ledger.
- This means the existing `InstanceDetailComponent` template needs a small adjustment for chat detail: the persistent message list reads from the chat store (which mirrors the ledger), while live-streaming chunks read from the instance's output buffer. The implementation can share components but must not assume "instance output buffer = transcript" the way project-session detail currently does.

**What is NOT bridged:**

- Child-agent inner monologue (already lives in the orchestration HUD; not part of the chat transcript).
- File-explorer interactions, MCP server lifecycle events, etc. — out-of-band UX, not transcript content.

This bridge is the single biggest piece of new code in this spec and is required for v1.

### 5. Persistence

New table in the existing `userData/operator/operator.db`:

```sql
CREATE TABLE chats (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  provider             TEXT,         -- NULL only for the migrated legacy Orchestrator thread before bootstrap; see Migration
  model                TEXT,
  current_cwd          TEXT,         -- NULL only for the migrated legacy thread before bootstrap; see Migration
  project_id           TEXT,         -- always NULL in v1; reserved for v2 unification of project-pinned chats
  yolo                 INTEGER NOT NULL DEFAULT 0,
  ledger_thread_id     TEXT NOT NULL UNIQUE,
  current_instance_id  TEXT,         -- nullable; cleared on app restart
  created_at           INTEGER NOT NULL,
  last_active_at       INTEGER NOT NULL,
  archived_at          INTEGER       -- nullable; non-null = hidden from default list
);

CREATE INDEX idx_chats_last_active ON chats(last_active_at DESC) WHERE archived_at IS NULL;
CREATE INDEX idx_chats_ledger_thread ON chats(ledger_thread_id);
```

`provider` and `current_cwd` are both nullable so the migration bootstrap state (legacy Orchestrator thread, no provider/cwd yet) can be represented. **A chat with either column NULL cannot spawn an Instance** — the chat detail surface shows the bootstrap panel described in §Migration until both are set. For freshly created chats the "+ New chat" dialog requires both, so the columns are non-null at creation.

`yolo`: per-chat autonomy toggle, mirroring the per-instance yolo toggle in today's project sessions. Defaults off. UI affordance lives in chat detail header.

A migration converts the single existing Orchestrator ledger thread (created by the prior spec's Wave 1) into the first chat:

- Pick that thread (`provider: "orchestrator"`, `INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID` or matching metadata).
- Insert a `chats` row with name "Orchestrator" (or the thread's title if non-empty), `provider = NULL`, `model = NULL`, `current_cwd = NULL`, `ledger_thread_id` = that thread id.
- The existing transcript is preserved verbatim.
- On first open after migration, the chat detail surface shows a one-time "Pick a provider, model, and working directory to continue this conversation" panel; the composer is disabled until provider, cwd, and any required model choice are set.

### 6. Recovery on Restart

- Load chat list from `chats` table on startup. Display in sidebar.
- **Do not auto-spawn** Instances. `current_instance_id` is cleared at startup; clicking a chat only loads ledger state. The first user message lazy-spawns the Instance if needed.
- Optional follow-up (not v1): eager-spawn the most recently active N chats in the background.

### 7. Tools the Chat's CLI Can Invoke

The chat is a normal CLI session, so it has the provider's native tools (file read/write, shell, MCP, child agents, etc.). On top of that, this design exposes orchestrator-specific tools **via MCP injection**, using the existing infrastructure in `src/main/mcp/orchestrator-mcp-repository.ts` + `orchestrator-injection-reader.ts`.

**Important constraint: MCP injection is currently Claude-only and provider-scoped.** The constant `ORCHESTRATOR_INJECTION_PROVIDERS = ['claude']` (`src/shared/types/mcp-scopes.types.ts:43`) limits injection to Claude. v1 keeps that visibility model, but the built-in orchestrator-tools config includes the spawning `instanceId` so tool invocations can be attributed correctly.

- v1 ships `git_batch_pull` as an injected MCP tool **only for Claude-backed sessions**, and the injection is **global** across all Claude sessions (chat instances AND project sessions). This is a small UX bonus for project-session users — it doesn't break anything.
- For non-Claude chats (Codex / Gemini / Copilot), the user can still drive the same outcome by asking the chat's CLI to run shell commands; the CLIs all have shell tool access. We do not block non-Claude chats from running batch git operations; we just don't surface the structured `git_batch_pull` tool to them.
- Per-instance visibility scoping (only chat instances see the tool) is **out of scope for v1**. Per-instance **binding** is in scope: the same tool can be visible to all Claude sessions, but each built-in tools bridge receives `AI_ORCHESTRATOR_INSTANCE_ID`. The tool runner resolves `chatId` by looking up the chat whose `current_instance_id` matches that instance id.

Implementation pattern:

1. Add a new bundled stdio MCP bridge that exposes the orchestrator-specific tools:
   - `src/main/mcp/orchestrator-tools-mcp-server.ts` — child-process stdio entrypoint, similar to the browser/codemem MCP bridges.
   - `src/main/mcp/orchestrator-tools-mcp-config.ts` — resolves the packaged/dev bridge path and builds the inline MCP config JSON.
   - `src/main/mcp/orchestrator-tools.ts` — tool definitions and run-store writes.
2. Keep user-configured Orchestrator MCP servers in `OrchestratorMcpRepository` as today.
3. Change `InstanceLifecycleManager.getOrchestratorMcpConfigs(provider)` to accept the spawning `instanceId` and append the built-in orchestrator-tools config alongside `OrchestratorInjectionReader.buildBundle(provider)`.
4. The built-in inline MCP config injects these env vars into the stdio bridge: `AI_ORCHESTRATOR_OPERATOR_DB_PATH`, `AI_ORCHESTRATOR_CONVERSATION_LEDGER_DB_PATH`, and `AI_ORCHESTRATOR_INSTANCE_ID`.
5. The tool runner resolves source attribution by querying `ChatStore.getByInstanceId(instanceId)`. Project-session Claude Instances can call `git_batch_pull`; their source context has `chatId = null` and `threadId = 'mcp-standalone'`.

v1 ships exactly one tool through this path:

- `git_batch_pull({ root, ignore?, concurrency? })` — discover Git roots under `root`, fetch + fast-forward pull where safe, skip dirty / divergent / no-upstream / detached / no-remote with reasons. Returns a structured per-repo summary. Backed by the existing `git-batch-service.ts`.

(Reserved for the future Jira-board layer; **not** implemented in v1: `create_item({ … })`, `transition_item({ … })`.)

#### `git_batch_pull` Audit-Run Wrapper

With `OperatorEngine` removed (§What to Delete), the previous "run graph creation on every user message" path is gone. But we still want each tool invocation to be auditable in the existing `OperatorRun` / `OperatorRunNode` / `OperatorRunEvent` records (they have the right shape and the future Jira-board layer will reuse them).

The MCP tool handler does this directly, no engine needed:

1. **On invocation start** — handler creates one `OperatorRun` (status = `running`, title = `git_batch_pull`) plus one `OperatorRunNode` (type = `git-batch`, status = `running`). It captures source attribution using existing run fields:
   - `threadId` — the chat ledger thread id when `ChatStore.getByInstanceId(instanceId)` finds a chat; otherwise `'mcp-standalone'`.
   - `sourceMessageId` — latest ledger `tool_call` message for the chat when available, otherwise latest user message, otherwise `mcp-tool:<timestamp>`.
   - `planJson` on the run stores `{ tool: 'git_batch_pull', chatId, instanceId, messageId }`.
   - `inputJson` on the node stores the tool args plus the same `chatId`, `instanceId`, and `messageId`.
2. **During execution** — `git-batch-service` events stream into `OperatorRunEvent` records (`shell-command`, `progress`).
3. **On completion** — node and run move to `completed` (or `failed`); the per-repo summary is stored in `OperatorRunNode.outputJson`.
4. **Cancellation** — the user clicks "Cancel" in the run panel. IPC marks the run `cancelled`; the live MCP tool checks `runStore.getRun(run.id)?.status === 'cancelled'` through `GitBatchPullOptions.shouldCancel`.
   - Extend `GitBatchPullOptions` with `shouldCancel?: () => boolean`.
   - `GitBatchService.pullAll()` and `pullRepository()` call `throwIfCancelled(options)` before discovery, before/after each repository worker, and between Git commands.
   - Cancellation throws `GitBatchCancelledError`, and the MCP handler marks the node/run `cancelled`.
   - This is best-effort for an already-running Git child command, but it prevents remaining repositories from starting once the cancellation is observed.
   - The IPC handler at `OPERATOR_CANCEL_RUN` is repointed from `getOperatorEngine().cancelRun()` to `OperatorRunRunner.cancel(runId)`.
5. **Retry** — re-invoking the tool with the same args creates a fresh run; retry does not mutate the prior run. The `OPERATOR_RETRY_RUN` IPC handler is **deleted** in v1 (no chat-issued retry button); future work can add a "retry from history" affordance if useful.
6. **Event streaming to renderer** — the existing `OperatorRunEvent` channel (`operator:event`) is reused. The renderer's run panel subscribes to it.

This means three of the existing `OPERATOR_*` IPC handlers stay (with simplified backing): `OPERATOR_GET_RUN` (read-only), `OPERATOR_LIST_RUNS` (read-only), `OPERATOR_CANCEL_RUN` (repointed to the new runner). `OPERATOR_RETRY_RUN`, `OPERATOR_GET_THREAD`, `OPERATOR_SEND_MESSAGE`, `OPERATOR_LIST_PROJECTS`, `OPERATOR_RESCAN_PROJECTS` are **deleted** — they belonged to the deterministic Orchestrator surface that's being replaced.

We are explicitly **not** preserving:

- `project-agent` executor — a chat *is* a project agent now.
- `synthesis` executor — the LLM writes its own summaries.
- `verification` executor — the user can ask the chat to run verification, and the chat's CLI runs the commands itself.
- Auto intent classification + run graph creation on every user message — replaced by direct chat → CLI.

The `OperatorRun` / `OperatorRunNode` / `OperatorRunEvent` schema in `operator-run-store.ts` is retained because (a) it's a clean record of structured tool invocations (the `git_batch_pull` MCP tool writes into it as a single-node run for auditability) and (b) it gives the future Jira-board layer a head start. Only tool invocations write into it.

## User Experience

### Sidebar

```
─ New chat ─────────────────────  (button)
─ Chats ────────────────────────  (group header)
  ● <chat name>             provider · cwd-display
  ● <chat name>             …
  …
─ Projects ─────────────────────  (existing, unchanged)
  ▸ Project A
  ▸ Project B
  …
```

The Chats group:

- Shows a flat list ordered by `last_active_at DESC`, archived chats hidden.
- Each row: chat name, provider/model badge, current cwd display (basename or "no project"), live/idle status dot.
- Click → select the chat. The dashboard renders chat detail in the main content area.

**Selection model — no new Angular routes.** The current dashboard already drives the main content area from store state, not from routing: `dashboard.component.html:103` switches on `operatorStore.selected()` to render `<app-operator-page />` vs. `<app-instance-detail />`. We replicate this pattern for chats — we do not introduce a `/chats/:id` route. Specifically:

- Rename `OperatorStore` to `ChatSelectionStore` (or keep `OperatorStore` and add a `selectedChatId` signal — implementer's call). Selection is a renderer-side store value.
- The dashboard template's `@if (operatorStore.selected())` branch is replaced with `@if (chatStore.selectedChatId())` rendering `<app-chat-detail />` (a new component that wraps `InstanceDetailComponent` with the chat-specific header).
- Sidebar click sets the selected chat id; chat detail unmounts when the user selects a project session or another sidebar entry.
- This mirrors how project sessions are selected today and avoids reworking the dashboard's routing model.

The "+ New chat" entry opens a small dialog with these fields:

- **Name** (optional). If blank, the chat row shows `Untitled chat` until the user sends a first message; on first send, name is auto-set to the first ~40 characters of the user message (trimmed at a word boundary). User can rename anytime via the chat detail header.
- **Provider** (required) — one of the existing `SupportedProvider` values (`claude` / `codex` / `gemini` / `copilot`, defined in `src/shared/types/mcp-scopes.types.ts:18-21`). The broader `CanonicalCliType` union also contains `auto` and `cursor`, but those are **not** valid chat providers in v1; the create dialog excludes them.
- **Model** (provider-specific picker; required when the provider has no useful default).
- **Initial cwd** (required) — defaults to the last-used cwd from any prior chat, falling back to `$HOME`. Folder picker available.

Submit → create the `chats` row → navigate to chat detail. The CLI Instance is spawned lazily on the first user message (or eagerly on detail open if implementation finds that gives a better feel; trivial to switch).

The current single pinned **Orchestrator** sidebar row is removed. The promotion described under Persistence preserves the existing transcript as the first chat row.

### Chat Detail Surface

Reuse `InstanceDetailComponent` (or extract the parts that aren't project-coupled into a shared sub-component, depending on what's cleaner — a renderer-only refactor decision the implementer can make). Differences from project-session detail:

- Header shows: chat name (editable), provider badge, **project picker chip** (clickable; opens cwd switcher), yolo toggle (per chat; persisted to `chats.yolo`).
- No "project group" breadcrumb / membership UI.
- Composer behaves exactly as in project sessions.

The cwd-switch flow is described in Architecture §1.

### Welcome State

A new chat with no messages shows a small welcome card:

> Start a conversation with <provider/model>. Ask anything; reference projects by name or path. Use the project picker above to set the working directory.

No deterministic acknowledgement. No regex routing. The first user message is sent straight to the CLI Instance.

## What to Delete

- `src/main/operator/operator-thread-service.ts` — entire file. Replaced by `chat-service`.
- `src/main/operator/operator-engine.ts` — entire file. Tool invocation is MCP-driven from the chat's CLI; the engine has no role.
- `src/main/operator/operator-planner.ts` — entire file (regex intent classifier).
- `src/main/operator/operator-project-agent-executor.ts`, `operator-synthesis-executor.ts`, `operator-verification-executor.ts`, `operator-fix-worker-prompt.ts`, `operator-stall-detector.ts`, `operator-follow-up-scheduler.ts`, `operator-budget.ts`, `operator-memory-promoter.ts` — entire files. Pieces of the deterministic engine with no place in v1. The implementation plan must run a "no remaining importers" check before deleting each.
- `src/renderer/app/features/operator/operator-page.component.ts` — entire file.
- **`src/renderer/app/features/dashboard/dashboard.component.ts`** — remove the `OperatorPageComponent` import (line 30) and its entry in the standalone component `imports` array (line 53). Replace with the new chat-detail component import + entry.
- **`src/renderer/app/features/dashboard/dashboard.component.html`** — replace the `@if (operatorStore.selected()) { <app-operator-page /> } @else { … }` block (lines ~103–111) with the chat selection switch described in §User Experience.
- **`src/main/app/initialization-steps.ts`** — replace the operator-engine / operator-thread-service / operator-stall-detector init steps (around lines ~119, ~133+) with the new chat-service init step. Keep the operator-database init step (the database stays). Keep the run-store-only readers needed for the audit-run wrapper.
- **`src/main/ipc/handlers/operator-handlers.ts`** — delete handlers for `OPERATOR_GET_THREAD`, `OPERATOR_SEND_MESSAGE`, `OPERATOR_RETRY_RUN`, `OPERATOR_LIST_PROJECTS`, `OPERATOR_RESCAN_PROJECTS`. Repoint `OPERATOR_CANCEL_RUN` to the new `OperatorRunRunner.cancel(runId)`. Keep `OPERATOR_GET_RUN` and `OPERATOR_LIST_RUNS` (read-only). The renderer side (`operator-ipc.service.ts`, `operator.store.ts`) drops its references to the removed channels at the same time.
- **`src/renderer/app/core/state/operator.store.ts`** — replaced (or evolved in place, implementer's call) by the new chat selection store described in §User Experience. The `selected()` signal stays in form, the contents change.
- The pinned single-row sidebar entry that routed to the operator surface — replaced by the new Chats group.

## What to Keep / Reposition

- `src/main/operator/operator-database.ts` and `userData/operator/operator.db` — kept; used for `chats` table.
- `src/main/operator/operator-run-store.ts` / `operator-event-bus.ts` / `operator-schema.ts` and the `OperatorRun*` types — kept; used by tool invocations for audit records and reserved for the future Jira-board layer. Tool-run source attribution is stored in existing `thread_id`, `source_message_id`, run `plan_json`, and node `input_json` fields.
- `src/main/operator/git-batch-service.ts` (already implemented) — kept; exposed as the `git_batch_pull` chat tool via MCP.
- `src/main/operator/operator-project-store.ts` — keep for now; the project registry is useful for the project picker UI in Wave B (the cwd switcher can suggest known projects). If unused after Wave B, remove in Wave C cleanup.
- Conversation ledger extensions for `provider: "orchestrator"` threads — kept; chat transcripts use them.
- `InstanceManager` — kept; chat runtimes are Instances. The cwd-switch path may need a small new lifecycle helper (`InstanceManager.replaceInstanceForChat(chatId, newCwd)`) that gracefully terminates the old instance and spawns the new one in one atomic operation.

## Out of Scope (Don't Touch)

- Existing project sessions / project sidebar groups / `instance-list` rendering of projects.
- The project-instance recovery code path. Project-pinned chats in v1 are still Instances and recover the way they always have.
- The Automations sidebar entry. (Already exists.)
- `forkInstance()` metadata-preservation work mentioned in the prior spec — only relevant if we link operator runs back to specific instances, which we mostly aren't doing in v1.

## Data Model Reference

### `chats` table

(See Architecture §5 Persistence.)

### Tool-run source attribution

Do **not** add a new `operator_runs.metadata_json` column in v1. The retained operator-run schema already has enough fields for audit attribution:

- `operator_runs.thread_id` — chat ledger thread id, or `'mcp-standalone'` for non-chat Claude project sessions.
- `operator_runs.source_message_id` — latest ledger tool-call/user message id when available, or an `mcp-tool:<timestamp>` fallback.
- `operator_runs.plan_json` — stores `{ tool: 'git_batch_pull', chatId, instanceId, messageId }`.
- `operator_run_nodes.input_json` — stores the tool args plus the same attribution fields.

This keeps the run-store contract small and matches the existing `OperatorRunStore` APIs.

### Future: `items` table (Jira-board layer; **NOT** v1)

Described here only so the v1 design doesn't paint us into a corner. Not implemented in v1.

```sql
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  origin_chat_id  TEXT NOT NULL REFERENCES chats(id),
  project_id   TEXT,
  title        TEXT NOT NULL,
  description  TEXT,
  stage        TEXT NOT NULL,            -- enum, configurable per board later
  assignee     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  custom_json  TEXT                      -- JSON blob for extensibility
);
```

Items reference chats; chats do not depend on items. Adding items later does not change the chat schema.

## IPC and Contracts

New channels in `packages/contracts/src/channels/chat.channels.ts`:

- `chat:list`
- `chat:get`
- `chat:create`
- `chat:rename`
- `chat:archive`
- `chat:set-cwd`           — Wave A: sets bootstrap/pre-runtime cwd for chats with no active Instance; Wave B: also initiates the cwd-switch flow described in Architecture §1
- `chat:set-provider`      — sets the chat's provider; only valid before the first message in the chat (or as part of the migrated-chat-bootstrap flow)
- `chat:set-model`         — sets the chat's model; valid at any time, but provider must be set first
- `chat:set-yolo`          — toggles per-chat yolo
- `chat:send-message`      — appends a user message to the ledger thread; lazy-spawns the Instance if needed; forwards to the Instance
- `chat:event`             — server-push for instance state, transcript updates, and tool-invocation progress

(Tool invocation goes through MCP, not a dedicated IPC. The retained `OPERATOR_GET_RUN` / `OPERATOR_LIST_RUNS` / `OPERATOR_CANCEL_RUN` and `operator:event` channels are reused for tool-run audit, list, cancel, and progress streaming.)

New Zod schemas in `packages/contracts/src/schemas/chat.schemas.ts`.

#### Contracts package wiring (don't miss any of these)

Adding a new contracts subpath touches more places than just `tsconfig`. The full checklist:

1. **Create the schema/channel files** in `packages/contracts/src/schemas/chat.schemas.ts` and `packages/contracts/src/channels/chat.channels.ts`.
2. **Add exports entries** to `packages/contracts/package.json`:
   ```json
   "./schemas/chat":  { "types": "./src/schemas/chat.schemas.ts",  "default": "./src/schemas/chat.schemas.ts" },
   "./channels/chat": { "types": "./src/channels/chat.channels.ts", "default": "./src/channels/chat.channels.ts" }
   ```
3. **Wire `CHAT_CHANNELS`** into `packages/contracts/src/channels/index.ts`: import, re-export, and spread into the `IPC_CHANNELS` literal.
4. **Update tsc path aliases:** `tsconfig.json` and `tsconfig.electron.json` (renderer + main type-checking).
5. **Update Node runtime resolver:** `src/main/register-aliases.ts` (`exactAliases` map). Per `AGENTS.md`, missing this trap silently breaks the packaged DMG.
6. **Update vitest:** `vitest.config.ts` if any test imports the new subpath.
7. **Add preload domain:** `src/preload/domains/chat.preload.ts` exposing the new channels through `contextBridge`.
8. **Wire preload domain** into `src/preload/preload.ts` so the renderer sees `window.electronAPI.chat`.
9. **Add renderer IPC service:** `src/renderer/app/core/services/ipc/chat-ipc.service.ts`.
10. **Add renderer state:** `src/renderer/app/core/state/chat.store.ts`.
11. **Run `npm run verify:ipc`** and `npm run verify:exports` and `npm run check:contracts` (all part of `prestart`/`prebuild`/`verify`). The implementation plan must include a step to confirm these pass before claiming the wave is done.

Skipping any of 2–6 will produce a packaged DMG that crashes at runtime even though `npm run dev` looks fine. (See `AGENTS.md` "Packaging Gotchas".)

## Migration

One-off migration on first launch after the new code ships:

1. Find the existing thread by `nativeThreadId = 'orchestrator-global'` (the legacy `INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID` constant). If present, insert a corresponding `chats` row pointing at the existing thread's ledger id; the legacy native thread id is retained on that ledger row so the data layer is consistent.
2. Set `name = thread.title` if non-empty, otherwise `"Orchestrator"`.
3. `provider = NULL`, `model = NULL`, `current_cwd = NULL`, `project_id = NULL`, `yolo = 0`. The `chats.provider` and `chats.current_cwd` columns are intentionally nullable in §Persistence to accommodate this bootstrap state; freshly created chats still require both values at creation time.
4. The user keeps their transcript history and lands on this chat as the first item in the new Chats list. The chat detail surface shows a one-time bootstrap panel:
   - **Provider** picker (required) — invokes `chat:set-provider` on submit.
   - **Model** picker (required for providers without a useful default) — invokes `chat:set-model`.
   - **Working directory** picker (required) — invokes `chat:set-cwd`.
   - The composer is disabled until provider, cwd, and any required model choice are set.
5. After bootstrap, the chat behaves like any other chat. Subsequent `chat:set-provider` calls are rejected (provider can only be set once per chat); `chat:set-model` and `chat:set-cwd` remain allowed.

If no `'orchestrator-global'` thread is found (fresh install), no migration is needed.

**Schema implication:** the `chats.provider` column is `TEXT` (nullable) rather than `TEXT NOT NULL` to support the migration bootstrap state.

## Testing Strategy

Unit tests:

- `InternalOrchestratorConversationAdapter.startThread()` returns unique native thread ids per call, and resumeThread round-trips them.
- `ChatTranscriptBridge` outbound: instance assistant turns, tool calls, tool results, and errors land in the ledger with the correct metadata; streaming chunks are coalesced.
- `ChatTranscriptBridge` inbound: `chat:send-message` appends one user message, and the bridge drops Instance-emitted `user` output so no duplicate user ledger message is produced.
- `chat-service` create / rename / archive / set-provider / set-model / set-yolo happy paths and validation (e.g., `set-provider` rejected after first message).
- `chat-service.set-cwd` bootstrap mode sets `current_cwd` for a migrated chat before any Instance is spawned.
- `chat-service.set-cwd` correctly terminates the old instance, creates the new one, links it, and appends the system event to the ledger (Wave B).
- Migration: existing `'orchestrator-global'` ledger thread → first chat row in bootstrap state; later `set-provider`/`set-model`/`set-cwd` complete bootstrap.
- Sidebar store: list ordering by `last_active_at`, archive hide.
- Cwd-switch transcript replay policy: last 10 turn pairs reach the new Instance's prompt, capped by character budget.
- Tool-run source attribution is written to existing `thread_id`, `source_message_id`, run `plan_json`, and node `input_json` fields.
- `GitBatchService.pullAll()` honors `shouldCancel` by preventing remaining repositories from starting and throwing `GitBatchCancelledError`.

IPC tests:

- Schema validation for each new channel.
- Lazy-spawn on first send-message.
- MCP-routed tool invocation: when a Claude chat's CLI calls `git_batch_pull`, an `OperatorRun` is produced with chat/source attribution in `thread_id`, `source_message_id`, run `plan_json`, and node `input_json`; cancel via `OPERATOR_CANCEL_RUN` best-effort cancels Git work through `shouldCancel`; progress events flow over `operator:event`.
- Repointed `OPERATOR_CANCEL_RUN` no longer calls `getOperatorEngine` (regression guard against accidental engine resurrection).

Renderer tests:

- Chats sidebar group renders, "+ New chat" dialog flow.
- Chat detail surface reuses transcript / composer; project picker shows current cwd.
- Migration bootstrap panel: composer is disabled until provider, cwd, and any required model choice are set.
- Cwd switch in UI triggers IPC and shows the system event in the transcript (Wave B).

Integration tests:

- Restart recovery: create a chat, send a message, restart the runtime, the chat is still in the list with its transcript intact (read from the ledger), no Instance spawned until the first post-restart user message.
- `git_batch_pull` tool invocation from a Claude chat against a temporary multi-repo workspace; verify per-repo summary in `OperatorRunNode.outputJson`, attribution in run `plan_json` / node `input_json`, and cancellation behavior through `shouldCancel`.
- Packaging guard: `npm run prebuild` (which runs `verify:ipc` + `verify:exports` + `check:contracts` + `verify-native-abi`) passes after the changes.

Verification commands after implementation:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- targeted Vitest suites for chat service, chat IPC, renderer chat store/components.
- full `npm run test` after the multi-file change is in.

## Rollout Plan

### Wave A — Chat aggregate + sidebar list + transcript bridge (no cwd switching yet)

- Modify `InternalOrchestratorConversationAdapter.startThread()` to generate per-call unique native thread ids (Architecture §3).
- Add `chats` table + migration of the existing `orchestrator-global` thread (with bootstrap state).
- Add `chat-service` + the **transcript bridge** (Architecture §4). Without the bridge the migrated chat's transcript can't be displayed and new chat replies don't persist.
- Add IPC channels: `chat:list`, `chat:get`, `chat:create`, `chat:rename`, `chat:archive`, `chat:set-provider`, `chat:set-model`, `chat:set-cwd`, `chat:set-yolo`, `chat:send-message`, `chat:event`.
- Wave A includes `chat:set-cwd` for bootstrap/pre-runtime cwd selection so migrated chats can leave bootstrap. Wave B expands the same channel to full runtime cwd switching.
- Wire all 11 contracts-package steps in §IPC and Contracts.
- Add the Chats sidebar group + "+ New chat" dialog.
- Add the chat-detail component wrapping `InstanceDetailComponent`, including the migrated-chat bootstrap panel.
- Update `dashboard.component.ts/html` to render chat-detail when a chat is selected (replaces the `OperatorPageComponent` branch).
- Update `initialization-steps.ts` and `operator-handlers.ts` per §What to Delete; keep the run-store-only IPC handlers.
- Delete the old engine / planner / executors / thread-service / `operator-page.component.ts` per §What to Delete (with importer-check).
- Cwd can be chosen during create/bootstrap in Wave A; switching away from an already-spawned cwd is Wave B.
- Acceptance: user can create N chats with provider/model/cwd, talk to a real LLM in each, restart the app, see them all listed, transcripts intact (driven by the ledger, not the dead Instance's buffer); the migrated Orchestrator thread appears as the first chat with its prior transcript visible after the bootstrap panel is satisfied; `verify:ipc` / `verify:exports` / `check:contracts` all pass; the packaged DMG launches without "Cannot find module" errors.

### Wave B — Cwd switching

- Add the project picker chip to the chat detail header.
- Expand `chat:set-cwd` from bootstrap-only behavior to runtime switching, backed by the `replaceInstanceForChat` lifecycle helper.
- Implement transcript replay policy on the new Instance's first turn (Architecture §1).
- Append the project-switch system event to the ledger on switch.
- Acceptance: in a single chat, the user switches projects; the transcript is continuous in the renderer; the new Instance receives a replay block on its first turn and operates in the new cwd.

### Wave C — Tool layer

- Add the new internal MCP server `orchestrator-tools-mcp-server` exposing `git_batch_pull`.
- Append its built-in inline config from `InstanceLifecycleManager.getOrchestratorMcpConfigs(provider, instanceId)` for Claude-backed spawns; keep `OrchestratorMcpRepository` for user-configured Orchestrator MCP entries.
- Implement the audit-run wrapper (§7): `OperatorRun` per invocation, source attribution, cancel via `OperatorRunRunner.cancel`, event streaming through `operator:event`.
- Surface tool invocations in the existing run-graph panel, visible only when the active chat has triggered a structured run.
- Acceptance: in a Claude-backed chat, the user asks "pull all repos in /Users/suas/work" and the CLI invokes `git_batch_pull`; a run row appears in the run panel; events stream live; cancellation works mid-run.

Each wave is independently shippable when taken in order. Wave B depends on Wave A. Wave C also depends on Wave A for chat identity, transcript bridge events, and active-chat run-panel filtering, but does not depend on Wave B.

## Success Criteria

- The screenshot in the user's report (typing "list files in the root of the minecraft project" and getting a canned acknowledgement plus blocked run) cannot reproduce. The same prompt in a chat now reaches a real LLM that can interpret it, ask a clarifying question, or use its tools to act.
- Multiple chats can be created, named, switched between, and archived from the sidebar.
- Chats persist across app restarts; their CLI Instances do not.
- A chat in the Chats group can change its working directory mid-conversation without losing visible transcript continuity.
- Project-pinned chats inside the Projects sidebar group continue to work exactly as today.
- A Claude-backed chat can invoke structured `git_batch_pull` to "pull all repos in my work folder" through its MCP tool path. Non-Claude chats can perform equivalent work through their shell tools, without the structured audit-run wrapper in v1.
- The future items / Jira-board layer can be added in a later spec without changing the chat schema.

## Open Questions / Future Work

(All decisions explicitly out of v1 scope; called out so v1 doesn't preclude them.)

- **Eager spawn on startup.** v1 is lazy. If startup latency on click is bad, we may want to eager-spawn the most recently active chats in the background.
- **Cross-chat search.** The reference screenshot shows a "Search" entry. Out of scope for v1; design when the chat list grows large enough to need it.
- **Status icons** (clock for scheduled, blue dot for unread, spinner for running). Out of scope for v1; trivial to add later.
- **Project-fluid-per-message routing** (option C from brainstorming). Deferred. If users want to mention multiple projects in one chat without manually switching cwd, this is the future direction.
- **Unifying project sessions and chats** under a single `Chat` record. Deferred. The current dual representation (Chats: aggregate over Instance; Projects: bare Instances) is acceptable for v1; consolidating in v2 is mechanical.
- **Items / Jira board.** Sketched in Data Model §Future. Spec separately when the user is ready.
- **Cwd-switch replay strategy.** v1 prepends the last 10 turn pairs to the new Instance's first turn. Alternatives if this proves insufficient: summarization-based replay, or sticky context that re-prepends on every turn until the user explicitly clears it.
- **Per-instance MCP injection scoping.** v1 accepts that `git_batch_pull` is visible to all Claude instances (chat AND project sessions), even though the built-in bridge receives `instanceId` for attribution. Future work: add an `injectInto.scope` (e.g. `'chat-only' | 'all'`) so chat-only tools don't leak into project sessions and so structured tools can later be exposed to non-Claude chats too.
- **Non-Claude chats and structured tools.** Codex / Gemini / Copilot chats can drive batch git work via shell tools but won't see the structured `git_batch_pull` tool until per-instance MCP scoping (above) is in place — or until each provider's CLI gets its own injection path.

## Completion Validation

Completed and revalidated on 2026-05-07.

Implementation evidence:

- Chat aggregate, persistence, bootstrap migration, provider/model/cwd/yolo mutation, restart recovery, and transcript bridge: `src/main/chats/`.
- Chat contracts and preload/renderer IPC: `packages/contracts/src/channels/chat.channels.ts`, `packages/contracts/src/schemas/chat.schemas.ts`, `src/preload/domains/chat.preload.ts`, `src/renderer/app/core/services/ipc/chat-ipc.service.ts`.
- Chat UI surface: `src/renderer/app/features/chats/`, with the dashboard rendering chat detail when a chat is selected.
- Retired deterministic operator engine/planner/thread-service APIs are no longer exported, and retained operator IPC is limited to run audit/list/get/cancel.
- `git_batch_pull` is exposed through the internal orchestrator MCP server, writes operator run audit records with chat/source attribution, streams run events, and observes cancellation.

Focused verification run:

```bash
npx vitest run src/main/chats/chat-service.spec.ts src/renderer/app/core/state/chat.store.spec.ts packages/contracts/src/channels/__tests__/chat.channels.spec.ts packages/contracts/src/schemas/__tests__/chat.schemas.spec.ts src/preload/__tests__/chat-domain.spec.ts src/renderer/app/core/services/ipc/chat-ipc.service.spec.ts src/renderer/app/features/chats/chat-components.spec.ts src/main/mcp/__tests__/orchestrator-tools.spec.ts src/main/mcp/__tests__/orchestrator-tools-mcp-config.spec.ts src/main/operator/operator-barrel.spec.ts src/main/operator/operator-event-relay.spec.ts
```

Result: 11 files passed, 30 tests passed.
