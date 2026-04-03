import { describe, it, expect } from 'vitest';
import {
  toInstanceId, toSessionId, toAgentId, toDebateId,
  toVerificationId, toConsensusId, toReviewId, toWorktreeId,
  toTaskId, toSkillId, toServerId, toSnapshotId,
  toWorkflowId, toArtifactId, toSupervisorNodeId, toWorkerNodeId,
  type InstanceId, type SessionId, type AgentId,
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

    it('toAgentId returns the same string value', () => {
      const branded = toAgentId('agent-default');
      expect(branded).toBe('agent-default');
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

    it('toReviewId returns the same string value', () => {
      expect(toReviewId('r789')).toBe('r789');
    });

    it('toWorktreeId returns the same string value', () => {
      expect(toWorktreeId('w321')).toBe('w321');
    });

    it('toTaskId returns the same string value', () => {
      expect(toTaskId('task-1')).toBe('task-1');
    });

    it('toSkillId returns the same string value', () => {
      expect(toSkillId('skill-1')).toBe('skill-1');
    });

    it('toServerId returns the same string value', () => {
      expect(toServerId('srv-1')).toBe('srv-1');
    });

    it('toSnapshotId returns the same string value', () => {
      expect(toSnapshotId('snap-1')).toBe('snap-1');
    });

    it('toWorkflowId returns the same string value', () => {
      expect(toWorkflowId('wf-1')).toBe('wf-1');
    });

    it('toArtifactId returns the same string value', () => {
      expect(toArtifactId('art-1')).toBe('art-1');
    });

    it('toSupervisorNodeId returns the same string value', () => {
      expect(toSupervisorNodeId('sup-1')).toBe('sup-1');
    });

    it('toWorkerNodeId returns the same string value', () => {
      expect(toWorkerNodeId('wrk-1')).toBe('wrk-1');
    });
  });

  describe('type safety (compile-time)', () => {
    it('branded IDs are interchangeable with string at runtime', () => {
      const instanceId: InstanceId = toInstanceId('c123');
      const sessionId: SessionId = toSessionId('s456');
      const agentId: AgentId = toAgentId('a789');

      expect(instanceId.startsWith('c')).toBe(true);
      expect(sessionId.length).toBe(4);
      expect(agentId.includes('789')).toBe(true);
    });
  });
});
