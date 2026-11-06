import type { InternalInputSource } from '../../shared/types/input-provenance.types';
import type { ProviderTurnEndingReason } from '@contracts/types/provider-runtime-events';

/** Every notice says this, so a reader never has to wonder whether their words or the work were lost. */
const KEPT = 'Your message and the work above are kept.';

export const REASONING_COLLAPSE_NOTICE =
  `This turn stopped because the model's reasoning repeated the same phrase until the provider cut it off. ${KEPT}`;

export const REASONING_COLLAPSE_CONTINUATION_PROMPT = [
  'Your previous turn was cut off. The model\'s reasoning started repeating the same short phrase, and the provider ended that step for length before any further action.',
  '',
  'Pick the task back up from the last concrete finding in the conversation. Do not repeat that reasoning. Break remaining work into smaller pieces. Check the latest tool results and the current files, keep completed work, and continue from the first unfinished step. If the task was already finished, say so in one line instead of redoing it.',
].join('\n');

export const CONTENT_FILTER_NOTICE =
  `This turn stopped because the provider blocked the reply with its content filter. ${KEPT}`;

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

/**
 * A next step the interface can offer as a button. `notice` is what the user reads;
 * `prompt` is what the model is told (a different text, never shown as the notice);
 * `action` says which button, if any, goes with the notice.
 */
export type TurnNoticeAction = 'continue' | 'retry' | 'switch-model' | 'sign-in';

export interface TurnContinuationPolicy {
  notice: string;
  prompt?: string;
  internalSource?: InternalInputSource;
  source: string;
  action?: TurnNoticeAction;
}

export const TURN_CONTINUATION_POLICY: Record<ProviderTurnEndingReason, TurnContinuationPolicy> = {
  completed: { notice: `This turn finished. ${KEPT}`, source: 'completed' },
  max_output: {
    notice: `This turn reached the provider output limit. ${KEPT}`,
    prompt: 'Output token limit hit. Resume directly from the last unfinished step. Pick up mid-thought, without apology or recap. Break remaining work into smaller pieces. Preserve completed work and check current files and tool results before proceeding.',
    internalSource: 'reasoning-collapse-continuation', source: 'max-output', action: 'continue',
  },
  content_filter: { notice: CONTENT_FILTER_NOTICE, prompt: CONTENT_FILTER_CONTINUATION_PROMPT,
    internalSource: 'content-filter-continuation', source: 'content-filter', action: 'continue' },
  crash: { notice: `The provider process stopped during this turn. ${KEPT}`,
    prompt: CRASH_TURN_CONTINUATION_PROMPT, internalSource: 'crash-turn-continuation', source: 'crash-turn-continuation', action: 'continue' },
  dangling_tool_result: { notice: `The provider stopped before replying to the latest tool result. ${KEPT}`,
    prompt: 'The previous tool result never got a reply. Continue from that result. Check current files and preserve completed work. Break remaining work into smaller pieces.',
    internalSource: 'crash-turn-continuation', source: 'dangling-tool-result', action: 'continue' },
  truncated_transport: { notice: `The provider stream ended before the reply finished. ${KEPT}`, source: 'truncated-transport', action: 'retry' },
  quota: { notice: `The provider stopped because its usage allowance or rate limit was reached. ${KEPT} Wait for the limit to reset before resuming.`, source: 'quota', action: 'switch-model' },
  billing: { notice: `The provider stopped because of a billing or credit issue. ${KEPT} Resolve that issue before resuming.`, source: 'billing', action: 'switch-model' },
  auth: { notice: `The provider stopped because authentication failed. ${KEPT} Sign in again before resuming.`, source: 'auth', action: 'sign-in' },
  context_overflow: { notice: `The provider could not fit this request into its context window. ${KEPT} Reduce the context before resuming.`, source: 'context-overflow' },
  doom_loop: { notice: `The provider was stopped because repeated tool calls made no progress. ${KEPT} Change approach before resuming.`, source: 'doom-loop' },
  parent_silent: { notice: `The delegated task stopped showing any activity before its time ran out. ${KEPT} Check the child task before resuming.`, source: 'parent-silent' },
  retryable: { notice: `The provider had a temporary problem, such as an overloaded model. ${KEPT} If it does not carry on by itself, send a message to try again.`, source: 'retryable' },
  empty_result: { notice: `The model sent no reply. ${KEPT}`, source: 'empty-result', action: 'retry' },
  unknown_error: { notice: `The provider ended this turn with an error. ${KEPT}`, source: 'unknown-error', action: 'retry' },
};

export function turnContinuationPolicy(reason: ProviderTurnEndingReason, reasoningCollapsed = false): TurnContinuationPolicy {
  return reason === 'max_output' && reasoningCollapsed
    ? { notice: REASONING_COLLAPSE_NOTICE, prompt: REASONING_COLLAPSE_CONTINUATION_PROMPT,
      internalSource: 'reasoning-collapse-continuation', source: 'reasoning-collapse', action: 'continue' }
    : TURN_CONTINUATION_POLICY[reason];
}

/** What a turn-ending notice travels with: where it came from and the one button it offers. */
export function turnNoticeMetadata(policy: Pick<TurnContinuationPolicy, 'source' | 'action'>): { source: string; action?: TurnNoticeAction } {
  return { source: policy.source, ...(policy.action ? { action: policy.action } : {}) };
}

/** Source-specific admission rules; all prompt delivery goes through one owner. */
export type ContinuationTrigger = 'cutoff' | 'cursor-transport' | 'announce' | 'async-result' | 'async-check-in' | 'waiting-check-in';
export const CONTINUATION_DISPATCH_POLICY = {
  cutoff: { rootOnly: true, allowWake: false, allowInhibitor: false, priority: 4, budget: 'cutoff', limit: 2 },
  'cursor-transport': { rootOnly: true, allowWake: true, allowInhibitor: false, priority: 2, budget: 'transport', limit: 2 },
  announce: { rootOnly: true, allowWake: true, allowInhibitor: false, priority: 1, budget: 'announce', limit: 1 },
  'async-result': { rootOnly: false, allowWake: true, allowInhibitor: true, priority: 3, budget: undefined, limit: undefined },
  'async-check-in': { rootOnly: false, allowWake: false, allowInhibitor: true, priority: 0, budget: undefined, limit: undefined },
  'waiting-check-in': { rootOnly: true, allowWake: true, allowInhibitor: false, priority: 0, budget: undefined, limit: undefined },
} as const;
