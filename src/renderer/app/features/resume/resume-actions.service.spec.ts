import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecoverSessionResult,
  SessionRecoveryCandidate,
} from '../../../../shared/types/session-recovery.types';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { SessionRecoveryStore } from '../../core/state/session-recovery.store';
import { ResumeActionsService } from './resume-actions.service';

function candidate(overrides: Partial<SessionRecoveryCandidate> = {}): SessionRecoveryCandidate {
  return {
    recoveryKey: 'recovery:claude:new',
    sourceInstanceId: 'source-1',
    historyThreadId: 'thread-1',
    provider: 'claude',
    modelId: 'sonnet',
    displayName: 'Autosaved auth fix',
    workingDirectory: '/repo',
    lastActivityAt: 1_700_000_000_000,
    recoveredMessageCount: 4,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
    ...overrides,
  };
}

describe('ResumeActionsService recovery actions', () => {
  const recoveryCandidates = signal<SessionRecoveryCandidate[]>([]);
  const recoveryError = signal<string | null>(null);
  const recoveryStore = {
    candidates: recoveryCandidates.asReadonly(),
    error: recoveryError.asReadonly(),
    recover: vi.fn(),
  };
  const historyIpc = {
    resumeLatest: vi.fn(),
    resumeById: vi.fn(),
    resumeSwitchToLive: vi.fn(),
    resumeForkNew: vi.fn(),
    resumeRestoreFallback: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    recoveryCandidates.set([]);
    recoveryError.set(null);
    recoveryStore.recover.mockResolvedValue({
      instanceId: 'replacement-1',
      recoveredMessageCount: 4,
      usedNativeResume: false,
    } satisfies RecoverSessionResult);
    historyIpc.resumeLatest.mockResolvedValue({ success: true, data: { instanceId: 'history-1' } });
    TestBed.configureTestingModule({
      providers: [
        ResumeActionsService,
        { provide: HistoryIpcService, useValue: historyIpc },
        { provide: SessionRecoveryStore, useValue: recoveryStore },
      ],
    });
  });

  it('recovers the newest autosave candidate before ordinary history for Resume Latest', async () => {
    recoveryCandidates.set([
      candidate({ recoveryKey: 'recovery:claude:older', lastActivityAt: 10 }),
      candidate({ recoveryKey: 'recovery:claude:newer', lastActivityAt: 20 }),
    ]);
    const service = TestBed.inject(ResumeActionsService);

    const response = await service.resumeLatest('/repo');

    expect(recoveryStore.recover).toHaveBeenCalledWith('recovery:claude:newer');
    expect(historyIpc.resumeLatest).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      success: true,
      source: 'recovery',
      recoveredMessageCount: 4,
      data: { instanceId: 'replacement-1' },
    });
  });

  it('falls back to the existing history Resume Latest path when no recovery candidate exists', async () => {
    const service = TestBed.inject(ResumeActionsService);

    const response = await service.resumeLatest('/repo');

    expect(historyIpc.resumeLatest).toHaveBeenCalledWith('/repo');
    expect(recoveryStore.recover).not.toHaveBeenCalled();
    expect(response).toEqual({ success: true, data: { instanceId: 'history-1' } });
  });

  it('wraps explicit autosave recovery success in the existing resume response shape', async () => {
    recoveryStore.recover.mockResolvedValueOnce({
      instanceId: 'replacement-2',
      recoveredMessageCount: 7,
      usedNativeResume: true,
    } satisfies RecoverSessionResult);
    const service = TestBed.inject(ResumeActionsService);

    const response = await service.recoverAutosave('recovery:claude:key');

    expect(response).toMatchObject({
      success: true,
      source: 'recovery',
      recoveredMessageCount: 7,
      data: { instanceId: 'replacement-2' },
    });
  });

  it('returns a retryable recovery error without falling back to history', async () => {
    recoveryCandidates.set([candidate()]);
    recoveryError.set('Recovery replacement failed to start');
    recoveryStore.recover.mockResolvedValueOnce(null);
    const service = TestBed.inject(ResumeActionsService);

    const response = await service.recoverAutosave('recovery:claude:new');

    expect(response).toEqual({
      success: false,
      source: 'recovery',
      error: { message: 'Recovery replacement failed to start' },
    });
    expect(historyIpc.resumeLatest).not.toHaveBeenCalled();
  });
});
