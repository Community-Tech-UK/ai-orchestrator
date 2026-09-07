/**
 * LT-196 round-2 regression: the live event-normalization layer must preserve
 * `tool_outcome`, not default it to `assistant`.
 *
 * Both `toOutputMessageType` (here) and `normalizeOutputMessageType`
 * (`adapter-runtime-event-bridge.ts`) switch over a loose `string`/`unknown`
 * with a `default: 'assistant'` arm, so adding `'tool_outcome'` to
 * `OutputMessage['type']` produced no compile error in either. A record that
 * arrives relabelled as `assistant` sails past every downstream
 * `type === 'tool_outcome'` filter — the mobile serializer's guard, the
 * continuity exclusion — carrying up to 2,000 characters of raw tool-failure
 * text onto a live user-facing channel. That is the LT-062 hygiene breach this
 * feature exists to avoid.
 */

import { describe, expect, it } from 'vitest';
import { toOutputMessageFromProviderOutputEvent } from './provider-output-event';
import type { ProviderOutputEvent } from '@contracts/types/provider-runtime-events';

const ERROR_TEXT = 'grep: unrecognized option --bogus-flag, aborting run';

function outputEvent(messageType: string): ProviderOutputEvent {
  return {
    kind: 'output',
    messageId: 'm-1',
    messageType,
    content: ERROR_TEXT,
    metadata: { tool_use_id: 'toolu_1', is_error: true },
  } as unknown as ProviderOutputEvent;
}

describe('toOutputMessageFromProviderOutputEvent — LT-196 type preservation', () => {
  it('preserves tool_outcome instead of defaulting it to assistant', () => {
    const message = toOutputMessageFromProviderOutputEvent(outputEvent('tool_outcome'));

    expect(message.type).toBe('tool_outcome');
    // The failure that mattered: relabelled as `assistant`, the raw tool error
    // text would be broadcast live to mobile as if the model had said it.
    expect(message.type).not.toBe('assistant');
  });

  it('still defaults a genuinely unknown type to assistant', () => {
    const message = toOutputMessageFromProviderOutputEvent(outputEvent('something_new'));

    expect(message.type).toBe('assistant');
  });

  it('leaves the ordinary types alone', () => {
    for (const type of ['assistant', 'user', 'system', 'tool_use', 'tool_result', 'error']) {
      expect(toOutputMessageFromProviderOutputEvent(outputEvent(type)).type).toBe(type);
    }
  });
});
