# Project Memory Source Provenance Plan

**Date:** 2026-05-03
**Spec:** `docs/superpowers/specs/2026-05-03-project-memory-source-provenance-design.md`
**Status:** Reviewed by Gemini and Claude; consensus changes integrated

## Goal

Make mined project memory inspectable by adding canonical source records, FK-backed evidence links to KG facts and wake hints, a project read model, and Knowledge UI evidence browsing. This is Wave 2 of project memory and intentionally does not add recursive code indexing, conversation promotion, or startup brief rewrites.

No commits or pushes are part of this plan unless the user explicitly asks.

## Reviewer Consensus

- Use one source row per project URI and concrete link tables (`project_knowledge_kg_links`, `project_knowledge_wake_links`) instead of a polymorphic target table.
- Delete source rows for high-signal files that disappear; let source-link FKs cascade.
- Avoid DB writes on unchanged projects when current source provenance already exists.
- Force a normal full mine/backfill when an unchanged legacy project has no Wave 2 source rows.
- Wrap changed-source clear/relink in one DB transaction.
- Read models must use exact project-room hints and current KG triples only.
- Use existing knowledge contracts/channels; do not add a new runtime alias.

## Phase 1: Types, Migration, and Persistence Tests

1. Add shared types in `src/shared/types/knowledge-graph.types.ts`:
   - `ProjectKnowledgeSourceKind`
   - `ProjectKnowledgeSource`
   - `ProjectKnowledgeTargetKind`
   - `ProjectSourceSpan`
   - `ProjectKnowledgeSourceLink`
   - `ProjectKnowledgeEvidence`
   - `ProjectKnowledgeSourceInventory`
   - `ProjectKnowledgeProjectSummary`
   - `ProjectKnowledgeReadModel`
   - `ProjectKnowledgeFact`
   - `ProjectKnowledgeWakeHintItem`
   - request payload/result DTOs for list/read/evidence
   - `id` and `sourceFile` on `KGQueryResult`

2. Add database row types in `src/main/persistence/rlm-database.types.ts`.

3. Add migration `020_project_knowledge_sources` in `src/main/persistence/rlm/rlm-schema.ts`:
   - `project_knowledge_sources` with `UNIQUE(project_key, source_uri)`
   - `project_knowledge_kg_links` with FK to `project_knowledge_sources(id)` and `kg_triples(id)`
   - `project_knowledge_wake_links` with FK to `project_knowledge_sources(id)` and `wake_hints(id)`
   - indexes for `(project_key, source_kind)`, `(project_key, source_uri)`, `(project_key, triple_id)`, and `(project_key, hint_id)`

4. Write failing tests in `src/tests/unit/memory/project-knowledge-persistence.test.ts`:
   - canonical source upsert does not duplicate unchanged source rows, even if source kind classification changes
   - changed fingerprint updates the same source row and returns `changed: true`
   - KG and wake link inserts are idempotent
   - link insert rejects source/project mismatch
   - clearing links by source and target kinds removes only requested link kinds
   - deleting a source cascades both concrete link tables
   - deleting a KG triple or wake hint cascades the matching link table
   - deleting sources not seen this run removes only missing project sources
   - inventory counts group by source kind
   - `hasCurrentProjectKnowledgeSources` is true only when all current descriptors have matching source rows and fingerprints

5. Implement `src/main/persistence/rlm/rlm-project-knowledge.ts`:
   - deterministic IDs from project/source/target identity
   - JSON metadata/span parse helpers with safe fallbacks
   - `upsertProjectKnowledgeSource`
   - `deleteProjectKnowledgeSourcesNotSeen`
   - `clearProjectKnowledgeLinksForSource`
   - `linkProjectKnowledgeKgTriple`
   - `linkProjectKnowledgeWakeHint`
   - `hasCurrentProjectKnowledgeSources`
   - `listProjectKnowledgeSources`
   - `listProjectKnowledgeLinks`
   - `listProjectEvidenceForTarget`
   - `getProjectKnowledgeSourceInventory`

6. Run targeted persistence tests.

## Phase 2: KG and Wake Target IDs

1. Update or add KG assertions:
   - `queryEntity`, `queryRelationship`, and `timeline` include `id`
   - DTOs preserve `sourceFile`
   - current-triple behavior stays unchanged

2. Update mappers in `src/main/persistence/rlm/rlm-knowledge-graph.ts`.

3. Update `CodebaseMiner.addHintIfMissing` to return the reused or created wake hint ID. The lookup must filter exact project room and exact normalized content before returning an existing ID.

4. Run targeted KG/wake/miner tests touched by the type changes.

## Phase 3: Miner Provenance Integration

1. Extend `CodebaseMiningResult` with optional source/link counters:
   - `sourcesProcessed`
   - `sourcesCreated`
   - `sourcesChanged`
   - `sourcesDeleted`
   - `sourceLinksCreated`
   - `sourceLinksPruned`

2. Write failing miner tests in `src/tests/unit/memory/codebase-miner.test.ts`:
   - mining `package.json` writes source rows and KG evidence links
   - mining `README.md` or `AGENTS.md` writes source rows and wake evidence links
   - unchanged re-mine with current provenance returns early without duplicate sources, links, or source writes
   - unchanged legacy project with no source rows performs a backfill instead of returning early
   - changed source clears stale links and creates current links inside a transaction
   - deleted or renamed source removes the old source row and cascades links
   - exact-room/content hint reuse links the existing project hint and never links `general`

3. Update `src/main/memory/codebase-miner.ts`:
   - collect source descriptors with kind, normalized absolute URI, title, fingerprint, and metadata
   - compute the content fingerprint as today from collected high-signal files
   - if prior status is completed, fingerprint is unchanged, and `hasCurrentProjectKnowledgeSources` is true, return early with no source/link writes
   - otherwise delete project source rows not seen in this run
   - for each source, use a DB transaction to upsert the source, clear links if changed, extract facts/hints, and insert concrete KG/wake links
   - when an unchanged legacy project lacks source rows, run the normal extraction path; KG/hint/link idempotency prevents duplicate memory

4. Run targeted miner tests.

## Phase 4: Read Model and IPC

1. Write failing read-model tests in `src/tests/unit/memory/project-knowledge-read-model.test.ts`:
   - lists registered projects with source inventory
   - returns sources sorted for UI
   - returns current KG facts with `targetKind: 'kg_triple'` and `targetId`
   - returns exact-room wake hints only
   - returns evidence for selected facts and hints
   - excludes invalidated KG triples from current facts
   - excludes dangling rows if a future regression bypasses FK cascades

2. Implement `src/main/memory/project-knowledge-read-model.ts`:
   - read project roots from `ProjectRootRegistry`
   - read source inventory and sources from `rlm-project-knowledge`
   - read facts by joining KG link rows to current `kg_triples` and entity names
   - read wake hints by joining wake link rows to `wake_hints` with exact `room = projectKey`
   - expose `listProjects`, `getReadModel`, and `getEvidence`

3. Export singleton helpers from `src/main/memory/index.ts`.

4. Add IPC contracts to existing files:
   - `packages/contracts/src/channels/memory.channels.ts`
   - `packages/contracts/src/schemas/knowledge.schemas.ts`
   - `src/preload/generated/channels.ts` if generated constants are maintained manually in this repo

5. Register handlers in `src/main/ipc/handlers/knowledge-graph-handlers.ts`.

6. Extend preload and renderer IPC service:
   - `src/preload/domains/memory.preload.ts`
   - `src/renderer/app/core/services/ipc/memory-ipc.service.ts`

7. Add IPC registration smoke coverage where existing handler tests live if a suitable seam exists; otherwise cover schema/channel usage through store tests and typecheck.

8. Run targeted read-model and IPC tests.

## Phase 5: Renderer Store and Knowledge UI

1. Extend `src/renderer/app/core/state/knowledge.store.ts`:
   - project summaries signal
   - selected project key signal
   - project read model signal
   - selected evidence signal
   - methods to list projects, select project, refresh read model, and load evidence

2. Update `src/renderer/app/features/knowledge/knowledge-page.component.ts`:
   - project selector backed by registered roots
   - source inventory panel
   - recent source list with relative paths
   - project fact/hint list with inspect controls
   - evidence panel for selected target
   - preserve existing Browse/Mine/Pause/Resume/Exclude controls and behavior

3. Update `src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`:
   - project selector renders summaries
   - selecting a project calls store selection/read load
   - evidence inspect calls store evidence load
   - existing pause/resume/exclude tests still pass

4. Run targeted renderer tests.

## Phase 6: Verification

Run, in order:

1. `npx vitest run src/tests/unit/memory/project-knowledge-persistence.test.ts`
2. `npx vitest run src/tests/unit/memory/codebase-miner.test.ts src/tests/unit/memory/project-knowledge-read-model.test.ts`
3. `npx vitest run src/renderer/app/features/knowledge/knowledge-page.component.spec.ts`
4. `npx tsc --noEmit`
5. `npx tsc --noEmit -p tsconfig.spec.json`
6. `npm run lint`
7. `npm run test`
8. `git diff --check`

Completion requires all verification commands to pass or an explicit note describing what failed and why.
