# Orchestrator Benchmark Design

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE (code).** The harness in `benchmarks/orchestrator-benchmark/` implements this design: runner, task loader, executors, context filler with needle planting, deterministic NIAH scoring and blind judging over the 15-task suite. Running a benchmark round is an operational activity, not implementation work.


> **Implementation**: See [`benchmarks/orchestrator-benchmark/`](../../benchmarks/orchestrator-benchmark/) for the harness code and [`README.md`](../../benchmarks/orchestrator-benchmark/README.md) for usage instructions.

**Goal:** Determine if AI Orchestrator produces better results than vanilla Claude CLI for software engineering tasks, particularly those with multi-file scope or requiring large context.

**Primary Questions:**
1. Does orchestrator produce more correct/complete answers?
2. Does orchestrator handle complex tasks better than single Claude?
3. Does orchestrator's advantage grow as context fills up?

---

## Experiment Config (Locked)

To ensure apples-to-apples comparison, both systems share these fixed parameters:

| Parameter | Value |
|-----------|-------|
| Model version | Claude claude-sonnet-4-20250514 (via CLI) |
| Temperature | 0 (deterministic) |
| Max output tokens | 16384 |
| Working directory | Repository root |
| Tool access | All tools enabled (read, write, bash, etc.) |

**System prompts:**
- Vanilla: Default Claude CLI system prompt
- Orchestrator: Default orchestrator system prompt (includes coordination instructions)

**Note:** System prompts are intentionally different; this benchmark measures end-to-end product behavior, not prompt-controlled parity.

---

## Run Isolation & Reset

Each run must start from a clean repository state to avoid contamination:

**Method:** Git worktree per run (preferred)
1. Create temporary worktree: `git worktree add /tmp/bench-<session>-<run> HEAD`
2. Execute benchmark run in isolated worktree
3. Delete worktree after completion: `git worktree remove /tmp/bench-<session>-<run>`

**Fallback method** (if worktrees unavailable):
1. `git stash --include-untracked`
2. `git reset --hard HEAD`
3. Execute run
4. `git stash pop` (if this fails, abort and reset; do not continue with a dirty tree)

All runs within a session must use the same isolation method.

---

## Run Order Randomization

To reduce drift bias (API performance, caching effects, time-of-day variations):
- Randomize task order within each session
- Randomize system order (vanilla vs orchestrator) per task
- Randomize context stage order per system

The runner logs the randomized order for reproducibility.

---

## Task Categories

### Category A: Known-Answer Tasks (Objective)
Tasks with verifiable correct answers for objective measurement.

### Category B: Real Codebase Tasks (Subjective)
Tasks on the orchestrator repo evaluated by LLM judges.

### Category C: Needle-In-A-Haystack Tasks (Context Retrieval)
Tasks that plant specific facts ("needles") into conversation context and test whether the system can retrieve them under context pressure. These directly measure context management quality — the orchestrator's key architectural advantage.

**Motivation:** Standard NIAH benchmarks (e.g., [LLMTest_NeedleInAHaystack](https://github.com/gkamradt/LLMTest_NeedleInAHaystack)) test raw model retrieval, but no existing benchmark tests **agent-level** NIAH comparing orchestrated multi-agent systems vs single agents. Research shows context degradation is non-linear ([Context Rot, Chroma Research](https://research.trychroma.com/context-rot)) and that multi-needle retrieval fails significantly as context grows ([MECW paper](https://www.oajaiml.com/uploads/archivepdf/643561268.pdf)).

**How it works:**
1. Needles are planted at specified depth positions within the conversation context
2. Each needle is wrapped in a realistic conversation exchange (file exploration, code review, debug session, etc.)
3. The system is then asked a question requiring retrieval of the planted facts
4. Scoring is deterministic: did the output contain the required facts?

**What this tests in the orchestrator:**
- Context compaction (preserving important facts during summarization)
- RLM context query engine (semantic retrieval of relevant context)
- Child instance spawning (fresh context for retrieval-heavy sub-tasks)

---

## Task Suite (15 Tasks)

### Known-Answer Tasks (4 tasks)

| ID | Task | Complexity | Verification Method |
|----|------|------------|---------------------|
| KA-1 | "Find all IPC handlers in the codebase" | Multi-file | Count match |
| KA-2 | "List all singleton services with `getInstance()`" | Multi-file | File list match |
| KA-3 | "What files import from `orchestration-handler.ts`?" | Multi-file | File list match |
| KA-4 | Inject 3 bugs into test files, ask "find the bugs" | Multi-file | Found 3/3? |

### Real Codebase Tasks (6 tasks)

| ID | Task | Complexity |
|----|------|------------|
| RC-1 | "Explain how model routing decides which model to use for child tasks" | Large-context |
| RC-2 | "What happens if a child instance crashes mid-task?" | Multi-file |
| RC-3 | "Review the fast-path retrieval code for edge cases" | Multi-file |
| RC-4 | "How would you add a new orchestrator command?" | Large-context |
| RC-5 | "What are all the ways an instance can fail?" | Multi-file |
| RC-6 | "Trace a message from user input to child spawn" | Large-context |

> **Note:** RC-6 was moved from Known-Answer (KA-5) because trace completeness is inherently subjective - there's no single "correct" trace path.

### Needle-In-A-Haystack Tasks (5 tasks)

| ID | Task | Needles | Needle Depth | Verification |
|----|------|---------|-------------|--------------|
| NIAH-1 | Single needle retrieval — retrieve a rate limiter config value | 1 | 30% | Exact fact match |
| NIAH-2 | Multi-needle synthesis — combine 3 timeout values from separate discussions | 3 | 15%, 45%, 70% | All 3 facts + reasoning |
| NIAH-3 | Needle + reasoning — calculate max concurrent DB ops from 2 scattered configs | 2 | 25%, 60% | Facts + arithmetic synthesis |
| NIAH-4 | Contradictory context — resolve old vs corrected IPC message size | 2 | 20%, 55% | Must prefer corrected value |
| NIAH-5 | Cross-file scattered — find a specific code detail among 5 file explorations (4 decoys) | 5 (1 target + 4 decoys) | 10%-80% | Target fact retrieval despite distractors |

**Scoring:** NIAH tasks use deterministic scoring (no LLM judge needed):
- `retrievalAccuracy`: percentage of required facts found in output (0-100%)
- `needleResults`: per-needle hit/miss with exact vs paraphrased match
- `reasoningCorrect`: for multi-needle tasks, whether the synthesized answer is correct
- `niahCorrectness`: unified 0-100 score (retrieval accuracy +/- reasoning bonus/penalty)

**Context resilience hypothesis:** NIAH tasks should show the steepest performance delta between orchestrator and vanilla at heavy context levels, because:
- Vanilla Claude's retrieval degrades as context fills (especially for facts near the beginning)
- Orchestrator can use RLM to semantically retrieve relevant context
- Orchestrator can spawn children with clean context to re-examine specific areas

---

## Evaluation Method

### Known-Answer Tasks (Category A)
- **Correctness score**: Did it find/fix all the things? (0-100%)
- **Completeness**: Any false negatives (missed items)?
- **Precision**: Any false positives (wrong items)?

### Real Codebase Tasks (Category B)
- **Dual LLM-as-judge**: Claude + Codex both score outputs
- **Blind comparison**: Judges see both outputs without knowing which is orchestrator vs vanilla
- **Scoring rubric**:
  - Completeness (0-10): Covered all relevant files/aspects?
  - Accuracy (0-10): Statements are factually correct about the code?
  - Actionability (0-10): Could you act on this answer?
- **Human spot-check**: Verify sample of judge decisions, especially disagreements

### NIAH Tasks (Category C)
- **Deterministic scoring** — no LLM judge required
- **Retrieval accuracy**: percentage of planted facts found in output
- **Per-needle tracking**: exact match vs paraphrased vs missed
- **Reasoning check**: for multi-needle tasks, whether synthesized answer is correct
- **Unified score**: `niahCorrectness` (0-100) with reasoning bonus/penalty

### Secondary Metrics (All Tasks)
- Total tokens used (cost proxy)
- Wall-clock time

---

## Context Pressure Testing

**Hypothesis:** Orchestrator's advantage grows as context fills up because:
- Single Claude degrades as context window fills
- Orchestrator spawns fresh children with clean context

### Context Stages

| Stage | Context Fill | Description |
|-------|--------------|-------------|
| Fresh | 0-10% | Task given at start of session |
| Moderate | 30-50% | Target tokens computed as % of model context window |
| Heavy | 70-80% | Target tokens computed as % of model context window |

### Context Resilience Metric
```
context_resilience = (heavy_score / fresh_score) × 100%
```
Higher = more resilient to context pressure.

---

## Test Matrix

Each task runs:
- 2 systems (Vanilla Claude CLI, Orchestrator)
- 3 runs per system (median for statistical confidence)
- 3 context stages (Fresh, Moderate, Heavy)

**Total runs:** 15 tasks × 2 systems × 3 runs × 3 context stages = **270 runs**
- Category A (KA): 4 × 2 × 3 × 3 = 72 runs
- Category B (RC): 6 × 2 × 3 × 3 = 108 runs
- Category C (NIAH): 5 × 2 × 3 × 3 = 90 runs

**Note:** Run order is randomized to reduce drift bias (see Run Order Randomization section).

---

## Architecture

### Components

```
benchmarks/orchestrator-benchmark/
├── runner.ts              # Main benchmark orchestration
├── task-loader.ts         # Load tasks from JSON
├── executors/
│   ├── vanilla-executor.ts    # Run task with vanilla Claude CLI
│   └── orchestrator-executor.ts # Run task with Orchestrator
├── context-filler.ts      # Pre-fill context to target level
├── judge.ts               # Send outputs to Claude + Codex judges
├── scorer.ts              # Score known-answer tasks
├── result-storage.ts      # Persist results and generate reports
├── tasks/
│   ├── task-suite.json    # Task definitions
│   └── setup/             # Setup scripts for known-answer tasks
└── results/               # Output directory for results (gitignored)
```

### Task Definition Format

```typescript
interface BenchmarkTask {
  id: string;
  name: string;
  category: 'known-answer' | 'real-codebase';
  complexity: 'single-file' | 'multi-file' | 'large-context';
  prompt: string;
  workingDirectory: string;
  // For known-answer tasks:
  expectedAnswer?: {
    files?: string[];      // expected files to find/modify
    patterns?: string[];   // expected patterns in output
    count?: number;        // expected count of items
  };
  timeoutMinutes: number;
}
```

### Result Storage Format

```typescript
interface BenchmarkRun {
  taskId: string;
  system: 'vanilla' | 'orchestrator';
  contextStage: 'fresh' | 'moderate' | 'heavy';
  runNumber: 1 | 2 | 3;

  // Output
  output: string;

  // Metrics
  tokensUsed: number;
  durationMs: number;

  // Scores (filled after judging)
  knownAnswerScore?: {
    correctness: number;    // 0-100
    falseNegatives: number;
    falsePositives: number;
  };
  judgeScores?: {
    claude: { completeness: number; accuracy: number; actionability: number };
    codex: { completeness: number; accuracy: number; actionability: number };
  };
}
```

---

## Judging Pipeline

### Blind Evaluation Prompt

```
You are evaluating two responses to a software engineering task.
You do not know which response comes from which system.

Task: {task.prompt}

Response A:
{randomized_output_1}

Response B:
{randomized_output_2}

Score each response on:
1. Completeness (0-10): Did it cover all relevant files and aspects?
2. Accuracy (0-10): Are the statements factually correct about the code?
3. Actionability (0-10): Could someone act on this answer?

Return JSON:
{
  "response_a": { "completeness": N, "accuracy": N, "actionability": N, "notes": "..." },
  "response_b": { "completeness": N, "accuracy": N, "actionability": N, "notes": "..." }
}
```

### Agreement Tracking
- If Claude and Codex disagree by >2 points on any dimension, flag for human review
- Track overall agreement rate as quality metric for the judging process

---

## Implementation Phases

### Phase 1: Core Harness (No API usage) ✅
- [x] Create directory structure
- [x] Implement `task-loader.ts`
- [x] Implement `vanilla-executor.ts` - spawn Claude CLI, capture output
- [x] Implement `orchestrator-executor.ts` - spawn orchestrator instance
- [x] Implement `context-filler.ts` - pre-fill context to target levels
- [x] Implement result storage (JSON files)
- [x] Basic `runner.ts` that can execute tasks

### Phase 2: Task Suite (No API usage) ✅
- [x] Create `task-suite.json` with all 10 tasks
- [x] Create setup scripts for known-answer tasks:
  - [x] KA-1: Script to count IPC handlers (ground truth)
  - [x] KA-2: Script to list singletons (ground truth)
  - [x] KA-3: Script to find imports (ground truth)
  - [x] KA-4: Script to inject/remove bugs
- [x] Create context pre-fill scripts (realistic prior conversation)

### Phase 3: Judging Pipeline (Needs API calls) ✅
- [x] Implement `judge.ts` with Claude integration
- [x] Add Codex integration to `judge.ts`
- [x] Implement blind randomization
- [x] Implement `scorer.ts` for known-answer evaluation
- [x] Agreement tracking and human review flagging

### Phase 3.5: NIAH Task Suite (No API usage) ✅
- [x] Add `NeedleDefinition` and `NiahScore` types
- [x] Add `niah` category to `BenchmarkTask`
- [x] Define 5 NIAH tasks in `task-suite.json` (NIAH-1 through NIAH-5)
- [x] Implement needle planting in `context-filler.ts`
- [x] Implement `scoreNiah()` in `scorer.ts` for deterministic evaluation
- [x] Wire NIAH scoring into `runner.ts`
- [x] Update task-loader validation to accept `niah` category

### Phase 4: Execution (After usage reset)
- [ ] Run full benchmark suite (~270 runs)
- [ ] Monitor for failures, re-run as needed
- [ ] Estimated duration: several hours

### Phase 5: Analysis & Reporting
- [ ] Implement `reporter.ts`
- [ ] Generate per-task comparison table
- [ ] Aggregate win/loss/tie by category and complexity
- [ ] Calculate cost multiplier (orchestrator tokens / vanilla tokens)
- [ ] Plot context resilience curves
- [ ] **NIAH-specific**: Plot retrieval accuracy vs context depth per system
- [ ] **NIAH-specific**: Heatmap showing needle retrieval by depth × context stage
- [ ] Identify patterns: where does orchestrator win/lose?

---

## Expected Output

### Summary Report

```
ORCHESTRATOR BENCHMARK RESULTS
==============================

Overall: Orchestrator wins 10/15 tasks, ties 3, loses 2

By Category:
  Known-Answer (KA):  Orchestrator 3/4 wins
  Real-Codebase (RC): Orchestrator 4/6 wins
  NIAH (Context):     Orchestrator 3/5 wins

By Complexity:
  Multi-file tasks:   Orchestrator +15% avg score
  Large-context tasks: Orchestrator +22% avg score

Context Resilience:
  Vanilla Claude:    85% → 72% → 58% (Fresh → Moderate → Heavy)
  Orchestrator:      87% → 84% → 79%

NIAH Context Retrieval:
  Vanilla Claude:    95% → 60% → 35% (Fresh → Moderate → Heavy)
  Orchestrator:      95% → 88% → 75%

Cost Multiplier: 2.3x (orchestrator uses 2.3x tokens on average)

Recommendation: Use orchestrator for multi-file, large-context, and
retrieval-intensive tasks where quality matters more than cost.
```

### Detailed Per-Task Results

| Task | Winner | Vanilla Score | Orch Score | Cost Ratio | Context Resilience |
|------|--------|---------------|------------|------------|-------------------|
| KA-1 | Orch   | 80%           | 95%        | 1.8x       | 0.92 vs 0.71      |
| ...  | ...    | ...           | ...        | ...        | ...               |
| NIAH-1 | Orch | 90%           | 100%       | 1.5x       | 0.95 vs 0.40      |
| ...  | ...    | ...           | ...        | ...        | ...               |

---

## Notes

- Run after weekly usage reset to avoid impacting daily work
- Budget for ~270 API calls per system (540 total for execution)
- Plus judging calls for RC tasks: ~108 × 2 judges = 216 judge calls
- NIAH and KA tasks scored deterministically (no judge calls needed)
- Total estimated: ~756 API calls for full benchmark
