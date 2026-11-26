# Project Memory Startup Brief Design

**Status:** Reviewed with Gemini and Claude; consensus changes integrated
**Date:** 2026-05-03
**Scope:** Source-backed spawn-time project memory packing over the existing project knowledge read model and code-index bridge.

## Goal

Fresh depth-0 agents should start with a compact, current, source-backed project memory brief. The current app already injects old prompt/history snippets, wake context, and background project mining. It does not yet pack the durable project knowledge read model that now contains mined facts, source-backed wake hints, and codemem file/symbol status.

This slice makes the existing `ProjectMemoryBriefService` the single startup packer for:

- source-backed project facts from high-signal mining
- source-backed project wake hints
- code-index status and relevant code symbols
- relevant prior same-project prompts/chats
- a persisted record of the exact rendered brief and source refs used for the spawn

The result should be useful on the next agent launch without dumping the whole memory database or blocking spawn on new indexing work.

## Current State

- `src/main/instance/instance-lifecycle.ts` calls `ProjectMemoryBriefService.buildBrief(...)` before agent spawn for fresh depth-0 instances.
- `ProjectMemoryBriefService` currently ranks prompt history and project-scoped history transcripts only.
- Wake context is injected separately via `WakeContextBuilder`.
- `ProjectKnowledgeReadModelService` can now read project sources, KG facts, wake hints, code-index status, and a bounded code-symbol preview.
- `ProjectKnowledgeCoordinator.ensureProjectKnown(...)` runs after prompt construction as fire-and-forget, so startup packing must use the latest committed read model and degrade cleanly when a project has not been mined yet.
- Wave 3A deliberately left startup prompt packing and unified retrieval out of scope.

## Reference Patterns

From local `mempalace-reference`:

- `searcher.py` treats direct drawer/BM25 search as the floor and vector/closet hits as ranking boosts, never as gates. For this slice, source-backed facts and symbols are the floor; old-chat recall is useful but must not crowd out current source-backed project state.
- `project_scanner.py` prefers real project signals such as manifests and git data over weak regex guesses. For this slice, checked-in high-signal sources and codemem symbols are preferred over model-extracted conversation candidates.

From local Open Brain (`OB1`):

- `recipes/live-retrieval` is "brief on hit, silent on miss"; failed retrieval should not interrupt the task. Startup packing should behave the same: if mined memory is absent or unavailable, spawn continues with no visible failure.
- `recipes/source-filtering` scopes retrieval by source. Startup packing must keep source types explicit in `ProjectMemoryBriefSource`.
- `recipes/content-fingerprint-dedup` makes capture idempotent. Startup brief recording should be idempotent per `instance_id`.

## Design

## Reviewer Consensus

Gemini and Claude both supported the direction and challenged the spec on
determinism and privacy. The consensus changes are:

- Define token overlap as overlap with `request.initialPrompt` tokens; if there
  is no initial prompt, overlap is zero.
- Make code-symbol inclusion concrete: include matching symbols by token overlap,
  or include all previewed symbols only when the preview has at most 12 symbols.
- Treat code-index status as a small always-included source-backed candidate
  whenever status is not `never`, rather than a vague ranked inventory dump.
- Redact candidate text before dedupe and persistence. Dedupe uses redacted
  normalized text only.
- Dedupe before reservation and use an explicit priority:
  source-backed > history transcript > prompt history, then score and recency.
- Verify the existing read-model API before planning. It currently exists as
  `ProjectKnowledgeReadModelService.getReadModel(projectKey)` and returns
  `{ project, sources, facts, wakeHints, codeIndex, codeSymbols }`.
- Confirm migration `022` is available; current RLM migrations end at
  `021_project_code_index_bridge`.
- Tighten secret redaction with deterministic patterns and explicit tests.
- Keep startup packing on committed RLM reads only. It must not call codemem,
  the filesystem, network, or background mining during prompt construction.

### Scope Name

Treat this as **Source-Backed Startup Brief Packing**. It is a pragmatic slice of the unified project memory Wave 5 prompt-packing goal, but it does not build a full `ProjectKnowledgeRetriever`, Knowledge search UI, per-turn live retrieval, or conversation promotion workflow.

### Startup Brief Contract

`ProjectMemoryBriefService.buildBrief(request)` remains the one method used by instance creation. It should:

1. Normalize `request.projectPath` with `normalizeProjectMemoryKey`.
2. Collect source-backed candidates from `ProjectKnowledgeReadModelService.getReadModel(projectKey)` when `includeMinedMemory !== false`.
3. Collect existing prompt/history/recall candidates as it does today.
4. Rank candidates with source-backed project facts/code/current wake hints guaranteed a reserved share when present.
5. Render one compact markdown section that fits `maxChars`.
6. Redact secret-like content before rendering or persistence.
7. If `request.instanceId` is provided, persist the exact rendered text, sections, sources, and budget metadata.
8. Return the same `ProjectMemoryBrief` shape, with source types extended but existing callers unchanged.

If project knowledge read fails, log and continue with prompt/history candidates. If all sources are empty, return an empty brief exactly as today.

### Candidate Types

Extend `ProjectMemoryBriefSourceType`:

```ts
export type ProjectMemoryBriefSourceType =
  | 'prompt-history'
  | 'history-transcript'
  | 'project-fact'
  | 'project-wake-hint'
  | 'code-index-status'
  | 'code-symbol';
```

New candidate sections:

- `Current source-backed facts`
- `Current code index`
- `Relevant code symbols`
- `Project wake hints`
- existing `Recent relevant prompts`
- existing `Relevant prior chat excerpts`

Source metadata should include enough provenance for later inspection:

- project facts: `targetKind: 'kg_triple'`, `targetId`, `evidenceCount`, `confidence`, optional `sourceFile`
- wake hints: `targetKind: 'wake_hint'`, `targetId`, `evidenceCount`, `importance`, `room`
- code symbols: `targetKind: 'code_symbol'`, `targetId`, `workspaceHash`, `pathFromRoot`, `symbolKind`, `line`
- code status: `status`, `fileCount`, `symbolCount`, `lastSyncedAt`, `workspaceHash`

No full source file text should be stored or rendered in this slice.

### Ranking And Reservation

Keep ranking deterministic and cheap. There is no embedding call in startup packing.
`token overlap` means the count of distinct normalized tokens shared with
`request.initialPrompt`. If the initial prompt is blank, overlap is zero.

Suggested base weights:

- project fact: 100 + token overlap + confidence/evidence boosts
- code-index status: 88 when status is not `never`
- code symbol: 82 + token overlap over name/path/container/signature
- project wake hint: 72 + importance/token overlap
- history transcript: 70 + existing boosts
- prompt history: 60 + existing boosts

Selection rules:

- `maxResults` remains clamped to 1..20.
- Dedupe by normalized redacted text before slot reservation. Unredacted text is
  never used as a persistence key, log value, or dedupe key.
- For duplicate text, prefer source-backed candidates over history transcripts
  over prompt history, then by score, then by timestamp.
- Sort candidates by `score DESC`, then `sourceRank DESC`, then
  `timestamp DESC`, then `sourceId ASC`.
- If source-backed candidates exist after dedupe, reserve at least
  `ceil(maxResults / 2)` slots for `project-fact`, `project-wake-hint`,
  `code-index-status`, and `code-symbol` candidates.
- Fill remaining slots from all candidates by score.
- Code-index status is included as one candidate whenever status is not `never`.
- Code symbols are considered only when the code index is `ready`, or when it is
  `indexing` and existing rows are present from a prior successful snapshot.
  Include individual symbols when either:
  - symbol name/path/container/signature has token overlap with the initial prompt; or
  - the `readModel.codeSymbols` preview array has at most 12 symbols.
  Otherwise, render only code-index status and omit individual symbols.

This follows the mempalace rule that direct current project sources are the floor and older semantic/contextual memory is a boost, not a gate.

### Rendering

The rendered brief should still start with:

```md
## Project Memory Brief
Project: <projectKey>
Scope: current source-backed project memory plus prior local chats/prompts for this project only
```

Item examples:

```md
Current source-backed facts:
- [fact src:2 conf:90%] AI Orchestrator uses Angular 21 with zoneless signals.

Current code index:
- [code-index ready] 1,248 files, 8,412 symbols indexed 2026-05-03.

Relevant code symbols:
- [symbol function src:1] ProjectMemoryBriefService.buildBrief at src/main/memory/project-memory-brief.ts:100
```

Footer:

```md
Use this as recall context. Prefer current repository files and direct user instructions when they conflict with memory. Verify important details against source files before editing.
```

The footer matters because prompt-packing is context, not authority.

### Secret Redaction

Before a candidate text is rendered or persisted, redact:

- keyword assignments:
  `/\b(api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\b\s*[:=]\s*["']?([^\s"']{3,})/gi`
- private key markers:
  `/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g`
  and single marker fallbacks when snippets are clipped
- AWS access key IDs:
  `/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g`
- URLs with embedded credentials:
  `/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s]+)@/gi`
- long token-looking strings:
  `\b[A-Za-z0-9+/_=-]{32,}\b` only when the value contains at least three of
  lowercase, uppercase, digit, and token-symbol character classes

Redaction is not a replacement for source filtering or a full secret scanner.
It prevents the startup brief from amplifying common accidental secret shapes.
The redactor is deterministic, local, and unit-tested. It must not throw. It
does not attempt broad PII removal in this slice because project facts may
legitimately contain names or emails; future policy can add configurable PII
filters.

Tests must cover:

- assignment secrets such as `api_key=...`, `password: ...`, and `token = ...`
- AWS key IDs
- private key block markers and clipped single markers
- credential URLs
- long token-looking strings
- false positives such as normal file paths, package names, short identifiers,
  and ordinary prose

### Startup Brief Persistence

Add migration `022_project_memory_startup_briefs`:

```sql
CREATE TABLE project_memory_startup_briefs (
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

CREATE INDEX idx_project_memory_startup_briefs_project_created
  ON project_memory_startup_briefs(project_key, created_at DESC);
```

IDs are deterministic:

```ts
stableId('pmsb', instanceId)
```

Recording is idempotent by `instance_id`. If `buildBrief` is called twice for the same instance, the later call updates the row with the exact current rendered text and metadata. Recording failure is logged but never fails spawn or brief generation.

The persistence helper should use `INSERT ... ON CONFLICT(instance_id) DO UPDATE`
instead of delete/reinsert so the deterministic row identity remains stable.

Persisting the exact source refs is required because running retrieval later may produce a different answer.

### Integration Order

Do not move project mining/indexing ahead of spawn in this slice. Doing so would make spawn latency unpredictable. The startup packer reads the current committed read model only. Background mining continues after spawn and improves future launches.

The read-model call is synchronous SQLite over bounded rows. Startup packing
must not call codemem, scan the filesystem, or invoke network/LLM work. If the
read-model call throws, log and continue. If it takes more than 250ms, log a
warning with project key and elapsed time so startup overhead can be measured.
Because the call is synchronous, the latency control in this slice is bounded
query shape: current fact/wake rows plus the code-symbol preview cap already
owned by `ProjectKnowledgeReadModelService`. A future async retriever can add a
hard timeout.

Keep separate wake-context injection for now. This slice adds source-backed project wake hints to the project brief, but does not delete or rewrite `WakeContextBuilder`; the two systems have different legacy data and UI controls. A later consolidation pass can remove duplication once measured.

## Out Of Scope

- Full `ProjectKnowledgeRetriever` abstraction.
- Per-turn live retrieval or topic-shift detection.
- Human promotion/rejection of conversation candidates.
- Import/call graph relationship mining.
- UI for inspecting stored startup brief records.
- Moving mining/indexing before spawn.
- Persisting full source code excerpts.

## Acceptance Criteria

- Fresh depth-0 instance startup still calls `ProjectMemoryBriefService.buildBrief`.
- Source-backed facts, wake hints, code-index status, and relevant code symbols appear in the brief when present.
- Same-project old prompt/history snippets still appear when relevant.
- Source-backed candidates reserve at least half of selected slots when available.
- `includeMinedMemory: false` preserves the old prompt/history-only behavior.
- Missing/unregistered/failed project knowledge reads do not fail spawn.
- Code symbols use the explicit overlap-or-12-symbol fallback rule.
- Secret-like content is redacted from rendered and persisted briefs, with
  dedicated tests for the patterns listed above.
- A row in `project_memory_startup_briefs` records the exact rendered text, sections, sources, and metadata for each startup brief with `instanceId`.
- Brief recording is idempotent per instance.
- Child, resume, and restore/replay instance behavior remains unchanged because instance lifecycle already gates `buildBrief`.
- Targeted unit tests, TypeScript checks, lint, full tests, build, `npm run verify`, `git diff --check`, and Electron native ABI verification pass.
