export interface CopilotModelCache {
  modelId: string;
  expiresAt: number;
  ttlSeconds: number;
}
export interface SessionSpendModel {
  model: string;
  costUsd: number;
  costKnown?: boolean;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  isMainModel: boolean;
}
export interface SessionSpendBreakdown {
  turns: number;
  totalCostUsd: number;
  estimatedShare: number;
  mainCostUsd: number;
  helperCostUsd: number;
  splitAvailable?: boolean;
  byModel: SessionSpendModel[];
  aiCreditsNano?: number;
  premiumRequests?: number;
  firstAt?: number;
  lastAt?: number;
  copilotCache: CopilotModelCache[];
}
export interface SubagentUsageSample {
  instanceId: string;
  toolUseId: string;
  finalContextTokens: number;
  toolUses: number;
  durationMs: number;
  final: boolean;
}
