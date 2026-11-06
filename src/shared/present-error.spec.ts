import { describe, expect, it } from 'vitest';
import { presentError } from './present-error';

describe('presentError', () => {
  it.each(['quota', 'auth', 'network', 'provider-crash', 'concurrency', 'tool-server', 'cancelled', 'unknown'] as const)(
    'gives %s a safe headline and a next step', category => {
      const result = presentError(category, { provider: 'codex', account: 'Work' });
      expect(result.category).toBe(category);
      expect(result.headline.length).toBeGreaterThan(0);
      expect(result.whatToDo).toMatch(/^(What to do:|No action needed:)/);
    },
  );

  it('keeps arbitrary provider text out of visible sentences', () => {
    const detail = 'unrecognised payload: PRIVATE_DIAGNOSTIC_TEXT';
    const result = presentError(new Error(detail));
    expect(result.rawDetail).toBe(detail);
    expect(result.headline + result.whatToDo).not.toContain('PRIVATE_DIAGNOSTIC_TEXT');
    expect(result.category).toBe('unknown');
  });

  it('uses the account and full reset date for a weekly limit more than twelve hours away', () => {
    const now = new Date(2026, 9, 20, 12).getTime();
    const resetAt = new Date(2026, 9, 22, 23).getTime();
    const result = presentError('quota', { provider: 'claude', account: 'Work', allowance: 'weekly', resetAt, now });
    expect(result.headline).toContain('Your Work Claude account has used its weekly allowance.');
    expect(result.headline).toContain('Thursday');
    expect(result.headline).toContain('22 October');
    expect(result.headline).toContain('23:00');
    expect(result.action).toBe('switch-account');
    expect(result.headline).not.toMatch(/rejected|seven_day/);
  });

  it('shows only the time for a nearby reset and never invents an unknown reset', () => {
    const now = new Date(2026, 9, 20, 12).getTime();
    expect(presentError('quota', { resetAt: now + 60_000, now }).headline).toContain('12:01');
    expect(presentError('quota').headline).not.toContain('resets');
  });

  it('identifies a tool server using only an explicitly supplied display name', () => {
    const result = presentError('tool-server', { provider: 'codex', toolServer: 'Search' });
    expect(result.headline).toBe("A tool server didn't start for this Codex session: Search.");
  });

  it('uses actual concurrency and wait duration, rather than a fixed one-minute claim', () => {
    const result = presentError('concurrency', { provider: 'opencode', maxSessions: 20, waitedMs: 60_000 });
    expect(result.headline).toBe('OpenCode is already running its maximum of 20 sessions; this one waited a minute.');
    expect(presentError('concurrency', { provider: 'codex', waitedMs: 5000 }).headline).toContain('5 seconds');
    expect(presentError('concurrency', { provider: 'codex', waitedMs: 1000 }).headline).toContain('1 second.');
    expect(result.action).toBe('retry');
  });

  it('distinguishes a planned retry from a manual retry', () => {
    expect(presentError('network', { retrying: true }).whatToDo)
      .toBe('No action needed: Harness is already retrying.');
    expect(presentError('network').whatToDo).toContain('What to do:');
  });

  it('recognises closed error codes without echoing the code or error payload', () => {
    const result = presentError({ code: 'ECONNRESET', message: 'PRIVATE_DIAGNOSTIC_TEXT' });
    expect(result.category).toBe('network');
    expect(result.rawDetail).toBe('PRIVATE_DIAGNOSTIC_TEXT');
    expect(result.headline).not.toContain('ECONNRESET');
  });

  it('does not let an unknown provider id or a malformed reset become visible text', () => {
    const result = presentError('quota', { provider: 'PRIVATE_PROVIDER_ID', resetAt: Infinity });
    expect(result.headline).not.toContain('PRIVATE_PROVIDER_ID');
    expect(result.headline).not.toContain('Invalid Date');
  });
});
