import { describe, expect, it } from 'vitest';
import { resolveCompactionInputLimit } from './compaction-input-limit';

describe('resolveCompactionInputLimit', () => {
  it('uses the configured compression slot input limit', () => {
    expect(resolveCompactionInputLimit(() => JSON.stringify({ compression: { maxInputTokens: 1234.8 } }))).toBe(1234);
  });

  it.each(['{', '{}', 'null', '{"compression":{"maxInputTokens":0}}',
    '{"compression":{"maxInputTokens":"4096"}}', '{"compression":{"maxInputTokens":-1}}'])
  ('keeps the established default for an unusable setting: %s', setting => {
    expect(resolveCompactionInputLimit(() => setting)).toBe(96_000);
  });
});
