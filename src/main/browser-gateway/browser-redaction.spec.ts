import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';
import { boundBrowserText, redactBrowserText, redactBrowserUrl, redactHeaders } from './browser-redaction';

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

describe('boundBrowserText (WS11.1 page-text spillover cap)', () => {
  it('returns small pages unchanged (after redaction)', () => {
    expect(boundBrowserText('hello page')).toBe('hello page');
  });

  it('caps an oversized synthetic page with a spillover reference instead of silently dropping text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-page-spill-'));
    _setToolOutputDirForTesting(dir);
    try {
      // ~40k lines / ~400 KB — far over the 2000-line / 51 KB preview caps.
      const hugePage = Array.from({ length: 40_000 }, (_, i) => `line-${i} content`).join('\n');
      const bounded = boundBrowserText(hugePage);
      expect(bounded.length).toBeLessThan(hugePage.length);
      expect(bounded).toContain('line-0 content'); // head preserved
      expect(bounded).toContain('[Output truncated'); // spill marker present
      expect(bounded).not.toContain('line-39999'); // tail actually cut from preview
    } finally {
      _setToolOutputDirForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the page preview within 12 KB and spills only redacted text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-page-cap-'));
    _setToolOutputDirForTesting(dir);
    try {
      const bounded = boundBrowserText(`password: placeholder\n${'x'.repeat(40_000)}`);
      expect(Buffer.byteLength(bounded.split('\n\n[Output truncated')[0])).toBeLessThanOrEqual(12_000);
      expect(bounded).toContain('password: [REDACTED]');
      expect(bounded).not.toContain('placeholder');
      const file = fs.readdirSync(dir)[0];
      expect(file).toBeDefined();
      const spill = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(spill).toContain('password: [REDACTED]');
      expect(spill).not.toContain('placeholder');
      expect(spill.length).toBeGreaterThan(12_000);
    } finally {
      _setToolOutputDirForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
