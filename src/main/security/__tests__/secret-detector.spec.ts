import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetExactSecretValuesForTesting,
  detectSecrets,
  redactSecrets,
  registerExactSecretValue,
  unregisterExactSecretValue,
} from '../secret-detector';
import { redactForEgress } from '../content-egress-gate';

describe('SecretDetector', () => {
  describe('prefix-based value scanning', () => {
    it('detects GitHub PAT (ghp_)', () => {
      const results = detectSecrets('token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(results.some(s => s.type === 'token' && s.name === 'github_pat')).toBe(true);
    });

    it('detects GitHub fine-grained token (github_pat_)', () => {
      const results = detectSecrets('GITHUB_TOKEN=github_pat_11ABCDEF0123456789abcdef');
      expect(results.some(s => s.type === 'token')).toBe(true);
    });

    it('detects AWS access key (AKIA)', () => {
      const results = detectSecrets('aws_key=AKIAFAKEFAKEFAKEFAKE');
      expect(results.some(s => s.type === 'api_key' && s.name === 'aws_access_key')).toBe(true);
    });

    it('detects Anthropic API key (sk-ant-api03-)', () => {
      const results = detectSecrets('key: sk-ant-api03-xxxxxxxxxxxxxxxxxxxx');
      expect(results.some(s => s.type === 'api_key' && s.name === 'anthropic_api_key')).toBe(true);
    });

    it('detects Slack bot token (xoxb-)', () => {
      const results = detectSecrets('SLACK=xoxb-123456789-123456789-abcdef');
      expect(results.some(s => s.type === 'token' && s.name === 'slack_token')).toBe(true);
    });

    it('detects Stripe secret key (sk_test_)', () => {
      const results = detectSecrets(`STRIPE_KEY=sk_test_${'x'.repeat(24)}`);
      expect(results.some(s => s.type === 'api_key' && s.name === 'stripe_key')).toBe(true);
    });

    it('detects Google API key (AIza)', () => {
      // AIza + 35 alphanumeric/dash/underscore chars = valid Google API key format
      const results = detectSecrets('gcp_key=AIzaSyDaGmWKa4JsXZ_AdVktZoaneg-EXAMPLEkey');
      expect(results.some(s => s.type === 'api_key' && s.name === 'google_api_key')).toBe(true);
    });

    it('does not false-positive on normal text', () => {
      const results = detectSecrets('The skiing trip was amazing');
      expect(results.length).toBe(0);
    });
  });

  describe('redactSecrets', () => {
    it('replaces detected secrets with redaction markers', () => {
      const input = 'key=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const result = redactSecrets(input);
      expect(result).not.toContain('ghp_');
      expect(result).toContain('[REDACTED');
    });

    it('does not store raw secret value in DetectedSecret', () => {
      const results = detectSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz123456');
      for (const secret of results) {
        expect(secret.redactedValue).toBeDefined();
        expect(secret.redactedValue).toMatch(/^\*+$/);
      }
    });
  });

  describe('runtime exact-value matchers', () => {
    const stored = 'aio-workspace-secret-placeholder-0001';

    afterEach(() => {
      _resetExactSecretValuesForTesting();
    });

    it('redacts a registered exact value at egress', () => {
      registerExactSecretValue(stored, 'github-pat');
      const result = redactForEgress(`leak: ${stored}`, { kind: 'prompt' });
      expect(result.secretsFound).toBe(true);
      expect(result.content).not.toContain(stored);
    });

    it('stops matching after unregister', () => {
      registerExactSecretValue(stored, 'github-pat');
      unregisterExactSecretValue(stored);
      const result = redactForEgress(`leak: ${stored}`, { kind: 'prompt' });
      expect(result.content).toContain(stored);
    });
    it.each([false, true])('redacts the union of overlapping exact values (reverse registration: %s)', (reverse) => {
      const full = 'OBVIOUS_TEST_SECRET_PLACEHOLDER_FOR_AUDIT_ONLY';
      const registrations = [[full, 'full_placeholder'], ['TEST_SECRET', 'inner_placeholder']];
      for (const [value, name] of reverse ? registrations.reverse() : registrations) registerExactSecretValue(value, name);
      expect(redactSecrets(`before ${full} after ${full}`)).toBe('before [REDACTED:full_placeholder] after [REDACTED:full_placeholder]');
    });
    it('unions partial overlaps without changing surrounding text', () => {
      const left = 'OBVIOUS_LEFT_PLACEHOLDER';
      const right = 'PLACEHOLDER_RIGHT_OBVIOUS';
      registerExactSecretValue(left, 'left_placeholder');
      registerExactSecretValue(right, 'right_placeholder');
      expect(redactSecrets('before OBVIOUS_LEFT_PLACEHOLDER_RIGHT_OBVIOUS after')).toBe('before [REDACTED:left_placeholder] after');
    });
    it('redacts every occurrence of a repeated placeholder connection string', () => {
      const placeholder = 'postgres://OBVIOUS_USER_PLACEHOLDER:OBVIOUS_PASSWORD_PLACEHOLDER@example.invalid/db';
      expect(redactSecrets(`before ${placeholder} between ${placeholder} after`)).toBe('before [REDACTED:connection_string] between [REDACTED:connection_string] after');
    });
    it('redacts overlapping occurrences of the same registered placeholder', () => {
      registerExactSecretValue('OBVIOUS_PLACEHOLDER_OBVIOUS_PLACEHOLDER', 'overlap_placeholder');
      expect(redactSecrets('before OBVIOUS_PLACEHOLDER_OBVIOUS_PLACEHOLDER_OBVIOUS_PLACEHOLDER after')).toBe('before [REDACTED:overlap_placeholder] after');
    });
  });
});
