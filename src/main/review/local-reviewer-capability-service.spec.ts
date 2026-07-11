import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import type {
  LocalModelToolTurnClient,
  LocalModelToolTurnResult,
} from '../cli/adapters/local-model-chat-adapter';
import { LocalReviewerCapabilityService } from './local-reviewer-capability-service';
import { subscribeToLocalReviewerQualifications } from './local-reviewer-capability-service';

const TARGET: Extract<ModelRuntimeTarget, { kind: 'local-model' }> = {
  kind: 'local-model',
  source: 'this-device',
  endpointProvider: 'ollama',
  endpointId: 'ollama',
  modelId: 'qwen-local',
  selectorId: 'lm://this-device/ollama/ollama/qwen-local',
};

function clientWith(...results: LocalModelToolTurnResult[]): LocalModelToolTurnClient {
  return { sendToolTurn: vi.fn().mockImplementation(async () => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected tool turn');
    return result;
  }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('LocalReviewerCapabilityService', () => {
  beforeEach(() => {
    new LocalReviewerCapabilityService({ clientFactory: vi.fn() }).invalidate();
  });

  it('requires a synthetic read call followed by a small structured response', async () => {
    const client = clientWith(
      {
        content: '',
        toolCalls: [{
          id: 'probe-1',
          name: 'workspace_read',
          arguments: { path: '__aio_local_review_probe__.txt' },
        }],
      },
      { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
    );
    const factory = vi.fn().mockResolvedValue(client);
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });

    await expect(service.qualify(TARGET)).resolves.toEqual({ status: 'verified' });
    expect(client.sendToolTurn).toHaveBeenCalledTimes(2);
    const first = vi.mocked(client.sendToolTurn).mock.calls[0];
    expect(first[1]).toEqual([expect.objectContaining({ name: 'workspace_read' })]);
    expect(first[1]).toHaveLength(1);
    expect(first[0]).toEqual([expect.objectContaining({ role: 'user' })]);
    const secondMessages = vi.mocked(client.sendToolTurn).mock.calls[1][0];
    expect(secondMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', toolCalls: expect.any(Array) }),
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'probe-1',
        content: expect.stringContaining('synthetic probe content'),
      }),
    ]));
    const probeToolResult = secondMessages.find((message) => message.role === 'tool');
    expect(Buffer.byteLength(probeToolResult?.content ?? '')).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(probeToolResult?.content ?? '')).toMatchObject({
      trust: 'untrusted-repository-data',
      wireTruncated: false,
      result: { content: 'synthetic probe content' },
    });
  });

  it.each([
    ['no tool call', { content: '{"ok":true}', toolCalls: [] }],
    ['malformed arguments', {
      content: '',
      toolCalls: [{ id: 'probe-1', name: 'workspace_read', arguments: { path: 42 } }],
    }],
  ])('rejects %s', async (_label, firstResult) => {
    const service = new LocalReviewerCapabilityService({
      clientFactory: async () => clientWith(firstResult as LocalModelToolTurnResult),
    });

    await expect(service.qualify(TARGET)).resolves.toMatchObject({ status: 'unverified' });
  });

  it('caches endpoint failures and supports explicit invalidation', async () => {
    const factory = vi.fn().mockResolvedValue({
      sendToolTurn: vi.fn().mockRejectedValue(new Error('endpoint stopped')),
    } satisfies LocalModelToolTurnClient);
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });

    const first = await service.qualify(TARGET);
    const second = await service.qualify({ ...TARGET });
    expect(first).toMatchObject({ status: 'unverified', reason: expect.stringContaining('endpoint stopped') });
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledTimes(1);

    service.invalidate(TARGET);
    await service.qualify(TARGET);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('retries a cached failure while deduplicating concurrent explicit retries', async () => {
    const retryTurn = deferred<LocalModelToolTurnResult>();
    const factory = vi.fn()
      .mockResolvedValueOnce({
        sendToolTurn: vi.fn().mockRejectedValue(new Error('endpoint stopped')),
      } satisfies LocalModelToolTurnClient)
      .mockResolvedValueOnce({
        sendToolTurn: vi.fn()
          .mockReturnValueOnce(retryTurn.promise)
          .mockResolvedValueOnce({ content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] }),
      } satisfies LocalModelToolTurnClient);
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });
    await service.qualify(TARGET);

    const first = service.retry(TARGET);
    const second = service.retry(TARGET);
    retryTurn.resolve({
      content: '',
      toolCalls: [{
        id: 'retry-1',
        name: 'workspace_read',
        arguments: { path: '__aio_local_review_probe__.txt' },
      }],
    });

    await expect(first).resolves.toEqual({ status: 'verified' });
    await expect(second).resolves.toEqual({ status: 'verified' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung client factory and caches the timed-out failure', async () => {
    const factory = vi.fn().mockReturnValue(new Promise<LocalModelToolTurnClient>(() => undefined));
    const service = new LocalReviewerCapabilityService({ clientFactory: factory, timeoutMs: 10 });

    const first = await service.qualify(TARGET);
    const second = await service.qualify(TARGET);

    expect(first).toEqual({ status: 'unverified', reason: 'Capability probe timed out.' });
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('bounds an endpoint turn even when a client ignores cancellation', async () => {
    const service = new LocalReviewerCapabilityService({
      clientFactory: async () => ({
        sendToolTurn: () => new Promise<LocalModelToolTurnResult>(() => undefined),
      }),
      timeoutMs: 10,
    });

    await expect(service.qualify(TARGET)).resolves.toEqual({
      status: 'unverified', reason: 'Capability probe timed out.',
    });
  });

  it('retries cached failures after failure-only refresh invalidation but keeps successes', async () => {
    const failureFactory = vi.fn().mockResolvedValue({
      sendToolTurn: vi.fn().mockRejectedValue(new Error('temporarily stopped')),
    } satisfies LocalModelToolTurnClient);
    const failureService = new LocalReviewerCapabilityService({ clientFactory: failureFactory });
    await failureService.qualify(TARGET);

    const successTarget = { ...TARGET, modelId: 'verified-local' };
    const successFactory = vi.fn().mockResolvedValue(clientWith(
      {
        content: '',
        toolCalls: [{ id: 'probe-1', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
      },
      { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
    ));
    const successService = new LocalReviewerCapabilityService({ clientFactory: successFactory });
    await successService.qualify(successTarget);

    failureService.invalidateFailures();
    await failureService.qualify(TARGET);
    await successService.qualify(successTarget);

    expect(failureFactory).toHaveBeenCalledTimes(2);
    expect(successFactory).toHaveBeenCalledTimes(1);
  });

  it('detaches pending probes so stale completion cannot cache or notify after refresh', async () => {
    const staleFirstTurn = deferred<LocalModelToolTurnResult>();
    const staleClient: LocalModelToolTurnClient = {
      sendToolTurn: vi.fn()
        .mockReturnValueOnce(staleFirstTurn.promise)
        .mockResolvedValueOnce({ content: '{"ok":false}', toolCalls: [] }),
    };
    const freshClient = clientWith(
      {
        content: '',
        toolCalls: [{ id: 'fresh-1', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
      },
      { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
    );
    const factory = vi.fn()
      .mockResolvedValueOnce(staleClient)
      .mockResolvedValueOnce(freshClient);
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });
    const notifications: LocalModelToolTurnResult[] = [];
    const unsubscribe = subscribeToLocalReviewerQualifications((_target, qualification) => {
      notifications.push({ content: qualification.status, toolCalls: [] });
    });

    const staleQualification = service.qualify(TARGET);
    await vi.waitFor(() => expect(staleClient.sendToolTurn).toHaveBeenCalledOnce());
    service.invalidateFailures();
    await expect(service.qualify(TARGET)).resolves.toEqual({ status: 'verified' });

    staleFirstTurn.resolve({
      content: '',
      toolCalls: [{ id: 'stale-1', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
    });
    await expect(staleQualification).resolves.toMatchObject({ status: 'unverified' });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(notifications.map((entry) => entry.content)).toEqual(['verified']);
    expect(service.getCachedQualification(TARGET)).toEqual({ status: 'verified' });
    unsubscribe();
  });

  it('uses endpoint and model identity in the cache key', async () => {
    const factory = vi.fn().mockResolvedValue(clientWith({ content: '', toolCalls: [] }));
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });

    await service.qualify(TARGET);
    await service.qualify({ ...TARGET, endpointId: 'ollama-2' });
    await service.qualify({ ...TARGET, modelId: 'qwen-local-v2' });

    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('requalifies a verified model after the cache TTL expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const factory = vi.fn()
      .mockResolvedValueOnce(clientWith(
        {
          content: '',
          toolCalls: [{ id: 'first', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
        },
        { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
      ))
      .mockResolvedValueOnce(clientWith(
        {
          content: '',
          toolCalls: [{ id: 'second', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
        },
        { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
      ));
    const service = new LocalReviewerCapabilityService({ clientFactory: factory, cacheTtlMs: 500 });

    await service.qualify(TARGET);
    now += 499;
    await service.qualify(TARGET);
    now += 2;
    await service.qualify(TARGET);

    expect(factory).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('aborts a pending probe when its target is invalidated', async () => {
    const staleClient: LocalModelToolTurnClient = {
      sendToolTurn: () => new Promise<LocalModelToolTurnResult>(() => undefined),
    };
    const freshClient = clientWith(
      {
        content: '',
        toolCalls: [{ id: 'fresh', name: 'workspace_read', arguments: { path: '__aio_local_review_probe__.txt' } }],
      },
      { content: '{"ok":true,"evidence":"synthetic"}', toolCalls: [] },
    );
    const factory = vi.fn().mockResolvedValueOnce(staleClient).mockResolvedValueOnce(freshClient);
    const service = new LocalReviewerCapabilityService({ clientFactory: factory, timeoutMs: 60_000 });

    const stale = service.qualify(TARGET);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    service.invalidate(TARGET);

    await expect(Promise.race([
      stale,
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ])).resolves.toMatchObject({ status: 'unverified' });
    await expect(service.qualify(TARGET)).resolves.toEqual({ status: 'verified' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('rejects cloud-marked Ollama IDs before creating a client', async () => {
    const factory = vi.fn();
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });

    await expect(service.qualify({ ...TARGET, modelId: 'kimi-k2.6:cloud-preview' }))
      .resolves.toMatchObject({ status: 'unverified', reason: expect.stringContaining(':cloud') });
    expect(factory).not.toHaveBeenCalled();
  });

  it('explicitly skips worker nodes without a normalized tool-turn transport', async () => {
    const factory = vi.fn();
    const service = new LocalReviewerCapabilityService({ clientFactory: factory });

    await expect(service.qualify({ ...TARGET, source: 'worker-node', nodeId: 'node-1' }))
      .resolves.toMatchObject({ status: 'unverified', reason: expect.stringContaining('worker-node') });
    expect(factory).not.toHaveBeenCalled();
  });
});
