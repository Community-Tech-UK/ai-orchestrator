# Project Code Index Bridge Design

**Status:** Reviewed with Gemini and Claude; consensus changes integrated
**Date:** 2026-05-03
**Scope:** Wave 3A of unified project memory: connect registered project roots to the existing codemem code index, source provenance, and Knowledge UI read model.

## Goal

Wave 1 registered project roots and routed high-signal mining through a coordinator. Wave 2 added durable source records and evidence links for mined KG facts and wake hints. Wave 3A makes code indexing part of that same project memory surface without creating a second code-search engine.

The app should be able to answer:

- Is this project code-indexed?
- Which source files are currently represented in project memory?
- Which symbols did codemem find for this project?
- Which file/span backs a symbol result?

This slice intentionally avoids conversation memory, startup prompt packing, LSP call hierarchy graph extraction, and natural-language retrieval ranking. It creates the source-backed code index bridge those later waves need.

## Problems To Solve

- Codemem already indexes workspaces, stores manifests and symbols, and exposes MCP tools, but the Knowledge page cannot show that project-scoped code memory.
- `project_knowledge_sources` currently only allows high-signal root files. It needs `code_file` sources before recursive source provenance can exist.
- The current source prune helper deletes any project source not seen by high-signal mining. If code files are added, a normal high-signal re-mine would delete code-file source rows unless pruning becomes source-kind scoped.
- Codemem uses its own CAS database. RLM needs a project-scoped read model and source links, but it should not duplicate chunk contents or replace codemem internals.
- Code indexing can be expensive. It must never block instance creation, and it must respect project pause/exclude and codemem feature flags.

## Design

## Reviewer Consensus

Gemini and Claude both challenged the first draft on robustness rather than the
basic direction. The consensus changes are:

- Add explicit file/size/symbol limits and a codemem timeout before automatic indexing; do not rely on codemem's internal scanner to fail safely for broad repos.
- Treat RLM code-index rows as a rebuildable snapshot over codemem, not as a second source of truth. Cross-database recovery is full snapshot replay plus an RLM transaction, not a distributed transaction.
- Make source pruning source-kind scoped before adding `code_file`.
- Define project ownership by the registered root path and codemem workspace hash returned for that exact root; nested roots are separate registered projects.
- Clarify that `code_symbol` evidence is a definition/source-location pointer, not proof for a semantic model-generated fact.
- Make symbol row IDs deterministic and cap signature/doc-comment storage.
- Preserve the previous successful code read model while a new sync is running or failed; the status tells the UI whether the rows are current.
- Cap renderer-facing symbol lists; status counters expose full counts while the default read model returns only a bounded preview.

### Scope Name

Treat this as Wave 3A: **code file and symbol provenance**.

Wave 3B can add imports/calls/implements relationships after the file/symbol bridge is reliable. This keeps the first code-index slice deterministic and avoids prematurely storing weak regex-derived graph facts as durable truth.

### Source Model Changes

Extend `ProjectKnowledgeSourceKind` and the active database CHECK constraint to include:

- `code_file`

Add a kind-scoped prune helper:

```ts
deleteProjectKnowledgeSourcesByKindNotSeen(
  db: SqliteDriver,
  projectKey: string,
  sourceKind: ProjectKnowledgeSourceKind,
  sourceUris: string[],
): number
```

Then update `CodebaseMiner` so high-signal mining prunes only:

- `manifest`
- `readme`
- `instruction_doc`
- `config`

This is required before any code-file source rows are written.

### RLM Code Index Read Model

Add migration `021_project_code_index_bridge`. Do not edit already-applied
migration `020_project_knowledge_sources`, because this repo verifies migration
checksums. Migration 021 rebuilds `project_knowledge_sources` with the expanded
CHECK constraint for both upgraded databases and fresh databases that apply the
full migration chain.

The resulting schema is:

```sql
CREATE TABLE project_code_index_status (
  project_key TEXT PRIMARY KEY,
  workspace_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('never','indexing','ready','failed','disabled','paused','excluded')),
  file_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  sync_started_at INTEGER,
  last_indexed_at INTEGER,
  last_synced_at INTEGER,
  updated_at INTEGER NOT NULL,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE project_code_symbols (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  workspace_hash TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  path_from_root TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container_name TEXT,
  start_line INTEGER NOT NULL,
  start_character INTEGER NOT NULL,
  end_line INTEGER,
  end_character INTEGER,
  signature TEXT,
  doc_comment TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_key, symbol_id),
  FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE
);
```

Indexes:

- `project_code_symbols(project_key, name, kind)`
- `project_code_symbols(project_key, source_id)`
- `project_code_symbols(project_key, path_from_root)`

`project_code_symbols` is a read model over codemem. Codemem remains authoritative for chunks, workspace manifests, symbol IDs, and MCP tool behavior. The RLM table exists so project memory can show status, symbols, and evidence without joining across two SQLite connections from renderer-facing reads.

`project_code_symbols.id` is deterministic:

```ts
stableId('pcs', projectKey, symbolId)
```

`UNIQUE(project_key, symbol_id)` is kept as a defensive constraint and lookup
index. Symbol rows are rebuilt from codemem snapshots, so deterministic IDs are
required for stable UI tracking and evidence target IDs.

`end_line` and `end_character` may be null in codemem. During RLM materialization,
the bridge normalizes missing ends to the start line/character for DTO source
spans. Raw nullable columns are retained so the read model does not invent more
precision than codemem supplied.

`signature` and `doc_comment` are bounded before insert:

- `signature`: 500 characters
- `doc_comment`: 1,000 characters

RLM must not store full source text or unbounded documentation.

Status metadata and symbol metadata include `snapshotVersion: 1`. Wave 3A only
writes version 1 rows. If a later build encounters an unknown future snapshot
version, it should treat the snapshot as rebuildable, refresh from codemem, and
avoid showing stale symbol details as authoritative.

### Symbol Evidence

Extend `ProjectKnowledgeTargetKind` with:

- `code_symbol`

No separate `project_knowledge_symbol_links` table is needed in Wave 3A. A `project_code_symbols` row has exactly one file source and one precise file span. `listProjectEvidenceForTarget(..., 'code_symbol', symbolId)` synthesizes a `ProjectKnowledgeSourceLink` DTO from the symbol row:

- `id`: stable id from project key + symbol id + source id
- `targetKind`: `code_symbol`
- `targetId`: `symbol_id`
- `sourceSpan`: `{ kind: 'file_lines', path, startLine, endLine, startColumn, endColumn }`
- `metadata`: workspace hash, symbol kind, container name, and `evidenceKind: 'definition_location'`

This keeps the public evidence API uniform while avoiding a redundant table for a one-source deterministic relationship. For `code_symbol`, "evidence" means "where this symbol was indexed from." It is not evidence for a semantic claim such as "symbol A calls symbol B"; those graph facts remain out of scope until Wave 3B and will need their own fact/evidence semantics.

### Project Code Index Bridge Service

Create `ProjectCodeIndexBridge` in `src/main/memory/project-code-index-bridge.ts`.

Responsibilities:

- Accept a registered `CodebaseMiningStatus` or project path.
- Respect project `isPaused`, `isExcluded`, `autoMine`, and codemem feature flags.
- Deduplicate in-flight indexing/sync by `projectKey`.
- Call `getCodemem().ensureWorkspace(rootPath)` when codemem is enabled.
- Read codemem `workspace_manifest` and `workspace_symbols` through `CodememService.store`.
- Upsert `code_file` source records for manifest entries.
- Replace the project symbol read model from current codemem symbols.
- Mark code-index status as:
  - `disabled` when codemem or codemem indexing is disabled
  - `paused` or `excluded` from project controls
  - `indexing` while work is running
  - `ready` after a successful sync
  - `failed` with an error message when sync fails

The service uses a small injected interface rather than depending on arbitrary codemem internals:

```ts
interface ProjectCodeIndexSource {
  isEnabled(): boolean;
  isIndexingEnabled(): boolean;
  ensureWorkspace(rootPath: string): Promise<{ workspaceHash: string; lastIndexedAt: number | null }>;
  listManifestEntries(workspaceHash: string): WorkspaceManifestRow[];
  listWorkspaceSymbols(workspaceHash: string): WorkspaceSymbolRecord[];
}
```

The production adapter wraps `getCodemem()`. Tests can inject a fake source.

In-flight dedupe is a `Map<projectKey, Promise<ProjectCodeIndexStatus>>`. A second request for the same project returns the existing promise. A manual request does not start a second concurrent sync; the user gets the current in-flight result.

### Safety Limits

Before automatic code indexing, the bridge runs a bounded filesystem preflight using the same built-in ignore families as codemem (`.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`) plus `.gitignore` when present.

Default limits:

- `maxFiles`: 5,000
- `maxBytes`: 250 MB
- `maxSymbols`: 100,000 after codemem returns symbols
- `ensureWorkspaceTimeoutMs`: 120,000

These limits are hardcoded constants in Wave 3A. They should be centralized in
the bridge module so a later settings/UI slice can make them configurable
without changing sync semantics.

If `maxFiles` or `maxBytes` is exceeded, the bridge writes status `failed` with metadata `{ reason: 'limit_exceeded' }` and does not call codemem. If the codemem call exceeds the timeout, the bridge writes status `failed` with metadata `{ reason: 'timeout' }`, preserves prior rows, and swallows any late rejection from the still-running codemem promise. A later explicit re-index can retry.

These limits are intentionally conservative and local to Wave 3A. A later UI confirmation flow can add opt-in indexing for broader repositories.

Sync algorithm:

1. Normalize project key through `normalizeProjectMemoryKey`.
2. If project is paused/excluded or codemem is disabled, upsert terminal status and return without indexing.
3. Run safety preflight for automatic indexing.
4. Upsert `project_code_index_status` as `indexing` with `sync_started_at` and `updated_at`.
5. Await `codemem.ensureWorkspace(rootPath)` through the configured timeout.
6. Read manifest entries and workspace symbols for the returned workspace hash.
7. Abort with status `failed` if symbol count exceeds `maxSymbols`.
8. Transaction:
   - Upsert `code_file` sources for every manifest entry, using `content_hash` as `content_fingerprint`.
   - Prune only `code_file` sources not in the manifest.
   - Delete existing `project_code_symbols` rows for the project.
   - Insert current symbols with source IDs and file-line spans.
   - Upsert status `ready` with file/symbol counts and timestamps.
9. On failure, upsert status `failed` and keep the previous successful read model for inspection.

There is no cross-database transaction between codemem and RLM. Recovery is deterministic full snapshot replay: if the app crashes after codemem indexes but before RLM sync commits, RLM either has the previous committed snapshot or no snapshot. The next sync reads codemem's current manifest/symbol snapshot and replaces RLM rows in one RLM transaction.

On startup/read, an `indexing` status older than `ensureWorkspaceTimeoutMs` is considered stale. The read model may label it as `failed` with a timeout-style error when refreshed; the bridge can also repair it on the next explicit or automatic sync.

### Project Ownership

Project ownership is deterministic:

- `ProjectRootRegistry` owns the project key and root path.
- `ProjectCodeIndexBridge` calls codemem for that exact registered root path.
- The returned `workspace_hash` belongs to that project status row.
- Source URIs are absolute file paths under that root; `path_from_root` is stored for display and stable symbol rows.

If two registered project roots overlap, they are treated as separate projects. The same physical file can therefore appear under two project keys only if the user or instance lifecycle registered overlapping roots. Cross-project dedupe is out of scope; project isolation is more important than global storage minimization.

### Coordinator Integration

`ProjectKnowledgeCoordinator` should stay thin:

- Continue returning the high-signal mining result for existing IPC calls.
- Start code-index bridge work in the background when `ensureProjectKnown(..., { autoRefresh: true })` or `refreshProject(...)` sees a registered project that can auto-mine/manual-mine.
- Do not let code indexing failure fail high-signal mining.
- Expose a new method for explicit UI refresh:

```ts
refreshProjectCodeIndex(rootPath: string): Promise<ProjectCodeIndexStatus>
```

This gives the Knowledge UI a deterministic "Re-index code" action without changing the existing Mine button semantics.

### Read Model And UI

Extend shared DTOs:

- `ProjectCodeIndexStatus`
- `ProjectCodeSymbol`
- `ProjectKnowledgeReadModel.codeIndex`
- `ProjectKnowledgeReadModel.codeSymbols`
- `ProjectKnowledgeSourceInventory.totalCodeSymbols`

`ProjectKnowledgeReadModel.codeSymbols` returns a bounded preview, default 200
symbols ordered by path, line, and name. The full symbol count comes from status
and inventory counters. Full symbol search/pagination is out of scope for Wave
3A; the UI should make clear when it is showing a preview.

Knowledge page additions:

- Show code index status alongside mining/source inventory.
- Show code-file and symbol counts.
- Add a `Re-index code` button.
- Add a compact symbol list with name, kind, relative path, and line.
- Clicking a symbol opens the existing evidence panel through `projectKnowledgeGetEvidence(projectKey, 'code_symbol', symbolId)`.

The UI must not imply code memory is complete or authoritative. It should present it as a local index derived from current source files.

### Privacy And Safety

- Do not index paused or excluded projects.
- Do not broaden discovery beyond existing registered roots.
- Use codemem's existing ignore rules and `.gitignore` support.
- Do not store full source-file contents in RLM. Store paths, fingerprints, symbols, and doc/signature snippets already produced by codemem metadata.
- Enforce Wave 3A safety limits before automatic indexing. Repos above those limits require a later explicit opt-in flow.

### Consistency During Re-index

Re-index is a full project snapshot sync in Wave 3A, not a delta sync. While a sync is running:

- The UI may continue showing the last successful `project_code_symbols` rows.
- The code index status is `indexing`.
- On success, rows are replaced atomically in RLM.
- On failure, prior rows remain and status becomes `failed`.

File deletion is handled by the full snapshot: if a file disappears from codemem's manifest, its `code_file` source is pruned by kind and `project_code_symbols` rows cascade through the source FK.

## Acceptance Criteria

- Re-indexing a project with codemem enabled creates `code_file` source rows and `project_code_symbols` rows.
- Re-running high-signal mining does not delete `code_file` sources.
- Re-indexing after deleting a source file prunes that file's `code_file` source and its symbols without touching high-signal sources.
- Paused/excluded projects do not start code indexing.
- Disabled codemem writes a visible `disabled` code-index status and does not throw into instance creation or mining.
- Broad projects above Wave 3A file/byte/symbol limits write a visible failed status and do not run unbounded indexing.
- Timed-out codemem indexing writes a failed status and preserves the previous successful code read model.
- Knowledge UI can show code index status, code-file count, full symbol count, a bounded symbol preview of at most 200 rows, and symbol evidence.
- Typecheck, spec typecheck, lint, targeted tests, full tests, architecture check, native ABI restore, and Electron smoke pass.

## Out Of Scope For Wave 3A

- Import/export/call/implements KG edges.
- Conversation-derived candidates.
- Unified retrieval ranking.
- Startup brief packing and persisted "why was this included?" spawn records.
- Editing codemem CAS schema unless review proves it is strictly necessary.
- Incremental RLM symbol diffs, codemem changelog/watermark tables, and import/call graph facts. Wave 3A uses full snapshot replay as its recovery model.
