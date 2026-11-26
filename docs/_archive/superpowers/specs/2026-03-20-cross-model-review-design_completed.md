# Cross-Model Review Service — Design Spec

## Summary

A background service that automatically sends primary AI output (code, plans, architecture decisions) to secondary models (Gemini, Codex, Copilot) for independent review. Runs silently — only surfaces findings when reviewers disagree or flag issues. Fault-tolerant: gracefully degrades when secondary models hit rate limits or are unavailable.

**Enabled by default.** Configurable via settings (which providers, review depth, output types, or disable entirely).

## Requirements

1. When the primary instance (e.g., Claude) produces code, plans, or architecture output, automatically dispatch it to 2 secondary models for review
2. Use round-robin selection across available secondary CLIs
3. If a secondary model hits rate limits or fails, failover to another; if all are down, skip silently
4. Primary output is NEVER blocked or delayed
5. Notifications are non-intrusive — user sees a small indicator (green/amber/grey) and can expand details on their own terms
6. When concerns are found, user gets actionable options: Dismiss, Ask Primary to Address, Full Review, Start Debate
7. Review depth is configurable: "structured" (default) or "tiered" (auto-escalates for complex output)
8. All settings are configurable per-user and per-project, with sensible defaults

## Architecture

### New Service: CrossModelReviewService

Singleton service at `src/main/orchestration/cross-model-review-service.ts`.

```
┌─────────────────┐     instance:output      ┌──────────────────────────┐
│  Primary Agent   │ ──────────────────────► │  CrossModelReviewService  │
│  (Claude)        │                          │                          │
└─────────────────┘                          │  1. Classify output      │
                                             │  2. Check threshold      │
                                             │  3. Select reviewers     │
        ┌────────────────────────────────────│  4. Dispatch reviews     │
        │                                    │  5. Collect results      │
        ▼                                    │  6. Emit findings        │
┌───────────────┐  ┌───────────────┐         └──────────────────────────┘
│  Gemini CLI   │  │  Codex CLI    │                    │
│  (reviewer 1) │  │  (reviewer 2) │                    │
└───────┬───────┘  └───────┬───────┘                    │
        │                  │          review:result      │
        └──────────────────┴──────────────────────────► │
                                                        ▼
                                              ┌──────────────────┐
                                              │  UI Notification  │
                                              │  (non-intrusive)  │
                                              └──────────────────┘
```

### Internal Components

1. **OutputClassifier** — heuristic-based classification (no LLM call)
2. **ReviewerPool** — round-robin selection, availability tracking, failover
3. **ReviewDispatcher** — sends output to reviewers with appropriate prompts
4. **ResultCollector** — aggregates results, detects disagreements, emits findings

### Lifecycle

- Initialized at startup in `src/main/index.ts` after ProviderRegistry is ready
- Subscribes to `instance:output` events
- On shutdown, cancels pending reviews and cleans up

## Response Aggregation

The `instance:output` event streams individual `OutputMessage` chunks. The service must aggregate these into complete responses before classification.

### Aggregation Strategy

1. **Filter**: Only process messages with `type === 'assistant'` — ignore `user`, `system`, `tool_use`, `tool_result`, and `error` messages
2. **Buffer**: Accumulate `assistant` messages per-instance in a buffer map (`Map<string, string[]>`)
3. **Trigger**: Classify and dispatch when the instance transitions to `idle` or `waiting_for_input` (detected via `instance:batch-update` event, filtering for updates where `status === 'idle'` or `status === 'waiting_for_input'`). Note: `instance:state-update` only fires for plan-mode changes — general status transitions come via `instance:batch-update` with payload `{ updates: [{ instanceId, status, contextUsage }], timestamp }`
4. **Cleanup**: Clear the buffer for an instance when review is dispatched or when `instance:removed` fires
5. **Minimum length gate**: Skip classification if aggregated output is < 50 characters (avoids reviewing trivial responses like "Done." or "Yes.")

### Token Budget & Truncation

- **Maximum review payload**: 8,000 tokens (~32K characters). If aggregated output exceeds this, truncate with a `[... truncated, showing first 8000 tokens of N total ...]` notice
- **Cooldown**: Minimum 10 seconds between review dispatches for the same instance (prevents cost runaway on rapid interactions)
- **Estimated cost per review**: ~2K tokens prompt + up to 8K tokens payload + ~1K tokens response = ~11K tokens per reviewer per review

### Task Description Source

The `{taskDescription}` template variable is populated from the instance's initial user prompt (the first `user` message in the conversation). If unavailable, falls back to the instance name/description.

## Output Classification

Runs synchronously via heuristics (no LLM call).

### Classification Types

| Type | Detection | Default Review | Complex Escalation |
|------|-----------|---------------|-------------------|
| `code` | Fenced code blocks, file writes/edits in output | Structured review | Yes, if >100 lines or touches >3 files |
| `plan` | Numbered steps, "implementation plan", task lists | Structured review | Yes, if >5 steps or mentions architecture |
| `architecture` | System design, component diagrams, data flow | Always escalated | Always |
| `conversation` | Everything else | Skip (no review) | No |

### Complexity Scoring

- Lines of code changed (>100 = complex)
- Number of files touched (>3 = complex)
- Plan step count (>5 = complex)
- Keyword triggers: "security", "auth", "migration", "database schema", "breaking change" -> auto-escalate
- If instance is already in a debate or multi-verify flow, skip (avoid review loops)

### Anti-Loop Guard

Output from CrossModelReviewService itself is tagged with `source: 'cross-model-review'` and always skipped by the classifier.

## ReviewerPool

### Reviewer State

```typescript
// Uses CliType from cli-detection.ts (concrete types: 'claude' | 'codex' | 'gemini' | 'copilot' | 'ollama')
// NOT the settings CliType which includes 'auto' and 'openai'
interface ReviewerInfo {
  cliType: CliType;              // 'gemini' | 'codex' | 'copilot'
  available: boolean;
  lastUsed: number;              // timestamp for round-robin
  consecutiveFailures: number;   // for failover
  rateLimited: boolean;
  rateLimitResetAt?: number;     // when to retry
  totalReviewsCompleted: number;
}
```

### Selection Logic

1. Filter to `available && !rateLimited` reviewers (exclude the primary's provider — determined from `instance.provider` which is typed as `InstanceProvider`/`CanonicalCliType`, resolved to a concrete type before output is produced; if user explicitly configures a review provider that matches the primary, silently exclude it)
2. Sort by `lastUsed` ascending (least recently used first)
3. Pick top 2
4. If fewer than 2 available, use what's available (1 is fine, 0 = skip silently)

### Failover Rules

| Event | Action |
|-------|--------|
| Review times out (30s default) | Mark +1 consecutive failure, pick next reviewer |
| Rate limit response (429 / quota error) | Set `rateLimited = true`, `rateLimitResetAt = now + 60s` |
| 3 consecutive failures | Set `available = false`, re-probe after 5 minutes |
| CLI process crash | Same as 3 consecutive failures |
| All reviewers unavailable | Skip review silently, log warning, emit `review:all-unavailable` event |

### Rate Limit Recovery

Background timer (every 30s) checks `rateLimitResetAt` timestamps. On re-enable, sends a lightweight probe to confirm before putting the reviewer back in rotation.

### Availability Detection

On startup, queries `CliDetectionService.detectAll()` to populate the initial pool. Subsequently, re-probes on a 5-minute timer and on-demand when a reviewer fails (the `provider:availability-changed` event does not exist — use polling instead). Consider composing with the existing `CircuitBreakerRegistry` (`getCircuitBreakerRegistry()`) for failure tracking, wrapping each reviewer's adapter calls in a per-provider circuit breaker.

**Key principle: primary output is NEVER blocked or delayed.**

## Review Prompts

Two tiers, both using "reasoning before scoring" pattern and small integer scales (1-4).

### Structured Review Prompt (Default)

```
You are a verification agent reviewing another AI's output. Your job is NOT
to re-solve the problem, but to verify the solution's correctness.

## Task Context
{taskDescription}

## Output Under Review
{primaryOutput}

## Review Checklist
Evaluate each dimension independently. For each, provide a brief justification
BEFORE your score.

1. **Correctness**: Does the code/plan achieve what was asked? Any bugs, logic
   errors, or wrong assumptions?
2. **Completeness**: Are there missing edge cases, error handling, or steps?
3. **Security**: Any injection vulnerabilities, auth issues, data exposure, or
   unsafe patterns?
4. **Consistency**: Does it contradict itself or the task requirements?

## Scoring
For each dimension:
- 4: No issues found
- 3: Minor issues (style, non-critical suggestions)
- 2: Notable issues that should be addressed
- 1: Critical issues that would cause failures

## Output Format
Respond in this exact JSON format:
{
  "correctness": { "reasoning": "...", "score": N, "issues": [] },
  "completeness": { "reasoning": "...", "score": N, "issues": [] },
  "security": { "reasoning": "...", "score": N, "issues": [] },
  "consistency": { "reasoning": "...", "score": N, "issues": [] },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment"
}

Be rigorous but fair. Only flag genuine issues, not stylistic preferences.
```

### Tiered/Escalated Review Prompt (Complex Tasks)

```
You are a senior verification agent performing a deep review of another AI's
output on a complex task. This is high-stakes -- be thorough.

## Task Context
{taskDescription}

## Output Under Review
{primaryOutput}

## Deep Verification Steps

### Step 1: Trace Through Execution
Pick 2-3 concrete scenarios (including an edge case) and mentally trace the
code/plan through each. Show your work briefly.

### Step 2: Boundary Analysis
Check: empty inputs, single elements, maximum values, null/undefined,
concurrent access, error paths. List what you checked.

### Step 3: Assumption Audit
What assumptions does this output make that are NOT guaranteed by the task
description? List each with severity.

### Step 4: Dependency & Integration Check
Would this break anything upstream or downstream? Are imports/interfaces
correct? Any missing migrations, config changes, or wiring?

### Step 5: Dimensional Scoring
Score each (1-4, with reasoning BEFORE score):
1. **Correctness** -- logic, algorithms, data flow
2. **Completeness** -- missing pieces, edge cases
3. **Security** -- vulnerabilities, data handling
4. **Consistency** -- internal contradictions, requirement mismatches
5. **Feasibility** -- will this actually work in practice?

## Output Format
{
  "traces": [{ "scenario": "...", "result": "pass|fail", "detail": "..." }],
  "boundaries_checked": ["...", "..."],
  "assumptions": [{ "assumption": "...", "severity": "high|medium|low" }],
  "integration_risks": ["...", "..."],
  "scores": {
    "correctness": { "reasoning": "...", "score": N, "issues": [] },
    "completeness": { "reasoning": "...", "score": N, "issues": [] },
    "security": { "reasoning": "...", "score": N, "issues": [] },
    "consistency": { "reasoning": "...", "score": N, "issues": [] },
    "feasibility": { "reasoning": "...", "score": N, "issues": [] }
  },
  "overall_verdict": "APPROVE | CONCERNS | REJECT",
  "summary": "One sentence overall assessment",
  "critical_issues": ["Only issues that MUST be addressed"]
}

Do not nitpick style. Focus on things that would cause real failures.
```

### Disagreement Detection

A review is flagged as a disagreement when:
- `overall_verdict` is `CONCERNS` or `REJECT`
- Any dimension scores `1` (critical)
- Two reviewers disagree with each other (one APPROVE, one REJECT)

Only disagreements produce user-facing notifications.

### Review Result Parsing

LLMs may wrap JSON in markdown fences, add preamble text, or produce slightly malformed JSON. Robust parsing strategy:

1. Strip markdown code fences (`` ```json ... ``` ``) if present
2. Try `JSON.parse()` on the full response
3. On failure, extract first `{...}` block via regex and retry parse
4. Validate parsed result with a Zod schema (`ReviewResultSchema`) to ensure all required fields exist and have correct types
5. If parsing fails entirely, treat as "unable to parse" — log warning, skip this reviewer's result, do not count as a failure for the reviewer pool

## Settings & Configuration

### New Types

The `SettingMetadata.category` union type must be extended to include `'review'`:
```typescript
// In settings.types.ts
category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review';
```

The `SettingMetadata.type` union must be extended to include `'multi-select'`:
```typescript
type: 'boolean' | 'string' | 'number' | 'select' | 'directory' | 'multi-select';
```

The `ReviewOutputType` must be defined in shared types:
```typescript
// In src/shared/types/cross-model-review.types.ts
export type ReviewOutputType = 'code' | 'plan' | 'architecture';
```

### New AppSettings Fields

```typescript
interface AppSettings {
  // ... existing fields ...

  // Cross-Model Review
  crossModelReviewEnabled: boolean;                       // default: true
  crossModelReviewDepth: 'structured' | 'tiered';        // default: 'structured'
  crossModelReviewMaxReviewers: number;                   // default: 2
  crossModelReviewProviders: CliType[];                   // default: [] (auto-detect)
  crossModelReviewTimeout: number;                        // default: 30 (seconds)
  crossModelReviewTypes: ReviewOutputType[];              // default: ['code', 'plan', 'architecture']
}
```

### Settings Metadata (UI Controls)

| Setting | Label | Type | Category | Notes |
|---------|-------|------|----------|-------|
| `crossModelReviewEnabled` | Enable Cross-Model Review | `boolean` | `review` | Master switch |
| `crossModelReviewDepth` | Review Depth | `select` | `review` | Options: structured, tiered |
| `crossModelReviewMaxReviewers` | Max Reviewers | `number` (1-4) | `review` | |
| `crossModelReviewProviders` | Preferred Providers | `multi-select` | `review` | Options populated dynamically from detected CLIs |
| `crossModelReviewTimeout` | Review Timeout (seconds) | `number` (10-120) | `review` | |
| `crossModelReviewTypes` | Review Triggers | `multi-select` | `review` | Options: code, plan, architecture |

The settings UI component must be updated to handle the new `multi-select` type, rendering a list of checkboxes with options from either a static array or a dynamic source.

### Project-Level Override

Via `.ai-orchestrator.json`, using the existing flat `settings` pattern (not a nested object):
```json
{
  "settings": {
    "crossModelReviewEnabled": true,
    "crossModelReviewDepth": "tiered",
    "crossModelReviewProviders": ["gemini", "codex"]
  }
}
```

Follows existing config hierarchy: project > user > defaults. Compatible with existing `mergeConfigs()` function.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `cross-model-review:result` | main -> renderer | Review completed (scores + issues) |
| `cross-model-review:status` | main -> renderer | Reviewer pool status |
| `cross-model-review:dismiss` | renderer -> main | User dismissed a finding |
| `cross-model-review:action` | renderer -> main | User chose: ignore / ask-primary / show-full / start-debate |

Zod schemas must be defined in `src/shared/validation/ipc-schemas.ts` for the two renderer-to-main channels (`dismiss` and `action`). The main-to-renderer channels carry structured data validated at the source.

## UI: Non-Intrusive Notifications

### Review Status Indicator

Small indicator in the instance header (same weight as existing badges):

- **Reviewing...** (spinner) -- review in progress
- **Verified** (green checkmark) -- all reviewers approved
- **Concerns** (amber dot + count) -- issues found, click to expand
- **Skipped** (grey dash) -- no reviewers available

### Expandable Review Panel

Inline collapsible panel below the output (not a popup or sidebar):

```
+---------------------------------------------------------+
| ! Cross-Model Review: 2 concerns found                  |
|                                                         |
| Gemini (structured review)                              |
|   Correctness: 4/4  Completeness: 3/4                  |
|   Security: 2/4  Consistency: 4/4                       |
|   -> "SQL query uses string interpolation instead       |
|      of parameterized queries in getUserById"           |
|                                                         |
| Codex (structured review)                               |
|   Correctness: 4/4  Completeness: 4/4                  |
|   Security: 2/4  Consistency: 4/4                       |
|   -> "Same SQL injection concern in getUserById"        |
|                                                         |
| [Dismiss]  [Ask Claude to Address]  [Full Review]       |
| [Start Debate]                                          |
+---------------------------------------------------------+
```

### Action Buttons

| Button | Behavior |
|--------|----------|
| Dismiss | Close panel, mark acknowledged |
| Ask Claude to Address | Send concerns to primary as follow-up message |
| Full Review | Expand complete JSON review from each reviewer |
| Start Debate | Dispatch to existing DebateCoordinator |

### Review History

Stored per-instance in memory (`Map<string, ReviewResult[]>`), accessible via "Review History" tab in instance detail panel. Maximum 50 reviews per instance (FIFO eviction). History is cleared when an instance is removed — no persistence to disk (reviews are transient, the code itself is the source of truth).

## Integration Points

### Startup (in `src/main/index.ts`)

Initialized after ProviderRegistry:
```
CrossModelReviewService.getInstance().initialize()
  -> Query ModelDiscovery for available CLIs
  -> Build initial ReviewerPool
  -> Subscribe to instance:output events
  -> Start rate-limit recovery timer
```

### Event Bus

```
instance:output             -> CrossModelReviewService (buffers assistant messages)
instance:batch-update       -> CrossModelReviewService (triggers classification when status becomes idle/waiting)
instance:removed            -> Cancel pending reviews, clear buffer
app:before-quit             -> Cancel all pending, cleanup

CrossModelReviewService emits:
  review:started            -> UI spinner
  review:result             -> UI notification
  review:all-unavailable    -> UI grey dash
```

### CLI Adapter Usage

Uses existing adapters via `createCliAdapter(cliType, options)` — same pattern as `default-invokers.ts`:

```typescript
const adapter = createCliAdapter(cliType, {
  workingDirectory: instanceWorkDir,  // same codebase context as primary
  timeout: settings.crossModelReviewTimeout * 1000,
  // model: undefined — use CLI's default model
});

// Check adapter compatibility
if (isBaseCliAdapterLike(adapter)) {
  const response = await adapter.sendMessage({
    role: 'user',
    content: reviewPrompt,
  });
  // Parse response.content as JSON review result
}
```

Each reviewer call is wrapped in the existing `CircuitBreakerRegistry` for the reviewer's provider, matching how `default-invokers.ts` handles fault tolerance.

`workingDirectory` is passed so reviewers have the same codebase context as the primary instance.

### What We Don't Touch

- `MultiVerifyCoordinator` -- different purpose (parallel consensus)
- `DebateCoordinator` -- stays as-is, invoked only via "Start Debate" button
- `default-invokers.ts` -- no changes
- Primary instance flow -- zero changes

## New Files

| File | Purpose |
|------|---------|
| `src/main/orchestration/cross-model-review-service.ts` | Main service (singleton) |
| `src/main/orchestration/cross-model-review.types.ts` | Types & interfaces |
| `src/main/orchestration/output-classifier.ts` | Heuristic classification |
| `src/main/orchestration/reviewer-pool.ts` | Round-robin, failover, rate-limit |
| `src/main/orchestration/review-prompts.ts` | Prompt templates |
| `src/main/ipc/cross-model-review-ipc.ts` | IPC handler registration |
| `src/shared/types/cross-model-review.types.ts` | Shared types for IPC |
| `src/renderer/app/features/review-panel/` | Angular component for UI panel |

## Testing Strategy

- **OutputClassifier**: Pure unit tests (Vitest) — feed various output strings, assert correct classification and complexity scores
- **ReviewerPool**: Unit tests for state machine — round-robin ordering, failover after N failures, rate-limit recovery, exclusion of primary provider
- **Review result parsing**: Unit tests — valid JSON, fenced JSON, malformed JSON, missing fields, Zod validation
- **CrossModelReviewService integration**: Mock CLI adapters, verify end-to-end flow from `instance:output` → buffer → classify → dispatch → collect → emit `review:result`
- **Settings UI**: Verify `multi-select` component renders and persists correctly

## Research Sources

Prompt design informed by:
- HuggingFace LLM-as-Judge Cookbook (reasoning-before-scoring, 1-4 scale)
- MT-Bench judge prompts (Zheng et al., LMSYS)
- Chain-of-Verification (Meta AI, ACL 2024)
- CollabEval multi-agent judging (Amazon Science)
- Constitutional AI critique-revision (Anthropic)
- Arize AI evidence-based prompting
- Evidently AI dimension-specific evaluation
