export type LoopContextStrategyName = 'fresh-child' | 'hybrid' | 'same-session';

export interface LoopCommitRatchetConfig {
  enabled: boolean;
  worktreeOnly: boolean;
  keepPolicy: 'score-improvement';
  resetOnRegression: boolean;
}

export interface LoopFreshSessionPerIterationConfig {
  enabled: boolean;
}

export interface LoopSubagentContractsConfig {
  enabled: boolean;
  maxDepth: number;
  requireNonOverlappingWriteScopes: boolean;
}

export interface LoopToolRwLockConfig {
  enabled: boolean;
}

export interface LoopPhase4Config {
  commitRatchet: LoopCommitRatchetConfig;
  freshSessionPerIteration: LoopFreshSessionPerIterationConfig;
  subagentContracts: LoopSubagentContractsConfig;
  toolRwLocks: LoopToolRwLockConfig;
}

export type LoopPhase4ConfigInput = {
  commitRatchet?: Partial<LoopCommitRatchetConfig>;
  freshSessionPerIteration?: Partial<LoopFreshSessionPerIterationConfig>;
  subagentContracts?: Partial<LoopSubagentContractsConfig>;
  toolRwLocks?: Partial<LoopToolRwLockConfig>;
};

export function defaultLoopPhase4Config(): LoopPhase4Config {
  return {
    commitRatchet: {
      enabled: false,
      worktreeOnly: true,
      keepPolicy: 'score-improvement',
      resetOnRegression: true,
    },
    freshSessionPerIteration: { enabled: false },
    subagentContracts: {
      enabled: false,
      maxDepth: 1,
      requireNonOverlappingWriteScopes: true,
    },
    toolRwLocks: { enabled: false },
  };
}

export function normalizeLoopPhase4Config(input?: LoopPhase4ConfigInput | null): LoopPhase4Config {
  const defaults = defaultLoopPhase4Config();
  return {
    commitRatchet: { ...defaults.commitRatchet, ...(input?.commitRatchet ?? {}) },
    freshSessionPerIteration: {
      ...defaults.freshSessionPerIteration,
      ...(input?.freshSessionPerIteration ?? {}),
    },
    subagentContracts: {
      ...defaults.subagentContracts,
      ...(input?.subagentContracts ?? {}),
    },
    toolRwLocks: { ...defaults.toolRwLocks, ...(input?.toolRwLocks ?? {}) },
  };
}

export function resolvePhase4ContextStrategy(
  contextStrategy: LoopContextStrategyName,
  phase4?: LoopPhase4ConfigInput | null,
): LoopContextStrategyName {
  return phase4?.freshSessionPerIteration?.enabled ? 'fresh-child' : contextStrategy;
}
