import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchCopilotLimitNotice, COPILOT_LIMIT_WHOLE_SOURCES } from './copilot-limit-messages';
import { COPILOT_LIMIT_FIXTURES } from './copilot-limit-fixtures.test-helpers';

describe('Copilot shipped limit catalogue', () => {
  afterEach(() => vi.useRealTimers());
  it.each(COPILOT_LIMIT_FIXTURES)('recognizes kind and action for %s', (text, kind) => {
    for (const lead of ['', 'Error: ', 'Internal error: ']) {
      expect(matchCopilotLimitNotice(`${lead}${text}`)).toMatchObject({ kind,
        action: kind === 'session-spend' ? 'recycle' : 'park',
        quotaVisible: kind === 'monthly-credits' || kind === 'additional-usage' });
      expect(matchCopilotLimitNotice(`Report finished.\n${lead}${text}`)?.kind).toBe(kind);
      expect(matchCopilotLimitNotice(`Report finished.\n${lead}${text}`, { whole: true })).toBeNull();
    }
    const bare = text.slice(0, text.indexOf('.') + 1);
    expect(matchCopilotLimitNotice(bare.toUpperCase().replace("'", '’'))?.kind).toBe(kind);
  });
  it('recognizes the logged old server wording and the ACP transport wrapper', () => {
    expect(matchCopilotLimitNotice('Error: You have exceeded your monthly quota (Request ID: 0000:PLACEHOLDER)')).toMatchObject({ kind: 'monthly-credits', resetAtHint: null });
    expect(matchCopilotLimitNotice(`ACP session/prompt failed: Internal error: ${COPILOT_LIMIT_FIXTURES[3][0]} (-32603)`)).toMatchObject({ kind: 'weekly-rate' });
  });
  it('uses only the matched notice reset hint, or the conservative one/six-hour fallback', () => {
    vi.useFakeTimers();
    const now = Date.now();
    expect(matchCopilotLimitNotice(`${COPILOT_LIMIT_FIXTURES[3][0]} Your limit resets in 2 hours.`)?.resetAtHint).toBe(now + 2 * 3600_000);
    expect(matchCopilotLimitNotice(`Work ran in 2 hours.\n${COPILOT_LIMIT_FIXTURES[3][0]}`)?.resetAtHint).toBe(now + 6 * 3600_000);
    expect(matchCopilotLimitNotice(`${COPILOT_LIMIT_FIXTURES[0][0]} Your limit resets tomorrow.`)?.resetAtHint).toBe(now + 3600_000);
    expect(matchCopilotLimitNotice(`${COPILOT_LIMIT_FIXTURES[5][0]} Your quota resets in 2 hours.`)?.resetAtHint).toBe(now + 2 * 3600_000);
  });
  it('preserves relative, clock, ISO and month-date reset hints', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 12, 12, 0));
    const now = Date.now();
    for (const suffix of ['in 2 hours', 'at 2pm', '14:00', 'at October 12th, 2026 2pm',
      `at ${new Date(now + 2 * 3600_000).toISOString().replace('.000', '')}`]) {
      const text = `${COPILOT_LIMIT_FIXTURES[0][0]} Your limit resets ${suffix}.`;
      expect(matchCopilotLimitNotice(text)?.resetAtHint, suffix).toBe(now + 2 * 3600_000);
      expect(matchCopilotLimitNotice(`Report finished.\n${text}`)?.resetAtHint, suffix).toBe(now + 2 * 3600_000);
    }
  });
  it('rejects a second reset statement instead of consuming it as an unknown reset format', () => {
    for (const suffix of ['x Your limit resets x', 'tomorrow. Your quota resets in 2 hours.']) {
      const text = `${COPILOT_LIMIT_FIXTURES[0][0]} Your limit resets ${suffix}`;
      expect(matchCopilotLimitNotice(text)).toBeNull();
      expect(matchCopilotLimitNotice(`Report finished.\n${text}`)).toBeNull();
      expect(COPILOT_LIMIT_WHOLE_SOURCES.every((source) => !new RegExp(`^${source}$`, 'iu').test(text))).toBe(true);
    }
  });
  it.each([
    `${COPILOT_LIMIT_FIXTURES[0][0]} More work followed.`,
    'LinkedIn weekly rate limit reached',
    'This sentence mentions a rate limit.',
    'You have hit your rate limit while investigating a bug.',
  ])('rejects %s', (text) => expect(matchCopilotLimitNotice(text)).toBeNull());
  it('exports only non-capturing whole sources for final output timezone validation', () => {
    for (const text of COPILOT_LIMIT_FIXTURES.map(([text]) => text)) {
      const match = COPILOT_LIMIT_WHOLE_SOURCES.map((source) => new RegExp(`^${source}$`, 'iu').exec(text)).find(Boolean);
      expect(match).toHaveLength(1);
    }
  });
});
