# Project Memory Source Provenance Design

**Status:** Reviewed with Gemini and Claude; consensus changes integrated
**Date:** 2026-05-03
**Scope:** Wave 2 of the unified project memory system: source registry, evidence links, and inspectable project memory read model.

## Goal

Wave 1 made project roots and high-signal mining persistent and controllable. Wave 2 makes that memory inspectable: every newly mined KG fact and wake hint should have a durable source record and an evidence link that the Knowledge UI can show.

This slice deliberately avoids recursive code indexing, codemem symbol graph integration, conversation memory promotion, and startup brief rewrites. Those require a reliable provenance layer first.

## Problems To Solve

- Codebase mining currently writes KG facts and wake hints, but the app cannot answer "which file caused this memory item?"
- The Knowledge page can mine and pause/exclude a single directory, but it cannot list known project roots or show source inventory.
- Existing KG triples have `source_file`, but wake hints only carry reflection/session fields, and neither has a unified project-scoped evidence model.
- Re-mining unchanged files should not duplicate sources or evidence links.

## Design

### Data Model

Add migration `020_project_knowledge_sources` with canonical sources and concrete evidence-link tables:

```sql
CREATE TABLE project_knowledge_sources (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_title TEXT,
  content_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_key, source_uri)
);

CREATE TABLE project_knowledge_kg_links (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  triple_id TEXT NOT NULL,
  source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
  evidence_strength REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_key, source_id, triple_id),
  FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
);

CREATE TABLE project_knowledge_wake_links (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  hint_id TEXT NOT NULL,
  source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
  evidence_strength REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_key, source_id, hint_id),
  FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
);
```

`project_knowledge_sources` is canonical per project/path. Re-mining a changed file updates the same source row's `source_kind`, `content_fingerprint`, `updated_at`, and `last_seen_at` instead of appending a new source identity. Historical source versions are out of scope for Wave 2.

Evidence link tables keep `project_key` denormalized for query speed. Insert helpers must verify that the referenced source belongs to the same project before inserting a link.

The shared DTO still exposes a narrow target shape in Wave 2:

- `kg_triple`
- `wake_hint`

There is no `mined_file` link kind or table. A row in `project_knowledge_sources` already proves the file was seen by mining. Links represent evidence for derived memory objects only.

Concrete link tables avoid dangling polymorphic references while still letting IPC/UI consume a unified evidence DTO. Later waves can add `project_memory_items` and either add a third concrete link table or backfill memory-item evidence from existing KG/wake links.

### Source Kinds

Codebase mining writes high-signal file sources:

- `manifest`: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`
- `readme`: `README.md`
- `instruction_doc`: `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`
- `config`: `tsconfig.json`

Sources use normalized absolute file paths as `source_uri` in Wave 2 because all processing is local. `source_uri` must be produced from the normalized registered project root plus the mined file path, not from user-entered raw strings. The UI displays project-relative paths by deriving them from `rootPath`.

### Source Spans

Add shared type:

```ts
export type ProjectSourceSpan =
  | { kind: 'file_lines'; path: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number }
  | { kind: 'whole_source' };
```

Wave 2 links use whole-source spans by default. More precise dependency-line spans can be added later without changing the storage shape.

### Persistence API

Create `src/main/persistence/rlm/rlm-project-knowledge.ts` with:

- `upsertProjectKnowledgeSource(db, params): ProjectKnowledgeSourceUpsertResult`
- `deleteProjectKnowledgeSourcesNotSeen(db, projectKey, sourceUris): number`
- `clearProjectKnowledgeLinksForSource(db, projectKey, sourceId, targetKinds): number`
- `linkProjectKnowledgeKgTriple(db, params): ProjectKnowledgeSourceLinkResult`
- `linkProjectKnowledgeWakeHint(db, params): ProjectKnowledgeSourceLinkResult`
- `hasCurrentProjectKnowledgeSources(db, projectKey, sources): boolean`
- `listProjectKnowledgeSources(db, projectKey): ProjectKnowledgeSource[]`
- `listProjectKnowledgeLinks(db, projectKey): ProjectKnowledgeSourceLink[]`
- `listProjectEvidenceForTarget(db, projectKey, targetKind, targetId): ProjectKnowledgeEvidence[]`
- `getProjectKnowledgeSourceInventory(db, projectKey): ProjectKnowledgeSourceInventory`

The API must be idempotent. Calling `upsertProjectKnowledgeSource` and the concrete link helpers multiple times for unchanged mining output returns existing rows or keeps a single link.

`upsertProjectKnowledgeSource` returns the canonical source row plus `created` and `changed` booleans. `changed` means the stored fingerprint changed and derived evidence links for that source may be stale.

When a source changes, the miner clears current `kg_triple` and `wake_hint` links for that source inside the same transaction that extracts and inserts replacement evidence. This prevents stale dependencies, README claims, or instruction-derived hints from retaining source support after the file changes, and prevents a crash from leaving a completed mine with an empty evidence set.

When a previously seen source file is missing from the current high-signal source set, the miner deletes its source row. Concrete link rows cascade through `source_id`.

KG invalidation remains authoritative: current read-model queries exclude triples where `valid_to IS NOT NULL`. Evidence links for invalidated triples may remain in storage as historical rows, but the Wave 2 UI shows only current facts and hints. Hard deletion of a KG triple or wake hint cascades through the concrete evidence tables.

### Codebase Miner Integration

`CodebaseMiner` will:

1. Register a `project_knowledge_sources` record for every collected high-signal file.
2. Delete source rows for high-signal files that are no longer present in the current source set.
3. If the source fingerprint changed, clear existing `kg_triple` and `wake_hint` links for that source before extracting new facts/hints.
4. When it adds or reuses a KG fact, capture the triple ID and link it to the relevant source.
5. When it adds or reuses a wake hint, link the hint ID to the relevant source.
6. Include source/link counts in mining results and status where useful.

The miner should continue to skip unchanged project fingerprints without DB churn when provenance is already present. The current miner already reads high-signal files to compute the fingerprint; after that, the early return is allowed when `hasCurrentProjectKnowledgeSources` verifies matching source rows for the current source descriptors. For previously mined projects that predate Wave 2, zero or incomplete source coverage bypasses the unchanged early return and forces a standard full mine/backfill. Existing KG/hint de-duplication plus source/link idempotency prevents duplicate memory.

`CodebaseMiner.addHintIfMissing` must return the wake hint ID for both newly inserted and pre-existing matching hints. The existing lookup must use exact room matching (`hint.room === projectKey`) and normalized content matching before returning a reused hint ID. Importance is scoring metadata, not hint identity.

KG query DTOs must expose a stable target ID. Wave 2 should add `id` to `KGQueryResult` or define read-model-specific fact DTOs with `targetKind: 'kg_triple'` and `targetId: tripleId`. The KG persistence mapper should also return the existing `sourceFile` field where available.

### Read Model

Create `ProjectKnowledgeReadModelService` as a read-only main-process service. It aggregates:

- project roots from `ProjectRootRegistry`
- source inventory counts
- current source list
- KG facts for sources in the project
- wake hints for the project room
- evidence links for each fact/hint when requested

This service does not own mining/indexing. It only reads existing persistence and normalizes DTOs for IPC/UI.

Wake hint queries for project memory must use exact project rooms only. `WakeContextBuilder.listHints(room)` intentionally includes `general` hints and must not be used as-is for project read-model facts.

### IPC And UI

Add IPC channels:

- `project-knowledge:list-projects`
- `project-knowledge:get-read-model`
- `project-knowledge:get-evidence`

These channels and schemas should be added to the existing knowledge contracts (`packages/contracts/src/channels/memory.channels.ts` and `packages/contracts/src/schemas/knowledge.schemas.ts`). Do not introduce a new `@contracts/schemas/project-knowledge` alias in Wave 2, avoiding the packaged-runtime alias trap.

Knowledge UI changes:

- Add a project selector backed by registered roots.
- Selecting a project loads mining status and source inventory.
- Show source counts by kind and recent source list.
- Add an evidence panel for selected project memory items. In Wave 2, inspectable items are mined KG facts and wake hints, each carrying a `targetKind` and `targetId`.
- Keep the existing single-directory manual mine input; it should update the selected project after Browse/Mine.

The UI should use restrained operational styling consistent with the current Knowledge page. It must not claim memory is authoritative; evidence is shown as source-backed context.

## Safety And Privacy

- Wave 2 only records high-signal files already read by `CodebaseMiner`.
- No recursive file crawling is introduced.
- No source content is uploaded.
- Source excerpts are not persisted in Wave 2; the UI shows paths/spans and memory statements. Later source preview can read local files on demand with the same file safety rules.
- Secret-like files remain outside `CodebaseMiner`'s configured file list.

## Acceptance Criteria

1. Mining a project with `package.json` creates project source records and evidence links for each new KG fact.
2. Mining a project with `README.md` or instruction docs creates source records and evidence links for new or existing wake hints.
3. Re-mining unchanged inputs does not duplicate source records or source links.
4. Re-mining a changed high-signal file prunes stale links for that source and rebuilds current evidence.
5. Previously mined projects with unchanged content can backfill source rows and evidence links.
6. Removing or renaming a mined high-signal file deletes the old source row and cascades old evidence links.
7. Project wake-hint read models exclude `general` room hints.
8. KG fact DTOs include target IDs and preserve `sourceFile` where available.
9. The Knowledge UI lists registered project roots and shows source inventory for the selected project.
10. The UI can request evidence for a fact/hint and show the source path plus span.
11. Existing Wave 1 behavior remains intact: pause/exclude/manual mining semantics do not change.
12. Full typecheck, spec typecheck, lint, targeted memory tests, renderer store/component tests, and full test suite pass.

## Test Plan

- Persistence tests for canonical source upsert, changed-fingerprint detection, concrete link idempotency, source-project mismatch rejection, stale-link clearing, hard-delete cascade, deleted-source pruning, and no duplicate rows.
- Miner integration tests for package/README/instruction provenance, unchanged-project backfill, unchanged-project no-DB-write skip, changed-source pruning, deleted-source cleanup, and exact-room wake hint linking.
- Read-model tests for project inventory, current KG fact filtering, exact-room wake hints, target evidence lookup across concrete KG/wake link tables, dangling-link exclusion, and source path/span DTOs.
- IPC handler registration smoke tests for the new channels.
- Renderer store/component tests for project selector loading, source inventory rendering, selected evidence loading, and existing pause/resume/exclude behavior.

## Explicitly Out Of Scope

- Recursive code indexing and symbol relationships.
- Conversation-derived candidate memory.
- Human promotion/rejection workflows.
- Startup brief source-ref persistence.
- Reading source file previews in the UI.
- Clearing all derived project memory.
