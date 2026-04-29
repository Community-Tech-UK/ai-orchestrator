import { describe, expect, it } from 'vitest';
import { redactValue } from '../redaction';

describe('redactValue', () => {
  it('redacts secret-looking fields and embedded secret values', () => {
    const redacted = redactValue({
      apiKey: 'sk-1234567890abcdefghijklmnop',
      stack: 'failed with sk-1234567890abcdefghijklmnop',
    });

    expect(redacted.apiKey).toBe('<redacted-secret>');
    expect(redacted.stack).toContain('<redacted-secret>');
    expect(redacted.stack).not.toContain('sk-1234567890');
  });

  it('replaces secret environment values and preserves env var presence only', () => {
    const redacted = redactValue(
      {
        line: 'token abcdefghijklmnop',
        hint: 'check process.env.MY_TOKEN',
      },
      { env: { MY_TOKEN: 'abcdefghijklmnop' } },
    );

    expect(redacted.line).toBe('token <redacted-secret>');
    expect(redacted.hint).toBe('check <env:MY_TOKEN:set>');
  });

  it('converts home paths and omits session body fields when requested', () => {
    const redacted = redactValue(
      {
        path: '/Users/tester/project/file.ts',
        content: 'private transcript',
        nested: { response: 'private response' },
      },
      {
        homeDir: '/Users/tester',
        redactSessionBodies: true,
      },
    );

    expect(redacted.path).toBe('~/project/file.ts');
    expect(redacted.content).toBe('[omitted-session-body]');
    expect(redacted.nested.response).toBe('[omitted-session-body]');
  });

  it('handles circular references', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(redactValue(value).self).toBe('[circular]');
  });
});
