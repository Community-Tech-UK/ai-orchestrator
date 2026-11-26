# Project Memory Startup Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pack source-backed project facts, wake hints, code-index status/symbols, and prior same-project chats into fresh depth-0 startup briefs, then persist the exact rendered brief/source refs per spawned instance.

**Architecture:** Extend the existing `ProjectMemoryBriefService` instead of adding a parallel prompt packer. Add a small RLM persistence helper for startup brief records, collect bounded source-backed candidates from `ProjectKnowledgeReadModelService`, apply deterministic ranking/dedupe/redaction, and keep instance lifecycle behavior unchanged.

**Tech Stack:** TypeScript 5.9, Electron 40 main process, better-sqlite3/RLM migrations, Vitest.

---

## Reviewer Consensus From Spec

- Use `request.initialPrompt` token overlap only; blank prompt means zero overlap.
- Include code symbols only by explicit overlap, or when `readModel.codeSymbols.length <= 12`.
- Always include one code-index status candidate when status is not `never`.
- Redact candidate text before dedupe; dedupe by normalized redacted text only.
- Dedupe before source-backed slot reservation. Priority: source-backed > history transcript > prompt history, then score, then timestamp, then source ID.
- Use RLM read-model data only during startup packing. No codemem, filesystem scan, network, or LLM calls.
- Redact deterministic common secret patterns before rendering and persistence.
- Migration `022_project_memory_startup_briefs` is available.

## Files

- Modify: `src/main/persistence/rlm-database.types.ts`
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Create: `src/main/persistence/rlm/rlm-project-memory-briefs.ts`
- Modify: `src/main/memory/project-memory-brief.ts`
- Modify: `src/main/memory/index.ts`
- Modify test: `src/main/memory/project-memory-brief.spec.ts`
- Create test: `src/tests/unit/memory/project-memory-brief-persistence.test.ts`
- Modify test if needed: `src/main/instance/__tests__/instance-manager.spec.ts`

## Task 1: Startup Brief Persistence

- [ ] Add `ProjectMemoryStartupBriefRow` to `src/main/persistence/rlm-database.types.ts`:

```ts
export interface ProjectMemoryStartupBriefRow {
  id: string;
  instance_id: string;
  project_key: string;
  rendered_text: string;
  sections_json: string;
  sources_json: string;
  max_chars: number;
  rendered_chars: number;
  source_count: number;
  truncated: number;
  provider: string | null;
  model: string | null;
  created_at: number;
  metadata_json: string;
}
```

- [ ] Add migration `022_project_memory_startup_briefs` to `src/main/persistence/rlm/rlm-schema.ts` after migration 021:

```sql
CREATE TABLE IF NOT EXISTS project_memory_startup_briefs (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL UNIQUE,
  project_key TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  max_chars INTEGER NOT NULL,
  rendered_chars INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_project_memory_startup_briefs_project_created
  ON project_memory_startup_briefs(project_key, created_at DESC);
```

- [ ] Add this migration object to the exported migration array in `src/main/persistence/rlm/rlm-schema.ts`; do not edit any previously applied migration text.
- [ ] Create `src/main/persistence/rlm/rlm-project-memory-briefs.ts` with:

```ts
export interface RecordProjectMemoryStartupBriefParams {
  instanceId: string;
  projectKey: string;
  renderedText: string;
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  maxChars: number;
  truncated: boolean;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export function projectMemoryStartupBriefId(instanceId: string): string;
export function recordProjectMemoryStartupBrief(db: SqliteDriver, params: RecordProjectMemoryStartupBriefParams): ProjectMemoryStartupBriefRecord;
export function getProjectMemoryStartupBriefByInstance(db: SqliteDriver, instanceId: string): ProjectMemoryStartupBriefRecord | undefined;
```

- [ ] `recordProjectMemoryStartupBrief` must use deterministic `stableId('pmsb', instanceId)` and `INSERT ... ON CONFLICT(instance_id) DO UPDATE`.
- [ ] JSON parse failures in the read mapper return empty arrays/objects instead of throwing.
- [ ] Write `src/tests/unit/memory/project-memory-brief-persistence.test.ts` covering:
  - creates one row with rendered text, sections, sources, provider/model, and metadata
  - second record for the same `instanceId` updates the row instead of inserting a duplicate
  - corrupt JSON in `sections_json`, `sources_json`, or `metadata_json` does not throw in the mapper

Run:

```bash
npx vitest run src/tests/unit/memory/project-memory-brief-persistence.test.ts
```

Expected: new persistence tests pass.

## Task 2: Redaction Helper

- [ ] In `src/main/memory/project-memory-brief.ts`, add exported helper:

```ts
export function redactProjectMemoryBriefText(text: string): string
```

- [ ] The helper must apply these deterministic patterns:
  - keyword assignments: `/\b(api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\b\s*[:=]\s*["']?([^\s"']{3,})/gi`
  - full private-key blocks: `/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g`
  - clipped private-key markers: `/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g` and `/-----END [A-Z0-9 ]*PRIVATE KEY-----/g`
  - AWS `AKIA`/`ASIA` keys: `/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g`
  - credential URLs: `/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s]+)@/gi`
  - long token-looking strings: `/\b[A-Za-z0-9+/_=-]{32,}\b/g`, only when the matched value contains at least three of lowercase, uppercase, digit, and `+/_=-` symbol classes
- [ ] Apply redaction inside `cleanSnippet(...)` so prompt/history/recall snippets are redacted.
- [ ] Apply redaction to project facts, wake hints, code-index text, code symbol signatures/doc comments, and the final rendered text before persistence.
- [ ] Add tests in `src/main/memory/project-memory-brief.spec.ts` covering redaction of:
  - `api_key=sk-test-abc123`
  - `password: hunter2`
  - `AKIA1234567890ABCDEF`
  - `https://user:pass@example.com/repo.git`
  - full and clipped private-key markers
  - a long token-looking string
  - false positives: `/Users/suas/work/orchestrat0r/ai-orchestrator`, `ProjectMemoryBriefService`, `package.json`

Run:

```bash
npx vitest run src/main/memory/project-memory-brief.spec.ts
```

Expected: brief tests pass and no secret literal appears in rendered output assertions.

## Task 3: Source-Backed Candidate Collection

- [ ] Extend `ProjectMemoryBriefSourceType` in `src/main/memory/project-memory-brief.ts` to include:

```ts
| 'project-fact'
| 'project-wake-hint'
| 'code-index-status'
| 'code-symbol'
```

- [ ] Extend `ProjectMemoryBriefDeps` with:

```ts
projectKnowledge?: Pick<ProjectKnowledgeReadModelService, 'getReadModel'>;
recorder?: ProjectMemoryBriefRecorder;
```

- [ ] Define `ProjectMemoryBriefRecorder` so tests can inject a fake recorder and production can call `recordProjectMemoryStartupBrief`.
- [ ] Use this dependency pattern:

```ts
export type ProjectMemoryBriefRecorder = (params: RecordProjectMemoryStartupBriefParams) => void;

function defaultRecordProjectMemoryStartupBrief(params: RecordProjectMemoryStartupBriefParams): void {
  recordProjectMemoryStartupBrief(getRLMDatabase().getRawDb(), params);
}

const recorder = this.deps.recorder ?? defaultRecordProjectMemoryStartupBrief;
```

- [ ] Add source-backed sections to the candidate model:

```ts
type ProjectMemoryBriefSectionKey =
  | 'facts'
  | 'codeIndex'
  | 'codeSymbols'
  | 'wakeHints'
  | 'prompts'
  | 'history';
```

- [ ] Implement `collectProjectKnowledgeCandidates(...)`:
  - call `getProjectKnowledgeReadModelService().getReadModel(projectKey)` only when `includeMinedMemory !== false`
  - catch errors and return `[]`
  - measure elapsed time and log a warning if the synchronous read exceeds 250ms
  - rely on bounded RLM query shape for latency control; do not attempt a fake timeout around synchronous SQLite
  - add one `code-index-status` candidate when `codeIndex.status !== 'never'`
  - add `project-fact` candidates from `readModel.facts`
  - add `project-wake-hint` candidates from `readModel.wakeHints`
  - add `code-symbol` candidates only when the explicit overlap-or-12-symbol fallback rule allows it
- [ ] Candidate text examples:

```text
[fact src:2 conf:90%] AI Orchestrator uses Angular 21 with zoneless signals.
[code-index ready] 1248 files, 8412 symbols indexed 2026-05-03.
[symbol function src:1] ProjectMemoryBriefService.buildBrief at src/main/memory/project-memory-brief.ts:100
[wake src:1 imp:8] Prefer source-backed project memory over stale chat recollection.
```

- [ ] Candidate source metadata must include the target/provenance fields from the spec.
- [ ] Add tests proving:
  - source-backed facts, wake hints, code-index status, and matching symbols render when present
  - `includeMinedMemory: false` does not call the read model and preserves prompt/history behavior
  - read-model exceptions do not fail `buildBrief`
  - code symbols are omitted when there is no overlap and `readModel.codeSymbols.length > 12`
  - code symbols are included with no overlap when `readModel.codeSymbols.length <= 12`

Run:

```bash
npx vitest run src/main/memory/project-memory-brief.spec.ts
```

Expected: all `ProjectMemoryBriefService` tests pass.

## Task 4: Deterministic Selection, Rendering, And Recording

- [ ] Replace the current simple `dedupeCandidates(...).sort(...).slice(...)` selection with:
  - redacted-text dedupe first; unredacted text is never used as a dedupe key, log value, or persistence key
  - duplicate priority `source-backed > history-transcript > prompt-history`
  - source-backed reserved slots `ceil(maxResults / 2)` when source-backed candidates exist
  - remaining slots sorted by `score DESC`, `sourceRank DESC`, `timestamp DESC`, `sourceId ASC`
- [ ] Update `buildStructuredBrief(...)` section order:

```ts
['facts', 'codeIndex', 'codeSymbols', 'wakeHints', 'prompts', 'history']
```

- [ ] Update `renderBrief(...)` scope line and footer to match the spec.
- [ ] Update `countSources(...)` so the accumulator handles all source types without exhaustive assumptions.
- [ ] After rendering, if `request.instanceId` is present, call the injected/default recorder with:
  - instance ID
  - project key
  - rendered text
  - sections
  - sources
  - max chars
  - truncated
  - provider/model
  - metadata containing:
    - `candidatesScanned`: total candidates before dedupe
    - `candidatesDeduped`: candidates remaining after dedupe
    - `candidatesIncluded`: selected candidates rendered into sections
    - `sourceCounts`: selected source count by `ProjectMemoryBriefSourceType`
- [ ] Recorder errors must be caught and logged without failing `buildBrief`.
- [ ] Update `src/main/memory/index.ts` exports if new recorder/persistence-facing types need public test access.
- [ ] Add tests proving:
  - source-backed candidates reserve at least half of selected slots when many prompt/history candidates also exist
  - duplicate text prefers source-backed candidate over prompt/history
  - recorder receives the exact redacted rendered text, sections, and sources when `instanceId` is present
  - recorder failure does not fail brief generation

Run:

```bash
npx vitest run src/main/memory/project-memory-brief.spec.ts src/tests/unit/memory/project-memory-brief-persistence.test.ts
```

Expected: targeted startup brief tests pass.

## Task 5: Instance Integration Regression

- [ ] Inspect `src/main/instance/__tests__/instance-manager.spec.ts` mocks for `ProjectMemoryBriefSourceType` assumptions.
- [ ] Update mocks only if TypeScript requires new fields or stricter source type handling.
- [ ] Grep `src/main/instance/__tests__/instance-manager.spec.ts` for an assertion that `mockProjectMemoryBuildBrief` receives `instanceId`. If missing, add this regression:

```ts
it('passes instance/provider/model metadata to the project memory brief builder', async () => {
  // create a root instance with initialPrompt/provider/modelOverride
  // expect mockProjectMemoryBuildBrief to receive instanceId, projectPath, initialPrompt, provider, model
});
```

- [ ] Do not move or expand lifecycle injection gates; child/resume/restore behavior must remain as-is.

Run:

```bash
npx vitest run src/main/instance/__tests__/instance-manager.spec.ts
```

Expected: existing lifecycle brief injection tests still pass.

## Task 6: Verification

- [ ] Run targeted tests:

```bash
npx vitest run src/main/memory/project-memory-brief.spec.ts src/tests/unit/memory/project-memory-brief-persistence.test.ts src/main/instance/__tests__/instance-manager.spec.ts
```

- [ ] Run TypeScript checks:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] Run lint:

```bash
npm run lint
```

- [ ] Run full tests:

```bash
npm run test
```

- [ ] Run build:

```bash
npm run build
```

- [ ] Run full project verification:

```bash
npm run verify
```

- [ ] If architecture verification reports drift, run:

```bash
npm run generate:architecture
npm run verify
```

- [ ] Run whitespace and native ABI checks:

```bash
git diff --check
node scripts/verify-native-abi.js
```

- [ ] Inspect generated/persisted evidence through automated tests:
  - persistence tests must read back one `project_memory_startup_briefs` row for one `instanceId`
  - brief tests must assert rendered output does not contain the secret literals covered by redaction tests
  - rely on `npm run verify` for Electron smoke coverage; no UI route changes are part of this slice

Expected: every command exits 0 before claiming this slice is complete.

## Self-Review

- Spec coverage: startup packing, source-backed reservation, symbol thresholds, secret redaction, startup brief persistence, graceful degradation, and verification are mapped to tasks.
- Placeholders: none.
- Deferred by design: full `ProjectKnowledgeRetriever`, per-turn live retrieval, startup brief UI, conversation promotion, code relationship graph, and wake-context consolidation.
