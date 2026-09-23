import { getLogger } from '../../logging/logger';
import type { ResumeHealthVerdict } from './runtime-readiness';

const logger = getLogger('RuntimeReconciler');

/**
 * Keep a healthy native resume; fall back only when it is proven unrecoverable.
 * An inconclusive probe gets one more window before the live session is kept.
 */
export async function resolveReconcilerResumeHealth(
  instanceId: string,
  evaluate: () => Promise<ResumeHealthVerdict>,
): Promise<boolean> {
  const first = await evaluate();
  if (first === 'healthy') {
    return true;
  }
  if (first === 'unrecoverable') {
    return false;
  }
  const second = await evaluate();
  if (second === 'unrecoverable') {
    return false;
  }
  if (second === 'inconclusive') {
    logger.warn(
      'Recovery resume health inconclusive after retry; keeping the live session '
      + 'rather than destroying it (host may be overloaded)',
      { instanceId },
    );
  }
  return true;
}
