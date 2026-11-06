import { USAGE_CAUSE_TOOLTIPS } from '../../../../shared/usage-insight/usage-cause-copy';
import { CACHE_MISS_TOKENS, LONG_CONTEXT_TOKENS } from '../../../../shared/usage-insight/usage-cause-rules';
import type { InstanceStatus } from '../../core/state/instance/instance.types';

/** Between turns: the next message is someone coming back to the chat after a break. */
const AT_REST: readonly InstanceStatus[] = ['idle', 'ready', 'waiting_for_input'];

export interface ContextSizeAdviceInput {
  provider: string | null | undefined;
  /** How big the chat is, in tokens, as the provider last measured it. Undefined when it has not. */
  tokens: number | undefined;
  status: InstanceStatus | undefined;
}

/**
 * The one sentence worth showing on the context ring and bar about why a big
 * chat costs more, or null when there is nothing to say.
 *
 * Both sentences and both sizes come from the usage card's own copy and rules,
 * so a chat is called "long" here at exactly the point the card counts it. They
 * describe how Claude reads a long chat, so no other provider gets them (Codex
 * has its own price line, drawn on the bar). Coming back to a chat at rest is
 * the more useful thing to say there, so it wins over the plain long-chat one.
 */
export function contextSizeAdvice({ provider, tokens, status }: ContextSizeAdviceInput): string | null {
  if (provider !== 'claude' || tokens === undefined) return null;
  if (status !== undefined && AT_REST.includes(status) && tokens > CACHE_MISS_TOKENS) {
    return USAGE_CAUSE_TOOLTIPS.contextRingIdle;
  }
  return tokens > LONG_CONTEXT_TOKENS ? USAGE_CAUSE_TOOLTIPS.contextRing : null;
}
