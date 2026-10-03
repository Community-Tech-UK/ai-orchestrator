import type { InternalInputSource } from '../../shared/types/input-provenance.types';
import type { ProviderTurnEndingReason } from '@contracts/types/provider-runtime-events';

export const REASONING_COLLAPSE_NOTICE =
  'This turn stopped because the model\'s reasoning repeated the same phrase until the provider cut it off. The work above is kept.';

export const REASONING_COLLAPSE_CONTINUATION_PROMPT = [
  'Your previous turn was cut off. The model\'s reasoning started repeating the same short phrase, and the provider ended that step for length before any further action.',
  '',
  'Pick the task back up from the last concrete finding in the conversation. Do not repeat that reasoning. Break remaining work into smaller pieces. Check the latest tool results and the current files, keep completed work, and continue from the first unfinished step. If the task was already finished, say so in one line instead of redoing it.',
].join('\n');

export const CONTENT_FILTER_NOTICE =
  'This turn stopped because the provider blocked the reply with its content filter. The work above is kept.';

export const CONTENT_FILTER_CONTINUATION_PROMPT = [
  'Your previous turn was cut off. The provider blocked the reply with its content filter, so the step ended before you could finish.',
  '',
  'Continue the task from the last concrete finding. Do not quote, paste, or repeat the source text that was blocked. Refer to entries by position, date, and field name, and keep working from the files already read. If the task was already finished, say so in one line instead of redoing it.',
].join('\n');


export const CRASH_TURN_CONTINUATION_PROMPT = [
  'Your previous turn was cut off because the agent process stopped unexpectedly, and Harness has restarted this session.',
  '',
  'Pick the task back up from where that turn stopped. The conversation above is the record of what is already done: check the latest tool results and the current state of the files rather than assuming, keep completed work, and do not repeat completed steps. If the task was already finished, say so in one line instead of redoing it.',
].join('\n');

export interface TurnContinuationPolicy {
  notice: string;
  prompt?: string;
  internalSource?: InternalInputSource;
  source: string;
}

export const TURN_CONTINUATION_POLICY: Record<ProviderTurnEndingReason, TurnContinuationPolicy> = {
  completed: { notice: '', source: 'completed' },
  max_output: {
    notice: 'This turn reached the provider output limit. The work above is kept.',
    prompt: 'Output token limit hit. Resume directly from the last unfinished step. Pick up mid-thought, without apology or recap. Break remaining work into smaller pieces. Preserve completed work and check current files and tool results before proceeding.',
    internalSource: 'reasoning-collapse-continuation', source: 'max-output',
  },
  content_filter: { notice: CONTENT_FILTER_NOTICE, prompt: CONTENT_FILTER_CONTINUATION_PROMPT,
    internalSource: 'content-filter-continuation', source: 'content-filter' },
  crash: { notice: 'The provider process stopped during this turn. The work above is kept.',
    prompt: CRASH_TURN_CONTINUATION_PROMPT, internalSource: 'crash-turn-continuation', source: 'crash-turn-continuation' },
  dangling_tool_result: { notice: 'The provider stopped before replying to the latest tool result. The work above is kept.',
    prompt: 'The previous tool result never got a reply. Continue from that result. Check current files and preserve completed work. Break remaining work into smaller pieces.',
    internalSource: 'crash-turn-continuation', source: 'dangling-tool-result' },
  truncated_transport: { notice: 'The provider stream ended before the reply finished. The work above is kept.', source: 'truncated-transport' },
  quota: { notice: 'The provider stopped because its usage allowance or rate limit was reached. Wait for the limit to reset before resuming.', source: 'quota' },
  billing: { notice: 'The provider stopped because of a billing or credit issue. Resolve that issue before resuming.', source: 'billing' },
  auth: { notice: 'The provider stopped because authentication failed. Sign in again before resuming.', source: 'auth' },
  context_overflow: { notice: 'The provider could not fit this request into its context window. Reduce the context before resuming.', source: 'context-overflow' },
  doom_loop: { notice: 'The provider was stopped because repeated tool calls made no progress. Change approach before resuming.', source: 'doom-loop' },
  parent_silent: { notice: 'The delegated task stopped producing observable activity before its lease expired. Check the child task before resuming.', source: 'parent-silent' },
  retryable: { notice: 'The provider encountered a temporary service error. Work is preserved; provider recovery owns any retry already in progress.', source: 'retryable' },
  unknown_error: { notice: 'The provider ended this turn with an error. The work and error above are kept.', source: 'unknown-error' },
};

export function turnContinuationPolicy(reason: ProviderTurnEndingReason, reasoningCollapsed = false): TurnContinuationPolicy {
  return reason === 'max_output' && reasoningCollapsed
    ? { notice: REASONING_COLLAPSE_NOTICE, prompt: REASONING_COLLAPSE_CONTINUATION_PROMPT,
      internalSource: 'reasoning-collapse-continuation', source: 'reasoning-collapse' }
    : TURN_CONTINUATION_POLICY[reason];
}

/** Source-specific admission rules; all prompt delivery goes through one owner. */
export type ContinuationTrigger = 'cutoff' | 'cursor-transport' | 'announce' | 'async-result' | 'async-check-in';
export const CONTINUATION_DISPATCH_POLICY = {
  cutoff: { rootOnly: true, allowWake: false, allowInhibitor: false, priority: 4, budget: 'cutoff', limit: 2 },
  'cursor-transport': { rootOnly: true, allowWake: true, allowInhibitor: false, priority: 2, budget: 'transport', limit: 2 },
  announce: { rootOnly: true, allowWake: true, allowInhibitor: false, priority: 1, budget: 'announce', limit: 1 },
  'async-result': { rootOnly: false, allowWake: true, allowInhibitor: true, priority: 3, budget: undefined, limit: undefined },
  'async-check-in': { rootOnly: false, allowWake: false, allowInhibitor: true, priority: 0, budget: undefined, limit: undefined },
} as const;
