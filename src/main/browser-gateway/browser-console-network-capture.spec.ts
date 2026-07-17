import { describe, expect, it } from 'vitest';
import {
  CONSOLE_CAPTURE_UNSUPPORTED_REASON,
  NETWORK_CAPTURE_UNSUPPORTED_REASON,
  captureReportedNotInstalled,
  extractCapturedEntries,
  isUnsupportedCaptureCommandError,
  normalizeCapturedConsoleEntries,
  normalizeCapturedNetworkEntries,
} from './browser-console-network-capture';

describe('browser console/network capture normalization', () => {
  it('extracts entries from the extension { entries } envelope or a bare array', () => {
    expect(extractCapturedEntries({ kind: 'console', installed: true, entries: [1, 2] })).toEqual([1, 2]);
    expect(extractCapturedEntries([3, 4])).toEqual([3, 4]);
    expect(extractCapturedEntries(null)).toEqual([]);
    expect(extractCapturedEntries({ installed: false })).toEqual([]);
  });

  it('flags a not-installed capture buffer distinctly from an empty one', () => {
    expect(captureReportedNotInstalled({ installed: false, entries: [] })).toBe(true);
    expect(captureReportedNotInstalled({ installed: true, entries: [] })).toBe(false);
    expect(captureReportedNotInstalled([])).toBe(false);
  });

  it('normalizes console entries with level, location, stack, and seq', () => {
    const entries = normalizeCapturedConsoleEntries({
      installed: true,
      entries: [
        {
          type: 'error',
          text: 'Cannot read properties of undefined',
          location: { url: 'https://app.example.com/main.js', lineNumber: 42, columnNumber: 7 },
          stack: 'Error\n  at x (main.js:42:7)',
          seq: 5,
          timestamp: 123,
        },
      ],
    });
    expect(entries).toEqual([
      {
        type: 'error',
        text: 'Cannot read properties of undefined',
        location: { url: 'https://app.example.com/main.js', lineNumber: 42, columnNumber: 7 },
        stack: 'Error\n  at x (main.js:42:7)',
        seq: 5,
        timestamp: 123,
      },
    ]);
  });

  it('redacts secrets in console text and location urls', () => {
    const [entry] = normalizeCapturedConsoleEntries({
      entries: [
        {
          type: 'warn',
          text: 'authorization: Bearer sk-do-not-leak',
          location: { url: 'https://app.example.com/cb?token=leaky-token-value' },
          timestamp: 1,
        },
      ],
    });
    expect(entry.text).toContain('[REDACTED]');
    expect(entry.text).not.toContain('sk-do-not-leak');
    // URL query redaction goes through URLSearchParams, which percent-encodes
    // the marker (%5BREDACTED%5D); assert the secret is gone + marker present.
    expect(entry.location?.url).toContain('REDACTED');
    expect(entry.location?.url).not.toContain('leaky-token-value');
  });

  it('normalizes network entries with status, failure, and redacted url', () => {
    const entries = normalizeCapturedNetworkEntries({
      entries: [
        {
          method: 'get',
          url: 'https://api.example.com/orders?token=secret-value',
          resourceType: 'fetch',
          status: 401,
          statusText: 'Unauthorized',
          ok: false,
          seq: 9,
          timestamp: 2,
        },
        {
          method: 'POST',
          url: 'https://api.example.com/submit',
          resourceType: 'xhr',
          status: 0,
          failureText: 'request failed or was aborted',
          timestamp: 3,
        },
      ],
    });
    expect(entries[0]).toMatchObject({
      method: 'GET',
      resourceType: 'fetch',
      status: 401,
      statusText: 'Unauthorized',
      ok: false,
      seq: 9,
    });
    expect(entries[0].url).toContain('REDACTED');
    expect(entries[0].url).not.toContain('secret-value');
    expect(entries[1]).toMatchObject({
      method: 'POST',
      resourceType: 'xhr',
      status: 0,
      failureText: 'request failed or was aborted',
    });
  });

  it('redacts sensitive network headers when present', () => {
    const [entry] = normalizeCapturedNetworkEntries({
      entries: [
        {
          method: 'GET',
          url: 'https://api.example.com/me',
          resourceType: 'fetch',
          status: 200,
          headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
          timestamp: 1,
        },
      ],
    });
    const headers = (entry as unknown as { headers?: Record<string, string> }).headers;
    expect(headers?.['authorization']).toBe('[REDACTED]');
    expect(headers?.['content-type']).toBe('application/json');
  });

  it('drops non-object rows and caps text length', () => {
    const long = 'x'.repeat(9000);
    const entries = normalizeCapturedConsoleEntries({
      entries: [null, 'nope', 42, { type: 'error', text: long, timestamp: 1 }],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].text.length).toBeLessThan(long.length);
    expect(entries[0].text.endsWith('…[truncated]')).toBe(true);
  });

  it('detects an old-extension unsupported-command error', () => {
    expect(isUnsupportedCaptureCommandError('Unsupported browser command: console_messages')).toBe(true);
    expect(isUnsupportedCaptureCommandError('browser_extension_command_timeout')).toBe(false);
  });

  it('exposes distinct capability-error reason codes', () => {
    expect(CONSOLE_CAPTURE_UNSUPPORTED_REASON).toBe('console_capture_unsupported_for_driver');
    expect(NETWORK_CAPTURE_UNSUPPORTED_REASON).toBe('network_capture_unsupported_for_driver');
    expect(CONSOLE_CAPTURE_UNSUPPORTED_REASON).not.toBe('profile_target_or_url_not_found');
  });
});
