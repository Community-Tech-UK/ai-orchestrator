import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PERMISSION_SCOPE_WORDS,
  describePermissionDuration,
  timedScopeWords,
  type PermissionScope,
} from './permission-scope-presentation';

const here = dirname(fileURLToPath(import.meta.url));
const renderer = resolve(here, '../../renderer/app');

describe('PERMISSION_SCOPE_WORDS', () => {
  it('names the three browser buttons exactly as James asked', () => {
    expect(PERMISSION_SCOPE_WORDS.once.allow).toBe('Allow this once');
    expect(PERMISSION_SCOPE_WORDS.session.allow).toBe('Allow for this session');
    expect(PERMISSION_SCOPE_WORDS['without-asking'].allow).toBe('Allow without asking (this session)');
  });

  it('uses the word session, never task, in every user-facing phrase', () => {
    for (const words of Object.values(PERMISSION_SCOPE_WORDS)) {
      for (const phrase of Object.values(words)) {
        expect(phrase.toLowerCase()).not.toContain('task');
      }
    }
  });

  it('keeps the short picker names the command card already shows', () => {
    const choices = (['once', 'session', 'always'] as const).map((scope) => PERMISSION_SCOPE_WORDS[scope].choice);
    expect(choices).toEqual(['Once', 'This session', 'Always']);
  });

  it('has a refusal wording for each scope the command card can refuse', () => {
    expect(PERMISSION_SCOPE_WORDS.once.refuse).toBe("Don't allow");
    expect(PERMISSION_SCOPE_WORDS.session.refuse).toBe('Block for this session');
    expect(PERMISSION_SCOPE_WORDS.always.refuse).toBe('Always block');
    expect('refuse' in PERMISSION_SCOPE_WORDS['without-asking']).toBe(false);
  });

  it('says how long each scope lasts in a phrase that reads after "Lasts"', () => {
    const lasts: Record<PermissionScope, string> = {
      once: 'just this once',
      session: 'until this session ends',
      'without-asking': 'until this session ends, without asking again',
      always: 'until you take it back',
    };
    for (const [scope, phrase] of Object.entries(lasts)) {
      expect(PERMISSION_SCOPE_WORDS[scope as PermissionScope].lasts).toBe(phrase);
    }
  });
});

describe('describePermissionDuration', () => {
  it.each([
    [60_000, '1 minute'],
    [30 * 60_000, '30 minutes'],
    [3_600_000, '1 hour'],
    [2 * 3_600_000, '2 hours'],
    [86_400_000, '24 hours'],
    [2 * 86_400_000, '2 days'],
    [7 * 86_400_000, '7 days'],
    [365 * 86_400_000, '1 year'],
    [90 * 60_000, '90 minutes'],
    [45_000, '1 minute'],
  ])('%i ms reads as %s', (ms, text) => {
    expect(describePermissionDuration(ms)).toBe(text);
  });

  it('never claims a duration shorter than the request', () => {
    expect(describePermissionDuration(61_000)).toBe('2 minutes');
  });
});

describe('timedScopeWords', () => {
  it('builds the allow button and the lasts phrase from the duration', () => {
    expect(timedScopeWords(30 * 60_000)).toEqual({
      choice: 'For 30 minutes',
      allow: 'Allow for 30 minutes',
      lasts: 'for 30 minutes',
    });
    expect(timedScopeWords(7 * 86_400_000).allow).toBe('Allow for 7 days');
  });
});

describe('one scope word list (guard)', () => {
  const consumers = [
    'features/instance-detail/user-action-request.rules.ts',
    'features/instance-detail/browser-approval-request.rules.ts',
    'core/state/pending-approvals-banner.rules.ts',
    'core/state/browser-approvals-banner.rules.ts',
    'features/browser/browser-approval-page.utils.ts',
  ];
  const literals = [
    'Allow this once',
    'Allow for this session',
    'Allow without asking',
    "Don't allow",
    'Block for this session',
    'This session',
  ];

  it.each(consumers)('%s takes its scope words from the shared module', (file) => {
    const source = readFileSync(resolve(renderer, file), 'utf8');
    expect(source).toContain('permission-scope-presentation');
    for (const literal of literals) {
      expect(source, `${file} re-declares "${literal}"`).not.toContain(`'${literal}`);
      expect(source, `${file} re-declares "${literal}"`).not.toContain(`"${literal}`);
    }
  });
});
