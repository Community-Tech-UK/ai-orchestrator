/**
 * Constants, configuration, and pure utility functions for InstanceCommunicationManager.
 * No dependency on manager state.
 */

import type { InstanceStatus, OutputMessage } from '../../shared/types/instance.types';

export const RESPONSE_PREVIEW_LENGTH = 120;
export const RECENT_ADAPTER_ERROR_OUTPUT_DEDUP_MS = 1_000;

export const CIRCUIT_BREAKER_CONFIG = {
  maxConsecutiveEmpty: 3,          // Trip after 3 consecutive empty responses
  minTimeBetweenResponses: 1000,   // Minimum expected time between responses (1s)
  resetTimeoutMs: 30000,           // Reset circuit after 30s
  cooldownMs: 5000                 // Wait 5s before allowing retry after trip
};

export const ACTIVE_CHILD_TURN_STATUSES = new Set<InstanceStatus>([
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_permission',
]);

export const CHILD_TURN_COMPLETE_STATUSES = new Set<InstanceStatus>([
  'idle',
  'ready',
  'waiting_for_input',
]);

/**
 * Per-instance circuit breaker state for detecting rapid empty responses.
 */
export interface CircuitBreakerState {
  consecutiveEmptyResponses: number;
  lastResponseTimestamp: number;
  isTripped: boolean;
}

export function summarizeLogText(value: string, maxLength = RESPONSE_PREVIEW_LENGTH): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

export function summarizeInputResponse(response: string, permissionKey?: string): Record<string, unknown> {
  const normalized = response.trim().toLowerCase();
  return {
    responseLength: response.length,
    responsePreview: summarizeLogText(response),
    isPermissionApproval: normalized.includes('permission granted')
      || normalized.includes('allow')
      || normalized.startsWith('y'),
    isPermissionDenial: normalized.includes('permission denied')
      || normalized.includes('do not perform')
      || normalized.startsWith('n'),
    permissionKey: permissionKey ?? null,
  };
}

export function getAccumulatedStreamingContent(message: OutputMessage): string {
  const accumulated = message.metadata?.['accumulatedContent'];
  return typeof accumulated === 'string' ? accumulated : message.content;
}
