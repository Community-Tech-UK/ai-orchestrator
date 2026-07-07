import { describe, it, expect } from 'vitest';
import {
  toInstanceId,
  toSessionId,
  toDebateId,
  toVerificationId,
  toConsensusId,
  toWorktreeId,
  toChatId,
  type InstanceId,
  type SessionId,
} from '../branded-ids';

describe('branded-ids', () => {
  describe('factory functions', () => {
    it('toInstanceId returns the same string value', () => {
      const raw = 'c8f3k2m1p';
      const branded = toInstanceId(raw);
      expect(branded).toBe(raw);
      expect(typeof branded).toBe('string');
    });

    it('toSessionId returns the same string value', () => {
      const branded = toSessionId('s7j4x1q9w');
      expect(branded).toBe('s7j4x1q9w');
    });

    it('toDebateId returns the same string value', () => {
      const branded = toDebateId('d5k2m8n3p');
      expect(branded).toBe('d5k2m8n3p');
    });

    it('toVerificationId returns the same string value', () => {
      expect(toVerificationId('v123')).toBe('v123');
    });

    it('toConsensusId returns the same string value', () => {
      expect(toConsensusId('n456')).toBe('n456');
    });

    it('toWorktreeId returns the same string value', () => {
      expect(toWorktreeId('w321')).toBe('w321');
    });

    it('toChatId returns the same string value', () => {
      expect(toChatId('chat-1')).toBe('chat-1');
    });
  });

  describe('type safety (compile-time)', () => {
    it('branded IDs are interchangeable with string at runtime', () => {
      const instanceId: InstanceId = toInstanceId('c123');
      const sessionId: SessionId = toSessionId('s456');

      expect(instanceId.startsWith('c')).toBe(true);
      expect(sessionId.length).toBe(4);
    });
  });
});
