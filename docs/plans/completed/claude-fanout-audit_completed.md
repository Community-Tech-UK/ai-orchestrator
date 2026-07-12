# Claude fan-out audit (Phase 1)

Date: 2026-06-11. Updated: 2026-06-17. Status: **bounded Phase 1
attribution run completed — awaiting human sign-off.**
Companion to `PROMPT_claude-cost-routing.md` and `AIO_CLAUDE_BILLING_FEASIBILITY.md`.
Untracked until implemented and verified, per AGENTS.md.

2026-06-17 note: the current branch already contains intent-routing changes at
the one-shot seams (`routingIntent:'scaffolding'` for verify/review and
non-synthesis debate, `routingIntent:'workflow'` for workflows). The run data in
§4 forced Claude/Sonnet where needed to establish a Claude-exposure baseline for
the named fan-out paths. It did not exercise the full UI chat instance-turn path.

Every AIO Claude invocation goes through `claude --print --output-format stream-json`
(`claude-cli-adapter.ts` `buildArgs()`, verified). There is no interactive-TTY path.
That means after June 15 **100% of the calls mapped below bill against the $200/mo
Agent SDK credit** (or spill to API rates). The "keep reasoning on subscription"
framing doesn't survive contact with this fact: for AIO there is no subscription
pool anymore, only the credit. The goal of routing is therefore simply to minimize
Claude tokens, and Phase 4 (bare + API key) makes whatever remains predictable.

---

## 1. The four mechanisms that reach Claude

1. **Interactive chat instances** — user-driven sessions via `instance-manager` →
   `claude-cli-adapter`. New sessions default to Opus-1M (`PROVIDER_MODEL_LIST[0]`).
   Usage recorded per turn by `CostTracker` (`instance-communication.recordCompletionCost`).
2. **One-shot orchestration invocations** — the single seam
   `invokeCliTextResponse()` in `src/main/orchestration/default-invokers.ts`. Six
   registered invokers (detail in §2). Fresh adapter per call (except same-session
   loops). Usage was **log-only** until this audit's instrumentation.
3. **Child/subagent spawns** — parent agents emit `spawn_child` commands (driven by
   the builtin skill markdown under `src/main/skills/builtin/`); children are full
   instances routed by `instance-orchestration.routeChildModel()` /
   `computeRoutingDecision()` (router + outcome-learning + preference store). Depth
   guard: `DEFAULT_MAX_SPAWN_DEPTH = 3` (`subagent-spawn-guard.ts`). Usage recorded
   by `CostTracker` like any instance, but with no task-type/skill tag.
4. **Direct API calls** — `rlm/llm-service.ts` calls `api.anthropic.com` with an
   API key as the frontier fallback for compression/memory distillation (already
   API-billed, not subscription). `providers/anthropic-api-provider.ts` is
   registered but thin (no tools/subagents) and effectively unused by default.

## 2. Call-site map

### 2a. One-shot orchestration calls (all through `invokeCliTextResponse`)

`taskType` = circuit-breaker key, now also the attribution tag. "Agentic" means the
spawned CLI can run tools inside its single print-mode turn (they all can; the
practical difference is whether the prompt asks for tool work).

| taskType | Trigger | Fan-out | Model selection | Notes |
|---|---|---|---|---|
| `loop-orchestration:<provider>` | Loop Mode iteration (`loop:invoke-iteration`, default-invokers ~L1141) | 1 per iteration; iterations **unbounded by default** (`maxIterations: null`, `maxCostCents: null`, `maxCompletionAttempts: 3`) | `routingIntent:'loop'` → **balanced tier (Sonnet)** when router enabled (it is by default); optional downshift to fast tier via aux `classifyCheapModelEligible`, gated by `auxiliaryLlmRoutingClassificationEnabled` (**default false**) | Current loop default is `contextStrategy:'same-session'`; `fresh-child` remains supported and was forced for the bounded run to measure a cold one-shot loop call. |
| `verify-orchestration` | `multi-verify-coordinator` `verification:invoke-agent` (IPC/orchestration commands, `/verify` skill path) | Default `agentCount: 1`; callers can raise it. This bounded run used 2 agents. | Current branch passes `routingIntent:'scaffolding'`; if a concrete model is requested it stays on that model/provider. | Previously suspected Opus floor is gone in current code; cache churn still made 2 Sonnet calls cost $0.3503 in the run. |
| `review-orchestration` | `agents/review-coordinator` `review:invoke-agent` | 1 per review agent in the session | Current branch passes `routingIntent:'scaffolding'`; this run forced Claude/Sonnet via the originating instance + model. | Triggered via orchestration IPC |
| `debate-orchestration:<event>` | `debate-coordinator`: `generate-response`, `generate-critiques`, `generate-defense`, `generate-synthesis` | Current defaults `agents: 2, maxRounds: 2` → responses (2) + synthesis (1). Critique/defense only appear when callers raise `maxRounds`. | Non-synthesis debate calls pass `routingIntent:'scaffolding'`; synthesis keeps the default strong model (**Opus** for Claude). | Triggered via IPC (`cross-model-review-ipc`, `memory-ipc`) and `/debate` skill, not automatically per loop iteration |
| `workflow-orchestration` | `workflow-manager` `workflow:invoke-agent` | 1 per workflow step | Current branch passes `routingIntent:'workflow'`; explicit model requests still win. | Workflow steps are caller-authored tasks |
| `loop-branch:<provider>` | LF-5 branch-and-select on loop stall | `exploration.fanout` (default 3) candidate worktrees | Provider per candidate (can be cross-model) | **Disabled by default** (`enabled: false`) |

### 2b. Skill-driven child fan-out (full instances, CostTracker-visible)

The builtin skills are prompt markdown; the *parent* Claude agent reads them and
emits `spawn_child` commands. Each child is a full agentic instance.

| Skill | Children per invocation | Notes |
|---|---|---|
| `/verify` (verify-implementation) | 4 (functional, integration, edge-cases, performance) | Each re-reads code/tests with tools |
| `/code-review` | 4 (security, performance, maintainability, testing) | |
| `/debate` (debate-topic) | 3 positions × `rounds` (default 3) of exchanges | Parent also synthesizes |
| `/research-team` | 3 perspectives | |
| `/summarize-children` | 0 new children, but the parent re-ingests **all child outputs** as input tokens | Input-token heavy synthesis on the parent's (frontier) model |

### 2c. Utility calls

| Call | Path | Model | Claude exposure |
|---|---|---|---|
| Auto-titling | `auto-title-service` → aux slot `titleGeneration` (local, quick tier) → on aux miss, CLI spawn with `FAST_PROVIDER_PREFERENCE = ['gemini','claude','codex']` fast tier | local first | Claude only when aux AND gemini unavailable |
| Cheap-model eligibility | aux slot `routingClassification` (local) | local | none (returns false on any failure) |
| Loop clean-review classification | aux slot `loopScoring` (local) | local | none |
| Compression / memory distillation | aux slots → frontier fallback = `rlm/llm-service` **direct API key call**, else deterministic local summarizer | local first | API-billed, never CLI |

### 2d. Already off Claude by design (don't re-route, don't re-check)

- **Auxiliary LLM service** (`rlm/auxiliary-llm-service.ts`): 7 slots, all enabled,
  `local-first` routing by default, localhost Ollama + worker-node Ollama (via
  heartbeat/RPC, e.g. the RTX 5090 box as a worker node) + OpenAI-compatible
  endpoints. This is the scaffolding-routing layer the prompt asks for, already
  built for the small stuff.
- **Fresh-eyes / cross-model review** (`cross-model-review-service`,
  `loop-fresh-eyes-reviewer`): reviewer CLIs restricted to
  `SUPPORTED_REVIEWER_CLIS = {gemini, codex, copilot, cursor}` — Claude is
  structurally excluded. Enabled by default for loops (`defaultCrossModelReviewConfig`).
- Pure heuristics (no LLM): loop progress/completion detectors, output classifier,
  doom-loop detector, confidence analyzer, consensus scoring math, embeddings
  (local embedding service).

## 3. Attribution infrastructure: before / after

**Existed:**
- `CostTracker` → `cost_entries` in `<userData>/rlm/rlm.db` (90-day retention,
  budget alerts). Covers **instance turns only** (chat + spawned children). Keys:
  instanceId, sessionId, model. **No task-type/skill/purpose tag.**
- Loop store → `loop_runs` / `loop_iterations` in `<userData>/loop-mode/loop-mode.db`
  with per-iteration `tokens` and `cost_cents`.
- One-shot orchestration calls: **log line only** (`Orchestration invocation
  completed` with breakerKey/model/tokens/cost). Not persisted. This was the gap:
  the suspected heaviest scaffolding (verify/review/debate gates) was invisible to
  every persisted cost view.

**Added by this audit (flag-gated, fail-soft, no behavior change):**
- `src/main/core/system/cost-attribution.ts` — JSONL sink, enabled only with
  `AIO_COST_ATTRIBUTION=1` (dir override: `AIO_COST_ATTRIBUTION_DIR`, default
  `<userData>/cost-attribution/`). One line per LLM call: ts, source, taskType,
  correlation/instance ids, provider, model, token breakdown, cost, costKnown.
- Hook in `invokeCliTextResponse` (tags = breaker keys, covers all six one-shot paths).
- Hook in `recordCompletionCost` (tags = `chat:<agentId>` / `child:<agentId>`).
- `cost-attribution.spec.ts` (Vitest) and `scripts/claude-cost-audit-report.mjs`
  (read-only aggregator over JSONL + rlm.db + loop-mode.db).

## 4. Real numbers from bounded attribution run

We can't fake this part; the ranking below comes from real Claude CLI calls
through the production invoker listeners, with JSONL emitted by
`AIO_COST_ATTRIBUTION=1`.

Run details:

- Command: `npx vitest run --config _scratch/vitest.claude-fanout-audit.config.ts --testTimeout 1200000`
- Run dir: `_scratch/claude-fanout-2026-06-17T09-17-54-976Z`
- Scope: one loop iteration, one review agent, two verification agents, and one
  two-agent/two-round debate. Electron app storage was mocked only so the
  production main-process modules could run headlessly; provider runtime and
  Claude CLI calls were real.
- Caveat: normal interactive chat instance-turn attribution was not exercised in
  this bounded headless run. The report below covers the one-shot orchestration
  hotspots that were invisible before Phase 1 instrumentation.
- Report command:
  `AIO_COST_ATTRIBUTION_DIR="_scratch/claude-fanout-2026-06-17T09-17-54-976Z/cost-attribution" node scripts/claude-cost-audit-report.mjs --userdata "_scratch/claude-fanout-2026-06-17T09-17-54-976Z/userData" --since 2026-06-17T09:17:00.000Z`

> **PER-TASK-TYPE COST RANKING — BOUNDED RUN**
>
> | task-type [provider/model] | calls | input tok | output tok | cache r/w | cost | % |
> |---|---:|---:|---:|---:|---:|---:|
> | `debate-orchestration:debate:generate-synthesis` [claude/opus] | 1 | 11,701 | 8,835 | 112,133/26,245 | $0.5979 | 38.3% |
> | `verify-orchestration` [claude/sonnet] | 2 | 13 | 7,039 | 217,039/29,932 | $0.3503 | 22.4% |
> | `loop-orchestration:claude` [claude/sonnet] | 1 | 5 | 279 | 61,277/35,098 | $0.2332 | 14.9% |
> | `debate-orchestration:debate:generate-response` [claude/sonnet] | 2 | 6 | 3,424 | 39,588/21,888 | $0.1946 | 12.5% |
> | `review-orchestration` [claude/sonnet] | 1 | 3 | 2,568 | 0/24,724 | $0.1869 | 12.0% |
>
> Total attributed cost: **$1.5629 across 7 calls**.

The biggest signal is cache churn: reported `inputTokens` were tiny on most
calls, but `cacheReadTokens`/`cacheWriteTokens` dominated cost. Debate synthesis
was the single highest-cost call because it stayed on Opus and re-ingested the
debate transcript.

## 5. Proposed classification (Phase 2 criteria, for review)

**Scaffolding — route off Claude** (local via Ollama adapter or aux service;
Gemini/Codex fallback):

- Debate **critique and defense rounds** (`debate-orchestration:generate-critiques`,
  `:generate-defense`): judging/structured rebuttal of existing text, no tool use
  needed. A strong local model (RTX 5090-class) is adequate.
- **Child-output summarization** (`/summarize-children` synthesis): replace the
  parent-side frontier synthesis with a one-shot local call (or aux `compression`
  slot with a raised input budget).
- **Workflow steps** without explicit model requests: current code already passes
  `routingIntent:'workflow'`; keep it there and map mid/fast tiers cross-provider.
- **Verification re-reads** (`verify-orchestration`): contested, our call is
  scaffolding. Current code already marks this as scaffolding; diversity also
  *improves* when the verifier is not the same model family that wrote the code —
  route to Gemini/local by default and keep at most one frontier verifier.
- **Review gate** (`review-orchestration`): same argument as verification; current
  code already marks this as scaffolding.
- Everything already on the aux service stays there. Additionally **enable
  `auxiliaryLlmRoutingClassificationEnabled`** so loop iterations can downshift to
  the fast tier (it's built, tested, and off).

**Reasoning — keep on Claude** (justify each):

- **Loop IMPLEMENT iterations** (`loop-orchestration:claude`): the actual code
  writing; quality measurably depends on the frontier model. Already routed to
  balanced (Sonnet), not Opus. Keep.
- **Debate final synthesis** (`:generate-synthesis`): one call per debate; extracting
  a balanced recommendation from conflicting positions is frontier-grade. Keep, 1 call.
- **Interactive chat instances**: user-driven; that's the product. Keep (and note
  these are *also* headless `--print` calls in AIO, so they hit the credit too —
  Phase 4's ring-fencing matters most here).
- **Skill children doing implementation work** (not review/verify aspects): keep,
  routed by the existing decision layer.

## 6. Expensive patterns that may not earn their cost (challenge list)

1. **Multi-verify cache churn**: the old suspected `agentCount = max(config, 3)`
   Opus floor is not present in current code (`agentCount` defaults to 1 and the
   invoker passes `routingIntent:'scaffolding'`). The bounded run still showed 2
   Sonnet verifier calls costing $0.3503 because cache read/write dominated.
   Proposal: keep default floor at 1, prefer deterministic `verifyCommand`
   (tests/lint) before adding agents, and route extra agents cross-provider/local.
2. **Debate synthesis dominates**: the old 3 agents × 4 rounds default is not
   present in current code (defaults are 2 agents × 2 rounds). In the bounded run,
   the single Opus synthesis call cost $0.5979, more than both initial response
   calls combined. Proposal: keep critique/defense off-Claude when enabled, and
   test whether synthesis can default to Sonnet/local except for explicit
   frontier-grade debates.
3. **Fresh-child loop cost when selected**: current default is already
   `same-session`, but `fresh-child` is still selectable and this bounded run
   forced it once. That single cold Sonnet loop call cost $0.2332, mostly cache
   writes/reads. Proposal: keep `same-session` as the default and treat
   `fresh-child` as an explicit reset/lowest-state option, not a cheap option.
4. **Opus as the one-shot house default** (`DEFAULT_MODELS['claude-cli']`): even
   for steps that stay on Claude, Sonnet is likely adequate for gate-keeping
   roles. The comment in `provider.types.ts` already shows cost awareness (plain
   Opus vs Opus-1M); we propose going one step further per task-type.
5. **Unbounded loops** (`maxIterations: null`, `maxCostCents: null` by default):
   with the June 15 split, an unbounded loop on the credit is a footgun. The
   quota-throttle ladder (`loop-quota-throttle.ts`) watches subscription windows
   but does not yet model the Agent SDK credit pool — worth a follow-up.

## 7. Confirmed mechanics (so Phase 3/4 don't re-derive them)

- `--bare` + `ANTHROPIC_API_KEY` is plumbed adapter-side (`spawnOptions.bare` →
  `--bare`, claude-cli-adapter ~L840). The user-facing `bareMode` in
  `instance.types.ts` (~L446) is **declared and read nowhere** — Phase 4 wires it
  through settings/IPC into `UnifiedSpawnOptions.bare`.
- Usage parsing: `result` event → `usage` + `total_cost_usd`
  (claude-cli-adapter ~L763-787, ~L1613+). Cache read/write and reasoning tokens
  are separated (`CliUsage`).
- Ollama path for full task routing exists: `createOllamaAdapter()` →
  `ollama-cli-adapter.ts` (REST). The aux service additionally proxies worker-node
  Ollama via RPC (never dials worker localhost).
- Routing seams for Phase 3: `route-task.ts` (`resolveRoutedModel`),
  `model-router.ts` (tiers, enabled by default), `resolveModelForInvocation` +
  `RoutingIntent` (the per-call-site opt-in), `resolveCliType`/`createCliAdapter`.

## 8. Open questions for sign-off

1. Approve the scaffolding/reasoning split in §5, especially verification → off-Claude?
2. Approve the §6 default changes (verify floor, debate shape, same-session loops),
   or treat them as separate follow-ups after the routing policy lands?
3. Which local models do we standardize on for the two boxes (5090 worker node vs
   M5 Max localhost), so tier mapping (`fast`/`balanced` → Ollama ids) is concrete?
4. Enable `auxiliaryLlmRoutingClassificationEnabled` by default?
5. Is the JSONL sink acceptable as the permanent observability mechanism for
   Phase 3 ("log which provider served each step"), or should Phase 3 promote it
   into `cost_entries` with a task-type column?

**STOP — sign-off gate.** Phase 1 now has bounded real run data in §4, but no
additional routing/default changes should land until a human signs off on §5/§6.
