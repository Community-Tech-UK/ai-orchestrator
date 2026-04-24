import { describe, it, expect, vi } from 'vitest';
import { SessionRecoveryHandler, planSessionRecovery } from '../session-recovery';

describe('SessionRecoveryHandler', () => {
  it('tries native resume first', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: true });
    const replayFallback = vi.fn();

    const handler = new SessionRecoveryHandler({ nativeResume, replayFallback });
    const result = await handler.recover('instance-1', 'session-abc');

    expect(nativeResume).toHaveBeenCalledWith('instance-1', 'session-abc');
    expect(replayFallback).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.method).toBe('native-resume');
  });

  it('falls back to replay when native resume fails', async () => {
    const nativeResume = vi.fn().mockResolvedValue({ success: false, error: 'Session not found' });
    const replayFallback = vi.fn().mockResolvedValue({ success: true });

    const handler = new SessionRecoveryHandler({ nativeResume, replayFallback });
    const result = await handler.recover('instance-1', 'session-abc');

    expect(nativeResume).toHaveBeenCalled();
    expect(replayFallback).toHaveBeenCalledWith('instance-1', 'session-abc');
    expect(result.success).toBe(true);
    expect(result.method).toBe('replay-fallback');
  });

  it('returns failure when both phases fail', async () => {
    const handler = new SessionRecoveryHandler({
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
});
