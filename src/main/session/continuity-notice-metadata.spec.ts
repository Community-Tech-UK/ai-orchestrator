import { describe, expect, it } from 'vitest';
import type { PresentedError } from '../../shared/present-error';
import type { OutputMessage } from '../../shared/types/instance.types';
import { noticeToMetadata, readNoticeMetadata } from './continuity-notice-metadata';

function message(type: OutputMessage['type'], metadata?: Record<string, unknown>): Pick<OutputMessage, 'type' | 'metadata'> {
  return { type, ...(metadata ? { metadata } : {}) };
}

function presentation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'quota',
    headline: 'Your Claude account has used its weekly allowance.',
    whatToDo: 'What to do: Wait for the allowance to reset, or switch account.',
    action: 'switch-account',
    rawDetail: 'Provider rate limit "rejected" (seven_day). Resets at 09:00.',
    ...overrides,
  };
}

// Obvious placeholders, assembled at run time so the file holds no secret-shaped literal.
const FAKE_GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;
const FAKE_JWT = [`eyJ${'a'.repeat(12)}`, `eyJ${'b'.repeat(12)}`, 'c'.repeat(12)].join('.');
const FAKE_OPAQUE = 'z'.repeat(24);

describe('readNoticeMetadata', () => {
  it('keeps exactly the named presentation facts of a system message', () => {
    const notice = readNoticeMetadata(message('system', {
      audience: 'routine',
      severity: 'warning',
      presentationKind: 'request-receipt',
      requestId: 'req-42',
      resumeFailed: true,
      errorPresentation: presentation(),
    }));

    expect(notice).toEqual({
      audience: 'routine',
      severity: 'warning',
      presentationKind: 'request-receipt',
      requestId: 'req-42',
      resumeFailed: true,
      errorPresentation: presentation(),
    });
  });

  it('keeps nothing else, however it is nested', () => {
    const notice = readNoticeMetadata(message('system', {
      audience: 'routine',
      diagnostic: true,
      category: 'quota',
      fatal: false,
      credentialHint: FAKE_OPAQUE,
      nested: { deep: { object: [1, 2, 3] } },
      errorPresentation: presentation({ stack: 'at secret.js:1', extra: { more: true } }),
    }));

    expect(Object.keys(notice ?? {}).sort()).toEqual(['audience', 'errorPresentation']);
    expect(Object.keys(notice?.errorPresentation ?? {}).sort()).toEqual(['action', 'category', 'headline', 'rawDetail', 'whatToDo']);
    expect(JSON.stringify(notice)).not.toContain(FAKE_OPAQUE);
    expect(JSON.stringify(notice)).not.toContain('secret.js');
  });

  it('is undefined when a message carries none of them', () => {
    expect(readNoticeMetadata(message('system'))).toBeUndefined();
    expect(readNoticeMetadata(message('system', {}))).toBeUndefined();
    expect(readNoticeMetadata(message('system', { internalInput: { actor: 'harness' }, autoRespawn: true }))).toBeUndefined();
  });

  it('drops a value outside the vocabulary rather than passing it through', () => {
    const notice = readNoticeMetadata(message('system', {
      audience: 'Routine',
      severity: 'critical',
      presentationKind: 'sparkle',
      requestId: 12,
      resumeFailed: 'true',
    }));

    expect(notice).toBeUndefined();
  });

  it('does not save the default audience, since a notice with none already reads as attention', () => {
    expect(readNoticeMetadata(message('system', { audience: 'attention' }))).toBeUndefined();
    expect(readNoticeMetadata(message('system', { audience: 'attention', severity: 'warning' }))).toEqual({ severity: 'warning' });
  });

  it('keeps resumeFailed only when it is true', () => {
    expect(readNoticeMetadata(message('system', { resumeFailed: true }))).toEqual({ resumeFailed: true });
    expect(readNoticeMetadata(message('system', { resumeFailed: false }))).toBeUndefined();
  });

  it('keeps a request id whole or not at all', () => {
    expect(readNoticeMetadata(message('system', { requestId: '  req-7  ' }))).toEqual({ requestId: 'req-7' });
    expect(readNoticeMetadata(message('system', { requestId: '   ' }))).toBeUndefined();
    expect(readNoticeMetadata(message('system', { requestId: 'r'.repeat(201) }))).toBeUndefined();
    expect(readNoticeMetadata(message('system', { requestId: 'r'.repeat(200) }))?.requestId).toHaveLength(200);
  });

  it('reads an error message as severity error, whatever it declares', () => {
    expect(readNoticeMetadata(message('error'))).toEqual({ severity: 'error' });
    expect(readNoticeMetadata(message('error', { severity: 'warning' }))).toEqual({ severity: 'error' });
    expect(readNoticeMetadata(message('system', { severity: 'warning' }))).toEqual({ severity: 'warning' });
  });
});

describe('error presentation', () => {
  it('is dropped whole when its category or text is not usable', () => {
    for (const bad of [
      presentation({ category: 'catastrophe' }),
      presentation({ category: 'constructor' }),
      presentation({ headline: undefined }),
      presentation({ whatToDo: 3 }),
      'not an object',
      ['array'],
      null,
    ]) {
      expect(readNoticeMetadata(message('system', { errorPresentation: bad })), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('keeps the presentation but drops an action it does not know, and defaults a missing detail to empty', () => {
    const notice = readNoticeMetadata(message('system', { errorPresentation: presentation({ action: 'explode', rawDetail: undefined }) }));

    expect(notice?.errorPresentation).toEqual({
      category: 'quota',
      headline: 'Your Claude account has used its weekly allowance.',
      whatToDo: 'What to do: Wait for the allowance to reset, or switch account.',
      rawDetail: '',
    });
  });

  it('takes secrets out of the details before they are saved', () => {
    const rawDetail = [
      `401 from provider. Authorization: Bearer ${FAKE_OPAQUE}`,
      `retrying with api_key=${FAKE_OPAQUE}`,
      `token ${FAKE_GITHUB_TOKEN} was rejected`,
      `session ${FAKE_JWT} expired`,
      `key sk-${FAKE_OPAQUE} is invalid`,
    ].join('\n');

    const saved = readNoticeMetadata(message('system', { errorPresentation: presentation({ rawDetail }) }))?.errorPresentation?.rawDetail ?? '';

    for (const secret of [FAKE_OPAQUE, FAKE_GITHUB_TOKEN, FAKE_JWT]) expect(saved).not.toContain(secret);
    expect(saved).toContain('401 from provider.');
    expect(saved).toContain('[REDACTED');
  });

  it('redacts the headline and advice as well', () => {
    const notice = readNoticeMetadata(message('system', {
      errorPresentation: presentation({ headline: `Failed with ${FAKE_GITHUB_TOKEN}`, whatToDo: `Use Bearer ${FAKE_OPAQUE}` }),
    }));

    expect(JSON.stringify(notice)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(notice)).not.toContain(FAKE_OPAQUE);
  });

  it('leaves ordinary wording alone, including a short word after "token:"', () => {
    const rawDetail = 'Invalid token: expired. Password: required. See https://example.com/docs#auth for the secret: none';

    const saved = readNoticeMetadata(message('system', { errorPresentation: presentation({ rawDetail }) }))?.errorPresentation?.rawDetail;

    expect(saved).toBe(rawDetail);
  });

  it('caps the length, ending a cut text with an ellipsis at exactly the cap', () => {
    const notice = readNoticeMetadata(message('system', {
      errorPresentation: presentation({ rawDetail: 'x'.repeat(20_000), headline: 'h'.repeat(5_000), whatToDo: 'w'.repeat(5_000) }),
    }));

    expect(notice?.errorPresentation?.rawDetail).toHaveLength(8_000);
    expect(notice?.errorPresentation?.rawDetail.endsWith('…')).toBe(true);
    expect(notice?.errorPresentation?.headline).toHaveLength(1_000);
    expect(notice?.errorPresentation?.whatToDo).toHaveLength(1_000);
  });

  it('redacts before it cuts, so a secret across the cap leaves no fragment', () => {
    const rawDetail = `${'x'.repeat(7_990)}${FAKE_GITHUB_TOKEN}${'y'.repeat(100)}`;

    const saved = readNoticeMetadata(message('system', { errorPresentation: presentation({ rawDetail }) }))?.errorPresentation?.rawDetail ?? '';

    expect(saved).toHaveLength(8_000);
    expect(saved).not.toContain('ghp_');
    expect(saved).not.toContain('aaaaaa');
  });
});

describe('noticeToMetadata', () => {
  it('gives back the same keys it was saved under', () => {
    const notice = readNoticeMetadata(message('system', {
      audience: 'routine', severity: 'info', presentationKind: 'request-receipt', requestId: 'req-1', resumeFailed: true,
      errorPresentation: presentation(),
    }));

    expect(noticeToMetadata(notice)).toEqual({
      audience: 'routine', severity: 'info', presentationKind: 'request-receipt', requestId: 'req-1', resumeFailed: true,
      errorPresentation: presentation(),
    });
  });

  it('is empty for no notice', () => {
    expect(noticeToMetadata(undefined)).toEqual({});
  });

  it('applies the same checks to a saved entry, so a corrupt one cannot add keys', () => {
    const corrupt = {
      audience: 'routine',
      severity: 'loud',
      requestId: 'r'.repeat(500),
      anything: { goes: 'here' },
      errorPresentation: { ...presentation(), injected: true, rawDetail: `leaked ${FAKE_GITHUB_TOKEN}` },
    };

    const restored = noticeToMetadata(corrupt as never);

    expect(Object.keys(restored).sort()).toEqual(['audience', 'errorPresentation']);
    expect(JSON.stringify(restored)).not.toContain(FAKE_GITHUB_TOKEN);
    expect(JSON.stringify(restored)).not.toContain('injected');
  });

  it('returns a copy, not the saved object', () => {
    const notice = readNoticeMetadata(message('system', { errorPresentation: presentation() }));
    const restored = noticeToMetadata(notice);

    expect(restored['errorPresentation']).toEqual(notice?.errorPresentation);
    expect(restored['errorPresentation']).not.toBe(notice?.errorPresentation);
  });
});

describe('reading what was just restored gives the same notice back', () => {
  const longDetail = `${'x'.repeat(7_990)}${FAKE_GITHUB_TOKEN}${'y'.repeat(100)}`;
  const cases: [string, OutputMessage['type'], Record<string, unknown>][] = [
    ['routine warning', 'system', { audience: 'routine', severity: 'warning' }],
    ['request receipt', 'system', { presentationKind: 'request-receipt', requestId: 'req-9' }],
    ['resume failed', 'system', { audience: 'routine', severity: 'warning', resumeFailed: true }],
    ['error presentation', 'system', { errorPresentation: presentation({ rawDetail: `bad ${FAKE_JWT} and ${FAKE_OPAQUE}` }) }],
    ['oversize, redacted detail', 'system', { errorPresentation: presentation({ rawDetail: longDetail }) }],
    ['error message', 'error', { errorPresentation: presentation(), severity: 'warning' }],
  ];

  it.each(cases)('%s', (_name, type, metadata) => {
    const saved = readNoticeMetadata(message(type, metadata));
    const again = readNoticeMetadata({ type: 'system', metadata: noticeToMetadata(saved) });

    expect(JSON.stringify(again)).toBe(JSON.stringify(saved));
  });

  it('survives a trip through JSON, as a saved state file does', () => {
    const saved = readNoticeMetadata(message('system', { audience: 'routine', errorPresentation: presentation() })) as PresentedErrorCarrier;
    const fromDisk = JSON.parse(JSON.stringify(saved)) as PresentedErrorCarrier;

    expect(JSON.stringify(readNoticeMetadata({ type: 'system', metadata: noticeToMetadata(fromDisk) }))).toBe(JSON.stringify(saved));
  });
});

type PresentedErrorCarrier = NonNullable<ReturnType<typeof readNoticeMetadata>> & { errorPresentation?: PresentedError };
