import type { IpcRenderer } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createLocalAiGuardDomain } from '../domains/local-ai-guard.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('Local AI Guard preload domain', () => {
  it('exposes every typed request on its exact generated channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createLocalAiGuardDomain(ipcRenderer, IPC_CHANNELS);
    const config = targetConfig();
    const requests = [
      [domain.localAiGuardGetSnapshot, IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT, undefined],
      [domain.localAiGuardCreateTarget, IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, { config }],
      [domain.localAiGuardUpdateTarget, IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
        targetId: 'target-1', patch: { warningLatencyMs: 2_000 },
      }],
      [domain.localAiGuardSetTargetLifecycle, IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, {
        targetId: 'target-1', lifecycle: 'paused', pausedUntil: 5_000,
      }],
      [domain.localAiGuardDiscover, IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER, undefined],
      [domain.localAiGuardValidate, IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, { config }],
      [domain.localAiGuardRecheck, IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {
        targetId: 'target-1', kind: 'functional',
      }],
      [domain.localAiGuardAcknowledgeIncident, IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, {
        incidentId: 'incident-1',
      }],
      [domain.localAiGuardDiagnose, IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, {
        targetId: 'target-1',
      }],
      [domain.localAiGuardRepair, IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
        targetId: 'target-1', action: 'restart-ollama', mode: 'guided',
      }],
      [domain.localAiGuardGetSummary, IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, {
        window: '7d',
      }],
      [domain.localAiGuardListPendingFallbacks,
        IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST, undefined],
      [domain.localAiGuardResolveFallback, IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, {
        requestId: 'request-1', resolution: 'allow-once',
      }],
    ] as const;

    for (const [method, channel, payload] of requests) {
      await method(payload as never);
      expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
        channel,
        ...(payload === undefined ? [] : [payload]),
      );
    }
  });

  it('forwards bounded snapshots and removes the exact status listener', () => {
    const ipcRenderer = {
      invoke: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createLocalAiGuardDomain(ipcRenderer, IPC_CHANNELS);
    const callback = vi.fn();
    const unsubscribe = domain.onLocalAiGuardStatusDelta(callback);
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1];
    const snapshot = {
      revision: '7',
      aggregate: {
        state: 'not-configured', enrolled: 0, healthy: 0, degraded: 0,
        unavailable: 0, paused: 0,
      },
      targets: [],
      incidents: [],
      pendingFallbacks: [],
    };

    listener({} as never, snapshot);
    expect(callback).toHaveBeenCalledWith(snapshot);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.LOCAL_AI_GUARD_STATUS_DELTA,
      listener,
    );
  });
});

function targetConfig() {
  return {
    lifecycle: 'enrolled' as const,
    location: { type: 'coordinator' as const },
    provider: 'ollama' as const,
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 5_000,
    routingRoles: ['compression' as const],
    fallbackPolicy: 'notify-and-allow' as const,
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 300_000 },
  };
}
