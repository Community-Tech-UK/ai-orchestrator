import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { getLogger } from '../logging/logger';
import { retryWithBackoff } from '../util/backoff';

const logger = getLogger('AuxiliaryGenerationRetry');
const AUXILIARY_GENERATION_ATTEMPTS = 2;

export async function retryAuxiliaryGeneration<T>(
  operation: () => Promise<T>,
  context: { endpointId: string; provider: string },
): Promise<T> {
  return retryWithBackoff(operation, {
    attempts: AUXILIARY_GENERATION_ATTEMPTS,
    classify: classifyAuxiliaryGenerationError,
    onRetry: ({ attempt, category, delayMs }) => {
      logger.warn('Retrying transient auxiliary generation failure', {
        ...context,
        attempt,
        category,
        delayMs,
      });
    },
  });
}

function classifyAuxiliaryGenerationError(error: unknown): ErrorCategory {
  const shaped = error as { status?: unknown; statusCode?: unknown } | null;
  const status = typeof shaped?.status === 'number'
    ? shaped.status
    : typeof shaped?.statusCode === 'number'
      ? shaped.statusCode
      : undefined;
  if (status === 429) return ErrorCategory.RATE_LIMITED;
  if (status !== undefined && status >= 500 && status <= 599) return ErrorCategory.TRANSIENT;

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed?\s*out|network|fetch failed|ECONNRESET|ECONNREFUSED|EPIPE/i.test(message)) {
    return ErrorCategory.NETWORK;
  }
  return ErrorCategory.UNKNOWN;
}
