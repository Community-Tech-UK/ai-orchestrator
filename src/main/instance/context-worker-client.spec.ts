/**
 * Targeted regression coverage for LT-170: a context-worker-recorded skill
 * activation must be forwarded to the main process's own SkillAttribution
 * singleton, not silently lost because SkillAttributionService is a
 * per-process singleton (same constraint as LT-169's controlCache).
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWorkerClient } from './context-worker-client';
import { getSkillAttribution, SkillAttributionService, type SkillActivation } from '../skills/skill-attribution-service';
import type { ContextWorkerOutboundMsg } from './context-worker-protocol';

/** Minimal IsolatedWorkerProcess fake: a real EventEmitter plus the two
 * methods ContextWorkerClient calls on it (postMessage/terminate). */
function makeFakeWorkerHandle() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    postMessage: vi.fn(),
    terminate: vi.fn().mockResolvedValue(0),
  });
}

describe('ContextWorkerClient (LT-170: cross-process skill-activation forwarding)', () => {
  let fakeWorker: ReturnType<typeof makeFakeWorkerHandle>;
  let client: ContextWorkerClient;

  beforeEach(() => {
    SkillAttributionService._resetForTesting();
    fakeWorker = makeFakeWorkerHandle();
    client = new ContextWorkerClient({
      userDataPath: '/tmp/lt170-spec',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workerFactory: (): any => fakeWorker,
    });
  });

  afterEach(async () => {
    await client.shutdown();
    SkillAttributionService._resetForTesting();
  });

  it('re-emits a worker-forwarded activation on the main process singleton so the existing renderer-push listener fires', () => {
    const received: SkillActivation[] = [];
    getSkillAttribution().on('activation', (activation: SkillActivation) => {
      received.push(activation);
    });

    const activation: SkillActivation = {
      id: 'act-1',
      skillName: 'test-stabilizer',
      skillSource: 'builtin',
      instanceId: 'inst-1',
      sessionId: 'sess-1',
      turnKey: 'turn-1',
      matchedBy: 'trigger',
      matchedTrigger: 'flaky test',
      matchScore: 0.12,
      tokensInjected: 347,
      autoSelected: true,
      createdAt: Date.now(),
    };

    // Simulate the context worker's outbound message the way the real
    // worker_threads/utilityProcess transport delivers it.
    fakeWorker.emit('message', { type: 'skill-activation', activation } satisfies ContextWorkerOutboundMsg);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(activation);
  });

  it('does not touch RPC bookkeeping when forwarding a skill-activation message', () => {
    const metricsBefore = client.getMetrics();

    const activation: SkillActivation = {
      id: 'act-2',
      skillName: 'visual-redesign',
      skillSource: 'builtin',
      instanceId: 'inst-2',
      sessionId: 'sess-2',
      turnKey: 'turn-2',
      matchedBy: 'trigger',
      matchedTrigger: 'make this look designed',
      matchScore: 1,
      tokensInjected: 512,
      autoSelected: true,
      createdAt: Date.now(),
    };

    fakeWorker.emit('message', { type: 'skill-activation', activation } satisfies ContextWorkerOutboundMsg);

    const metricsAfter = client.getMetrics();
    expect(metricsAfter.processed).toBe(metricsBefore.processed);
    expect(metricsAfter.inFlight).toBe(metricsBefore.inFlight);
  });

  it('keeps an RLM admin RPC pending while forwarding an unrelated worker broadcast', async () => {
    const pending = client.invokeRlm({ kind: 'list-stores' });
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    const metricsBefore = client.getMetrics();
    const activation: SkillActivation = {
      id: 'act-concurrent',
      skillName: 'test-stabilizer',
      skillSource: 'builtin',
      instanceId: 'inst-1',
      sessionId: 'sess-1',
      turnKey: 'turn-concurrent',
      matchedBy: 'trigger',
      matchedTrigger: 'flaky test',
      matchScore: 1,
      tokensInjected: 32,
      autoSelected: true,
      createdAt: 1,
    };

    fakeWorker.emit('message', {
      type: 'skill-activation',
      activation,
    } satisfies ContextWorkerOutboundMsg);

    expect(client.getMetrics()).toMatchObject({
      inFlight: metricsBefore.inFlight,
      processed: metricsBefore.processed,
    });

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: [],
    } satisfies ContextWorkerOutboundMsg);

    await expect(pending).resolves.toEqual([]);
    expect(client.getMetrics()).toMatchObject({ inFlight: 0, processed: 1 });
  });

  it('accepts worker residency metrics without disturbing RPC bookkeeping', () => {
    const before = client.getMetrics();
    const sensitiveStoreId = 'store-/private/worker-metrics-secret';

    fakeWorker.emit('message', {
      type: 'worker-metrics',
      residency: {
        processRole: 'context-worker',
        counts: {
          durableStores: 0,
          durableSections: 0,
          activeSessions: 0,
          residentMetadataSections: 0,
          deferredMetadataSections: 0,
          residentContentSections: 0,
          residentContentStores: 0,
          metadataOnlyStores: 0,
          deferredStores: 0,
        },
        discoveredStores: 0,
        activeSessions: 0,
        startupContentBytes: 0,
        residentMetadataSections: 0,
        deferredMetadataSections: 0,
        residentContentBytes: 0,
        residentContentSections: 0,
        residentContentStores: 0,
        hotCandidates: 0,
        hotAdmitted: 0,
        hotSkipped: 0,
        hotExhausted: 0,
        hotCancelled: 0,
        semanticDiscovered: 0,
        semanticIndexed: 0,
        semanticSkipped: 0,
        semanticFailed: 0,
        semanticRetried: 0,
        metadataOnlyStores: 0,
        deferredStores: 0,
        exhausted: {
          metadata: false,
          contentBytes: false,
          contentSections: false,
          contentStores: false,
        },
        elapsedMs: 0,
        lastAdmissionFailure: {
          storeId: sensitiveStoreId,
          reason: 'store-not-found',
        },
      },
    } as unknown as ContextWorkerOutboundMsg);

    expect(client.getMetrics()).toMatchObject({
      inFlight: before.inFlight,
      processed: before.processed,
      residency: {
        startupContentBytes: 0,
        lastAdmissionFailure: { reason: 'store-not-found' },
      },
    });
    const serialized = JSON.stringify(client.getMetrics());
    expect(serialized).not.toContain(sensitiveStoreId);
    expect(serialized).not.toContain('storeId');
  });
});
