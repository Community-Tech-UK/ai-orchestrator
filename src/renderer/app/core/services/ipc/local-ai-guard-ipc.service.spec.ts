import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalAiGuardSnapshot } from '../../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardIpcService } from './local-ai-guard-ipc.service';

describe('LocalAiGuardIpcService', () => {
  let originalElectronApiDescriptor: PropertyDescriptor | undefined;
  let deltaListener: ((snapshot: LocalAiGuardSnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  const api = {
    localAiGuardGetSnapshot: vi.fn(),
    localAiGuardSetTargetLifecycle: vi.fn(),
    localAiGuardResolveFallback: vi.fn(),
    onLocalAiGuardStatusDelta: vi.fn((listener: (snapshot: LocalAiGuardSnapshot) => void) => {
      deltaListener = listener;
      return unsubscribe;
    }),
  };

  beforeEach(() => {
    originalElectronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    vi.clearAllMocks();
    deltaListener = undefined;
    api.localAiGuardGetSnapshot.mockResolvedValue({ success: true, data: snapshot() });
    api.localAiGuardSetTargetLifecycle.mockResolvedValue({ success: true, data: {} });
    api.localAiGuardResolveFallback.mockResolvedValue({
      success: true,
      data: { id: 'request-1', status: 'allowed' },
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: api,
    });
    TestBed.configureTestingModule({ providers: [LocalAiGuardIpcService] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    if (originalElectronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', originalElectronApiDescriptor);
    } else {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('returns typed response envelopes from the preload domain', async () => {
    const service = TestBed.inject(LocalAiGuardIpcService);

    await expect(service.getSnapshot()).resolves.toEqual({
      success: true,
      data: snapshot(),
    });
    await service.resolveFallback('request-1', 'allow-once');
    await service.setTargetLifecycle('target-1', 'paused', { pausedUntil: 5_000 });

    expect(api.localAiGuardGetSnapshot).toHaveBeenCalledOnce();
    expect(api.localAiGuardResolveFallback).toHaveBeenCalledWith({
      requestId: 'request-1',
      resolution: 'allow-once',
    });
    expect(api.localAiGuardSetTargetLifecycle).toHaveBeenCalledWith({
      targetId: 'target-1',
      lifecycle: 'paused',
      pausedUntil: 5_000,
    });
  });

  it('delivers deltas inside Angular and returns the preload unsubscribe', () => {
    const service = TestBed.inject(LocalAiGuardIpcService);
    const callback = vi.fn();
    const stop = service.onStatusDelta(callback);

    deltaListener?.(snapshot());
    stop();

    expect(callback).toHaveBeenCalledWith(snapshot());
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

function snapshot(): LocalAiGuardSnapshot {
  return {
    revision: '4',
    aggregate: {
      state: 'not-configured', enrolled: 0, healthy: 0, degraded: 0,
      unavailable: 0, paused: 0,
    },
    targets: [],
    targetConfigs: [],
    incidents: [],
    recoveryAttempts: [],
    pendingFallbacks: [],
  };
}
