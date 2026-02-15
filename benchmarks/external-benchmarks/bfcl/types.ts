/**
 * BFCL (Berkeley Function Calling Leaderboard) benchmark types
 */

/** A single BFCL test case */
export interface BFCLTestCase {
  id: string;
  question: string;
  /** Available functions the model can call */
  functions: BFCLFunction[];
  /** Ground truth function call */
  groundTruth: BFCLFunctionCall;
}

export interface BFCLFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BFCLFunctionCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface BFCLResult {
  testCaseId: string;
  system: 'vanilla' | 'orchestrator';
  /** Did the model call the correct function? */
  functionNameCorrect: boolean;
  /** Were all parameters correct? (via AST comparison) */
  parametersCorrect: boolean;
  /** Overall pass (name + params correct) */
  pass: boolean;
  /** Raw model output */
  rawOutput: string;
  /** Parsed function call from output */
  parsedCall?: BFCLFunctionCall;
  /** Token usage */
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export interface BFCLReport {
  totalCases: number;
  results: {
    vanilla: {
      passRate: number;
      functionNameAccuracy: number;
      parameterAccuracy: number;
      avgTokensUsed: number;
      avgInputTokens: number;
      avgOutputTokens: number;
      avgDurationMs: number;
    };
    orchestrator: {
      passRate: number;
      functionNameAccuracy: number;
      parameterAccuracy: number;
      avgTokensUsed: number;
      avgInputTokens: number;
      avgOutputTokens: number;
      avgDurationMs: number;
    };
  };
  /** Per-case detailed results */
  cases: BFCLResult[];
  /** Cost efficiency: orchestrator tokens / vanilla tokens for same pass rate */
  costEfficiencyRatio: number;
  /** Which system was better */
  winner: 'vanilla' | 'orchestrator' | 'tie';
}
