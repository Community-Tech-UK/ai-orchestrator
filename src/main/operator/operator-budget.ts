import type {
  OperatorRunBudget,
  OperatorRunRecord,
  OperatorRunUsage,
} from '../../shared/types/operator.types';

export type OperatorBudgetLimit =
  | 'maxNodes'
  | 'maxRetries'
  | 'maxWallClockMs'
  | 'maxTokens'
  | 'maxConcurrentNodes';

export interface OperatorBudgetBreach {
  limit: OperatorBudgetLimit;
  allowed: number;
  actual: number;
  message: string;
}

export interface OperatorBudgetEvaluationOptions {
  nodesToStart?: number;
  retriesToUse?: number;
  concurrentNodes?: number;
  usageJson?: Partial<OperatorRunUsage>;
}

export function evaluateOperatorBudget(
  run: Pick<OperatorRunRecord, 'budget' | 'usageJson'>,
  options: OperatorBudgetEvaluationOptions = {},
): OperatorBudgetBreach | null {
  const budget = run.budget;
  const usage: OperatorRunUsage = {
    ...run.usageJson,
    ...options.usageJson,
  };

  const projectedNodesStarted = usage.nodesStarted + (options.nodesToStart ?? 0);
  if (projectedNodesStarted > budget.maxNodes) {
    return breach('maxNodes', budget.maxNodes, projectedNodesStarted, 'would be exceeded');
  }

  const projectedRetries = usage.retriesUsed + (options.retriesToUse ?? 0);
  if (projectedRetries > budget.maxRetries) {
    return breach('maxRetries', budget.maxRetries, projectedRetries, 'would be exceeded');
  }

  if (usage.wallClockMs > budget.maxWallClockMs) {
    return breach('maxWallClockMs', budget.maxWallClockMs, usage.wallClockMs, 'exceeded');
  }

  if (
    budget.maxTokens !== undefined
    && usage.tokensUsed !== undefined
    && usage.tokensUsed > budget.maxTokens
  ) {
    return breach('maxTokens', budget.maxTokens, usage.tokensUsed, 'exceeded');
  }

  const concurrentNodes = options.concurrentNodes ?? 0;
  if (concurrentNodes > budget.maxConcurrentNodes) {
    return breach('maxConcurrentNodes', budget.maxConcurrentNodes, concurrentNodes, 'would be exceeded');
  }

  return null;
}

export function budgetBreachPayload(
  breach: OperatorBudgetBreach,
  budget: OperatorRunBudget,
  usage: OperatorRunUsage,
): Record<string, unknown> {
  return {
    limit: breach.limit,
    allowed: breach.allowed,
    actual: breach.actual,
    message: breach.message,
    budget,
    usage,
  };
}

function breach(
  limit: OperatorBudgetLimit,
  allowed: number,
  actual: number,
  suffix: string,
): OperatorBudgetBreach {
  return {
    limit,
    allowed,
    actual,
    message: `Budget exhausted: ${limit} ${suffix}`,
  };
}
