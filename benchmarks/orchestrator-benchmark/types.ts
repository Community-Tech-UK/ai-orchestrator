/**
 * Benchmark types for orchestrator comparison testing
 */

export interface BenchmarkTask {
  id: string;
  name: string;
  category: 'known-answer' | 'real-codebase' | 'niah';
  complexity: 'single-file' | 'multi-file' | 'large-context';
  prompt: string;
  workingDirectory: string;
  /** For known-answer tasks: expected results for verification */
  expectedAnswer?: {
    files?: string[];
    patterns?: string[];
    count?: number;
  };
  /** For NIAH tasks: needle definitions planted into context */
  needles?: NeedleDefinition[];
  /** For NIAH tasks: expected retrieval answers */
  expectedRetrieval?: {
    /** Exact strings that must appear in the output */
    requiredFacts: string[];
    /** Strings where at least one must appear (for paraphrased answers) */
    acceptableVariants?: string[][];
    /** Whether the task requires reasoning across multiple needles */
    requiresMultiNeedleReasoning?: boolean;
  };
  /** Setup script to run before task (e.g., inject bugs) */
  setupScript?: string;
  /** Teardown script to run after task (e.g., remove bugs) */
  teardownScript?: string;
  timeoutMinutes: number;
}

/**
 * A "needle" is a specific fact planted into the conversation context
 * that the system should be able to retrieve later.
 */
export interface NeedleDefinition {
  /** Unique ID for this needle */
  id: string;
  /** The fact to embed in conversation context */
  content: string;
  /** Where in the context to place the needle (0.0 = start, 1.0 = end) */
  depthPercent: number;
  /** How the needle should be wrapped in context */
  wrapper: 'file-exploration' | 'analysis-discussion' | 'code-review' | 'debug-session';
  /** The file path context the needle appears in (for realism) */
  contextFile?: string;
}

export interface NiahScore {
  /** How many required facts were retrieved (0-100%) */
  retrievalAccuracy: number;
  /** Individual needle retrieval results */
  needleResults: {
    needleId: string;
    found: boolean;
    /** Whether the fact was exactly quoted vs paraphrased */
    exactMatch: boolean;
  }[];
  /** For multi-needle reasoning tasks: was the synthesis correct? */
  reasoningCorrect?: boolean;
}

export type ContextStage = 'fresh' | 'moderate' | 'heavy';
export type SystemType = 'vanilla' | 'orchestrator';

export interface KnownAnswerScore {
  /** Percentage of expected items found (0-100) */
  correctness: number;
  /** Count of expected items not found */
  falseNegatives: number;
  /** Count of unexpected items reported */
  falsePositives: number;
}

export interface JudgeScore {
  /** Did it cover all relevant files/aspects? (0-10) */
  completeness: number;
  /** Are statements factually correct? (0-10) */
  accuracy: number;
  /** Could someone act on this answer? (0-10) */
  actionability: number;
  notes?: string;
}

export interface JudgeScores {
  claude: JudgeScore;
  codex: JudgeScore;
  /** True if judges disagree by >2 points on any dimension */
  needsHumanReview: boolean;
}

export interface BenchmarkRun {
  taskId: string;
  system: SystemType;
  contextStage: ContextStage;
  runNumber: 1 | 2 | 3;

  /** Raw output from the system */
  output: string;

  /** Total tokens consumed */
  tokensUsed: number;
  /** Detailed token breakdown (input/output/cache) */
  tokenBreakdown?: TokenUsageBreakdown;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Timestamp when run started */
  startedAt: number;
  /** Timestamp when run completed */
  completedAt: number;

  /** For known-answer tasks */
  knownAnswerScore?: KnownAnswerScore;
  /** For NIAH tasks */
  niahScore?: NiahScore;
  /** For real-codebase tasks */
  judgeScores?: JudgeScores;

  /** Any errors that occurred */
  error?: string;
}

export interface TaskResult {
  taskId: string;
  task: BenchmarkTask;
  runs: BenchmarkRun[];
  /** Median scores across runs */
  medianScores: {
    vanilla: {
      fresh: number;
      moderate: number;
      heavy: number;
    };
    orchestrator: {
      fresh: number;
      moderate: number;
      heavy: number;
    };
  };
  /** Winner for this task */
  winner: 'vanilla' | 'orchestrator' | 'tie';
  /** Cost ratio (orchestrator tokens / vanilla tokens) */
  costRatio: number;
  /** Context resilience (heavy_score / fresh_score) */
  contextResilience: {
    vanilla: number;
    orchestrator: number;
  };
  /** Token efficiency metrics */
  tokenEfficiency?: {
    vanilla: TokenEfficiency;
    orchestrator: TokenEfficiency;
  };
}

export interface BenchmarkReport {
  startedAt: number;
  completedAt: number;
  tasks: TaskResult[];
  summary: {
    orchestratorWins: number;
    vanillaWins: number;
    ties: number;
    avgCostRatio: number;
    avgContextResilienceVanilla: number;
    avgContextResilienceOrchestrator: number;
    /** Average tokens per correct answer (vanilla) */
    avgTokensPerCorrectVanilla: number;
    /** Average tokens per correct answer (orchestrator) */
    avgTokensPerCorrectOrchestrator: number;
    /** Aggregate token breakdown */
    totalTokenBreakdown?: {
      vanilla: TokenUsageBreakdown;
      orchestrator: TokenUsageBreakdown;
    };
  };
  byComplexity: {
    'multi-file': { orchestratorAvgScore: number; vanillaAvgScore: number };
    'large-context': { orchestratorAvgScore: number; vanillaAvgScore: number };
    'single-file': { orchestratorAvgScore: number; vanillaAvgScore: number };
  };
}

/** Detailed token usage breakdown */
export interface TokenUsageBreakdown {
  /** Tokens consumed reading input/context */
  inputTokens: number;
  /** Tokens generated as output */
  outputTokens: number;
  /** Tokens served from cache (subset of input) */
  cacheReadTokens: number;
  /** Tokens written to cache for future use */
  cacheWriteTokens: number;
}

export interface ExecutorResult {
  output: string;
  tokensUsed: number;
  /** Detailed token breakdown when available */
  tokenBreakdown?: TokenUsageBreakdown;
  durationMs: number;
  error?: string;
}

export interface ContextFillerOptions {
  stage: ContextStage;
  workingDirectory: string;
}

/** Token efficiency metrics for a task result */
export interface TokenEfficiency {
  /** Tokens per percentage point of correctness */
  tokensPerCorrectPoint: number;
  /** Cost ratio relative to vanilla baseline */
  costMultiplier: number;
  /** For orchestrator: ratio of parent tokens to total (coordination overhead) */
  coordinationOverhead?: number;
}

/** Quick eval preset configuration */
export interface QuickEvalConfig {
  /** Task IDs to include */
  taskIds: string[];
  /** Context stages to test */
  stages: ContextStage[];
  /** Number of runs per config */
  runsPerConfig: number;
}
