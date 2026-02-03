/**
 * Benchmark types for orchestrator comparison testing
 */

export interface BenchmarkTask {
  id: string;
  name: string;
  category: 'known-answer' | 'real-codebase';
  complexity: 'single-file' | 'multi-file' | 'large-context';
  prompt: string;
  workingDirectory: string;
  /** For known-answer tasks: expected results for verification */
  expectedAnswer?: {
    files?: string[];
    patterns?: string[];
    count?: number;
  };
  /** Setup script to run before task (e.g., inject bugs) */
  setupScript?: string;
  /** Teardown script to run after task (e.g., remove bugs) */
  teardownScript?: string;
  timeoutMinutes: number;
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
  /** Files that were examined/read during execution */
  filesExamined: string[];

  /** Total tokens consumed */
  tokensUsed: number;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Timestamp when run started */
  startedAt: number;
  /** Timestamp when run completed */
  completedAt: number;

  /** For known-answer tasks */
  knownAnswerScore?: KnownAnswerScore;
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
  };
  byComplexity: {
    'multi-file': { orchestratorAvgScore: number; vanillaAvgScore: number };
    'large-context': { orchestratorAvgScore: number; vanillaAvgScore: number };
    'single-file': { orchestratorAvgScore: number; vanillaAvgScore: number };
  };
}

export interface ExecutorResult {
  output: string;
  filesExamined: string[];
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

export interface ContextFillerOptions {
  stage: ContextStage;
  workingDirectory: string;
}
