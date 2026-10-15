import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPILOT_LIMIT_FIXTURES } from './copilot-limit-fixtures.test-helpers';
import { classifyFinalOutputProviderLimit } from './final-output-provider-limit';
import { tagAcpProviderLimit } from './adapters/acp-provider-limit';
import { detectCompletionProviderLimit, detectErrorProviderLimit } from '../instance/instance-provider-limit-detection';

describe('Copilot limit delivery paths', () => {
  afterEach(() => vi.useRealTimers());
  it.each(COPILOT_LIMIT_FIXTURES)('parks whole final output: %s', (text) => {
    expect(classifyFinalOutputProviderLimit(text)).toMatch(/^provider_limit:/);
    expect(classifyFinalOutputProviderLimit(`Completed the report.\n${text}`)).toBeNull();
  });
  it.each(COPILOT_LIMIT_FIXTURES)('tags ACP park messages without tagging session spending: %s', (text, kind) => {
    const error = tagAcpProviderLimit(new Error(`Internal error: ${text}`));
    expect((error as Error & { quota?: { exhausted: boolean } }).quota?.exhausted).toBe(kind === 'session-spend' ? undefined : true);
  });
  it('parks a Copilot weekly reply for six hours without trusting monthly credits', () => {
    vi.useFakeTimers();
    const now = Date.now();
    expect(detectCompletionProviderLimit({ content: COPILOT_LIMIT_FIXTURES[3][0] }, null, { provider: 'copilot' })).toMatchObject({
      resetAtHint: now + 6 * 60 * 60_000, quotaBlind: true,
    });
  });
  it.each(['claude', 'codex'] as const)('does not park %s when it quotes a Copilot rate notice', (provider) => {
    expect(detectCompletionProviderLimit({ content: COPILOT_LIMIT_FIXTURES[0][0] }, null, { provider })).toBeNull();
  });
  it.each(['claude', 'codex'] as const)('does not apply Copilot rate/credit horizons to an explicit %s error', (provider) => {
    for (const [text] of COPILOT_LIMIT_FIXTURES) {
      expect(detectErrorProviderLimit({}, text, null, provider), text).toBeNull();
    }
    expect(detectErrorProviderLimit({}, 'You have reached your weekly rate limit.', null, provider)).toBeNull();
  });
  it('keeps the unspecified-provider ACP error path classifying the catalogue', () => {
    expect(detectErrorProviderLimit({}, `Internal error: ${COPILOT_LIMIT_FIXTURES[3][0]}`)).toMatchObject({ quotaBlind: true });
  });
  it('leaves credit reset timing to the snapshot and never parks chat session-spend', () => {
    expect(detectCompletionProviderLimit({ content: COPILOT_LIMIT_FIXTURES[5][0] }, null, { provider: 'copilot' })).toMatchObject({ resetAtHint: null, quotaBlind: false });
    expect(detectCompletionProviderLimit({ content: COPILOT_LIMIT_FIXTURES[4][0] }, null, { provider: 'copilot' })).toBeNull();
    expect(detectErrorProviderLimit({}, COPILOT_LIMIT_FIXTURES[4][0], null, 'copilot')).toBeNull();
  });
  it('does not park a Copilot notice followed by more work', () => {
    expect(detectCompletionProviderLimit({ content: `${COPILOT_LIMIT_FIXTURES[0][0]}\nMore work followed.` }, null, { provider: 'copilot' })).toBeNull();
  });
});
