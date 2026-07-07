import { describe, it, expect, vi } from 'vitest';
import {
  SessionRecoveryCoordinator,
  planSessionRecovery,
  computeResumeConfigFingerprint,
} from '../session-recovery';
import type { ResumeCursor } from '../../../session/session-continuity';

function cursor(overrides: Partial<ResumeCursor> = {}): ResumeCursor {
  return {
    provider: 'codex',
    threadId: 'thread-abc',
    workspacePath: '/tmp/project',
    capturedAt: 0,
    scanSource: 'native',
    ...overrides,
  };
}

describe('SessionRecoveryCoordinator', () => {
  it('tries native resume first', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: true });
    const replayFallback = vi.fn();

    const handler = new SessionRecoveryCoordinator({ nativeResume, replayFallback });
    const result = await handler.recover('instance-1', 'session-abc');

    expect(nativeResume).toHaveBeenCalledWith('instance-1', 'session-abc');
    expect(replayFallback).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.method).toBe('native-resume');
  });

  it('falls back to replay when native resume fails', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: false, error: 'Session not found' });
    const replayFallback = vi.fn().mockResolvedValue({ success: true });

    const handler = new SessionRecoveryCoordinator({ nativeResume, replayFallback });
    const result = await handler.recover('instance-1', 'session-abc');

    expect(nativeResume).toHaveBeenCalled();
    expect(replayFallback).toHaveBeenCalledWith('instance-1', 'session-abc');
    expect(result.success).toBe(true);
    expect(result.method).toBe('replay-fallback');
  });

  it('returns failure when both phases fail', async () => {
    const handler = new SessionRecoveryCoordinator({
      nativeResume: vi.fn().mockResolvedValue({ success: false }),
      replayFallback: vi.fn().mockResolvedValue({ success: false, error: 'No history' }),
    });

    const result = await handler.recover('instance-1', 'session-abc');
    expect(result.success).toBe(false);
  });

  it('plans native resume only when resume is supported and session id is usable', () => {
    const plan = planSessionRecovery({
      instanceId: 'instance-1',
      reason: 'restart',
      previousProviderSessionId: 'session-abc',
      provider: 'claude',
      cwd: '/tmp/project',
      capabilities: {
        supportsResume: true,
        supportsForkSession: false,
      },
      adapterGeneration: 2,
      hasConversation: true,
    });

    expect(plan).toMatchObject({
      kind: 'native-resume',
      expectedProof: 'provider-session-match',
      requestedSessionId: 'session-abc',
    });
  });

  it('plans replay fallback instead of native resume when the session is not yet persisted', () => {
    const plan = planSessionRecovery({
      instanceId: 'instance-1',
      reason: 'interrupt',
      previousProviderSessionId: 'session-abc',
      provider: 'claude',
      cwd: '/tmp/project',
      capabilities: {
        supportsResume: true,
        supportsForkSession: false,
      },
      adapterGeneration: 1,
      hasConversation: true,
      // Fresh first turn still in flight — CLI has not flushed the session.
      providerSessionPersisted: false,
    });

    expect(plan).toMatchObject({
      kind: 'replay-fallback',
      reason: 'provider session not yet persisted (fresh first turn)',
    });
  });

  it('still plans native resume once the session has been persisted', () => {
    const plan = planSessionRecovery({
      instanceId: 'instance-1',
      reason: 'interrupt',
      previousProviderSessionId: 'session-abc',
      provider: 'claude',
      cwd: '/tmp/project',
      capabilities: {
        supportsResume: true,
        supportsForkSession: false,
      },
      adapterGeneration: 1,
      hasConversation: true,
      providerSessionPersisted: true,
    });

    expect(plan).toMatchObject({ kind: 'native-resume', requestedSessionId: 'session-abc' });
  });

  it('plans replay fallback instead of native resume for blacklisted sessions', () => {
    const plan = planSessionRecovery({
      instanceId: 'instance-1',
      reason: 'unexpected-exit',
      previousProviderSessionId: 'session-abc',
      provider: 'claude',
      cwd: '/tmp/project',
      capabilities: {
        supportsResume: true,
        supportsForkSession: false,
      },
      adapterGeneration: 3,
      hasConversation: true,
      sessionResumeBlacklisted: true,
    });

    expect(plan).toMatchObject({
      kind: 'replay-fallback',
      reason: 'provider session id is blacklisted',
    });
  });

  describe('config fingerprint (§6.2)', () => {
    it('computeResumeConfigFingerprint is stable and differs across model/cwd', () => {
      const a = computeResumeConfigFingerprint({ provider: 'codex', model: 'gpt-5.5', cwd: '/p' });
      const b = computeResumeConfigFingerprint({ provider: 'codex', model: 'gpt-5.5', cwd: '/p' });
      const c = computeResumeConfigFingerprint({ provider: 'codex', model: 'gpt-5.4', cwd: '/p' });
      const d = computeResumeConfigFingerprint({ provider: 'codex', model: 'gpt-5.5', cwd: '/other' });
      expect(a).toBeTruthy();
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).not.toBe(d);
    });

    it('returns undefined when there is nothing to fingerprint', () => {
      expect(computeResumeConfigFingerprint({})).toBeUndefined();
    });

    it('skips native resume when cursor fingerprint differs from current config', () => {
      const plan = planSessionRecovery({
        instanceId: 'instance-1',
        reason: 'wake',
        previousProviderSessionId: 'session-abc',
        provider: 'codex',
        cwd: '/tmp/project',
        capabilities: { supportsResume: true, supportsForkSession: false },
        adapterGeneration: 1,
        hasConversation: true,
        resumeCursor: cursor({ configFingerprint: 'old-fingerprint-aaaa' }),
        currentConfigFingerprint: 'new-fingerprint-bbbb',
      });

      expect(plan).toMatchObject({
        kind: 'replay-fallback',
        reason: 'resume config fingerprint changed since the session was created (model/cwd/MCP differ)',
      });
    });

    it('allows native resume when fingerprints match', () => {
      const plan = planSessionRecovery({
        instanceId: 'instance-1',
        reason: 'wake',
        previousProviderSessionId: 'session-abc',
        provider: 'codex',
        cwd: '/tmp/project',
        capabilities: { supportsResume: true, supportsForkSession: false },
        adapterGeneration: 1,
        hasConversation: true,
        resumeCursor: cursor({ configFingerprint: 'same-fingerprint' }),
        currentConfigFingerprint: 'same-fingerprint',
      });

      expect(plan).toMatchObject({ kind: 'native-resume' });
    });

    it('stays resume-eligible when the cursor has no fingerprint (legacy cursor)', () => {
      const plan = planSessionRecovery({
        instanceId: 'instance-1',
        reason: 'wake',
        previousProviderSessionId: 'session-abc',
        provider: 'codex',
        cwd: '/tmp/project',
        capabilities: { supportsResume: true, supportsForkSession: false },
        adapterGeneration: 1,
        hasConversation: true,
        resumeCursor: cursor(),
        currentConfigFingerprint: 'new-fingerprint',
      });

      expect(plan).toMatchObject({ kind: 'native-resume' });
    });
  });
});
