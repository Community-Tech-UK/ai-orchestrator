import { describe, expect, it } from 'vitest';
import { redactBrowserText, redactBrowserUrl, redactHeaders } from './browser-redaction';

describe('browser-redaction', () => {
  it('redacts sensitive browser headers and leaves safe headers intact', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer abc',
        Cookie: 'sid=123',
        'Set-Cookie': 'sid=123',
        'X-Api-Key': 'secret-key',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'Set-Cookie': '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'Content-Type': 'application/json',
    });
  });

  it('redacts sensitive key-value pairs in browser text', () => {
    const result = redactBrowserText(
      'Authorization: Bearer auth-token\nCookie: sid=123\nX-Api-Key: secret-key\ntoken=abc123 password: hunter2 "sessionId": "sess-1" safe=value',
    );

    expect(result).toContain('Authorization: [REDACTED]');
    expect(result).toContain('Cookie: [REDACTED]');
    expect(result).toContain('X-Api-Key: [REDACTED]');
    expect(result).toContain('token=[REDACTED]');
    expect(result).toContain('password: [REDACTED]');
    expect(result).toContain('"sessionId": "[REDACTED]"');
    expect(result).toContain('safe=value');
    expect(result).not.toContain('auth-token');
    expect(result).not.toContain('sid=123');
    expect(result).not.toContain('secret-key');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('sess-1');
  });

  it('redacts sensitive URL credentials, query params, and fragments', () => {
    const result = redactBrowserUrl(
      'https://user:pass@example.com/upload?token=abc123&safe=value&api_key=secret#session=sess-1',
    );

    expect(result).toBe(
      'https://%5BREDACTED%5D:%5BREDACTED%5D@example.com/upload?token=%5BREDACTED%5D&safe=value&api_key=%5BREDACTED%5D#[REDACTED]',
    );
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('secret');
    expect(result).not.toContain('sess-1');
    expect(result).toContain('safe=value');
  });
});
