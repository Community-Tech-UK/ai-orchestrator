import { describe, expect, it } from 'vitest';
import { detectSecrets, redactSecrets } from '../secret-detector';

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
});
