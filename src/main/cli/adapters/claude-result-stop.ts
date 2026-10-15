import type { RawCliPayload } from './claude-cli-adapter.types';

export interface ClaudeResultStop {
  finishReason: string;
  subtype?: string;
  terminalReason?: string;
  numTurns?: number;
}

export function readClaudeResultStop(msg: RawCliPayload): ClaudeResultStop | undefined {
  if (msg.type !== 'result') return undefined;
  const terminalReason = typeof msg.terminal_reason === 'string' && msg.terminal_reason.trim()
    ? msg.terminal_reason : undefined;
  const finishReason = terminalReason
    ?? (msg.subtype === 'error_max_turns' || msg.errors?.some((error) => /Reached maximum number of turns/i.test(error))
      ? 'max_turns'
      : msg.subtype === 'error_max_budget_usd' ? 'budget_exhausted'
        : typeof msg.stop_reason === 'string' && msg.stop_reason.trim() ? msg.stop_reason : undefined);
  if (!finishReason) return undefined;
  return {
    finishReason,
    ...(msg.subtype ? { subtype: msg.subtype } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    ...(typeof msg.num_turns === 'number' && Number.isFinite(msg.num_turns) && msg.num_turns >= 0
      ? { numTurns: msg.num_turns } : {}),
  };
}

export function resultMetadata(quota: unknown, stop: ClaudeResultStop | undefined): { metadata?: Record<string, unknown> } {
  if (quota === undefined && !stop) return {};
  return { metadata: {
    ...(quota !== undefined ? { quota } : {}),
    ...(stop ? { finishReason: stop.finishReason, claudeResult: stop } : {}),
  } };
}
