import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthenticationError } from '../cli/adapters/provider-authentication-error';
import { ProviderConcurrencyTimeoutError } from '../cli/provider-concurrency-limiter';
import { errorMessageText } from '../util/error-utils';
import { presentFailure } from './instance-failure-presentation';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({ getProfile: (_provider: string, id: string) => (id === 'work-1' ? { label: 'Work' } : null) }),
}));

const NOON = new Date(2026, 9, 20, 12);
const FIVE_PM = new Date(2026, 9, 20, 17).getTime();
const claude = { provider: 'claude' as const };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});
afterEach(() => vi.useRealTimers());

describe('presentFailure', () => {
  it('turns a failure the app cannot name into a plain sentence, with the real reason for Details only', () => {
    const failure = presentFailure({ error: new Error('spawn claude ENOENT'), message: 'spawn claude ENOENT', instance: claude });

    expect(failure.content).toBe('Claude couldn\'t finish this request. What to do: Check Details, then try again. Your message and the work above are kept.');
    expect(failure.metadata).toEqual({
      errorPresentation: {
        category: 'unknown',
        headline: 'Claude couldn\'t finish this request.',
        whatToDo: 'What to do: Check Details, then try again. Your message and the work above are kept.',
        action: 'retry',
        rawDetail: 'spawn claude ENOENT',
      },
    });
    expect(failure.content).not.toContain('ENOENT');
  });

  it('opens with what failed, and does not repeat that the request could not finish', () => {
    const failure = presentFailure({ error: new Error('boom'), message: 'boom', instance: claude, lead: 'This session could not start.' });
    expect(failure.content).toBe('This session could not start. What to do: Check Details, then try again. Your message and the work above are kept.');
  });

  it.each([
    ['a dropped connection', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'The connection to Claude was interrupted. What to do: Check your connection, then try again.', 'network'],
    ['a sign-out the provider reported by type', new ProviderAuthenticationError('token rejected'), 'Signed out of Claude. What to do: Sign in to continue.', 'auth'],
    ['a sign-out the provider described', new Error('Failed to authenticate: OAuth session expired and could not be refreshed'), 'Signed out of Claude. What to do: Sign in to continue.', 'auth'],
    ['a stopped turn', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'This turn was stopped. Your message and the work above are kept. What to do: Continue when you are ready.', 'cancelled'],
  ])('knows %s', (_label, error, content, category) => {
    const failure = presentFailure({ error, message: (error as Error).message, instance: claude });
    expect(failure.content).toBe(content);
    expect(failure.metadata['errorPresentation']).toMatchObject({ category });
  });

  it('adds the lead before a known cause as well', () => {
    const failure = presentFailure({
      error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), message: 'read ECONNRESET', instance: claude, lead: 'This session could not start.',
    });
    expect(failure.content).toBe('This session could not start. The connection to Claude was interrupted. What to do: Check your connection, then try again.');
  });

  it('does not take a tool\'s or an MCP server\'s sign-in message for the provider signing us out', () => {
    const failure = presentFailure({ error: new Error('GitHub: authentication error 401'), message: 'GitHub: authentication error 401', instance: claude });
    expect(failure.metadata['errorPresentation']).toMatchObject({ category: 'unknown' });
  });

  it('uses the provider limiter\'s own sentence, with its real numbers, and keeps the old technical line for Details', () => {
    const error = new ProviderConcurrencyTimeoutError('codex', 6, 30_000, 30_000);
    const failure = presentFailure({ error, message: error.message, instance: { provider: 'codex' }, lead: 'This session could not start.' });

    expect(failure.content).toBe(
      'This session could not start. Codex is already running its maximum of 6 sessions; this one waited 30 seconds. '
      + 'What to do: Wait for another session to finish, then try again.',
    );
    expect(failure.metadata['errorPresentation']).toMatchObject({
      category: 'concurrency',
      rawDetail: "Timed out waiting 30000ms for 'codex' provider concurrency slot",
    });
  });

  it('keeps wording that history and restore already recognise as a lost session', () => {
    const failure = presentFailure({
      error: new Error('No conversation found with session ID: 11111111-2222-3333-4444-555555555555'),
      message: 'No conversation found with session ID: 11111111-2222-3333-4444-555555555555',
      instance: claude,
    });
    expect(failure.content).toBe('That session does not exist any more. What to do: Check Details, then try again. Your message and the work above are kept.');
    expect(failure.content).not.toContain('11111111');
  });

  it('removes secrets from the reason before it is kept anywhere', () => {
    const failure = presentFailure({
      error: new Error('spawn failed token=sk-test-1234567890abcdef'), message: 'spawn failed token=sk-test-1234567890abcdef', instance: claude,
    });
    expect(JSON.stringify(failure)).not.toContain('sk-test-1234567890abcdef');
  });

  it('shows a usage limit nothing held as the limit, with the account and reset, and tags its window', () => {
    const failure = presentFailure({
      error: new Error('Claude stream closed'), message: 'Claude stream closed',
      instance: { provider: 'claude', accountProfileId: 'work-1' },
      limit: { resetAtHint: FIVE_PM, reason: 'provider limit on turn: Claude stream closed' },
    });

    expect(failure.content).toBe(
      'Your Work Claude account has used its current allowance. It resets at 17:00. What to do: Wait for the allowance to reset, or switch account.',
    );
    expect(failure.metadata['errorPresentation']).toMatchObject({ category: 'quota', action: 'switch-account', rawDetail: 'Claude stream closed' });
    expect(failure.metadata['usageLimitWindow']).toEqual({ provider: 'claude', account: 'work-1', resetAt: FIVE_PM, announcedAt: NOON.getTime() });
  });

  it('shows a limit with no reset time without inventing one', () => {
    const failure = presentFailure({
      error: new Error('limit'), message: 'limit', instance: claude, limit: { resetAtHint: null, reason: 'provider limit on turn: limit' },
    });
    expect(failure.content).toBe('Your Claude account has used its current allowance. What to do: Wait for the allowance to reset, or switch account.');
  });

  it('does not let an unknown provider id or a hostile message into the sentence', () => {
    const failure = presentFailure({
      error: new Error('PRIVATE_DETAIL\nINJECTED'), message: 'PRIVATE_DETAIL\nINJECTED', instance: { provider: 'PRIVATE_PROVIDER' as never },
    });
    expect(failure.content).not.toMatch(/PRIVATE|INJECTED/);
    expect(failure.content.startsWith('AI couldn\'t finish this request.')).toBe(true);
  });
});

describe('errorMessageText', () => {
  it('reads the real reason from a message shown in plain words', () => {
    const shown = presentFailure({ error: new Error('boom: details'), message: 'boom: details', instance: claude });
    expect(errorMessageText({ content: shown.content, metadata: shown.metadata })).toBe('boom: details');
  });

  it.each([
    ['no metadata', undefined],
    ['no presentation', { source: 'x' }],
    ['a presentation with no detail', { errorPresentation: { category: 'unknown' } }],
    ['an empty detail', { errorPresentation: { rawDetail: '' } }],
    ['a presentation that is not an object', { errorPresentation: 'nope' }],
    ['a detail that is not text', { errorPresentation: { rawDetail: 42 } }],
    ['a null presentation', { errorPresentation: null }],
  ])('falls back to the message text with %s', (_label, metadata) => {
    expect(errorMessageText({ content: 'the text', ...(metadata ? { metadata } : {}) })).toBe('the text');
  });
});
