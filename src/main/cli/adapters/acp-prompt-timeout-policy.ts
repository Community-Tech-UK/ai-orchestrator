import type { AcpToolCallStatus } from '../../../shared/types/cli.types';

/** Long but bounded inactivity lease for provider-reported external work. */
export const DEFAULT_ACTIVE_TOOL_TIMEOUT_MS = 60 * 60_000;

export function hasActiveAcpToolCall<T extends { status: AcpToolCallStatus }>(
  toolCalls: Iterable<T>,
): boolean {
  for (const toolCall of toolCalls) {
    if (toolCall.status === 'pending' || toolCall.status === 'in_progress') return true;
  }
  return false;
}
