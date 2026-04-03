import { describe, it, expect } from 'vitest';
import {
  generateId, generateShortId, generateToken, generateTimestampedId,
  generatePrefixedId, generateInstanceId, generateOrchestrationId,
  INSTANCE_ID_PREFIXES, ORCHESTRATION_ID_PREFIXES,
} from '../id-generator';

describe('id-generator', () => {
  describe('generateId', () => {
    it('returns a valid UUID v4', () => {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateShortId', () => {
    it('returns 8 characters', () => {
      expect(generateShortId()).toHaveLength(8);
    });
  });

  describe('generateToken', () => {
    it('returns 64 hex characters', () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateTimestampedId', () => {
    it('contains a dash separator', () => {
      expect(generateTimestampedId()).toContain('-');
    });
  });

  describe('generatePrefixedId', () => {
    it('starts with the given prefix', () => {
      const id = generatePrefixedId('test');
      expect(id.startsWith('test')).toBe(true);
    });

    it('has prefix + 8 random characters', () => {
      const id = generatePrefixedId('z');
      expect(id).toHaveLength(9);
    });
  });

  describe('generateInstanceId', () => {
    it('uses claude prefix by default for claude provider', () => {
      const id = generateInstanceId('claude');
      expect(id.startsWith(INSTANCE_ID_PREFIXES.claude)).toBe(true);
    });

    it('uses generic prefix when no provider specified', () => {
      const id = generateInstanceId();
      expect(id.startsWith(INSTANCE_ID_PREFIXES.generic)).toBe(true);
    });

    it('returns InstanceId branded type usable as string', () => {
      const id = generateInstanceId('gemini');
      expect(typeof id).toBe('string');
      expect(id.startsWith('g')).toBe(true);
    });
  });

  describe('generateOrchestrationId', () => {
    it('uses debate prefix', () => {
      const id = generateOrchestrationId('debate');
      expect(id.startsWith(ORCHESTRATION_ID_PREFIXES.debate)).toBe(true);
    });

    it('uses session prefix', () => {
      const id = generateOrchestrationId('session');
      expect(id.startsWith(ORCHESTRATION_ID_PREFIXES.session)).toBe(true);
    });
  });
});
