# AI Orchestrator — Second-Pass Improvement Recommendations (Claude)

A second, complementary deep-dive after revisiting `ai-orchestrator/` and the
**broader** peer set in this workspace — including projects the first review
(`claude.md`) did not cover in depth: **CodePilot**, **CodexDesktop-Rebuild**,
**OB1**, **online-orchestrator**, **oh-my-codex**, **codex-plugin-cc**,
**storybloq**, **rtk** (deeper than Phase 0/1 integration), **claude-code**
(Anthropic's reference plugins), **copilot-sdk** (GitHub's typed RPC client),
**mempalace-reference**, plus a fresh pass over **hermes-agent**, **nanoclaw**,
and **claw-code** for patterns the first review missed.

The first review (`claude.md`) is right about the **structural** opportunities
(oxlint, Turborepo, tsgo, daemon split, Effect-TS at narrow seams, plugin-SDK
barrels, OpenAPI generation, import-boundary enforcement). This document does
**not** restate those — read it first. Instead, this document focuses on
**feature-level, pattern-level, and code-level** borrowings:

- New durability patterns (durable approvals, write-ahead logs, two-DB splits)
- Memory-system patterns AI-Orchestrator's `src/main/memory/` doesn't yet have
  (temporal knowledge graph, tiered wake-up, hybrid BM25+vector, AAAK index)
- Plugin/skill primitives proven by `claude-code` and `copilot-sdk`
- Diagnostic & self-healing patterns from `CodePilot`'s Provider Doctor
- Subprocess isolation, hook deduplication, and job persistence from `oh-my-codex`
- Testing discipline from `rtk` (snapshot tests + token-savings gates)
- Configuration hierarchies and credential-vault choices from `claw-code`/`nanoclaw`

References use `<project>:<path>` so each can be opened directly.

---

## TL;DR — What to add to the backlog

| # | Improvement | Source pattern | Effort | Risk | Payoff |
|---|-------------|----------------|--------|------|--------|
| 1 | **Durable approval state** in SQLite (not in-memory `permission-registry`) | `nanoclaw:src/modules/approvals/onecli-approvals.ts` | S | Low | Survives crashes; cross-window approval; audit trail |
| 2 | **Provider Doctor**: 5-probe diagnosis + structured repair actions | `CodePilot:src/lib/provider-doctor.ts` | M | Low | One-click "fix my Codex auth"; reduces "why doesn't this work" tickets |
| 3 | **Error Classifier**: 20+ category taxonomy with retryable/recoveryActions | `CodePilot:src/lib/error-classifier.ts` | S | Low | UI surfaces actionable errors instead of raw stderr |
| 4 | **Subprocess-isolated plugins** with timeout + SIGKILL grace | `oh-my-codex:src/hooks/extensibility/dispatcher.ts` | M | Med | A misbehaving plugin can't crash the daemon |
| 5 | **Job persistence** for long tasks (`.plugin-state/jobs.jsonl`) | `codex-plugin-cc:scripts/lib/job-control.mjs` | S | Low | `/orchestration status` works hours later, after restart |
| 6 | **Snapshot testing** (`vitest --update-snapshots`) for IPC payloads + adapter event streams | `rtk:tests/fixtures/*` + `insta` discipline | S | Low | Catch envelope-shape regressions early |
| 7 | **Markdown-first command/skill specs** (frontmatter + prose, not TS classes) | `claude-code:plugins/*/commands/*.md` | M | Low | Versionable, user-editable, AI-readable orchestration patterns |
| 8 | **Typed hook callbacks** with structured `PermissionDecision` results | `copilot-sdk:src/types.ts` | S | Low | Replaces EventEmitter + boolean returns with type-safe results |
| 9 | **`systemMessage.customize` mode**: replace `tone` only, keep `safety` | `copilot-sdk:src/types.ts:724-779` | S | Low | Debate agents can tweak voice without breaking safety guardrails |
| 10 | **Temporal knowledge graph** (validity ranges, as-of queries) | `mempalace-reference:knowledge_graph.py` | M | Low | Memory knows when facts were true; doom-loop detector can ask as-of |
| 11 | **Tiered memory wake-up** (L0 identity / L1 essential / L2 on-demand / L3 deep) | `mempalace-reference:layers.py` | M | Low | Spawn cost <1k tokens instead of dumping all memory in |
| 12 | **Hybrid BM25 + vector search** (not vector-only) | `mempalace-reference:searcher.py` | S | Low | Keyword-heavy queries ("last AWS pricing decision") work |
| 13 | **Write-ahead log** for orchestration mutations | `mempalace-reference:mcp_server.py:170-195` | S | Low | Rollback + audit; helps post-mortem doom loops |
| 14 | **Two-DB session split** for container/host isolation | `nanoclaw:src/session-manager.ts` | L | Med | Eliminates IPC; offline container ops; survives host crash |
| 15 | **Custom 65-line structured logger** (drop log4js) | `nanoclaw:src/log.ts` | S | Low | Fewer deps; matches the simpler peers |
| 16 | **Config source hierarchy** (`User → Project → Local` + env override) | `claw-code:rust/crates/runtime/src/config.rs:14-68` | S | Low | Documented precedence beats scattered env vars |
| 17 | **Mock parity test harness** for provider integration tests | `claw-code:rust/crates/compat-harness/` | M | Low | Stops burning tokens on flaky API-dependent tests |
| 18 | **Bridge subsystem** for IM channels (Telegram / Discord / Slack / WhatsApp) | `CodePilot:src/lib/bridge/` + `nanoclaw` adapters | L | Med | Headless agents reachable from phone; matches the 50+ `add-*` skills here |
| 19 | **Markdown IR for output formatting** (parse once, render per platform) | `CodePilot:src/lib/bridge/markdown/ir.ts` | S | Low | Same agent output to renderer + Slack + Telegram without duplication |
| 20 | **AST-based tool registry discovery** (replace static factory list) | `hermes-agent:tools/registry.py:42-74` | S | Low | New providers/tools self-register; no central allowlist |
| 21 | **Lazy-loaded heavy deps** (proxy pattern) | `hermes-agent:run_agent.py:74-99` | S | Low | Faster cold-start for daemon mode |
| 22 | **Tool-execution thread pool** w/ runtime resize | `hermes-agent:environments/agent_loop.py:26-47` | S | Low | Avoids supervisor starvation under N-parallel debate runs |
| 23 | **Storybloq-style `.story/` project memory + handovers** | `storybloq:src/core/project-loader.ts` + `src/autonomous/session.ts` | M | Low | Long-running multi-day orchestrations have continuity beyond logs |
| 24 | **Hook lifecycle deduplication** (event fingerprint cache) | `oh-my-codex:src/notifications/lifecycle-dedupe.ts` | S | Low | Multi-provider events don't double-fire SessionStart-style hooks |
| 25 | **Heartbeat-based subprocess health polling** | `oh-my-codex:src/team/runtime.ts` | S | Med | Detects zombie CLI processes faster than waitpid+timeout |
| 26 | **Plain-text skill packs** (markdown + frontmatter + auto-loaded) | `claude-code:plugins/*/skills/*.md` + `OB1:skills/` | S | Low | Skills become user-extendable without rebuilding |
| 27 | **Automated agent-PR-review** for plugin/skill contributions | `OB1:.github/workflows/ob1-review.yml` | M | Low | Manifest schema + secret-leak + structure validation gates |
| 28 | **Performance benchmarking as CI gate** (`hyperfine`-style) | `rtk:CLAUDE.md` testing strategy | S | Low | Catch supervisor/IPC latency regressions before they ship |
| 29 | **Stream preview throttle + degradation** (auto-stop after N failures) | `CodePilot:src/lib/bridge/bridge-manager.ts:74-95` | S | Low | Prevents cascading retries on a permanently-broken provider |
| 30 | **MCP-as-public-API** (Hono + Zod tools) for headless mode | `OB1:extensions/household-knowledge/index.ts` | M | Med | Future `apps/server` exposes orchestrator as MCP server |

---

## 1. Memory & Continuity — borrow from `mempalace-reference` and `storybloq`

ai-orchestrator's memory subsystem (`src/main/memory/` with `learning-events`,
`memory-host`, `codemem`) is solid but flat. Two sibling projects model memory
differently — and better — for an agent that needs to remember decisions
across days/weeks of orchestration.

### 1.1 Temporal knowledge graph (mempalace)

**Source:** `mempalace-reference:mempalace/knowledge_graph.py:50-150`

mempalace stores facts as triples with `valid_from` / `valid_to` ranges in
SQLite (WAL mode). Queries can ask *"what was true as_of=2026-01-15?"*. This
is exactly what ai-orchestrator's `doom-loop-detector.ts` and
`debate-coordinator.ts` need: when they re-engage a stale debate, they should
not see today's facts as the original premise.

**Schema sketch:**

```sql
CREATE TABLE kg_triples (
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  valid_from TEXT NOT NULL,        -- ISO-8601
  valid_to TEXT,                    -- NULL = still valid
  source_drawer_id TEXT,
  source_run_id TEXT,
  confidence REAL,
  PRIMARY KEY (subject, predicate, object, valid_from)
);
CREATE INDEX kg_subject_time ON kg_triples (subject, valid_from);
```

**Where it slots into ai-orchestrator:**
- `src/main/memory/learning-events.ts` becomes a writer that emits triples
  alongside (not instead of) its current events.
- `src/main/orchestration/debate-coordinator.ts:resumeRound()` queries
  `kg_query_entity(entity, as_of=run.started_at)`.
- `src/main/observation/` gains a "facts that changed mid-run" alert.

### 1.2 Tiered memory wake-up (mempalace L0–L3)

**Source:** `mempalace-reference:mempalace/layers.py:1-100`

Each layer is a class with `render()` and `token_estimate()`. L0+L1 are always
loaded (~600–900 tokens combined); L2 is loaded only when a topic surfaces;
L3 is full semantic search. The agent never wakes up with all memory dumped
in.

**ai-orchestrator translation:**

```ts
// src/main/memory/layers/index.ts
export interface MemoryLayer {
  readonly id: 'L0_identity' | 'L1_essential' | 'L2_on_demand' | 'L3_deep';
  render(ctx: WakeContext): Promise<string>;
  estimateTokens(): number;
}

// L0: workspace identity — loaded always, ~100 tokens
// L1: top-15 high-weight recent decisions — loaded always, 500–800 tokens
// L2: room-specific recall on topic match — loaded on demand
// L3: full ChromaDB / better-sqlite3 FTS5 search — never loaded eagerly
```

The current pattern (load all `learning-events` for a workspace) wastes
context. A typical Claude debate burns ~3k tokens to "remember" what's
trivially recoverable on demand.

### 1.3 Hybrid BM25 + vector search

**Source:** `mempalace-reference:mempalace/searcher.py:60-100`

mempalace runs Okapi-BM25 over the candidate set returned by vector search and
re-ranks. ai-orchestrator's memory queries are likely vector-only (or worse,
substring). For queries like "the AWS pricing decision from last sprint",
keyword matching finds it; semantic search misses it.

`better-sqlite3` already supports FTS5. Adding a `documents_fts5` virtual
table next to the vector store is a 30-line patch with no new dependency.

### 1.4 Write-ahead log for orchestration mutations

**Source:** `mempalace-reference:mempalace/mcp_server.py:170-195`

mempalace logs every write to a JSONL WAL **before** execution, with sensitive
keys (content, query, text) redacted. This gives:
- Rollback capability on crash mid-write
- An audit trail for every fact change
- A debugging tool for "why did the agent decide X?"

ai-orchestrator's `debate-coordinator.ts` already runs many parallel writes
(per-round verdicts, consensus snapshots, retry decisions). A WAL at
`~/Library/Application Support/ai-orchestrator/wal/<date>.jsonl` would
make post-mortem analysis 10× easier.

### 1.5 `.story/` project memory + handovers (storybloq)

**Source:** `storybloq:src/core/project-loader.ts`, `storybloq:src/autonomous/session.ts`

storybloq persists project state in a tracked `.story/` directory:
- `tickets/`, `issues/`, `phases/`, `lessons/`, `roadmap.md` — plain JSON/MD
- `handovers/YYYY-MM-DD-<slug>.md` — markdown summaries with structured
  metadata (decisions, blockers, next steps)

When a new orchestration run starts, storybloq reads handovers + open tickets
and seeds the agent's context. This is exactly the pattern ai-orchestrator
needs for **multi-day** orchestrations: the loop-mode runs that span hours,
the debate clusters that get paused and resumed.

**Plan:**
1. Add `src/main/continuity/` reading `<workspace>/.ai-orchestrator/state/`
2. Persist `tickets.json` (per-run goals), `lessons.jsonl` (what worked / what
   didn't), `handovers/<run-id>.md` (LLM-generated summary at run end)
3. Surface in renderer at instance boot: "Here's what the previous run did"

### 1.6 Eager derived-data construction (storybloq pattern)

**Source:** `storybloq:src/core/project-state.ts:52-100+`

`ProjectState` constructor performs 7 eager derivations once: umbrella IDs,
leaf tickets, phase grouping, reverse-blocking maps. Subsequent queries are
O(1) map lookups. ai-orchestrator's `src/main/orchestration/` recomputes
similar reductions on each render tick — moving them into the constructor
of an orchestration-run snapshot would cut renderer CPU.

### 1.7 Best-effort loading with structured warnings

**Source:** `storybloq:src/core/project-loader.ts`

`loadProject()` distinguishes critical files (config, roadmap → throw on error)
from best-effort files (tickets, issues → skip corrupt entries, return
warnings). The return type is `{ state, warnings: LoadWarning[] }`, never
just `state`.

ai-orchestrator's IPC reads currently throw or silently swallow. A
`LoadResult<T>` shape with non-fatal warnings would let the renderer surface
"3 chats failed to load (corrupt JSON)" without crashing the whole list.

---

## 2. Plugin / Skill System Maturation

ai-orchestrator has `packages/sdk/src/plugins.ts` with `PluginManifest` and
`PluginSlot`, but the surface is small and the contract isn't enforced. Three
peer projects show what a mature plugin system looks like.

### 2.1 Markdown-first command/skill specs (claude-code)

**Source:** `claude-code:plugins/{plugin-name}/commands/*.md`,
`plugins/{plugin-name}/agents/*.md`, `plugins/{plugin-name}/skills/*.md`

Anthropic's own Claude Code reference uses markdown frontmatter + prose for
agents, commands, and skills. Example agent:

```markdown
---
name: code-architect
description: Architect for design decisions and refactoring plans
tools: [Read, Grep, Glob]
model: opus
color: purple
---

# Code Architect

You design clean, maintainable systems… (prose continues)
```

**Why this beats TS classes:**
- Versionable — diffs are readable
- User-editable without rebuild
- The LLM can read its own definition (recursive bootstrapping)
- Skills can be shared as gists

**Translation for ai-orchestrator:**

Migrate `src/main/orchestration/debate-coordinator.ts` from:
- A 600-line TS class with hard-coded prompts
- Into: `src/main/orchestration/patterns/debate.md` + a 50-line runtime that
  reads the markdown and executes the declared workflow

`src/main/skills/builtin/<skill>/SKILL.md` already exists — extend the same
pattern to **orchestration patterns** themselves.

### 2.2 Subprocess isolation for plugins (oh-my-codex)

**Source:** `oh-my-codex:src/hooks/extensibility/dispatcher.ts:60-120`

OMX runs hook plugins in isolated subprocesses (`spawn(process.execPath, [runnerPath])`)
with timeout + SIGKILL grace period. Stdout/stderr captured; results parsed
via a `__OMX_PLUGIN_RESULT__` line marker. A hung plugin can't block the
orchestrator.

ai-orchestrator's plugins run in-process today (`packages/sdk/src/plugins.ts`).
A misbehaving plugin can crash the Electron main process. Subprocess isolation
trades a small startup cost for crash-safety.

**Plan:**
- Add `src/main/plugins/runner.ts` that `spawn`s a Node subprocess per plugin
  invocation
- Define a stdio protocol: JSON-RPC over stdin/stdout
- Default timeout 30s, SIGKILL grace 250ms (matches OMX `RUNNER_SIGKILL_GRACE_MS`)
- For trusted first-party plugins, allow `inProcess: true` opt-in

### 2.3 Hook lifecycle deduplication (oh-my-codex)

**Source:** `oh-my-codex:src/notifications/lifecycle-dedupe.ts` + dispatcher

Broadcast hooks (SessionStart, SessionEnd) compute a fingerprint per event.
Duplicates within a window are suppressed. Prevents the "5 providers all
fired SessionStart, the user got 5 notifications" bug.

ai-orchestrator's multi-provider event stream has the same risk. Add a
fingerprint cache keyed by `(eventType, instanceId, runId, deduplicationKey)`
in `src/main/orchestration/event-router.ts`.

### 2.4 Job persistence (`.plugin-state/jobs.jsonl`)

**Source:** `codex-plugin-cc:scripts/lib/job-control.mjs`

Codex plugin writes background-task metadata to an append-only JSONL file
(`{ task_id, started_at, git_state, model, prompt, status, output_path }`).
`/codex:status` queries it; `/codex:result <task_id>` reads it. Works hours
later. Survives Claude Code restart.

ai-orchestrator's loop-mode runs are similar — they can run for hours. Today
state is in-memory (RxJS Subjects). After daemon mode (CLAUDE.md §6),
persistent jobs become essential.

**Plan:**
- `~/Library/Application Support/ai-orchestrator/jobs/<run-id>.jsonl`
- One JSON line per status transition: started, claimed, ran-step, completed,
  failed, retried
- Add `src/main/api/jobs.ts` exposing `list()`, `get(id)`, `tail(id)`

### 2.5 Markdown command + skill specs from `OB1`

**Source:** `OB1:skills/auto-capture/SKILL.md`, `OB1:extensions/household-knowledge/`

OB1's pattern adds two layers ai-orchestrator should adopt:

1. **`metadata.json` per plugin** — author, version, requirements, learning
   order, difficulty, estimated time. This is the contract validated at
   registration.
2. **Per-plugin `schema.sql`** — extension can declare its own SQLite tables
   that get created at install time, isolated under a namespace.

**Plan:** add `manifest.json` (Zod-validated) to plugin SDK; deny registration
on validation failure with a structured error.

### 2.6 Automated agent-based PR review (OB1)

**Source:** `OB1:.github/workflows/ob1-review.yml`

OB1 runs Claude in CI on contributor PRs to validate:
- Manifest schema correctness
- No leaked credentials/secrets
- SQL safety (no obvious injection)
- Documentation quality
- Required structure (README + metadata + index file)

For ai-orchestrator's future plugin marketplace, this is the gating policy.
Even today, it would catch missing IPC channel definitions and untyped
contracts.

---

## 3. Provider/Adapter Refinements

The first review (`claude.md` §3) covered the `BaseProvider` deduplication,
config-decode-at-registry, and `supportsMultipleInstances` metadata. Three
more refinements:

### 3.1 Typed hook callbacks (copilot-sdk)

**Source:** `copilot-sdk:src/types.ts:979-1000+`

```typescript
hooks?: {
  onPreToolUse?: (input: PreToolUseHookInput) => Promise<{
    permissionDecision?: 'allow' | 'deny' | 'ask';
    modifiedArgs?: unknown;
    additionalContext?: string;
  }>;
  onPostToolUse?: (input: PostToolUseHookInput) => Promise<{...}>;
  onUserPromptSubmitted?: (input: UserPromptSubmittedHookInput) => Promise<{...}>;
  // ... 5 more hooks
}
```

Each hook returns a structured object — not a boolean — so the runtime can
distinguish "deny" vs "ask" vs "allow with modification". ai-orchestrator's
`permission-registry.ts` returns booleans; the renderer has no way to
surface "agent wants to modify your tool args before running".

### 3.2 Permission handler with structured result kinds

**Source:** `copilot-sdk:src/types.ts:784-804`

Request kinds: `'shell' | 'write' | 'read' | 'mcp' | 'custom-tool' | 'url' | 'memory' | 'hook'`
Result kinds: `'approved' | 'denied-interactively-by-user' | 'denied-by-rules' | 'allowed-by-rules' | 'pending'`

The `denied-by-rules` vs `denied-interactively-by-user` distinction is
important: it lets the agent learn (this kind of action is always blocked
here, don't ask again) without re-prompting.

### 3.3 `systemMessage.customize` mode

**Source:** `copilot-sdk:src/types.ts:724-779`

```typescript
systemMessage?: {
  mode: 'append' | 'replace' | 'customize',
  sections?: {
    tone?: { action: 'replace' | 'append' | 'prepend' | 'remove'; content?: string };
    safety?: { action: ... };
    code_change_rules?: ...;
  }
}
```

Sections are named (`identity`, `tone`, `safety`, `code_change_rules`).
ai-orchestrator's debate coordinators currently override the entire system
prompt — losing the safety guardrails. Section-level overrides let:
- Adversarial debate agent: override `tone` only ("be skeptical, not deferential")
- Code-review subagent: override `code_change_rules` only
- Safety guardrails always preserved

### 3.4 Tool definition with built-in Zod + `skipPermission`

**Source:** `copilot-sdk:src/types.ts:379-410`

```typescript
defineTool<T>('name', {
  parameters: z.object({...}),
  handler: async (args: T) => {...},
  skipPermission?: true,  // safe read-only tools
})
```

`@ai-orchestrator/sdk/tools.ts` defines the tool surface but doesn't have a
`skipPermission` flag. Read-only tools (e.g., `get_workspace_status`) re-prompt
unnecessarily today. Adding the flag is a one-line interface change.

### 3.5 AST-based tool registry discovery (hermes-agent)

**Source:** `hermes-agent:tools/registry.py:42-74`

hermes-agent scans `tools/` via AST to find modules with top-level
`registry.register(...)` calls. New tools self-register; no central allowlist
to update. The AST scan avoids the import-side-effect problem (can't check
"does this module register" without importing it, which executes
registration).

ai-orchestrator's `src/main/providers/register-built-in-providers.ts` is a
hand-maintained list. Adding a provider means editing two files. AST-based
discovery lets `extensions/<provider>/index.ts` self-register.

### 3.6 Lazy-loaded heavy deps (hermes-agent)

**Source:** `hermes-agent:run_agent.py:74-99`

```python
class _OpenAIProxy:
    def __call__(self, *args, **kwargs):
        from openai import OpenAI       # deferred import
        return OpenAI(*args, **kwargs)
    def __instancecheck__(self, instance):
        from openai import OpenAI
        return isinstance(instance, OpenAI)

OpenAI = _OpenAIProxy()
```

Saves ~240ms cold-start per import. ai-orchestrator's main process imports
**every** provider's SDK (Anthropic, OpenAI, Google, etc.) eagerly via
`register-built-in-providers.ts`. A proxy pattern would defer the SDK import
until the provider is actually instantiated.

---

## 4. Bridge / Multi-Channel Output

The current renderer is the only output surface. CodePilot ships a full IM
bridge subsystem; the `add-*` skills in this workspace (telegram, slack,
discord, whatsapp, signal, gchat, gmail, linear, x, webex, gchat, deltachat,
emacs, github) reveal how much of this peer ecosystem is built around remote
operation. ai-orchestrator's current approach is renderer-or-nothing.

### 4.1 BaseChannelAdapter pattern (CodePilot)

**Source:** `CodePilot:src/lib/bridge/channel-adapter.ts:16-123`

```typescript
abstract class BaseChannelAdapter {
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;
  // optional
  answerCallback?(callbackId: string, answer: 'allow' | 'deny'): Promise<void>;
  streamPreview?(draftId: string, content: string): Promise<void>;
}

registerAdapterFactory(channelType: 'telegram', () => new TelegramAdapter());
```

Per-channel registration via side-effect imports. `bridge-manager.ts` knows
about the registry, not the adapters.

### 4.2 Markdown intermediate representation (CodePilot)

**Source:** `CodePilot:src/lib/bridge/markdown/ir.ts`

Parse model output to a platform-agnostic IR once, then render per platform:

```typescript
interface MarkdownIR {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
}

renderToTelegramHTML(ir: MarkdownIR): string;
renderToDiscordMarkdown(ir: MarkdownIR): string;
renderToFeishuCard(ir: MarkdownIR): FeishuCard;
```

ai-orchestrator's renderer formats provider output in
`src/renderer/app/features/instance-detail/output-stream/`. If the same
output ever needs to go to Slack or Telegram (and per the `add-*` skills,
that's the obvious direction), an IR layer prevents per-channel formatting
divergence.

### 4.3 Stream preview throttle + degradation (CodePilot)

**Source:** `CodePilot:src/lib/bridge/bridge-manager.ts:74-95`

Streaming previews use:
- Throttle timer (don't emit faster than 200ms)
- Min-delta threshold (don't emit if <10 new chars)
- **Auto-degrade** after permanent failure: `state.degraded = true` stops
  preview emission for that draft, preventing cascading retries

ai-orchestrator's RxJS provider stream already throttles. The degradation
flag is missing — a permanently-broken provider connection emits failed
previews forever.

### 4.4 Deferred offset acknowledgement (CodePilot)

**Source:** `CodePilot:src/lib/bridge/CLAUDE.md` (line 9)

Adapter offsets split into `fetchOffset` (advance on poll) and
`committedOffset` (advance only after successful local handling). Crash
between fetch and commit → reprocess. Crash after commit → no duplicate.

ai-orchestrator's IPC sequence numbers exist (`provider-runtime-events`)
but the commit-after-handling discipline isn't codified. A `commit(seq)` call
in `instance-communication.ts` would make idempotency explicit.

### 4.5 Per-chat rate limiting (CodePilot)

**Source:** `CodePilot:src/lib/bridge/security/rate-limiter.ts`

Per-channel buckets (20 messages/minute per chat, not global). Auto-cleanup
every 5 minutes. ai-orchestrator's failover-manager has global rate limiting;
a per-instance bucket would prevent one rogue agent from starving others.

---

## 5. Subprocess & Resource Management

ai-orchestrator already has `process/` (Supervisor, PoolManager, LoadBalancer,
HibernationManager) — sophisticated. Three patterns from peers that fit
within the existing structure:

### 5.1 Heartbeat-based subprocess health polling (oh-my-codex)

**Source:** `oh-my-codex:src/team/runtime.ts` + `tmux-session.ts`

OMX workers write a heartbeat file (`.omx/team/<name>/workers/<id>/heartbeat`)
on each task claim. The supervisor polls; stale heartbeat → declare worker
dead, reap, respawn. Faster than `waitpid()` + timeout because it detects
**hung** processes (alive but not making progress), not just dead ones.

ai-orchestrator's CLI subprocesses (claude-cli, codex-cli, gemini-cli) can
hang waiting for a missing dependency, an unresolved prompt, etc. A heartbeat
discipline would cut "why is my run stuck for 10 minutes" cases.

### 5.2 Tool execution thread pool with runtime resize (hermes-agent)

**Source:** `hermes-agent:environments/agent_loop.py:26-47`

```python
_tool_executor = ThreadPoolExecutor(max_workers=128)

def resize_tool_pool(max_workers: int):
    global _tool_executor
    _tool_executor.shutdown(wait=False)
    _tool_executor = ThreadPoolExecutor(max_workers=max_workers)
```

Solves a specific deadlock: sync tools that internally call `asyncio.run()`
must run in clean event loops. ai-orchestrator's analog: orchestration runs
that spawn N parallel debate agents can starve when N exceeds the default
event loop concurrency. A configurable, runtime-resizable pool gives the
operator a dial.

### 5.3 Subprocess lifecycle guards (oh-my-codex)

**Source:** `oh-my-codex:src/team/runtime.ts:1-80`

```typescript
async function buildWorker(spec) {
  const proc = spawn(...spec, { stdio: ['pipe', 'pipe', 'pipe'] });
  await waitForWorkerReady(proc, { timeout: 30_000 });
  await dismissTrustPromptIfPresent(proc);  // detect & answer first-run prompts
  registerCleanup(proc, teardownWorkerPanes);
  return proc;
}
```

Three guards ai-orchestrator's `cli/adapters/*.ts` could adopt:
1. **Ready-marker wait** — don't return from `start()` until child writes
   a known marker
2. **Trust-prompt dismissal** — first-run CLI prompts (`Trust this directory?`
   `Send telemetry?`) handled programmatically
3. **Explicit cleanup registry** — prevents zombie processes on crash

---

## 6. Approval & Permission Maturity

### 6.1 Durable approval state (nanoclaw)

**Source:** `nanoclaw:src/modules/approvals/onecli-approvals.ts`,
`nanoclaw:src/modules/permissions/sender-approval.ts`,
`nanoclaw:src/db/migrations/011-pending-sender-approvals.ts`

Schema:

```sql
CREATE TABLE pending_approvals (
  approval_id TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,        -- 'shell' | 'write' | 'mcp' | …
  payload_json TEXT NOT NULL,
  card_metadata TEXT,                -- DM card sent to admin
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,              -- 'pending' | 'approved' | 'denied' | 'expired'
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Startup sweep:
DELETE FROM pending_approvals WHERE expires_at < strftime('%s', 'now') AND status = 'pending';
-- Logged to audit table.
```

ai-orchestrator's `permission-registry.ts` is in-memory. If the user
approves a `shell` request and the main process crashes before the tool
executes, the approval is lost. Durable approvals also enable:
- Cross-window approval (approve from a different Electron window)
- Cross-machine approval (after daemon split, approve from CLI on phone)
- Audit trail ("who approved this rm -rf at 2am?")

### 6.2 Unknown-sender deduplication (nanoclaw)

**Source:** `nanoclaw:src/modules/permissions/sender-approval.ts:54-100`

```sql
UNIQUE (messaging_group_id, sender_identity)
```

When a new sender appears, dedup prevents the admin from seeing 50 approval
prompts for 50 messages. On approve, the original message is re-routed.

ai-orchestrator's analog: when a CLI plugin makes its first MCP call, the
"approve this MCP server" prompt should fire once, not per call. Unique
constraint on `(workspace_id, mcp_server_id, action_kind)` is the equivalent.

### 6.3 OneCLI credential vault pattern (nanoclaw)

The first review mentioned this; the concrete shape is worth quoting:

**Architecture:**
- Server-side gateway holds credentialed requests
- Host-side receives `pending_approvals` callback, routes via DM card
- Persisted, with expiry
- API requests at the agent boundary inject real tokens at the last moment;
  raw secrets never enter the agent process

ai-orchestrator's `secret-storage.ts` (using Electron `safeStorage`) is fine
for desktop. For headless mode (per CLAUDE.md §6), this gateway pattern
becomes essential: secrets don't live in env vars or process memory.

---

## 7. Diagnostics & Self-Healing — borrow CodePilot's Provider Doctor

This is the highest-leverage borrowing in this entire document. ai-orchestrator
has a `diagnostics/` directory but no comparable Doctor.

### 7.1 Provider Doctor (CodePilot)

**Source:** `CodePilot:src/lib/provider-doctor.ts:39-80`

Public interface:

```typescript
type Severity = 'ok' | 'warn' | 'error';

interface Finding {
  severity: Severity;
  code: string;                 // 'cli.not-found', 'auth.expired', etc.
  message: string;
  detail?: string;
  repairActions?: Array<{
    id: string;
    label: string;              // user-visible button label
    description: string;
    params?: Record<string, string>;
  }>;
}

interface DiagnosisResult {
  overallSeverity: Severity;
  probes: ProbeResult[];        // 5 probes: cli, auth, provider, endpoint, mcp
  repairs: RepairAction[];
  timestamp: string;
  durationMs: number;
}

type RepairActionType =
  | 'set-default-provider'
  | 'apply-provider-to-session'
  | 'clear-stale-resume'
  | 'switch-auth-style'
  | 'reimport-env-config';
```

5 diagnostic probes run in parallel. Each returns findings with attached
repair actions. UI surfaces "Run Doctor" → list of findings → one-click
repair buttons.

**Plan for ai-orchestrator:**
1. Add `src/main/diagnostics/provider-doctor.ts` with probes for each
   provider (claude-cli, codex-cli, gemini-cli, copilot-cli, anthropic-api).
2. Each probe returns `Finding[]`.
3. Repair actions wired through the existing IPC layer
4. Renderer surfaces in Settings → Doctor tab (already exists per the
   inventory: `src/renderer/app/features/settings/doctor-tab/`).

### 7.2 Error Classifier (CodePilot)

**Source:** `CodePilot:src/lib/error-classifier.ts:56-150`

20+ category taxonomy:

```typescript
type ClaudeErrorCategory =
  | 'CLI_NOT_FOUND' | 'NO_CREDENTIALS' | 'AUTH_REJECTED' | 'AUTH_FORBIDDEN'
  | 'AUTH_STYLE_MISMATCH' | 'RATE_LIMITED' | 'NETWORK_UNREACHABLE'
  | 'ENDPOINT_NOT_FOUND' | 'MODEL_NOT_AVAILABLE' | 'CONTEXT_TOO_LONG'
  | 'UNSUPPORTED_FEATURE' | 'CLI_VERSION_TOO_OLD' | 'CLI_INSTALL_CONFLICT'
  | 'MISSING_GIT_BASH' | 'RESUME_FAILED' | 'SESSION_STATE_ERROR'
  | 'PROVIDER_NOT_APPLIED' | 'PROCESS_CRASH'
  | 'NATIVE_STREAM_ERROR' | 'OPENAI_AUTH_FAILED' | 'MCP_CONNECTION_ERROR'
  | 'EMPTY_RESPONSE' | 'UNKNOWN';

interface ClassifiedError {
  category: ClaudeErrorCategory;
  userMessage: string;          // Plain language
  actionHint: string;           // How to fix
  rawMessage: string;
  providerName?: string;
  retryable: boolean;
  recoveryActions?: Array<{ kind: 'open_settings' | 'retry' | 'new_conversation'; label: string }>;
}
```

Pattern-match against `ErrorPattern[]` array (regex or literal). The renderer
shows a structured error card with a retry button instead of raw stderr.

ai-orchestrator's failover-manager has retry logic but **classifies nothing**.
A failed CLI invocation surfaces as "Provider error: <stderr text>" — useless
for the user.

### 7.3 Sentry fire-and-forget integration

**Source:** `CodePilot:src/lib/error-classifier.ts:25-40`

```typescript
import('@sentry/node').then((Sentry) => {
  Sentry.withScope((scope) => {
    scope.setTag('provider', provider);
    scope.setLevel('warning');
    Sentry.captureException(new Error(rawMessage));
  });
}).catch(() => { /* Sentry not available */ });
```

Async dynamic import; never blocks the caller. Sentry is optional. If the
package isn't installed (e.g., fork build), classifier silently skips.

ai-orchestrator's OTel is fine for first-party telemetry, but Sentry-style
crash reporting (for the DMG users with no OTel collector) is missing. The
fire-and-forget pattern is the right shape: zero hard dependency.

---

## 8. Testing Discipline (rtk + claw-code)

ai-orchestrator's test surface is solid for IPC (verify-ipc-channels.js),
contracts (check-contracts-aliases.ts), and architecture
(verify-architecture). Two more disciplines to adopt:

### 8.1 Snapshot tests (rtk's insta discipline)

**Source:** `rtk:CLAUDE.md` testing strategy, `rtk:tests/fixtures/*`

RTK requires for **every** filter:
1. Real command output fixture in `tests/fixtures/<cmd>_raw.txt`
2. Snapshot test (`assert_snapshot!(output)`) — fails on any change
3. Token-savings assertion (`assert!(savings >= 60.0)`)
4. Integration test (run real command via RTK binary)

Savings <60% **blocks release**. This enforces accountability.

ai-orchestrator's adapter event normalization
(`packages/sdk/src/provider-adapter.ts`) is high-risk: a small change to
event envelope shape breaks the renderer silently if not caught.

**Plan:**
- Add `test/fixtures/provider-events/<provider>.jsonl` — recorded raw events
  from each adapter
- Snapshot test: feed fixture through normalizer, assert envelope shape
- Vitest's built-in `toMatchSnapshot()` works fine; no `insta` equivalent
  needed

### 8.2 Performance benchmarking as CI gate (rtk hyperfine)

**Source:** `rtk:CLAUDE.md` performance section

RTK runs `hyperfine` in pre-release CI: startup must be <10ms, memory <5MB.
ai-orchestrator has `bench:indexing` and `bench:search`; extend to:
- IPC round-trip latency (renderer → main → renderer)
- Provider event normalization throughput (events/sec)
- Supervisor restart cost (failure detection → respawn ready)

Failing benches block the release the same way failing tests do.

### 8.3 Mock parity test harness (claw-code)

**Source:** `claw-code:rust/crates/compat-harness/`

claw-code ships a deterministic Anthropic-compatible mock service for
integration tests. Tests run against the mock; no token burn, no flakiness,
no network. The mock implements the same SSE protocol as Anthropic's API
so tests exercise the real SSE parsing.

ai-orchestrator's tests mostly mock at the function boundary
(`vi.mock('./anthropic-api-provider')`). A protocol-level mock — running an
actual HTTP server that returns canned SSE streams — would catch SSE-parsing
regressions that function mocks don't.

**Plan:**
- `test/harness/anthropic-mock-server.ts` — Express server with fixture-based
  SSE responses
- Provider tests configure the real `AnthropicApiProvider` with
  `baseUrl: 'http://localhost:<mock-port>'`
- Same harness pattern works for Codex, Gemini, Copilot endpoint mocking

### 8.4 TOML filter DSL as user escape hatch (rtk)

**Source:** `rtk:src/core/toml_filter.rs`

RTK supports per-project/global `.rtk/filters/custom.toml` so users can
customize without recompiling. ai-orchestrator could expose
`<workspace>/.ai-orchestrator/config.toml` for per-workspace overrides:
- Provider preferences
- Hook commands
- Skill enable/disable
- Custom prompts

Format-wise, TOML wins for human-edited config (vs JSON's no-comments
limitation).

---

## 9. Configuration Hierarchy (claw-code + nanoclaw)

### 9.1 Source hierarchy with documented merge order

**Source:** `claw-code:rust/crates/runtime/src/config.rs:14-68`

```rust
enum ConfigSource {
    User,     // ~/.claw.json
    Project,  // <workspace>/.claw.json
    Local,    // <workspace>/.claw.local.json (gitignored)
}
```

Merge order: User → Project → Local → env vars → CLI args. **Documented**;
not just implied. ai-orchestrator's settings are scattered across
`config/`, `~/Library/Application Support/`, env vars. A `ConfigSource`
enum + `mergeConfigs(sources: ConfigSource[])` function makes precedence
explicit and testable.

### 9.2 Config via merged `.env` + `process.env` (nanoclaw)

**Source:** `nanoclaw:src/config.ts`

```typescript
const envConfig = readEnvFile(['KEY_NAME', ...]);
export const KEY = process.env.KEY || envConfig.KEY || DEFAULT;
```

No dotenv library. Precedence: `process.env` (CI/CD override) → `.env` file
(local default) → hard-coded default. Module-level exports beat `Config.get()`
calls because TypeScript can narrow types.

ai-orchestrator currently uses Electron's settings API — fine for desktop —
but the daemon/CLI path will need this pattern.

---

## 10. Daemon-Mode Building Blocks

The first review (CLAUDE.md §6) covered the daemon split conceptually. Three
peer projects show concrete primitives.

### 10.1 MCP-as-public-API (OB1 + Hono)

**Source:** `OB1:extensions/household-knowledge/index.ts:9-160`

OB1 exposes its memory/state via MCP server using:
- Deno + Hono (lightweight HTTP framework)
- `StreamableHTTPTransport` (MCP protocol over HTTP)
- Zod schemas defining the tool surface
- Single auth key (`MCP_ACCESS_KEY`) for local-network use

For ai-orchestrator's `apps/server`, an MCP transport works for any AI
client (Claude Desktop, Cursor, OpenCode, custom). The renderer can stay on
the WebSocket transport; MCP is the third-party integration surface.

### 10.2 Service-agnostic message routing (online-orchestrator)

**Source:** `online-orchestrator:multi-ai-query/background/service-worker.js`

Background worker doesn't know ChatGPT/Gemini/Claude internals; it routes
messages, collects responses, and formats merge prompts. Each content
script encapsulates service-specific DOM logic in isolation.

ai-orchestrator's CLI adapters should follow the same pattern: each adapter
(`claude-cli`, `codex-cli`) owns its CLI grammar and stdio handling
**only**. Multi-agent orchestration (debate, consensus) lives in a neutral
router that knows none of the CLI specifics.

### 10.3 Two-DB session split (nanoclaw)

**Source:** `nanoclaw:src/session-manager.ts`

Each session = two SQLite files:
- `inbound.db` (host writes, container reads)
- `outbound.db` (container writes, host reads)

**Hard constraints:**
- `journal_mode=DELETE` (not WAL — WAL `-shm` doesn't refresh across
  Docker mount boundaries)
- One writer per file
- Host opens-writes-CLOSES per operation (forces container to invalidate
  page cache)

This eliminates IPC entirely for the host↔container link. For ai-orchestrator's
`worker-agent/` (already a separate compiled binary), the same pattern would
remove the WebSocket dependency and survive worker crashes without losing
in-flight messages.

### 10.4 Session resume with --resume

**Source:** `claw-code:rust/crates/runtime/src/session.rs`

`--resume [session.jsonl|session-id|latest]` recovers prior context. Key
insight: don't replay tool invocations; replay only the conversation log.
The agent re-decides from the same state.

ai-orchestrator's loop-mode runs already persist; surfacing this as a
first-class `npm run resume <run-id>` (and CLI flag in daemon mode) closes
the loop on multi-day orchestrations.

---

## 11. Packaging Gotchas (CodexDesktop-Rebuild)

ai-orchestrator builds its own Electron app. CodexDesktop-Rebuild patches
upstream Electron releases. Two patterns are still relevant:

### 11.1 Forge config as state machine

**Source:** `CodexDesktop-Rebuild:forge.config.js:5-50`

`.build-mode` marker file written during prep; `forge.config.js` reads it
and conditionally applies `asar`/`ignore`. ai-orchestrator's
`electron-builder.json` is hardcoded; if you ever need separate "DMG with
RTK", "DMG without RTK", "headless server bundle" outputs, this state-machine
pattern keeps one config.

### 11.2 ASAR integrity hash post-patch

**Source:** `CodexDesktop-Rebuild:scripts/build-from-upstream.js:255-288`

If you ever modify `app.asar` after Electron Builder runs (e.g., to inject a
build stamp), the bundled binary's embedded hash check fails. The fix is:
- Compute new ASAR header hash
- Patch the old hash inside the .exe (Windows) or `Info.plist`
  (`ElectronAsarIntegrity.Resources/app.asar.hash` on macOS)

Keep this in `docs/packaging.md` for the day someone hits the silent
"app is damaged" error.

---

## 12. Smaller, Highly-Borrowable Patterns

A grab bag — none deserve their own section, all are <2-hour ports.

### 12.1 `nanoclaw:src/log.ts` — 65-line structured logger

Replaces log4js. ANSI colors, structured KV, LOG_LEVEL thresholding,
stderr/stdout split. Drop-in.

### 12.2 `oh-my-codex` plugin manifest

Each plugin = `index.ts` exporting an `export default { name, version,
hooks: { onPreToolUse, … } }` object. No global registry call. Loader
inspects the export.

### 12.3 `storybloq:src/mcp/tools.ts` — shared MCP pipeline

All read tools flow through `loadProject(root) → buildContext → invoke
handler → format result`. Eliminates per-tool boilerplate. ai-orchestrator's
49 IPC handlers in `src/main/ipc/` have similar boilerplate.

### 12.4 `CodePilot:src/lib/db.ts` — inline migrations

Schema DDL inline with `CREATE TABLE IF NOT EXISTS`; evolution via
on-demand `ALTER TABLE` checks. No separate migrations folder needed for a
single-machine SQLite. ai-orchestrator's RLM persistence layer could
simplify if it doesn't already use this pattern.

### 12.5 `hermes-agent:agent/skill_utils.py` — decoupled lightweight utils

Imports nothing heavy. Safe to import from anywhere. Prevents circular
dependencies between prompts, skills, providers. ai-orchestrator should
audit `src/main/skills/` for similar circular-import risks.

### 12.6 `claude-code:plugins/*/hooks/hooks.json`

Hook config is JSON; handler is an executable (Python or shell) reading
stdin and writing stdout. Cross-language. ai-orchestrator's hooks are
TypeScript-only; supporting `executable: <path>` in the hook spec opens
the door to user-written Python/Bash hooks.

### 12.7 `OB1:schemas/*` — per-extension SQL extension

Each OB1 extension can declare its own SQLite tables that get created on
install. ai-orchestrator's plugin SDK should let plugins declare schema
deltas (`migrations: SqlScript[]`) rather than requiring all storage to go
through the host.

### 12.8 Common-English stoplist for entity disambiguation

**Source:** `mempalace-reference:mempalace/entity_registry.py`

Prevents "Grace" (name) from matching "grace" (adverb). 200-word list,
loaded once. ai-orchestrator's memory codemem could use this when extracting
people/project names from chat output.

### 12.9 Markdown handover parser (storybloq)

Frontmatter + structured-section markdown can be read both by the LLM (for
context resumption) **and** by code (for routing/state recovery). The
parser is one regex per section. Reuse for run summaries.

---

## 13. What ai-orchestrator already has that **none** of these peers do

For balance — most of the deep-dives confirm ai-orchestrator is, at the
orchestration layer, the most sophisticated project in this workspace:

- 5+ orchestration patterns (debate, consensus, multi-verify, synthesis,
  doom-loop detection) — none of CodePilot, OB1, online-orchestrator,
  storybloq, claude-code, or copilot-sdk has more than one or two
- Full RxJS-based provider event streaming with normalized envelopes
  (Wave 2)
- ~50 Zod schemas + 775 generated IPC channels with drift detection
- A signed-DMG build pipeline with the registered-aliases footgun guard
- OpenTelemetry already wired
- Worker-agent compiled as a separate SEA binary
- Bonjour service discovery + remote-node pairing (the rare peer with
  this is hermes-agent)
- A real plugin slot system, even if not yet enforced via barrels

The improvements above are **additive**. None require backing out a
working subsystem.

---

## 14. Concrete second-sprint plan

The first review's "first sprint" (oxlint, Turborepo, generate-aliases,
delete legacy `BaseProvider`, madge boundary check) is the right starting
point. After that, **second sprint** should be:

1. **Provider Doctor + Error Classifier** (CodePilot patterns, §7) — biggest
   user-visible win, isolated change. 2–3 days.
2. **Durable approval state** in SQLite (§6.1) — moves
   `permission-registry.ts` from in-memory to `pending_approvals` table.
   Half-day for schema, 1 day for IPC integration, 1 day for renderer.
3. **Job persistence** for orchestration runs (§2.4) — JSONL log per run,
   exposed via IPC. 1 day.
4. **Snapshot tests for adapter event normalization** (§8.1) — record
   fixtures per provider, lock envelope shape. Half-day per provider.
5. **Typed hook callbacks** (§3.1) — Copilot SDK shape; replaces boolean
   returns in `permission-registry.ts` and the hook surface. 1 day.
6. **Custom logger** (§12.1) — drop log4js, use the nanoclaw 65-liner. Half-day.
7. **`systemMessage.customize` mode** (§3.3) — section-level system prompt
   overrides. 1 day for the type, 1 day to migrate debate-coordinator.

That's a 7–10 day sprint that:
- Makes errors actionable (Doctor + Classifier)
- Makes approvals durable across crashes
- Locks down adapter envelope drift
- Replaces booleans with typed results everywhere it matters
- Removes a transitive dep (log4js)

**Third sprint** themes (each is a 1-2 week spec):
- Tiered memory wake-up + temporal knowledge graph (§1.1, §1.2) — biggest
  payoff for long-running orchestrations
- Subprocess-isolated plugins (§2.2) — required before community plugins
  are safe
- Bridge subsystem for IM channels (§4) — opens headless mode to phone use
- Mock parity test harness (§8.3) — kills flaky integration tests

---

## 15. Cross-cutting themes

Pulling back, the peer set splits into three philosophical camps:

| Camp | Projects | What they prove |
|------|----------|-----------------|
| **Effect-native, fast tools** | opencode, t3code | Effect/Bun/Turbo/oxlint stack is the future fast lane |
| **Channel-first headless** | nanoclaw, CodePilot, OB1 | Agents reachable from anywhere; renderer is one of N surfaces |
| **Markdown-first declarative** | claude-code, OB1, storybloq | Plugin/skill/agent definitions belong in `.md` + frontmatter, not TS |

ai-orchestrator currently has one foot in each but commits to none. The
first review (`claude.md`) pushed toward the first camp. This review
suggests **also** committing to the third camp — the markdown-first
declarative pattern — because it's where the broader ecosystem (Claude
Code plugins, Cursor rules, Copilot config, OpenCode agents) is converging.

The markdown-first commitment is what unlocks user-extensibility without a
full rebuild — and that's the lever for going from "James's tool" to
"James's tool that has a community".

---

*Report generated by Claude after a second-pass deep-dive of the
orchestrat0r workspace on 2026-05-10. Complementary to `claude.md` (same
date, structural recommendations).*
