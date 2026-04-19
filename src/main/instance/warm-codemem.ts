/**
 * Bounded codemem workspace warm-up.
 *
 * `CodememService.warmWorkspace` can take arbitrarily long on large workspaces
 * or when the main process event loop is saturated (e.g. many restored
 * instances streaming output concurrently after a history restore). This helper
 * races the warm-up against a timeout so the spawn critical path is never
 * blocked for more than `timeoutMs` milliseconds. If the timeout wins, the
 * warm-up continues running in the background and any eventual rejection is
 * swallowed to avoid an unhandled promise rejection.
 *
 * Exported as a standalone helper (not a private method) so it can be unit
 * tested without standing up the full InstanceLifecycleManager, which pulls in
 * 30+ modules.
 */
import type { SubsystemLogger } from '../logging/logger';

export interface WarmCodememTarget {
  isEnabled(): boolean;
  warmWorkspace(workspacePath: string): Promise<{ ready: boolean; filePath: string | null }>;
}

export interface WarmCodememOptions {
  workspacePath: string;
  timeoutMs: number;
  logger: Pick<SubsystemLogger, 'info' | 'warn'>;
}

type WarmOutcome =
  | { status: 'ok'; result: { ready: boolean; filePath: string | null } }
  | { status: 'error'; error: unknown }
  | { status: 'timeout' };

/**
 * Warm the codemem workspace for `workspacePath`, bounded by `timeoutMs`.
 * Returns when the warm-up completes, fails, or the timeout fires — whichever
 * happens first. Never throws.
 */
export async function warmCodememWithTimeout(
  codemem: WarmCodememTarget,
  options: WarmCodememOptions,
): Promise<void> {
  if (!codemem.isEnabled()) {
    return;
  }

  const { workspacePath, timeoutMs, logger } = options;

  const warmPromise: Promise<WarmOutcome> = codemem
    .warmWorkspace(workspacePath)
    .then<WarmOutcome>((result) => ({ status: 'ok', result }))
    .catch<WarmOutcome>((error: unknown) => ({ status: 'error', error }));

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<WarmOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  const outcome = await Promise.race([warmPromise, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  if (outcome.status === 'ok') {
    logger.info('Codemem workspace warm-up completed', {
      workspacePath,
      ready: outcome.result.ready,
      representativeFile: outcome.result.filePath,
    });
    return;
  }

  if (outcome.status === 'timeout') {
    logger.warn(
      'Codemem workspace warm-up exceeded timeout; continuing spawn without blocking',
      { workspacePath, timeoutMs },
    );
    // Let the in-flight warmup keep running in the background. Swallow any
    // eventual rejection so we don't leave an unhandled promise rejection.
    warmPromise.catch(() => undefined);
    return;
  }

  logger.warn('Codemem workspace warm-up failed; continuing without blocking spawn', {
    workspacePath,
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
  });
}
