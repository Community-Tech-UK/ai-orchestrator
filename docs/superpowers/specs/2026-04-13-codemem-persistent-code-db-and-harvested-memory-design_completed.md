# Codemem: Persistent Code Database + Harvested Memory + Warm LSP

**Status:** Draft, pending review
**Author:** Claude (opus-4.6), with critique from Gemini (gemini-3-flash-preview); Codex init-stalled
**Date:** 2026-04-13

## Problem

Orchestrated agent children spawn without durable workspace context. Each session rediscovers the repo: LSP tools are loaded on demand and often skipped, `MEMORY.md` contains exactly one line despite weeks of non-trivial work, and the `searching-history.md` reference is never consulted before new tasks. We have all the substrate — RLM (SQLite) with `file_metadata` and `codebase_trees`, `mempalace` episodic outcomes, semantic memory with embeddings, a tree-sitter chunker, a full `lsp-manager.ts` for TS/JS/Py/Go/Rust — but no integration discipline. The gap is behavioral, not architectural.

## Goal

Give every agent spawned by `InstanceLifecycle`:

1. A persistent, incrementally-updated code-structure database that survives product restarts and shares content across git worktrees.
2. Warm LSP access via a reduced, agent-native tool surface.
3. A memory-harvest loop that promotes durable observations only after a verification signal, gated against the LSP graph as the arbiter of truth.

## Non-goals

- Code-chunk embeddings on the hot path. The 2026 consensus (Claude Code native LSP, Sourcegraph Enterprise retreat from embeddings, Cline's no-index stance, Cursor's merkle-of-chunks) is that precise LSP plus content-addressed indexing beats embed-everything. Semantic memory stays available for explicitly fuzzy queries — not as the primary code retrieval layer.
- Cross-workspace observation portability. Each durable observation is scoped to the workspace that produced it. Cross-workspace lessons are a v2 concern.
- Replacement of the existing `mempalace` outcomes table. That layer continues to track task/model/success tuples; codemem adds the prose-observation layer on top.

## Approach

Ship approach "B" — a minimal integration layer under `src/main/codemem/` that reuses existing subsystems, revised for four consensus findings from external critique:

1. Central content-addressable store + per-workspace manifest (not per-workspace DB) — cheap git worktrees and zero duplicate indexing.
2. AST-normalized merkle leaves — Prettier/eslint-format/ruff changes don't invalidate the index.
3. LSP lives in an Electron utility process — no UI jank, survives main-thread reloads.
4. Promotion gate: LSP-consistency is mandatory; plus one positive signal (tests passed, human accepted, or verifier agent sign-off).

## Architecture

New domain: `src/main/codemem/`. Integrates four existing subsystems without replacing them.

```
src/main/codemem/
  code-index-manager.ts     # merkle, fs.watch, tree-sitter writes
  agent-lsp-facade.ts       # Serena-shaped reduced LSP surface
  observation-harvester.ts  # staging → durable, LSP-consistency gate, Memify
  brief-packer.ts           # spawn-time brief assembly
  schema-migrations.ts      # new CAS + manifest + observations tables
  index.ts                  # singleton wiring + getXxx helpers

src/main/lsp-worker/        # new Electron utilityProcess
  worker-main.ts            # hosts existing lsp-manager.ts
  gateway-ipc.ts            # MessageChannelMain to main + children
```

### Component responsibilities

- **CodeIndexManager** — owns the merkle, subscribes to debounced `fs.watch` via chokidar, re-chunks changed files through `tree-sitter-chunker.ts`, writes chunks/symbols/merkle nodes to the central CAS, emits `code-index:changed`.
- **AgentLspFacade** — sits in front of `lsp-worker`, exposes the reduced surface to children via MCP tools `mcp__codemem__*`. Owns token-budget caps, stable `symbol_id` derivation, warming-state passthrough.
- **ObservationHarvester** — receives `codemem.record_observation` calls from agents, tracks staging rows, attaches verification signals, runs the LSP-consistency check, promotes, and executes the nightly Memify pass.
- **BriefPacker** — pure function over `{workspace_hash, task_spec, head_commit, observations_version}`. LRU-cached. Emits the ≤3k-token spawn preamble.

### Storage layout

One central content-addressable SQLite at `~/Library/Application Support/ai-orchestrator/codemem.sqlite` (Darwin path; platform-appropriate user-data dir elsewhere via Electron `app.getPath('userData')`).

**Tables (new):**

- `chunks(content_hash PK, language, ast_normalized_hash, chunk_type, name, signature, doc_comment, symbols_json, imports_json, exports_json, raw_text)` — immutable, content-addressed, shared across all workspaces.
- `merkle_nodes(node_hash PK, kind, children_json)` — content-addressed merkle tree nodes; `kind ∈ {'file','dir','root'}`.
- `workspace_manifest(workspace_hash, path_from_root, content_hash, merkle_leaf_hash, mtime, PRIMARY KEY(workspace_hash, path_from_root))` — per-workspace pointer layer; cheap to clone for a worktree.
- `workspace_root(workspace_hash PK, abs_path, head_commit, primary_language, last_indexed_at, merkle_root_hash, pagerank_json)`. `workspace_hash = SHA-1(abs_path)` at open time; each worktree is its own workspace, but the content-addressed `chunks` table means sibling worktrees share the ~99% of chunks that are identical and pay index-time cost only on the diverging files.
- `observations_staging(id PK, workspace_hash, symbol_ids_json, claim_json, provenance_json, task_id, verification_signal, created_at)`.
- `observations_durable(id PK, workspace_hash, symbol_ids_json, claim_json, confidence REAL, use_count INTEGER, created_at, last_seen_at, supersedes_id)`.

**Tables (extended):**

- `file_metadata` gains `content_hash` and `ast_normalized_hash` columns as foreign keys into `chunks`. Existing fields (language, imports, exports, symbols) become a per-workspace materialized view over the manifest + chunks tables during migration.

Per-workspace bookkeeping: `.ai-orchestrator/workspace-manifest.json` at the workspace root contains only `{workspace_hash, last_indexed_head_commit, schema_version}`. The real manifest lives in the central DB; this file is a breadcrumb so a worktree detaches cleanly and the orchestrator can find its workspace_hash on open.

### Indexer update loop

1. chokidar watch on workspace root; filter through `.gitignore` + default ignores; debounce 150ms per path; coalesce bursts.
2. For each changed file: read, feed to `tree-sitter-chunker`. For each chunk, compute:
   - `content_hash` = SHA-256 of raw bytes.
   - `ast_normalized_hash` = SHA-256 of AST-traversal with `extras` (comments/whitespace trivia) stripped, stable node ordering.
3. Upsert into `chunks` (content-addressed — if hash exists, no write).
4. Compute `merkle_leaf_hash` for the file = SHA-256 of stable-sorted `(ast_normalized_hash, chunk_type, name)` tuples.
5. Walk directory tree up; recompute directory `node_hash` = SHA-256 of stable-sorted child hashes. Stop at first unchanged node.
6. Atomic swap: update `workspace_manifest` row for the path, update affected `merkle_nodes`, update `workspace_root.merkle_root_hash`.
7. Emit `code-index:changed` with the minimal diverging subtree.

**Cold start**: full walk on a worker thread; progress streamed via existing `workspace` IPC channel. Target: ≤60s for a 10k-file repo on dev hardware. Incremental updates are O(changed_files × chunks_per_file).

**fs.watch reliability**: Linux inotify and Docker volumes drop events. Every 10 minutes the indexer samples 100 manifest entries against disk mtime+size; if mismatch rate >5%, trigger a full scan.

### LSP process topology

`lsp-manager.ts` moves behind an Electron `utilityProcess` (`src/main/lsp-worker/worker-main.ts`). Started at app boot; re-started by `SupervisorTree` on crash. Main process and agent children address it via `MessageChannelMain` pairs routed through `agent-lsp-facade.ts`.

**Warm-up contract**: `InstanceLifecycle.spawn()` awaits `lspWorker.ready(workspaceId, primaryLanguage, timeoutMs=15000)`. On timeout, spawn proceeds but facade returns `{status: 'warming', etaMs}` for operations that require a live server. Index-backed operations (symbol lookups) work immediately because they hit the CAS, not the LSP.

**Crash handling**: on utility-process crash, in-flight facade calls return `{status: 'lsp_unavailable'}`; child agents fall back to `read` + `grep`. Supervisor restarts the worker within 500ms on a healthy system.

### Reduced LSP tool surface

Exposed as MCP tools `mcp__codemem__*` via the existing MCP server plumbing:

| Tool | Returns | Caps |
|---|---|---|
| `find_symbol(name, kind?, workspace?)` | `{path, range, kind, container, symbol_id}[]` | 50 results |
| `find_references(symbol_id, limit?)` | `{path, range, snippet}[]` | default 100, max 500 |
| `document_symbols(path)` | hierarchical symbols | unbounded (single file) |
| `workspace_symbols(query, limit?)` | fuzzy match | default 50, max 200 |
| `call_hierarchy(symbol_id, direction, maxDepth?)` | depth-capped paths with cycle detection | maxDepth default 3, hard cap 5; `truncated: true` when hit |
| `find_implementations(symbol_id)` | implementations of interface/abstract | 50 results |
| `hover(symbol_id)` | signature + doc | max 1000 chars |
| `diagnostics(path?)` | error+warning, paginated | page 50 |

**`symbol_id`** = SHA-1 of `{abs_path, kind, name, containerName}`, stable across invocations. Children pass this id back to reference the same symbol across tool calls.

**Explicitly excluded from v1**: `completion`, `code_actions`, `rename`, raw `goto_definition` over positions. These are LSP-orchestration primitives that invite failure without proportionate value.

### Harvest loop

**What gets stored.** Structured claims, not prose paragraphs:

```ts
type SymbolId = string;  // SHA-1 of {abs_path, kind, name, containerName}
type DomainTag = string; // free-form tag like 'ipc-validation', 'session-recovery'

type Claim = {
  kind: 'invariant' | 'gotcha' | 'convention' | 'pattern';
  subject: SymbolId | Path | DomainTag;
  statement: string;          // ≤400 chars
  counterexample?: SymbolId;  // optional pointer to a failure case
};
```

Staging table: `observations_staging(id, workspace_hash, symbol_ids, claim, provenance, task_id, verification_signal, created_at)`. Provenance includes task type, model, files touched, tool-call count.

Durable table: `observations_durable(id, workspace_hash, symbol_ids, claim, confidence, use_count, created_at, last_seen_at, supersedes_id)`.

**Capture.** Single MCP tool `mcp__codemem__record_observation(claim)`. Writes to staging with status `pending`. Orchestrator's `ObservationHarvester.onTaskComplete(taskId, signal)` attaches verification signal to staged rows.

**Promotion gate.** Must pass both:

1. **LSP-consistency check** — for every `symbol_id` in `claim.symbol_ids`, resolve against live LSP. Reject if symbol doesn't exist, or if the claim contradicts LSP-known type info (type checks run for `invariant` and `gotcha` kinds; `convention` and `pattern` kinds only require symbol existence).
2. **One positive verification signal** — any of:
   - `tests_passed = true` at task completion (captured from existing test-runner hooks)
   - Human accepted the change in-session (captured from review-gate events)
   - An orchestrator verifier agent (low-cost model) signed off against a rubric passed at spawn time

Both conditions met → promote to `observations_durable` with initial `confidence = 0.6`. Else staging row expires after 7 days.

**Conflict arbitration (LSP graph as arbiter).** On promote, check durable for claims sharing any `symbol_id` and same `kind`:

| New vs LSP | Old vs LSP | Action |
|---|---|---|
| agrees | agrees, same statement | merge; bump `use_count` on old; discard new |
| agrees | agrees, different statement | keep both — complementary facts |
| agrees | contradicts (graph drifted) | self-edit: new row inserted with `supersedes_id = old.id` and `confidence = 0.7`; old row marked `stale` and removed after 90-day audit window |
| contradicts | agrees | reject new |
| contradicts | contradicts | reject both; mark old `stale` |

No runtime critic agent. If logs show frequent "both agree with LSP but disagree in prose", we add one in v2.

**Forgetting (nightly Memify pass on CAS DB).**

- Decay `confidence *= 0.98` for rows not referenced in last 30 days.
- Delete where `confidence < 0.3 AND use_count == 0` after decay.
- Delete where all `symbol_ids` have been missing from the index for >14 days (dangling).
- Delete rows with `supersedes_id` older than 90 days (audit window passed).

**Retrieval.** BriefPacker queries `observations_durable` filtered by intersection with the task's initial symbol set; ranks by `confidence * recency_weight * log(use_count + 1)`.

### BriefPacker

Called at `InstanceLifecycle.spawn()`. Produces a ≤3k-token preamble prepended to the child's system prompt between the harness preamble and the task itself.

Fixed block order with hard token budgets:

1. **Workspace header** (~100 tokens) — path, primary language, HEAD, branch, AGENTS.md/CLAUDE.md presence flags.
2. **AGENTS.md excerpt** (~400 tokens) — truncated with pointer to `codemem.read_agents_md` for the rest.
3. **Skeleton repo-map** (~1200 tokens) — Aider-PageRank over the merkle, ranked by `centrality * task_relevance`. Centrality pre-computed on workspace and cached in `workspace_root.pagerank_json`; invalidated on merkle-root change. Task-relevance: cosine-similarity between task description and existing semantic-memory embeddings (the one place semantic memory enters the hot path). Format: `path :: Symbol.member(sig) — doc`, collapsed per file.
4. **Known gotchas** (~600 tokens) — up to 10 durable observations whose `symbol_ids` intersect the skeleton, ranked by score from previous paragraph. Format: `[kind]: statement (@symbol_id)`.
5. **Task-slice files** (~700 tokens, optional) — if `spec.taskHints.files` set, inline first N lines; else omit.

**Token accounting** uses the provider-specific tokenizer from `src/main/budget/`. Overflow policy: truncate within a block rather than dropping blocks; never skip block 4 to grow block 3.

**Determinism + cache**: pure over `{workspace_hash, task_description_hash, head_commit, observations_durable_version}`; 5-minute LRU.

**Footer.** Fixed string appended to every brief:

> "The above is a structural snapshot, not source of truth. For anything load-bearing: use `mcp__codemem__find_symbol`, `mcp__codemem__find_references`, or read the file. Observations are confidence-weighted hypotheses, not invariants — verify against current code before acting on them."

This hedge closes the "echo chamber" drift vector.

## Failure modes

| Mode | Mitigation |
|---|---|
| LSP utility-process crash mid-task | Supervisor restart; in-flight calls return `{status: 'lsp_unavailable'}`; agents fall back to read+grep |
| LSP cold-start on huge monorepo | 15s warm-up timeout; spawn proceeds; facade returns `{status: 'warming'}` until ready |
| fs.watch drops events | Periodic 10min manifest-vs-disk sample; full scan when mismatch rate >5% |
| Merkle collision across workspaces | Keys include `(content_hash, language_version)` |
| Observations table unbounded growth | Nightly Memify + 7-day staging TTL; alert at 10k durable rows per workspace |
| Manifest drift from files (crash mid-update) | SQLite WAL + atomic swap; boot-time 100-entry sample; full rebuild at >5% mismatch |
| Observation on deleted symbol | Dangling sweep deletes after 14-day grace |
| Central CAS DB corruption | WAL mode; nightly `PRAGMA integrity_check`; re-index from source on failure (source is authoritative) |

## Testing (Vitest, per AGENTS.md conventions)

- **Unit**: `CodeIndexManager`, `AgentLspFacade`, `ObservationHarvester`, `BriefPacker`. Use `_resetForTesting()` per singleton convention.
- **Integration** against `test/fixtures/codemem-sample/`:
  - Cold index → expected merkle root.
  - Edit single file → only the affected subtree is touched in the manifest.
  - Prettier-only change → merkle root unchanged (AST-normalized hash absorbs whitespace).
  - Rename symbol → old symbol marked stale; observations referencing it rejected at next promote.
- **End-to-end**: spawn a mock child via existing test harness; assert brief matches shape + budget; record observation; verify gate path both ways; verify next spawn's brief includes promoted durable.
- **Soak**: 10k synthetic file-change events — verify debounce behavior, memory stability, no missed updates.

## Rollout

Three phases, each gated by a settings-surface feature flag. Disabling falls back cleanly to current behavior.

**Phase 1 — Index + LSP facade only.** Ship CAS, merkle, fs.watch, LSP utility process, AgentLspFacade. Observations and BriefPacker disabled. Gate: integration tests green; rust-analyzer warm-up measured <60s on a reference Rust repo.

**Phase 2 — BriefPacker without observations.** Skeleton + AGENTS.md excerpt + task-slice. Observations block empty. Measure: first-N-tool-call count per spawned child vs. Phase 1 (expect ≥30% reduction for navigation-heavy tasks).

**Phase 3 — Harvest loop.** Enable `record_observation`, LSP-consistency gate, promotion, Memify. Dark-launch: write to staging but do not promote for 1 week; audit staged rows by hand; tune the LSP-consistency checker against real data. Then enable promotion.

## Open questions

- Does `lsp-worker` utility process need OS-level resource limits (rlimit) to keep rust-analyzer from OOMing on huge repos, or is delegating to the language server's own limits sufficient? Will measure in Phase 1 before deciding.
- Is `.ai-orchestrator/workspace-manifest.json` the right breadcrumb format, or should we rely purely on git config / workspace hash derived from abs_path? Revisit if users report worktree confusion.
- Should `verifier agent sign-off` as a positive signal be optional per-workspace (some repos lack tests)? Default on; settings-surface toggle.

## References

- [Cursor merkle-of-chunks](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast)
- [Aider PageRank repo-map](https://aider.chat/2023/10/22/repomap.html)
- [Serena MCP reference for LSP-as-tool](https://github.com/oraios/serena)
- [Mem0 production paper — self-edit on conflict](https://arxiv.org/html/2504.19413v1)
- [Cognee Memify pattern — usage-weighted pruning](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory)
- [Why AI Agents Break — Arize on memory corruption cascades](https://arize.com/blog/common-ai-agent-failures/)
- [Why Cline doesn't index](https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing)
- [Sourcegraph Cody — embeddings retreat on Enterprise](https://sourcegraph.com/docs/cody/faq)
