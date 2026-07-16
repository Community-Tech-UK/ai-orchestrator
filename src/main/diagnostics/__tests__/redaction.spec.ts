import { describe, expect, it } from 'vitest';
import { redactValue, redactForSink, redactSpanAttributes } from '../redaction';

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

  // Union with the canonical security detector: provider key formats the local
  // inline patterns miss must still be scrubbed from free-text log lines, even
  // when the value never appears in a secret-named env var.
  it('redacts a Google/Gemini API key embedded in a log line', () => {
    const key = 'AIzaSyA1234567890abcdefghijklmnopqrstuvw';
    const redacted = redactValue({ line: `gemini failed using ${key} oops` });
    expect(redacted.line).not.toContain(key);
    expect(redacted.line).toContain('<redacted-secret>');
  });

  it('redacts AWS, Stripe, Slack, GitLab and SendGrid keys in free text', () => {
    const stripeKey = `sk_live_${'x'.repeat(24)}`;
    const samples = {
      aws: 'creds AKIAIOSFODNN7EXAMPLE here',
      stripe: `charge ${stripeKey} done`,
      slack: 'hook xoxb-1234567890-abcdefghijkl posted',
      gitlab: 'token glpat-abcdefghij1234567890 used',
      sendgrid: 'email SG.abcdefghij1234567890ab.cdefghij1234567890abcdefghij done',
    };
    const redacted = redactValue(samples);
    expect(redacted.aws).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted.stripe).not.toContain(stripeKey);
    expect(redacted.slack).not.toContain('xoxb-1234567890');
    expect(redacted.gitlab).not.toContain('glpat-abcdefghij');
    expect(redacted.sendgrid).not.toContain('SG.abcdefghij');
    for (const v of Object.values(redacted)) {
      expect(v).toContain('<redacted-secret>');
    }
  });

  it('still redacts generic sk-/Bearer tokens the detector does not cover', () => {
    const redacted = redactValue({
      openai: 'used sk-proj1234567890abcdefghij to call',
      header: 'Authorization: Bearer abcdef1234567890ghijkl',
    });
    expect(redacted.openai).not.toContain('sk-proj1234567890');
    expect(redacted.openai).toContain('<redacted-secret>');
    expect(redacted.header).toContain('Bearer <redacted-secret>');
  });

  it('leaves benign text untouched', () => {
    const redacted = redactValue({ note: 'the build finished in 42 seconds' });
    expect(redacted.note).toBe('the build finished in 42 seconds');
  });
});

describe('redactForSink (Task 14)', () => {
  it('redacts secret-shaped fields while preserving operational fields', () => {
    const redacted = redactForSink({
      provider: 'claude',
      model: 'claude-opus',
      apiKey: 'sk-1234567890abcdefghij',
      durationMs: 1234,
      status: 'ok',
    });
    expect(redacted.apiKey).toBe('<redacted-secret>');
    expect(redacted.provider).toBe('claude');
    expect(redacted.model).toBe('claude-opus');
    expect(redacted.durationMs).toBe(1234);
    expect(redacted.status).toBe('ok');
  });

  it('preserves allowlisted token-count keys that would otherwise trip the secret heuristic', () => {
    const redacted = redactForSink({
      promptTokens: 100,
      completion_tokens: 55,
      // A string-valued count must survive too (the "token" substring matches
      // the secret-key pattern, so without the allowlist it would be redacted).
      totalTokens: '155',
    });
    expect(redacted.promptTokens).toBe(100);
    expect(redacted.completion_tokens).toBe(55);
    expect(redacted.totalTokens).toBe('155');
  });

  it('still redacts a genuine authorization header', () => {
    const redacted = redactForSink({ authorization: 'Bearer abcdef1234567890ghijkl' });
    expect(redacted.authorization).not.toContain('abcdef1234567890');
  });
});

describe('redactSpanAttributes (Task 14)', () => {
  it('keeps values primitive — secret-keyed strings become the redacted string, not an object', () => {
    const attrs = redactSpanAttributes({
      'ai.provider.model': 'claude-opus',
      'verification.query': 'find sk-1234567890abcdefghij in the repo',
      authorization: 'Bearer abcdef1234567890ghijkl',
      'ai.provider.token_count': 4096,
    });
    expect(attrs['ai.provider.model']).toBe('claude-opus');
    // Inline secret scrubbed from a free-form attribute value, still a string.
    expect(typeof attrs['verification.query']).toBe('string');
    expect(attrs['verification.query']).not.toContain('sk-1234567890');
    // Secret-keyed string collapses to a primitive placeholder (never an object).
    expect(attrs['authorization']).toBe('<redacted-secret>');
    // Numeric count under a secret-shaped key passes through unchanged.
    expect(attrs['ai.provider.token_count']).toBe(4096);
  });
});
