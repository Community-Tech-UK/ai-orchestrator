# Project Code Index Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Wave 3A of unified project memory by syncing codemem file/symbol snapshots into project-scoped source provenance, read models, IPC, and the Knowledge UI.

**Architecture:** Keep codemem as the authoritative code index. Add a rebuildable RLM snapshot (`project_code_index_status`, `project_code_symbols`) keyed by project root, and update project knowledge reads to include code files, symbols, and definition-location evidence. The coordinator remains thin: high-signal mining continues as before while code indexing runs deduped in the background or by explicit UI action.

**Tech Stack:** TypeScript 5.9, Electron 40 main process, Angular 21 renderer, better-sqlite3/RLM migrations, codemem CAS store, Zod IPC schemas, Vitest.

---

## Reviewer Consensus

- Enforce hard Wave 3A limits: 5,000 files, 250 MB, 100,000 symbols, and 120s codemem timeout.
- Use kind-scoped source pruning before adding `code_file`.
- Use deterministic full snapshot replay from codemem into RLM; no cross-DB transaction or changelog in this wave.
- Preserve prior successful symbol rows while indexing or failed.
- Treat `project_code_symbols` as rebuildable snapshot rows only; future user annotations must live in a separate table, not on these rows.
- Define code-symbol evidence as `definition_location`, not semantic proof.
- Cap renderer-facing symbol previews to 200 rows by default while status/inventory counters expose full counts.
- Keep import/call graph facts, conversation memory, retrieval, and startup prompt packing out of scope.

## Files

- Modify: `src/shared/types/knowledge-graph.types.ts`
- Modify: `src/main/persistence/rlm-database.types.ts`
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Modify: `src/main/persistence/rlm/rlm-project-knowledge.ts`
- Modify: `src/main/memory/codebase-miner.ts`
- Create: `src/main/persistence/rlm/rlm-project-code-index.ts`
- Create: `src/main/memory/project-code-index-bridge.ts`
- Modify: `src/main/memory/project-knowledge-coordinator.ts`
- Modify: `src/main/memory/project-knowledge-read-model.ts`
- Modify: `src/main/memory/index.ts`
- Modify: `src/main/bootstrap/memory-bootstrap.ts`
- Modify: `packages/contracts/src/channels/memory.channels.ts`
- Modify: `packages/contracts/src/schemas/knowledge.schemas.ts`
- Modify: `src/preload/generated/channels.ts`
- Modify: `src/preload/domains/memory.preload.ts`
- Modify: `src/renderer/app/core/services/ipc/memory-ipc.service.ts`
- Modify: `src/renderer/app/core/state/knowledge.store.ts`
- Modify: `src/renderer/app/features/knowledge/knowledge-page.component.ts`
- Test: `src/tests/unit/memory/project-knowledge-persistence.test.ts`
- Create test: `src/tests/unit/memory/project-code-index-persistence.test.ts`
- Create test: `src/tests/unit/memory/project-code-index-bridge.test.ts`
- Test: `src/tests/unit/memory/project-knowledge-coordinator.test.ts`
- Test: `src/tests/unit/memory/project-knowledge-read-model.test.ts`
- Test: `src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`

## Task 1: Protect Existing Source Pruning

- [ ] Add `deleteProjectKnowledgeSourcesByKindNotSeen` before enabling any writer that creates `code_file` sources.
- [ ] Update `CodebaseMiner` so high-signal mining prunes only `manifest`, `readme`, `instruction_doc`, and `config` source kinds.
- [ ] Add tests proving high-signal mining/pruning preserves existing `code_file` sources.

## Task 2: Shared Types, Schema, And Persistence

- [ ] Add `code_file` to `ProjectKnowledgeSourceKind`.
- [ ] Add `code_symbol` to `ProjectKnowledgeTargetKind`.
- [ ] Add DTOs:
  - `ProjectCodeIndexRunStatus`
  - `ProjectCodeIndexStatus`
  - `ProjectCodeSymbol`
  - `ProjectCodeIndexRefreshRequest`
- [ ] Extend `ProjectKnowledgeSourceInventory` with `totalCodeSymbols`.
- [ ] Extend `ProjectKnowledgeReadModel` with `codeIndex` and `codeSymbols`.
- [ ] Add RLM row types: `ProjectCodeIndexStatusRow`, `ProjectCodeSymbolRow`.
- [ ] Keep already-applied migration `020_project_knowledge_sources` unchanged to preserve migration checksums; migration 021 must rebuild the CHECK constraint for both upgraded and fresh databases.
- [ ] Add migration `021_project_code_index_bridge`:
  - Rebuild `project_knowledge_sources` CHECK constraint for upgraded databases to include `code_file`.
  - Create `project_code_index_status`.
  - Create `project_code_symbols` with FK to `project_knowledge_sources(id) ON DELETE CASCADE`.
  - Add symbol lookup/source/path indexes.
- [ ] Add `PROJECT_CODE_INDEX_SNAPSHOT_VERSION = 1` and persist it in status and symbol metadata.
- [ ] Add stale-indexing normalization: `indexing` statuses older than `PROJECT_CODE_INDEX_TIMEOUT_MS` surface as `failed`/stale until the next successful refresh.
- [ ] Add persistence tests proving:
  - `code_file` sources can be inserted.
  - `deleteProjectKnowledgeSourcesByKindNotSeen` prunes only one kind.
  - deleting a `code_file` source cascades symbol rows.
  - inventory includes total code symbols.
  - `listProjectEvidenceForTarget(..., 'code_symbol', symbolId)` returns a synthesized definition-location evidence DTO.
  - status/symbol metadata carries `snapshotVersion: 1`.
  - stale `indexing` status is normalized in returned status DTOs.

## Task 3: Project Code Index Persistence Module

- [ ] Create `src/main/persistence/rlm/rlm-project-code-index.ts`.
- [ ] Implement deterministic ID helper for symbol rows: `stableId('pcs', projectKey, symbolId)`.
- [ ] Implement:
  - `upsertProjectCodeIndexStatus`
  - `getProjectCodeIndexStatus`
  - `replaceProjectCodeSymbols`
  - `listProjectCodeSymbols`
  - `getProjectCodeSymbol`
  - `countProjectCodeSymbols`
- [ ] `replaceProjectCodeSymbols` must run inside the caller's transaction, delete existing rows for one project, insert current rows, cap `signature` at 500 chars and `docComment` at 1,000 chars, write `snapshotVersion: 1`, and normalize missing end positions to start positions in DTO mapping.
- [ ] Keep raw nullable end columns in the DB; normalize only in returned DTO/evidence.
- [ ] `listProjectCodeSymbols` defaults to a 200-row preview ordered by path, start line, and name.

## Task 4: ProjectCodeIndexBridge

- [ ] Create `src/main/memory/project-code-index-bridge.ts`.
- [ ] Define constants:
  - `PROJECT_CODE_INDEX_MAX_FILES = 5000`
  - `PROJECT_CODE_INDEX_MAX_BYTES = 250 * 1024 * 1024`
  - `PROJECT_CODE_INDEX_MAX_SYMBOLS = 100000`
  - `PROJECT_CODE_INDEX_TIMEOUT_MS = 120000`
- [ ] Define `PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT = 200` for renderer-facing reads.
- [ ] Define injectable `ProjectCodeIndexSource` interface wrapping codemem.
- [ ] Add production adapter over `getCodemem()`.
- [ ] Implement `refreshProject(rootPath, options?)`.
- [ ] Implement in-flight dedupe map keyed by normalized project key; a background refresh and explicit refresh for the same key return/observe the same promise and never run concurrently.
- [ ] Implement preflight scanner with built-in ignores and `.gitignore` support.
- [ ] Status behavior:
  - disabled codemem -> `disabled`
  - paused/excluded project -> `paused`/`excluded`
  - limit exceeded -> `failed` with metadata reason
  - timeout -> `failed` with metadata reason, preserve rows
  - sync success -> `ready`
- [ ] Snapshot transaction must:
  - Upsert `code_file` sources for manifest entries using `(project_key, source_uri)` where `source_uri` is the absolute file path.
  - Prune only `code_file` source rows absent from manifest.
  - Replace project symbols from codemem symbols.
  - Update ready status with counts/timestamps.
- [ ] Timeout handling must attach a late `.catch(() => {})` to the codemem promise when the timeout wins, preventing unhandled rejection noise after status is already `failed`.
- [ ] Comment the snapshot assumption: manifest and symbols are read as a current codemem snapshot for one workspace hash; Wave 3A repairs any drift with the next full replay.
- [ ] Tests must cover success, disabled, paused/excluded, background+explicit in-flight dedupe, file/byte limit failure, timeout failure, symbol limit failure, deletion prune/cascade, and preserving prior rows on failure.

## Task 5: Coordinator, IPC, Preload, And Store

- [ ] Extend `ProjectKnowledgeCoordinator` deps with code index bridge.
- [ ] In `ensureProjectKnown(..., { autoRefresh: true })`, start code-index refresh in the background only when auto mining is allowed. Swallow/log failures so spawn/mining is not blocked.
- [ ] In `refreshProject(...)`, start code-index refresh in the background after manual mining is accepted.
- [ ] Add `refreshProjectCodeIndex(rootPath)` for explicit UI action.
- [ ] Add memory channel `PROJECT_KNOWLEDGE_REFRESH_CODE_INDEX`.
- [ ] Add Zod payload schema for `{ projectKey: string }` or `{ rootPath: string }` consistently; use `projectKey` because read-model selection is project-key based.
- [ ] Register IPC handler that calls `getProjectKnowledgeCoordinator().refreshProjectCodeIndex(projectKey)`.
- [ ] Expose preload and `MemoryIpcService.projectKnowledgeRefreshCodeIndex`.
- [ ] Update `KnowledgeStore.refreshProjectCodeIndex(projectKey)` to call IPC, refresh project summaries/read model, and surface errors.
- [ ] Tests must assert coordinator auto path starts background refresh without awaiting it, background+explicit refresh dedupe is delegated to the bridge, paused/excluded skip, and explicit refresh returns status.

## Task 6: Read Model And Knowledge UI

- [ ] Extend `ProjectKnowledgeReadModelService`:
  - `listProjects()` includes `totalCodeSymbols`.
  - `getReadModel()` includes `codeIndex` and a 200-row code-symbol preview.
  - `getEvidence(..., 'code_symbol', symbolId)` returns synthesized symbol evidence.
- [ ] Update Knowledge page:
  - Show code index status and counts in the Projects/Codebase side panel.
  - Add `Re-index code` button.
  - Show compact code symbol preview in Project Memory and make full-count/preview distinction visible.
  - Symbol click loads code-symbol evidence.
  - Label code-symbol evidence as source/location, not semantic proof.
- [ ] Add an integration-style unit test with a fake codemem source proving codemem snapshot -> bridge -> RLM -> read model -> evidence.
- [ ] Renderer tests must cover symbol list rendering, re-index button dispatch, and symbol evidence loading.

## Task 7: Verification

- [ ] Run targeted tests:
  - `npx vitest run src/tests/unit/memory/project-knowledge-persistence.test.ts src/tests/unit/memory/project-code-index-persistence.test.ts src/tests/unit/memory/project-code-index-bridge.test.ts src/tests/unit/memory/project-knowledge-coordinator.test.ts src/tests/unit/memory/project-knowledge-read-model.test.ts src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run generate:architecture` if `npm run verify:architecture` reports drift.
- [ ] Run `npm run verify`.
- [ ] Run `git diff --check`.
- [ ] Confirm `better-sqlite3` ABI matches Electron after tests: `node scripts/verify-native-abi.js`.

## Self-Review

- Spec coverage: source-kind scoped pruning, code-file sources, symbol read model, status, limits, timeout, full-snapshot recovery, coordinator background behavior, UI evidence, and verification are all mapped to tasks.
- Placeholders: none.
- Deferred by design: import/call graph, conversation memory, retrieval, startup prompt packing, incremental symbol diffs, configurable limits.
