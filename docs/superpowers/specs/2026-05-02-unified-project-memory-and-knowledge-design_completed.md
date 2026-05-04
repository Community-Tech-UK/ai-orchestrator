# Unified Project Memory And Knowledge System

**Status:** Draft
**Date:** 2026-05-02
**Scope:** AI Orchestrator project memory, codebase knowledge, retrieval, and user-visible controls

## Problem

AI Orchestrator now has several useful memory pieces, but they still behave like adjacent systems:

- Codebase mining extracts high-signal project facts and wake hints.
- Codebase indexing and codemem can index/chunk code and expose code search/LSP-shaped data.
- Project memory briefs retrieve prior project context.
- Conversation mining, wake context, RLM, and the knowledge graph store facts, snippets, hints, and vectors.
- The Knowledge UI exposes manual mining and status, but it does not yet explain or control the full memory lifecycle.

The missing product is a single project-scoped knowledge pipeline that discovers project roots, mines them automatically, links every durable memory item to source evidence, keeps indexes fresh, and makes retrieval inspectable when agents receive context.

## Goals

1. Automatically maintain project-scoped memory for folders AI Orchestrator actually works in.
2. Merge codebase mining, code indexing, conversation memory, wake context, and knowledge graph retrieval behind one coordinator.
3. Require source attribution for every promoted durable fact, hint, symbol relationship, and memory item.
4. Keep memory project-scoped by default so unrelated repos do not leak into fresh sessions.
5. Make memory visibly useful in agent context while keeping startup prompts short and auditable.
6. Provide UI controls to browse, add, pause, rescan, exclude, inspect, and clear project memory.
7. Keep failures non-fatal: memory may improve spawn/retrieval, but it must never block instance creation.

## Non-goals

- Do not replace checked-in `AGENTS.md`, `CLAUDE.md`, `README`, or provider-native instruction files.
- Do not write directly into provider memory stores as part of this work.
- Do not build a second full code search engine if the existing indexing/codemem layers can provide the data.
- Do not promote model-generated summaries as durable truth without source links and a promotion gate.
- Do not auto-mine arbitrary user directories outside known project roots.

## Reference Inputs

### Existing AI Orchestrator Subsystems

- `src/main/memory/codebase-miner.ts` now provides persistent high-signal mining with content fingerprints and status.
- `src/main/memory/project-memory-brief.ts` builds project-scoped startup memory.
- `src/main/memory/wake-context-builder.ts` builds wake hints.
- `src/main/memory/conversation-miner.ts` extracts memory candidates from transcripts.
- `src/main/memory/knowledge-graph-service.ts` stores graph facts.
- `src/main/indexing/` provides BM25, vector, hybrid search, file watching, and metadata extraction.
- `src/main/codemem/` provides content-addressed code indexing, symbol IDs, and MCP-facing code memory tools.
- `src/main/session/session-recall-service.ts` provides explicit old-session recall.

### Mempalace Patterns To Keep

- Direct evidence is the baseline; summaries and graph facts improve ranking, not truth.
- Project-like scoping is mandatory before retrieval.
- Wake context should be compact and useful at session start.
- Graph facts should point back to source material.

### OpenBrain Patterns To Keep

- Normalize and fingerprint source content so imports are idempotent.
- Treat graph nodes/edges as source-backed records with extraction status.
- Use queues/status fields for background extraction and retries.
- Stage model-extracted knowledge before promotion.

## Review Consensus

Gemini and Claude reviewed this spec adversarially before implementation
planning. The consensus changes are:

- The first implementation slice must be narrower than the full six-wave
  product. It should prove project registration, pause-aware auto-mining, and
  status ownership before touching recursive indexing or conversation memory.
- Do not create a competing `project_roots` table while
  `codebase_mining_status` already owns persisted project-path mining state.
  Wave 1 extends that existing table into the project registry/read model.
- The coordinator must stay thin and event-oriented. It routes project-root
  events to existing subsystems and stores status; it must not become a
  monolithic state machine that owns all indexing, mining, extraction, and
  promotion internals.
- Auto-mining needs hard safety limits and pause/exclude controls before broad
  discovery.
- Conversation-derived memory promotion is explicitly out of Wave 1. When it
  arrives, candidate facts remain staged until a human action or a defined
  verifier signal promotes them.

## Current Baseline

The current codebase mining v1 is useful but intentionally narrow:

- It reads high-signal root files such as manifests, README files, instruction docs, and language configs.
- It persists mining status in SQLite and skips unchanged directories using a project-level content fingerprint.
- It auto-mines the configured/default project directory and instance working directories.
- It writes project facts and wake hints into existing memory/KG paths.
- The Knowledge page has manual mining status and a folder Browse button.

This is not yet a full memory product because it does not recursively mine semantic code relationships, continuously watch all active project roots, link every recall item back to precise source spans, or give the user a single inspectable "why was this recalled?" view.

## Product Behavior

### Project Root Discovery

AI Orchestrator should maintain a `ProjectRootRegistry` of known roots:

- Current default working directory.
- Instance working directories.
- User-selected directories from the Knowledge UI Browse button.
- Git repo roots discovered from selected subdirectories.

Auto-mining rules:

- Auto-enable for project roots used by an instance or explicitly selected by the user.
- Never auto-enable for `$HOME`, filesystem roots, cloud-drive roots, system directories, or folders above a repo root unless the user explicitly confirms.
- If recursive indexing sees more than 5,000 candidate files or 250 MB of
  candidate text, pause recursive indexing and show a confirmation/control in
  the UI. Fast high-signal mining may still run because it only reads bounded
  root files.
- Never read ignored files, `.env*`, private keys, credential files, local
  database dumps, build outputs, dependency folders, or hidden app-state
  folders unless a future explicit setting opts in.
- Use `.gitignore` and built-in excludes for recursive indexing.
- Allow per-project pause/exclude.
- Keep all processing local by default.

### Knowledge UI

The Knowledge page should gain a project memory panel with:

- Project root selector.
- Browse button.
- Auto-mine toggle.
- Current status: never, queued, mining, indexing, extracting, ready, failed, paused.
- Last scan time, files scanned, files changed, facts extracted, hints created, symbols indexed, conversation snippets linked.
- Source inventory: code files, manifests, docs, conversations, wake hints, KG facts.
- Actions: Mine now, Re-index, Rebuild from source, Pause, Exclude, Clear project memory.
- Inspection: click a fact/hint/result to see source path, line/span or conversation/message provenance.

The UI should not claim that memory is authoritative. It should show memory as source-backed context candidates.

### Agent Context

Fresh depth-0 instances should receive a compact project memory brief:

1. Checked-in project instructions and project identity.
2. Recent source-backed project facts.
3. Current code structure summary from indexing/codemem.
4. Relevant prior decisions/snippets from project-scoped conversation memory.
5. Wake hints.

The prompt should include source labels and stay within a small fixed budget. Deep retrieval should happen through explicit tools/search, not by dumping the whole memory database into startup context.

## Architecture

Add a thin coordinator layer instead of replacing existing stores:

```text
ProjectRootRegistry
        |
        v
ProjectKnowledgeCoordinator
        |
        +-- CodebaseMiner                  fast root-signal facts and hints
        +-- CodebaseIndexingService         recursive chunks, metadata, hybrid search
        +-- Codemem                         CAS, symbol IDs, LSP/code graph facade
        +-- ConversationMiner/Ledger        transcript-derived candidates
        +-- KnowledgeGraphService           typed source-backed facts
        +-- WakeContextBuilder              compact wake hints
        +-- ProjectMemoryBriefService       spawn-time context packer
        +-- ProjectKnowledgeReadModel       UI status and inspection DTOs
```

### `ProjectRootRegistry`

Responsibilities:

- Normalize project paths using `normalizeProjectMemoryKey`.
- Resolve subdirectories to git/workspace roots where safe.
- Persist user-selected roots, auto-discovered roots, status, pause/exclude flags, and last-active time.
- Emit root-added/root-removed/root-updated events.

Wave 1 storage rule:

- Do not add a separate `project_roots` table.
- Extend the existing `codebase_mining_status` table because it already has the
  normalized project path, mining status, fingerprint, files read, counts, and
  errors.
- Treat `normalized_path` as the project key. It must be produced by
  `normalizeProjectMemoryKey`.
- Add registry/read-model columns to that table rather than duplicating status.

Suggested Wave 1 columns added to `codebase_mining_status`:

```sql
ALTER TABLE codebase_mining_status ADD COLUMN root_path TEXT;
ALTER TABLE codebase_mining_status ADD COLUMN project_key TEXT;
ALTER TABLE codebase_mining_status ADD COLUMN discovery_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE codebase_mining_status ADD COLUMN auto_mine INTEGER NOT NULL DEFAULT 1;
ALTER TABLE codebase_mining_status ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE codebase_mining_status ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE codebase_mining_status ADD COLUMN display_name TEXT;
ALTER TABLE codebase_mining_status ADD COLUMN last_active_at TEXT;
```

For a fresh migration, these columns are created with the table:

```sql
CREATE TABLE codebase_mining_status (
  normalized_path TEXT PRIMARY KEY,
  root_path TEXT NOT NULL,
  project_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  discovery_source TEXT NOT NULL,
  auto_mine INTEGER NOT NULL DEFAULT 1,
  is_paused INTEGER NOT NULL DEFAULT 0,
  is_excluded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  content_fingerprint TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  facts_extracted INTEGER NOT NULL DEFAULT 0,
  hints_created INTEGER NOT NULL DEFAULT 0,
  files_read INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  completed_at TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

### `ProjectKnowledgeCoordinator`

Responsibilities:

- React to project-root events and route work to existing subsystems.
- Queue fast mining first, then later recursive indexing and extraction/linking.
- Deduplicate in-flight work across UI actions and instance lifecycle events.
- Persist status and errors in a project-level read model.
- Ensure failures degrade to partial memory instead of blocking agents.
- Respect existing feature flags for codemem/indexing/conversation mining when
  later waves wire those layers in.

Wave 1 ownership rule:

- The coordinator wraps `CodebaseMiner` only.
- It does not own codemem, recursive code indexing, or conversation mining yet.
- Existing direct auto-mining calls should be moved behind
  `ProjectKnowledgeCoordinator.ensureProjectKnown(..., { autoRefresh: true })`
  so startup and instance lifecycle do not double-trigger mining.

Pipeline states:

- `never`
- `queued` (future background queue)
- `mining`
- `indexing` (Wave 3)
- `extracting` (Wave 4)
- `ready`
- `failed`
- `paused`

Coordinator API:

```ts
export interface ProjectKnowledgeCoordinator {
  ensureProjectKnown(path: string, source: ProjectDiscoverySource): Promise<ProjectRoot>;
  refreshProject(projectKey: string, options?: RefreshProjectOptions): Promise<ProjectKnowledgeRefreshResult>;
  getProjectStatus(projectKey: string): Promise<ProjectKnowledgeStatus>;
  getProjectReadModel(projectKey: string): Promise<ProjectKnowledgeReadModel>;
  pauseProject(projectKey: string): Promise<void>;
  resumeProject(projectKey: string): Promise<void>;
  clearProjectMemory(projectKey: string, scope: ClearProjectMemoryScope): Promise<void>;
}
```

Wave 1 discovery sources:

- `default-working-directory`
- `instance-working-directory`
- `manual-browse`

Recently opened roots are intentionally deferred until there is a broader
workspace/navigation history model.

### Source Registry

Every mined/indexed/extracted item should link to a normalized source record.
This begins in Wave 2, after Wave 1 has one authoritative project-root/status
store.

Suggested table:

```sql
CREATE TABLE project_knowledge_sources (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_title TEXT,
  content_fingerprint TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(project_key, source_kind, source_uri, content_fingerprint)
);
```

Source kinds:

- `code_file`
- `manifest`
- `instruction_doc`
- `readme`
- `conversation_message`
- `conversation_snippet`
- `wake_hint`
- `manual_note`
- `external_import`

`source_span_json` is a discriminated union, not arbitrary JSON:

```ts
type ProjectSourceSpan =
  | { kind: 'file_lines'; path: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number }
  | { kind: 'conversation_chars'; threadId: string; messageId: string; startOffset: number; endOffset: number }
  | { kind: 'whole_source' };
```

### Memory Items

Durable memory should be stored as structured items with provenance links.

```sql
CREATE TABLE project_memory_items (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE project_memory_source_links (
  memory_item_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_span_json TEXT,
  evidence_strength REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(memory_item_id, source_id)
);
```

Item kinds:

- `project_fact`
- `decision`
- `convention`
- `gotcha`
- `symbol_fact`
- `dependency_fact`
- `workflow_hint`
- `unresolved_question`

Statuses:

- `candidate`
- `promoted`
- `stale`
- `rejected`
- `superseded`

### Code Graph Integration

Do not create a separate recursive code graph if codemem/indexing can provide it.

Required integration:

- Map indexed files and chunks to `project_knowledge_sources`.
- Map codemem `symbol_id` values into `project_memory_items` subjects.
- Store import/export/class/function relationships as source-backed KG edges.
- Prefer AST/codemem relationships over model-generated code claims.
- Treat code graph data as rebuildable from source; source files remain authoritative.

Minimum relationships:

- file contains symbol
- file imports module/path
- symbol calls/references symbol, where available
- symbol implements/extends symbol, where available
- config file defines project setting
- manifest declares dependency/script/tool

### Conversation Integration

Conversation-derived memory must use source links down to message or snippet level.

Required behavior:

- Feed memory from a canonical conversation ledger when available.
- Until then, use existing history/session recall/transcript snippets and include their IDs in source metadata.
- Stage extracted decisions/gotchas/conventions as `candidate`.
- Code-derived facts can be promoted deterministically when their source file
  exists, its fingerprint matches, and the extraction rule is deterministic.
- Conversation-derived candidates remain `candidate` until a human promotes
  them in the UI or a later explicitly defined verifier signal is implemented.
- Respect private/excluded conversations.

### Retrieval

Create one project-scoped retrieval layer used by UI, startup briefs, and later per-turn context.

Ranking principles:

- Direct source evidence outranks summaries.
- Current source files outrank stale conversation memory.
- Same-project is mandatory.
- Recent, frequently used, and verified items rank higher.
- Duplicates collapse by normalized statement plus source overlap.
- Conflicts are shown, not silently merged.

V1 deterministic scoring:

```ts
score =
  sourceWeight +
  recencyBoost +
  exactQueryOverlapBoost +
  verifiedBoost +
  usageBoost -
  stalePenalty -
  conflictPenalty;
```

Weights:

- Checked-in instruction docs: 100
- Current manifest/config/readme facts: 90
- Current code symbol/file facts: 80
- Human-promoted conversation memory: 70
- Wake hints: 55
- Candidate conversation memory: 25 and never included in startup briefs by default
- Stale items: subtract 60
- Conflicted items: subtract 40 and include only in inspection/debug views unless explicitly requested

Retrieval result shape:

```ts
export interface ProjectKnowledgeResult {
  id: string;
  kind: 'source' | 'memory_item' | 'graph_fact' | 'code_symbol' | 'wake_hint';
  title: string;
  excerpt: string;
  score: number;
  projectKey: string;
  sourceRefs: ProjectKnowledgeSourceRef[];
  status: 'current' | 'stale' | 'candidate';
}
```

### Prompt Packing

`ProjectMemoryBriefService` should become the single spawn-time packer over this retrieval layer.

Budget rules:

- Keep default brief under a provider-aware token budget. Use 2,000 to 3,000
  characters only as a UI/debug approximation.
- Reserve at least half the brief for direct source-backed snippets/facts.
- Include source labels.
- Include a footer reminding agents to verify against current files.
- Skip or shrink memory if provider context budget is tight.

Brief inspection requirement:

- Persist the exact source references used for each fresh depth-0 startup brief
  before Wave 5 claims "why was this included" support.
- Use a `project_spawn_briefs` table or existing RLM session context table if it
  can preserve `instance_id`, `project_key`, rendered brief text, source refs,
  budget metadata, and creation time.
- Re-running retrieval later is not sufficient for inspection because it may
  produce different results.

## Background Processing

Processing should be incremental and resumable:

1. `ensureProjectKnown` registers or refreshes the project root.
2. Fast mining runs against high-signal root files.
3. Recursive indexing watches and updates changed code files.
4. Graph extraction writes source-backed relationships.
5. Conversation extraction stages memory candidates.
6. Promotion updates durable memory and wake hints.
7. Read model aggregates status for the Knowledge UI.

Failure behavior:

- Store per-source errors.
- Retry transient errors with backoff.
- Mark project `ready` if at least one useful layer is current and non-fatal layers failed.
- Mark project `failed` only when no layer can produce useful state.

Initialization ownership:

- Wave 1 moves direct project auto-mining behind `ProjectKnowledgeCoordinator`.
- Startup/default-directory and instance-working-directory triggers should call
  `ensureProjectKnown` rather than calling `CodebaseMiner.mineDirectory`
  directly.
- Later waves must explicitly retire or delegate existing direct initialization
  paths before enabling coordinator-owned indexing/codemem work.

## Privacy And Safety

- Per-project exclude and clear controls are required before broad auto-discovery.
- Private/excluded conversations must not feed shared memory.
- The app must not upload project memory or embeddings unless a later explicit setting says so.
- Source excerpts shown in UI should be local-only.
- Clearing project memory must remove derived facts, wake hints, vectors/chunks owned only by that project, and status rows while preserving unrelated project data.
- Secret-like content must be filtered before durable promotion or prompt
  injection. At minimum, exclude `.env*`, private keys, credential files, local
  database dumps, and high-entropy token-looking strings from memory items and
  startup briefs.

## Implementation Waves

### Wave 1: Root Registry And Coordinator

Deliverables:

- Extend `codebase_mining_status` so it is the single persisted project
  registry/read model for high-signal mining status.
- Add `ProjectRootRegistry` as a focused wrapper over that table.
- Add `ProjectKnowledgeCoordinator` as a thin wrapper over existing
  `CodebaseMiner`.
- Move default-working-directory and instance-working-directory auto-mining
  triggers behind the coordinator.
- Add pause/resume/exclude checks so auto-mining can be controlled.
- Keep the Knowledge page's current single-directory mining UI; do not build a
  full project selector until Wave 2.

Acceptance criteria:

- Opening a fresh project creates or updates one root registry record.
- Browse can add a project root.
- Auto-mining does not duplicate in-flight work.
- Paused projects are not auto-mined.
- Existing `codebase_mining_status` rows remain valid because they are the
  registry rows.
- Wave 1 does not start recursive indexing, codemem indexing, or conversation
  mining.

### Wave 2: Source Registry And Provenance Links

Deliverables:

- `project_knowledge_sources` and `project_memory_source_links`.
- Codebase mining writes source records for each high-signal file.
- KG facts and wake hints get source links where possible.
- Knowledge UI can inspect evidence for a mined fact or hint.
- UI project selector backed by registry and source counts.

Acceptance criteria:

- Every new mined fact has at least one source record.
- Re-mining unchanged files does not duplicate sources or facts.
- Changed source fingerprints update status and preserve old evidence only where still referenced.

### Wave 3: Code Index And Code Graph Integration

Deliverables:

- Coordinator listens to existing `CodebaseIndexingService` or codemem update
  events for registered roots; it should not duplicate their internal queues.
- Add either a `project_key` column to relevant indexing metadata or a
  `project_index_roots` join table so indexed files can be traced back to a
  project registry row.
- Indexed files/chunks map to project sources.
- Symbol/file/import relationships appear as KG facts or a code graph read model.
- File watcher updates derived relationships incrementally.

Acceptance criteria:

- Recursive indexing is visible in project status.
- Editing one file updates only that file's source fingerprint and related derived facts.
- Search/retrieval can return code symbols with source paths.
- Source file deletion marks affected symbol facts stale.

### Wave 4: Conversation Memory Integration

Deliverables:

- Conversation/history/snippet sources link into project memory.
- Candidate memory staging for decisions, gotchas, conventions, and unresolved questions.
- Human promotion/rejection controls for candidate conversation memory, unless
  a verifier signal has been separately specified and implemented.
- Private/excluded conversations are respected.
- Conflict detection marks contradictory facts instead of silently overwriting.

Acceptance criteria:

- Same-project prior conversation snippets can appear in retrieval with message/snippet provenance.
- Other-project snippets are excluded.
- Model-extracted candidates are not promoted without source links.
- Candidate conversation memory is not injected into startup briefs by default.
- Conflicting facts are visible in the UI read model.

### Wave 5: Unified Retrieval And Prompt Packing

Deliverables:

- `ProjectKnowledgeRetriever` used by startup briefs, Knowledge search, and future per-turn context.
- `ProjectMemoryBriefService` consumes the retriever instead of assembling separate source paths directly.
- Persisted startup brief/source-ref records expose the source list used for
  each fresh depth-0 spawn.

Acceptance criteria:

- Fresh depth-0 instances receive concise source-backed memory.
- Resume/replay/child instances do not get duplicate startup memory.
- Retrieval failure logs and degrades gracefully.
- UI can show why a memory item was included.

### Wave 6: Controls, Maintenance, And Quality Metrics

Deliverables:

- Per-project clear/pause/exclude/rescan controls.
- Background integrity checks for status/source drift.
- Retention and pruning for stale low-confidence memory.
- Metrics: retrieval hit rate, source coverage, duplicate rate, stale fact count, brief token/char size.

Acceptance criteria:

- User can remove all derived memory for one project without touching other projects.
- Stale source links are detected and pruned.
- Memory quality metrics are visible in debug/status output.

## Test Plan

Unit tests:

- Project root normalization and dangerous-root rejection.
- Coordinator state transitions and in-flight dedupe.
- Source fingerprint idempotency.
- Provenance link creation.
- Retrieval ranking and duplicate collapse.
- Prompt packing budgets and source labels.

Integration tests:

- Register project, mine high-signal files, restart singleton, status persists.
- Modify `package.json`, verify re-mine and source update.
- Index a fixture repo, verify symbol/source results.
- Import same-project and other-project conversation fixtures, verify scoping.
- Clear project memory, verify unrelated projects remain intact.

Renderer tests:

- Browse adds/selects a project root.
- Status badges match coordinator status.
- Pause/exclude disables auto-mining.
- Evidence inspector renders source references.

Verification commands after implementation:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```

Run targeted Vitest files during each wave, then the full suite after any multi-file integration.

## Risks

| Risk | Mitigation |
|---|---|
| Project key mismatch leaks or hides memory | Normalize through one helper and test symlink/trailing-slash cases |
| Startup context becomes noisy | Fixed budget, direct evidence priority, source labels, user controls |
| Recursive indexing is expensive | Queue work, use watchers and fingerprints, do not block spawn |
| Model summaries drift from truth | Stage candidates, require source links, prefer code/index facts for code claims |
| UI implies memory is authoritative | Label results as source-backed context candidates and show evidence |
| Auto-discovery mines too much | Only project roots from instances/default/user selection; reject broad roots |

## Definition Of Done

- Known project roots are persisted, controllable, and auto-refreshed.
- Codebase mining, code indexing, conversation memory, wake context, and KG facts are coordinated through one project-scoped pipeline.
- Every promoted durable memory item has source provenance.
- Fresh root instances receive compact, source-backed memory that is inspectable after spawn.
- The Knowledge UI shows project status, controls, and evidence.
- Clearing or pausing memory works per project.
- Typecheck, spec typecheck, lint, targeted tests, and full tests pass.
