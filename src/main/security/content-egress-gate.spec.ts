import { beforeEach, describe, expect, it } from 'vitest';
import { getSecretAuditLog } from './secret-redaction';
import { redactForEgress } from './content-egress-gate';

const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

describe('redactForEgress', () => {
  beforeEach(() => {
    getSecretAuditLog().clear();
  });

  it('replaces whole secret-bearing diff lines while retaining their diff markers and hunk structure', () => {
    const result = redactForEgress(
      [
        'diff --git a/.env b/.env',
        '@@ -1,2 +1,2 @@',
        `-GITHUB_TOKEN=${GITHUB_TOKEN}`,
        '+GITHUB_TOKEN=changed',
        ' unchanged context',
      ].join('\n'),
      { kind: 'diff', preserveDiffMarkers: true },
    );

    expect(result).toEqual({
      content: [
        'diff --git a/.env b/.env',
        '@@ -1,2 +1,2 @@',
        '-[REDACTED — potential secret]',
        '+GITHUB_TOKEN=changed',
        ' unchanged context',
      ].join('\n'),
      secretsFound: true,
      secretCount: 1,
    });
  });

  it('redacts inline secrets without destroying unrelated prompt content and is idempotent', () => {
    const first = redactForEgress(`Review this value: ${GITHUB_TOKEN}\nKeep this conclusion.`, {
      kind: 'prompt',
    });
    const second = redactForEgress(first.content, { kind: 'prompt' });

    expect(first.content).toBe('Review this value: [REDACTED — potential secret]\nKeep this conclusion.');
    expect(second).toEqual({ ...first, secretCount: 0, secretsFound: false });
  });

  it('writes a redaction audit record for each detected secret', () => {
    redactForEgress(`token=${GITHUB_TOKEN}`, { kind: 'webhook', instanceId: 'instance-1' });

    expect(getSecretAuditLog().getRecords()).toEqual([
      expect.objectContaining({
        action: 'redact',
        decision: 'redacted',
        secretName: 'github_pat',
        instanceId: 'instance-1',
      }),
    ]);
  });

  it('collapses overlapping detector matches so a PEM secret is never partially restored', () => {
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'super-sensitive-key-material',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    const result = redactForEgress(`Key follows:\n${privateKey}\nEnd.`, { kind: 'prompt' });

    expect(result.content).toBe('Key follows:\n[REDACTED — potential secret]\nEnd.');
    expect(result.secretCount).toBe(1);
  });
});
