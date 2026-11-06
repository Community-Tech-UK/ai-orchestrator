/** Native cache and reasoning counters are subsets of input and output. */
export interface CodexUsageTokens {
  input: number | null;
  cache: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
  estimated: boolean;
}
export interface CodexEphemeralUsage {
  version: 1;
  threadId: string;
  instanceId: string | null;
  jobId: string | null;
  kind: 'chat' | 'child' | 'loop' | 'plan-queue' | 'automation' | 'review';
  /** SHA-256 grouping key; raw configuration never enters the log. */
  trialKey: string | null;
  /** `control` and `candidate` are the arm names earlier builds saved; they stay readable. */
  trialArm: 'cheaper' | 'full' | 'off' | 'control' | 'candidate' | 'unassigned';
  requests: number | null;
  requestsAvailable: boolean;
  /** Root only. Helper usage is separate, never included twice. */
  tokens: CodexUsageTokens;
  helpers: { count: number | null; tokens: CodexUsageTokens };
  compactions: number | null;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  finishReason: 'stopped' | 'runtime-exit' | 'reopened' | 'exec-exit' | 'exec-failed' | 'abandoned';
}
export interface CodexEphemeralUsageResult {
  entries: CodexEphemeralUsage[];
  truncated: boolean;
  skippedLines: number;
}
