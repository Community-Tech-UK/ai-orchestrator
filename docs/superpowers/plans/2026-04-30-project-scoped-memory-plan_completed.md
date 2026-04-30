# Project-Scoped Memory Implementation Plan

Completed: 2026-04-30

## Goal

Fresh root instances should start with useful project context even when the
selected provider/model has no resumable session. The app should also let a
user explicitly search old chats for the current project without restoring a
prior provider session.

This should be orchestrator-owned memory, not provider memory. Provider memory
can help when available, but the app needs one cross-provider substrate for
Claude, Gemini, Codex, Copilot, and future adapters.

## Validation Summary

The original sketch is directionally right. The repo already has most of the
raw parts:

- `src/main/prompt-history/` stores per-instance and per-project prompts in
  `electron-store`.
- `src/main/history/` has archived conversation history, advanced search, and
  expandable transcript snippets.
- `src/main/session/session-recall-service.ts` can search archived sessions and
  history transcript snippets when `includeHistoryTranscripts` is explicitly
  enabled.
- `src/main/memory/wake-context-builder.ts` injects L0/L1 wake context for
  depth-0 instances.
- `src/main/memory/conversation-miner.ts`, the knowledge graph, RLM, and
  unified memory provide mined/enriched memory primitives.

The missing feature is not another memory stack. It is a project-scoped
retrieval coordinator and one deterministic injection point during fresh
depth-0 spawn.

Important corrections to the first draft:

- Prompt history is currently written mostly from the renderer input panel.
  Backend-generated prompts, automation sends, and some lifecycle prompts may
  bypass it unless the main process also records them.
- Advanced history search already exists. The plan should reuse and tighten it
  before adding a separate old-chat index.
- Session recall does not include transcript snippets by default. The project
  memory service must opt into `includeHistoryTranscripts: true` when it wants
  old-chat evidence.
- RLM and unified memory are currently scoped mostly by instance/session tags,
  not by project path. They are enrichment sources, not the v1 source of truth.
- Wake context accepts a `wing` argument, but project scoping depends on using a
  normalized project key consistently across wake hints, conversation mining,
  and history retrieval.

## External Findings

Provider memory is fragmented:

- Claude Code supports project files and machine-local auto memory, but that
  memory is Claude-specific and scoped by Claude's own project directory model:
  https://code.claude.com/docs/en/memory
- Codex supports `AGENTS.md` project instructions and optional generated
  memories under `~/.codex/memories/`, but OpenAI explicitly says required
  team guidance belongs in checked-in docs, not only generated memories:
  https://developers.openai.com/codex/guides/agents-md and
  https://developers.openai.com/codex/memories
- Gemini CLI uses `GEMINI.md` hierarchy for context and `save_memory` for
  concise facts, but it is not intended for large chat history:
  https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html and
  https://google-gemini.github.io/gemini-cli/docs/tools/memory.html
- GitHub Copilot supports repository custom instructions and agent instruction
  files, but those are prompt guidance, not cross-provider saved chat recall:
  https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions

MemPalace is the most relevant reference. The inspected code and docs emphasize:

- Store original conversation/project content verbatim.
- Scope by project-like metadata (`wing`) and topic/time-like metadata
  (`room`).
- Use semantic/vector search, BM25, closets, and knowledge graph facts as
  ranking/navigation aids.
- Never let auxiliary indexes hide direct verbatim content. In
  `mempalace/searcher.py`, direct drawer search is always the baseline and
  closet hits only boost ranking.
- Use a small wake-up layer for new sessions, with deeper search available on
  demand.

That maps cleanly to this app: old chat transcripts and prompt history should
be primary evidence; RLM/KG/wake/mined facts should improve recall and ranking,
not replace direct project history.

References inspected:

- Local `mempalace-reference/`
- Fresh upstream clone of `https://github.com/MemPalace/mempalace`
- MemPalace README: https://github.com/MemPalace/mempalace

## Design Principles

1. Direct evidence first.
   Archived transcripts and prompt history are the source of truth for old
   chats. Summaries, KG facts, wake hints, and embeddings can rank or enrich
   results but cannot be the only source.

2. Strict project scoping.
   Every query and write path must use a normalized project key derived from
   the working directory or repository root. Never mix unrelated projects in a
   fresh instance brief.

3. Provider independence.
   The brief is built in the Electron main process before provider spawn, so it
   works for Claude, Gemini, Codex, Copilot, and any adapter that accepts an
   initial system prompt/instructions.

4. Budgeted startup context.
   Fresh spawn memory should be short and inspectable. Deep recall belongs in
   explicit old-chat search or later per-message retrieval, not a giant startup
   dump.

5. Provenance everywhere.
   Each included item should carry source metadata: history entry id, snippet
   id, timestamp, provider/model/session when available, and whether the text is
   direct transcript, prompt history, wake hint, or mined memory.

6. Local and auditable.
   Use existing local storage. Do not call external embedding/LLM services for
   core memory unless the user explicitly opts in later.

## Proposed Architecture

Add a main-process service:

```ts
// src/main/memory/project-memory-brief.ts
export interface ProjectMemoryBriefRequest {
  projectPath: string;
  instanceId?: string;
  initialPrompt?: string;
  provider?: string;
  model?: string;
  maxChars?: number;
  maxResults?: number;
  includeMinedMemory?: boolean;
}

export interface ProjectMemoryBrief {
  text: string;
  sections: ProjectMemoryBriefSection[];
  sources: ProjectMemoryBriefSource[];
  stats: {
    projectKey: string;
    candidatesScanned: number;
    candidatesIncluded: number;
    truncated: boolean;
  };
}
```

Service responsibilities:

- Normalize the project key from `projectPath`.
- Gather candidates from existing stores.
- Rank, dedupe, and cap candidates.
- Render one compact Markdown block for injection.
- Return structured sources for tests/debug UI.

Suggested rendered block:

```md
## Project Memory Brief

Project: /path/to/project
Scope: prior local chats and prompts for this project only

Recent relevant prompts:
- ...

Relevant prior chat excerpts:
- [2026-04-28 Claude] ...

Useful durable notes:
- ...

Use this as recall context. Prefer current repository files and direct user
instructions when they conflict with old memory.
```

Default budget:

- 6 to 10 total bullets.
- 1,200 to 1,800 chars by default, configurable later.
- At least 50 percent reserved for direct chat/prompt evidence.
- Hard truncate with an explicit marker when over budget.

## Retrieval Sources

Use these in order for v1:

1. Prompt history
   - Read `PromptHistoryService.getForProject(projectKey).entries` or an added
     normalized equivalent. The renderer store has a similarly named
     `getEntriesForProject(...)`, but the implementation service in main uses
     `getForProject(...)`.
   - Score exact text overlap with `initialPrompt`, recency, and provider/model
     match only as a weak signal.
   - Do not rely on this alone until main-process prompt recording is added.

2. Archived conversations and snippets
   - Use `HistoryManager`/advanced history paths for project-filtered entries.
   - Use `TranscriptSnippetService.expandSnippets(...)` or targeted conversation
     loads for top entries so startup evidence is not limited to metadata.
   - Prefer direct transcript excerpts over summaries.

3. Session recall
   - Call `SessionRecallService.search(...)` with:
     - `repositoryPath: projectKey`
     - `includeHistoryTranscripts: true`
     - explicit sources including `history-transcript` and `archived_session`
   - Treat this as an aggregator, not a separate source of truth.

4. Wake context
   - Include a small section from `WakeContextBuilder.getWakeUpText(projectKey)`
     only after project-key normalization is consistent.
   - Keep it subordinate to direct old-chat hits.

5. Mined memory and KG facts
   - Later enrichment only; do not make these v1 startup dependencies.
   - Use `ConversationMiner`, KG, and RLM entries as additive context when their
     source metadata points back to the same project key.

## Ranking and Dedupe

Candidate score:

- Direct transcript or prompt history: high base weight.
- Exact query/token overlap with `initialPrompt`: strong boost.
- Recent same-project chat: moderate boost.
- Same provider/model: weak boost.
- Wake/KG/mined source: lower base weight unless corroborated by a direct hit.
- Duplicate or near-duplicate text: keep the highest-provenance item only.

Mempalace-inspired invariant:

- Always run direct project history retrieval.
- Auxiliary indexes may boost direct hits.
- Auxiliary indexes must never gate direct hits out of the candidate set.

## Spawn Integration

Wire the brief in `src/main/instance/instance-lifecycle.ts` during fresh
depth-0 instance creation.

Current flow already:

- Loads instruction hierarchy for depth-0 instances.
- Injects observation memory.
- Injects wake context.
- Starts codebase mining.
- Spawns the provider adapter and sends the initial prompt.

Add project memory brief assembly after instruction loading and before provider
spawn. Recommended order in the final prompt:

1. Base/system prompt and instruction hierarchy.
2. Observation memory.
3. Project memory brief.
4. Wake context.
5. Tool permission note.

Rules:

- Only inject on fresh depth-0 spawn.
- Concretely, guard on `instance.depth === 0` and skip when `config.resume` or
  `config.initialOutputBuffer?.length` indicates history restore/replay
  continuity instead of a clean new session.
- Skip native resume/replay restore paths to avoid duplicating prior context.
- If retrieval fails, log and continue spawning. Memory must not block instance
  creation.
- Add a debug log with source counts, not full private excerpts.

## Explicit Old-Chat Search

Do not build a second search system first. Reuse the existing advanced history
search stack:

- `src/main/history/advanced-history-search.ts`
- `src/main/history/transcript-snippet-service.ts`
- `src/main/session/session-recall-service.ts`
- existing IPC handlers for advanced search and snippet expansion

Needed improvements:

- Add a "current project old chats" mode in the renderer if the UI does not
  already expose the right defaults.
- Ensure project filtering uses the same normalized project key as the brief.
- Make expanded snippets easy to open/restore when the user wants the full
  conversation.
- Expose enough provenance for the brief service and UI to share result
  formatting.

## Write-Path Fixes

1. Normalize project keys once.
   - Add a helper such as `normalizeProjectMemoryKey(projectPath)` in a shared
     main/shared utility.
   - Use it in prompt history, history search filters, wake context, and
     conversation mining.

2. Record prompts in main as well as renderer.
   - Renderer recording is useful for UI responsiveness, but the main process
     sees all sends.
   - Avoid double records by deterministic IDs/deduping on instance, timestamp
     window, and text hash.

3. Ensure archived conversation metadata includes project key.
   - Existing history entries have working directory/project fields; verify they
     are written consistently for every provider.

4. Keep transcript mining append-safe and idempotent.
   - This matches mempalace's append/incremental bias and avoids losing prior
     evidence when indexes are rebuilt.

## Implementation Phases

### Phase 1: Normalized project key

- Add the project-key helper.
- Update prompt history lookups to use normalized aliases while preserving
  backward compatibility with raw stored paths.
- Add unit tests for symlinks/trailing slashes/case behavior where the platform
  requires it.

### Phase 2: `ProjectMemoryBriefService`

- Create the service and tests.
- Implement prompt history and archived-history retrievers first.
- Add scoring, dedupe, caps, rendering, and structured sources.
- Mock dependencies in unit tests; do not require real provider CLIs.

### Phase 3: Spawn injection

- Wire the service into `InstanceLifecycleManager.createInstance()`.
- Test fresh depth-0 injection.
- Test child instances and restore/resume paths do not get duplicate startup
  briefs.
- Verify failures are logged and non-fatal.

### Phase 4: Explicit project old-chat search polish

- Reuse advanced history search IPC.
- Add renderer defaults or a dedicated command for "search old chats in this
  project".
- Add tests for current-project filtering and snippet expansion.

### Phase 5: Enrichment

- Fold in conversation-mined verbatim segments, KG facts, and RLM results only
  when source metadata proves same-project scope.
- Add an optional local semantic index if direct search quality is not enough.
- Keep the direct transcript/prompt path as the baseline.

### Phase 6: Controls and maintenance

- Add UI/debug visibility for what was injected.
- Add per-project clear/delete controls if not already available through history
  management.
- Add retention settings and privacy copy before broad auto-injection.

## Tests

Minimum coverage:

- `ProjectMemoryBriefService` returns empty-but-valid text when no history
  exists.
- Same-project old chats are included; other-project chats are excluded.
- Prompt history and transcript duplicates collapse to one item.
- Direct transcript matches outrank wake/KG/mined-only hits.
- Token/character caps are enforced with visible truncation.
- Spawn prompt contains the project brief for fresh depth-0 instances.
- Spawn prompt does not contain the brief for child instances or resume/replay.
- Retrieval failure does not block spawn.

Recommended verification after code changes:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test -- --run <targeted-specs>
```

Run the full suite after multi-file integration work.

## Risks

- Project-key mismatch can leak context between projects or make memory appear
  missing. Treat key normalization as Phase 1, not cleanup.
- Startup injection can become noisy. Keep the brief small and source-weighted.
- Renderer-only prompt history can miss non-UI sends. Fix main-side recording
  before relying on prompt history as complete evidence.
- Provider adapters may differ in how they apply system prompts. Test at least
  one adapter path with captured spawn arguments.
- Summaries can distort old conversations. Prefer verbatim snippets and include
  source pointers.

## Definition of Done

- A fresh depth-0 instance in a project receives a short project memory brief
  assembled by the main process.
- The brief uses direct prompt/transcript evidence first and cites its sources
  internally.
- Old-chat search works for the current project without restoring a provider
  session.
- Tests cover project scoping, ranking, dedupe, caps, spawn injection, and
  failure handling.
- Typecheck, spec typecheck, lint, and relevant tests pass.
