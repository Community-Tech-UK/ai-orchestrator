import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { CrossModelReviewService } from './cross-model-review-service';
import type { ReviewDispatchRequest } from './cross-model-review.types';
import { InstanceStateManager } from '../instance/instance-state';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { ReviewerPool } from './reviewer-pool';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { attachReviewStalenessAbort } from './review-staleness-abort';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({
  crossModelReviewLocalEnabled: false, crossModelReviewProviders: [], crossModelReviewMaxReviewers: 1,
  crossModelReviewDepth: 'structured', crossModelReviewTimeout: 30,
}) }) }));
vi.mock('./cross-model-review-dispatch', () => ({ buildCrossModelReviewDispatch: (input: Parameters<typeof import('./cross-model-review-dispatch').buildCrossModelReviewDispatch>[0]) => ({
  request: { ...request('race-review', input.instance.id), content: input.content,
    classification: input.classification, taskDescription: input.taskDescription,
    changedFiles: input.changedFiles, turnSeq: input.turnSeq, trigger: input.trigger },
  reviewers: [{ provider: 'codex' }],
}) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'codex' }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_cli: unknown, options: unknown) => options }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: makeAdapter }) }));
const { makeAdapter } = vi.hoisted(() => ({ makeAdapter: vi.fn() }));
const { waitConsult } = vi.hoisted(() => ({ waitConsult: vi.fn(async (): Promise<void> => undefined) }));
vi.mock('../work-admission/consult-admission', async original => {
  const actual = await original<typeof import('../work-admission/consult-admission')>();
  return { ...actual, waitForConsult: waitConsult };
});
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

function request(id: string, instanceId: string): ReviewDispatchRequest {
  return { id, instanceId, primaryProvider: 'claude', workingDirectory: '/tmp/reviews',
    content: 'code', taskDescription: 'check', classification: { type: 'code', shouldReview: true,
      isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 },
    reviewDepth: 'structured', sourceUserMessageId: 'old', timestamp: 1 };
}

afterEach(() => {
  CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); vi.useRealTimers();
  getCircuitBreakerRegistry().destroy(); makeAdapter.mockReset();
  waitConsult.mockReset().mockResolvedValue(undefined);
});

it('captures the user turn before waiting for consult admission', async () => {
  const service = CrossModelReviewService.getInstance(); const source = new EventEmitter();
  const detach = attachReviewStalenessAbort(source, service);
  const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
    outputBuffer: [{ id: 'old', type: 'user', content: 'task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
  service.setInstanceManager({ getInstance: () => instance,
    getTurnFileChanges: () => ({ seq: 1, changedPaths: [], editedPaths: [] }) } as unknown as InstanceManager);
  let release!: () => void;
  waitConsult.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const started = vi.fn(); service.on('review:started', started);
  const pending = service.requestReview('one');
  try {
    source.emit('instance:input-started', { instanceId: 'one', autoContinuation: false });
    release();
    await expect(pending).resolves.toEqual({ status: 'no-output' });
    expect(started).not.toHaveBeenCalled();
  } finally { release(); detach(); }
});

it.each(['admission', 'discovery'])('does not resurrect a review after pause and resume during %s', async boundary => {
  const service = CrossModelReviewService.getInstance();
  const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
    outputBuffer: [{ id: 'old', type: 'user', content: 'task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
  service.setInstanceManager({ getInstance: () => instance,
    getTurnFileChanges: () => ({ seq: 1, changedPaths: [], editedPaths: [] }) } as unknown as InstanceManager);
  let release!: () => void;
  const internal = service as unknown as { refreshAvailability: () => Promise<void>; collectSuccessfulReviews: () => Promise<never[]> };
  if (boundary === 'admission') waitConsult.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  else vi.spyOn(internal, 'refreshAvailability').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const collected = vi.spyOn(internal, 'collectSuccessfulReviews').mockResolvedValue([]);
  const started = vi.fn(); service.on('review:started', started);
  const pending = service.requestReview('one');
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    getPauseCoordinator().emit('pause'); getPauseCoordinator().emit('resume'); release();
    await expect(pending).resolves.toEqual({ status: 'no-reviewers' });
    expect(started).not.toHaveBeenCalled(); expect(collected).not.toHaveBeenCalled();
  } finally { release(); getPauseCoordinator().emit('resume'); }
});

describe('new user turn cancellation', () => {
  afterEach(() => CrossModelReviewService._resetForTesting());

  it.each(['task', ''])('aborts superseded text or attachment-only turns (%j), preserving history', async (newText) => {
    const service = CrossModelReviewService.getInstance();
    const source = new EventEmitter();
    let userId = 'old';
    service.setInstanceManager({ getInstance: () => ({ outputBuffer: [{ type: 'user', id: 'old', content: 'task' }, { type: 'user', id: userId, content: userId === 'old' ? 'task' : newText }] }) } as unknown as InstanceManager);
    const internals = service as unknown as {
      executeReviews: (r: ReviewDispatchRequest, reviewers: never[], timeout: number) => Promise<void>;
      collectSuccessfulReviews: (r: ReviewDispatchRequest, c: never[], t: number, signal: AbortSignal) => Promise<never[]>;
      buffers: Map<string, unknown>;
      reviewHistory: Map<string, unknown[]>;
      reviewContexts: Map<string, ReviewDispatchRequest>;
    };
    const signals = new Map<string, AbortSignal>();
    vi.spyOn(internals, 'collectSuccessfulReviews').mockImplementation((r, _c, _t, signal) => {
      signals.set(r.id, signal);
      return new Promise(resolve => signal.addEventListener('abort', () => resolve([]), { once: true }));
    });
    internals.buffers.set('one', { messages: ['existing output'] });
    internals.reviewHistory.set('one', [{ id: 'previous' }]);
    const first = request('first', 'one'); const other = request('other', 'two');
    internals.reviewContexts.set(first.id, first); internals.reviewContexts.set(other.id, other);
    const detach = attachReviewStalenessAbort(source, service);
    const discarded = vi.fn(); const result = vi.fn();
    service.on('review:discarded', discarded); service.on('review:result', result);
    const running = internals.executeReviews(first, [], 30);
    const unrelated = internals.executeReviews(other, [], 30);
    await vi.waitFor(() => expect(signals.size).toBe(2));
    source.emit('instance:batch-update', { updates: [{ instanceId: 'one', status: 'busy' }] });
    expect(signals.get('first')?.aborted).toBe(false); // tool resume, same user turn
    userId = 'new';
    source.emit('instance:batch-update', { updates: [{ instanceId: 'one', status: 'busy' }] });
    expect(signals.get('first')?.aborted).toBe(true);
    expect(signals.get('other')?.aborted).toBe(false);
    expect(service.getReviewHistory('one')).toEqual([{ id: 'previous' }]);
    expect(internals.buffers.has('one')).toBe(true);
    await running;
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveBeenCalled();
    service.shutdown(); await unrelated; detach();
    expect(source.listenerCount('instance:batch-update')).toBe(0);
  });
});


describe('review failure accounting and cancellation', () => {
  afterEach(() => { CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); getCircuitBreakerRegistry().destroy(); });

  function setup() {
    const service = CrossModelReviewService.getInstance();
    const internal = service as unknown as { reviewerPool: ReviewerPool;
      executeOneReview: (r: ReviewDispatchRequest, cli: string, timeout: number, signal: AbortSignal) => Promise<unknown> };
    internal.reviewerPool.setAvailable(['codex']);
    return internal;
  }

  it('retires a reviewer after two unparseable operations and does not spawn it through pinned routing', async () => {
    const internal = setup();
    const adapter = { sendMessage: vi.fn(async () => ({ content: 'invalid review' })), terminate: vi.fn(async () => undefined) };
    vi.mocked(getProviderRuntimeService().createAdapter).mockReturnValue(adapter as never);
    const invalid = vi.spyOn(internal.reviewerPool, 'recordValidationFailure');
    const signal = new AbortController().signal;
    await internal.executeOneReview(request('bad-1', 'one'), 'codex', 30, signal);
    await internal.executeOneReview(request('bad-2', 'one'), 'codex', 30, signal);
    expect(invalid.mock.calls).toEqual([['codex'], ['codex']]);
    expect(internal.reviewerPool.selectReviewers('claude', 1)).toEqual([]);
    const calls = makeAdapter.mock.calls.length;
    await internal.executeOneReview({ ...request('bad-3', 'one'), licencePinned: true }, 'codex', 30, signal);
    expect(makeAdapter.mock.calls.length).toBe(calls);
  });

  it('cancellation terminates the adapter without penalising reviewer health', async () => {
    const internal = setup();
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const adapter = { sendMessage: vi.fn(() => { dispatched(); return new Promise(() => undefined); }), terminate: vi.fn(async () => undefined) };
    makeAdapter.mockReturnValue(adapter);
    const failure = vi.spyOn(internal.reviewerPool, 'recordFailure');
    const controller = new AbortController();
    const running = internal.executeOneReview(request('cancel', 'one'), 'codex', 30, controller.signal);
    await started; controller.abort();
    await expect(running).rejects.toThrow('Review cancelled');
    expect(adapter.terminate).toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(getCircuitBreakerRegistry().getBreaker('cross-review-codex').getStats().failureCount).toBe(0);
    expect(internal.reviewerPool.selectReviewers('claude', 1)).toEqual(['codex']);
  });
});


it('does not start a stale review when a new user turn arrives during availability refresh', async () => {
  const service = CrossModelReviewService.getInstance();
  try {
    const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
      outputBuffer: [{ id: 'old', type: 'user', content: 'old task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => ({ seq: 1 }) } as unknown as InstanceManager);
    const internal = service as unknown as { refreshAvailability: () => Promise<void>; collectSuccessfulReviews: () => Promise<never[]> };
    let release!: () => void;
    vi.spyOn(internal, 'refreshAvailability').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collected = vi.spyOn(internal, 'collectSuccessfulReviews').mockResolvedValue([]);
    const started = vi.fn(); service.on('review:started', started);
    const pending = service.requestReview('one');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    instance.outputBuffer.push({ id: 'new', type: 'user', content: 'new task' });
    release();
    await expect(pending).resolves.toEqual({ status: 'no-output' });
    expect(collected).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  } finally { CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); }
});


it('does not count schema failures when cancellation arrives during adapter cleanup', async () => {
  const service = CrossModelReviewService.getInstance();
  const internal = service as unknown as { reviewerPool: ReviewerPool;
    executeOneReview: (r: ReviewDispatchRequest, cli: string, timeout: number, signal: AbortSignal) => Promise<unknown> };
  internal.reviewerPool.setAvailable(['codex']);
  try {
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      makeAdapter.mockReturnValue({ sendMessage: async () => ({ content: 'invalid review' }),
        terminate: async () => { controller.abort(); } });
      await expect(internal.executeOneReview(request(`cleanup-${i}`, 'one'), 'codex', 30, controller.signal))
        .rejects.toThrow('Review cancelled');
    }
    expect(internal.reviewerPool.isValidationRetired('codex')).toBe(false);
    expect(getCircuitBreakerRegistry().getBreaker('cross-review-codex').getStats().totalCalls).toBe(0);
  } finally { CrossModelReviewService._resetForTesting(); getCircuitBreakerRegistry().destroy(); }
});


it('does not charge reviewers or reserve a dispatch when paused during discovery', async () => {
  const service = CrossModelReviewService.getInstance();
  try {
    const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
      outputBuffer: [{ id: 'old', type: 'user', content: 'task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => ({ seq: 1 }) } as unknown as InstanceManager);
    const internal = service as unknown as { refreshAvailability: () => Promise<void>; collectSuccessfulReviews: () => Promise<never[]> };
    let release!: () => void;
    vi.spyOn(internal, 'refreshAvailability').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collected = vi.spyOn(internal, 'collectSuccessfulReviews').mockResolvedValue([]);
    const started = vi.fn(); service.on('review:started', started);
    const pending = service.requestReview('one');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    getPauseCoordinator().emit('pause'); release();
    await expect(pending).resolves.toEqual({ status: 'no-reviewers' });
    expect(collected).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
  } finally { getPauseCoordinator().emit('resume'); CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); }
});

it.each([false, true])('captures turn identity when the user source is outside the live buffer (retained=%j)', async retained => {
  const service = CrossModelReviewService.getInstance();
  let running: Promise<void> | undefined;
  try {
    const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
      retainedPrompts: retained ? [{ id: 'retained-user', type: 'user', content: 'task', timestamp: 1 }] : [],
      outputBuffer: [{ id: 'answer', type: 'assistant', content: 'answer', timestamp: 2 }] };
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => ({ seq: 1 }) } as unknown as InstanceManager);
    const internal = service as unknown as {
      refreshAvailability: () => Promise<void>;
      collectSuccessfulReviews: (r: ReviewDispatchRequest, c: never[], t: number, signal: AbortSignal) => Promise<never[]>;
      executeReviews: (r: ReviewDispatchRequest, c: never[], t: number) => Promise<void>;
    };
    vi.spyOn(internal, 'refreshAvailability').mockResolvedValue();
    let signal!: AbortSignal;
    vi.spyOn(internal, 'collectSuccessfulReviews').mockImplementation((_r, _c, _t, s) => {
      signal = s;
      return new Promise(resolve => s.addEventListener('abort', () => resolve([]), { once: true }));
    });
    const original = internal.executeReviews.bind(internal);
    vi.spyOn(internal, 'executeReviews').mockImplementation((...args) => { running = original(...args); return running; });
    await expect(service.requestReview('one')).resolves.toMatchObject({ status: 'started' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (retained) expect(service.getReviewContext('race-review')?.sourceUserMessageId).toBe('retained-user');
    instance.outputBuffer.push({ id: 'new-user', type: 'user', content: 'new task', timestamp: 3 });
    service.abortSupersededReviews('one');
    expect(signal.aborted).toBe(true);
    await running;
  } finally { service.shutdown(); await running; CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); }
});


it('cancels from lossless input before the real batcher coalesces busy into processing', async () => {
  vi.useFakeTimers();
  const service = CrossModelReviewService.getInstance();
  const state = new InstanceStateManager(); const source = new EventEmitter();
  const statuses: unknown[] = [];
  state.on('batch-update', data => { statuses.push(data.updates.map((u: { status: string }) => u.status)); source.emit('instance:batch-update', data); });
  const instance = { outputBuffer: [{ id: 'old', type: 'user', content: 'task' }] };
  service.setInstanceManager({ getInstance: () => instance } as unknown as InstanceManager);
  const internal = service as unknown as {
    reviewContexts: Map<string, ReviewDispatchRequest>;
    collectSuccessfulReviews: (r: ReviewDispatchRequest, c: never[], t: number, signal: AbortSignal) => Promise<never[]>;
    executeReviews: (r: ReviewDispatchRequest, c: never[], t: number) => Promise<void>;
  };
  let signal!: AbortSignal;
  vi.spyOn(internal, 'collectSuccessfulReviews').mockImplementation((_r, _c, _t, s) => {
    signal = s; return new Promise(resolve => s.addEventListener('abort', () => resolve([]), { once: true }));
  });
  const current = request('coalesced', 'one'); internal.reviewContexts.set(current.id, current);
  const detach = attachReviewStalenessAbort(source, service);
  const running = internal.executeReviews(current, [], 30);
  await vi.waitFor(() => expect(signal).toBeDefined());
  try {
    source.emit('instance:input-started', { instanceId: 'one', autoContinuation: true });
    expect(signal.aborted).toBe(false);
    // This production event precedes committing the new user message to the buffer.
    source.emit('instance:input-started', { instanceId: 'one', autoContinuation: false });
    expect(signal.aborted).toBe(true);
    instance.outputBuffer.push({ id: 'new', type: 'user', content: 'new task' });
    state.queueUpdate('one', 'busy'); state.queueUpdate('one', 'processing');
    await vi.advanceTimersByTimeAsync(50);
    expect(statuses).toEqual([['processing']]);
  } finally {
    service.shutdown(); await running; state.destroy(); detach();
    CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); vi.useRealTimers();
  }
});

it('refuses an in-flight admission when input starts before its new user message is committed', async () => {
  const service = CrossModelReviewService.getInstance(); const source = new EventEmitter();
  const detach = attachReviewStalenessAbort(source, service);
  try {
    const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
      outputBuffer: [{ id: 'old', type: 'user', content: 'task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => ({ seq: 1 }) } as unknown as InstanceManager);
    const internal = service as unknown as { refreshAvailability: () => Promise<void>; collectSuccessfulReviews: () => Promise<never[]> };
    let release!: () => void;
    vi.spyOn(internal, 'refreshAvailability').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collected = vi.spyOn(internal, 'collectSuccessfulReviews').mockResolvedValue([]);
    const started = vi.fn(); service.on('review:started', started);
    const pending = service.requestReview('one');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    source.emit('instance:input-started', { instanceId: 'one', autoContinuation: false }); release();
    await expect(pending).resolves.toEqual({ status: 'no-output' });
    expect(collected).not.toHaveBeenCalled(); expect(started).not.toHaveBeenCalled();
  } finally { detach(); CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); }
});


it('does not resurrect a review or charge a dispatch after shutdown during discovery', async () => {
  const service = CrossModelReviewService.getInstance();
  try {
    const instance = { id: 'one', provider: 'claude', workingDirectory: '/tmp/reviews',
      outputBuffer: [{ id: 'old', type: 'user', content: 'task' }, { id: 'answer', type: 'assistant', content: 'answer' }] };
    service.setInstanceManager({ getInstance: () => instance, getTurnFileChanges: () => ({ seq: 1 }) } as unknown as InstanceManager);
    const internal = service as unknown as { refreshAvailability: () => Promise<void>; collectSuccessfulReviews: () => Promise<never[]> };
    let release!: () => void;
    vi.spyOn(internal, 'refreshAvailability').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const collected = vi.spyOn(internal, 'collectSuccessfulReviews').mockResolvedValue([]);
    const pending = service.requestReview('one');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    service.shutdown(); release();
    await expect(pending).resolves.toEqual({ status: 'no-reviewers' });
    expect(collected).not.toHaveBeenCalled();
    expect(service.getReviewContext('race-review')).toBeNull();
  } finally { CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); }
});


it('does not install background intervals after shutdown overtakes initialization', async () => {
  vi.useFakeTimers();
  const service = CrossModelReviewService.getInstance();
  try {
    const internal = service as unknown as { refreshAvailability: () => Promise<void> };
    let release!: () => void;
    vi.spyOn(internal, 'refreshAvailability').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = service.initialize();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    service.shutdown(); release();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  } finally { service.shutdown(); CrossModelReviewService._resetForTesting(); vi.restoreAllMocks(); vi.useRealTimers(); }
});
