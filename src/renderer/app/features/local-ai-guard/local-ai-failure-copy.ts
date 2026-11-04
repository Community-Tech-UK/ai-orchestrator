import type {
  LocalAiFailureCode,
  LocalAiHealthLayer,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';

/** One plain-English reason per health failure, shared by every Local AI screen. */
export const LOCAL_AI_FAILURE_REASONS: Record<LocalAiFailureCode, string> = {
  'worker-offline': 'Remote computer offline',
  'worker-degraded': 'Remote computer slow to respond',
  'rpc-unavailable': 'Remote computer not answering',
  'endpoint-not-advertised': 'Model server not found',
  'configuration-drift': 'Model server settings changed',
  'connection-refused': 'Model server refused the connection',
  'endpoint-timeout': 'Model server not responding',
  'protocol-error': 'Model server gave an unexpected reply',
  'authentication-error': 'Model server rejected the sign-in',
  'missing-required-model': 'Required model missing',
  'insufficient-context': 'Model context too small',
  'inference-timeout': 'Model too slow to reply',
  'malformed-inference-output': 'Model gave an unusable reply',
  'latency-exceeded': 'Replies slower than the limit',
  flapping: 'Keeps dropping in and out',
  'monitor-error': 'Health check could not run',
};

/** Checks run in this order, so the first failing layer is the root cause. */
const LAYER_ORDER: readonly LocalAiHealthLayer[] = [
  'worker',
  'endpoint',
  'model',
  'inference',
  'effectiveness',
];

/** The reason a target needs attention, or undefined when no check names one. */
export function localAiTargetFailureReason(status: LocalAiTargetStatus): string | undefined {
  if (status.flapping) return LOCAL_AI_FAILURE_REASONS.flapping;
  const failures = LAYER_ORDER.flatMap((layer) => {
    const result = status.layers[layer];
    return result && !result.ok && result.failureCode ? [result] : [];
  });
  const rootCause = failures.find((result) => result.required) ?? failures[0];
  return rootCause?.failureCode ? LOCAL_AI_FAILURE_REASONS[rootCause.failureCode] : undefined;
}
