/**
 * OpenCode is a tool that fronts several backends, but its accounts and its usage
 * allowance are always the MiMo Token Plan's. An error about an allowance or a
 * sign-in names the account ("MiMo"); an error about the tool's own limits names
 * the tool ("OpenCode"). See `src/shared/display-names.ts`.
 */

import { describe, expect, it } from 'vitest';
import { presentError } from './present-error';

describe('presentError: the account behind OpenCode', () => {
  it('says MiMo when the allowance is used up', () => {
    expect(presentError('quota', { provider: 'opencode', allowance: 'weekly' }).headline)
      .toBe('Your MiMo account has used its weekly allowance.');
  });

  it('puts the account name the user chose before MiMo', () => {
    expect(presentError('quota', { provider: 'opencode', account: 'Work' }).headline)
      .toBe('Your Work MiMo account has used its current allowance.');
  });

  it('says MiMo when signed out', () => {
    expect(presentError('auth', { provider: 'opencode' }).headline).toBe('Signed out of MiMo.');
  });

  it('prefers the account name the user chose when signed out', () => {
    expect(presentError('auth', { provider: 'opencode', account: 'Work' }).headline).toBe('Signed out of Work.');
  });

  it('keeps the tool name for the tool\'s own session limit', () => {
    expect(presentError('concurrency', { provider: 'opencode', maxSessions: 20, waitedMs: 60_000 }).headline)
      .toBe('OpenCode is already running its maximum of 20 sessions; this one waited a minute.');
  });

  it('keeps the tool name for a crash or a dropped connection', () => {
    expect(presentError('provider-crash', { provider: 'opencode' }).headline)
      .toBe('OpenCode stopped before this turn finished.');
    expect(presentError('network', { provider: 'opencode' }).headline)
      .toBe('The connection to OpenCode was interrupted.');
  });

  it('leaves every other provider unchanged', () => {
    expect(presentError('quota', { provider: 'claude' }).headline).toBe('Your Claude account has used its current allowance.');
    expect(presentError('auth', { provider: 'codex' }).headline).toBe('Signed out of Codex.');
  });

  it('falls back to "AI" without a known provider', () => {
    expect(presentError('quota', {}).headline).toBe('Your AI account has used its current allowance.');
    expect(presentError('auth', { provider: 'not-a-provider' }).headline).toBe('Signed out of AI.');
  });
});
