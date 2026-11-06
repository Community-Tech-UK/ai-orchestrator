/**
 * What starts a turn.
 *
 * A turn begins with an input: something the user sent, or something Harness
 * sent on the user's behalf. Harness-authored input is stored as a `system`
 * message with `metadata.internalInput` (see input-provenance.types.ts) so it
 * can never be mistaken for the user's own words, but it still makes the agent
 * start work, so it still opens a turn. The transcript note under that work
 * belongs to that turn, not to the user message before it.
 */

import type { OutputMessage } from './types/instance.types';

export type TurnStartKind = 'user' | 'machine';

export function turnStartKind(message: Pick<OutputMessage, 'type' | 'metadata'>): TurnStartKind | null {
  if (message.type === 'user') return 'user';
  if (message.type === 'system' && message.metadata?.internalInput) return 'machine';
  return null;
}
