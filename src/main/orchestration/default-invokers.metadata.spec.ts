import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import type { ReviewDispatchRequest } from './cross-model-review.types';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  review: new Map<string, (payload: unknown) => Promise<void>>(),
  verify: new Map<string, (payload: unknown) => Promise<void>>(),
  loop: null as unknown as EventEmitter,
  debate: null as unknown as EventEmitter,
  workflow: null as unknown as EventEmitter,
}));
vi.mock('../agents/review-coordinator', () => ({ getReviewCoordinator: () => ({ listenerCount: () => 0, on: (event: string, listener: never) => mocks.review.set(event, listener) }) }));
vi.mock('./multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: () => ({ listenerCount: () => 0, on: (event: string, listener: never) => mocks.verify.set(event, listener) }) }));
vi.mock('./loop-coordinator', () => ({ getLoopCoordinator: () => mocks.loop }));
vi.mock('./debate-coordinator', () => ({ getDebateCoordinator: () => mocks.debate }));
vi.mock('../workflows/workflow-manager', () => ({ getWorkflowManager: () => mocks.workflow }));
vi.mock('../workspace/git/worktree-manager', () => ({ getWorktreeManager: () => ({ createWorktree: async () => ({ id: 'branch-placeholder', worktreePath: '/disposable-absent-fixture-directory' }) }) }));
vi.mock('./loop-branch-selector-helpers', async importOriginal => ({
  ...(await importOriginal<typeof import('./loop-branch-selector-helpers')>()),
  runVerifyInDir: () => true,
  commitWorktreeChanges: () => undefined,
}));
vi.mock('./loop-safety-advisor', () => ({ registerLoopSafetyAdvisor: () => undefined }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: mocks.create }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'codex' }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: (run: () => Promise<unknown>) => run() }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'codex', providerAccountProfiles: [], providerAccountPools: {} }) }) }));
// Account lookup is outside this test; keep the real origin/kind stamping in attachProviderRoutes.
vi.mock('../instance/lifecycle/account-route-preflight', () => ({ attachAccountRoute: async (_provider: unknown, options: unknown) => options }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { buildLoopBranchSelectorDeps, registerDefaultDebateInvoker, registerDefaultLoopInvoker, registerDefaultMultiVerifyInvoker, registerDefaultReviewInvoker, registerDefaultWorkflowInvoker } from './default-invokers';
import { CrossModelReviewService } from './cross-model-review-service';

describe('production invocation ownership metadata', () => {
  const manager = { getInstance: () => undefined };
  beforeEach(() => {
    vi.clearAllMocks();
    CrossModelReviewService._resetForTesting();
    mocks.loop = new EventEmitter();
    mocks.debate = new EventEmitter();
    mocks.workflow = new EventEmitter();
    mocks.create.mockReturnValue(Object.assign(new EventEmitter(), {
      sendMessage: async () => ({ content: 'I cannot fulfill this request.' }),
      terminate: async () => undefined,
    }));
  });
  afterEach(() => CrossModelReviewService._resetForTesting());

  it('retains the debate request and consensus origin for synthesis', async () => {
    registerDefaultDebateInvoker(manager as never);
    await new Promise(resolveResult => mocks.debate.emit('debate:generate-synthesis', {
      correlationId: 'correlation-placeholder', debateId: 'debate-placeholder', instanceId: 'owner-placeholder',
      agentId: 'checker-placeholder', model: 'model-placeholder', prompt: 'Check the work', callback: resolveResult,
    }));
    expect(mocks.create.mock.calls[0]?.[0].options).toMatchObject({ instanceId: 'owner-placeholder', jobId: 'debate-placeholder', sessionKind: 'review', machineSession: 'consensus' });
  });

  it('retains workflow execution identity even without an associated instance', async () => {
    registerDefaultWorkflowInvoker({ getAllInstances: () => [] } as never);
    await new Promise(resolveResult => mocks.workflow.emit('workflow:invoke-agent', {
      correlationId: 'correlation-placeholder', executionId: 'workflow-placeholder', agentId: 'checker-placeholder',
      agentType: 'checker', model: 'model-placeholder', prompt: 'Check the work', callback: resolveResult,
    }));
    expect(mocks.create.mock.calls[0]?.[0].options).toMatchObject({ jobId: 'workflow-placeholder', sessionKind: 'review', machineSession: 'workflow' });
    expect(mocks.create.mock.calls[0]?.[0].options.instanceId).toBeUndefined();
  });

  it('retains the owning loop run for a branch candidate with no chat instance', async () => {
    await buildLoopBranchSelectorDeps(manager as never).fanout({
      loopRunId: 'loop-run-placeholder', workspaceCwd: '/disposable-absent-fixture-directory', goal: 'Check the work', prompt: 'Check the work', provider: 'codex',
      exploration: { enabled: true, fanout: 1, crossModel: false, selector: 'verify+listwise' },
      caps: { maxIterations: 1, maxWallTimeMs: 1000, maxTokens: 1000, maxCostCents: 1 }, spentTokens: 0, spentCents: 0,
      verifyCommand: 'placeholder-command', verifyTimeoutMs: 1000, iterationTimeoutMs: 1000,
    });
    expect(mocks.create.mock.calls[0]?.[0].options).toMatchObject({ jobId: 'loop-run-placeholder', sessionKind: 'loop', machineSession: 'loop' });
    expect(mocks.create.mock.calls[0]?.[0].options.instanceId).toBeUndefined();
  });

  it.each(['review', 'verify'] as const)('retains the real %s request and owner through provider routing', async purpose => {
    registerDefaultReviewInvoker(manager as never);
    registerDefaultMultiVerifyInvoker(manager as never);
    const payload = { correlationId: 'correlation-placeholder', instanceId: 'owner-placeholder', agentId: 'checker-placeholder',
      reviewId: 'review-placeholder', requestId: 'verification-placeholder', systemPrompt: 'Check the work', context: '', userPrompt: 'Check', callback: vi.fn() };
    await (purpose === 'review' ? mocks.review.get('review:invoke-agent')! : mocks.verify.get('verification:invoke-agent')!)(payload);
    expect(mocks.create.mock.calls[0]?.[0].options).toMatchObject({
      instanceId: 'owner-placeholder', jobId: purpose === 'review' ? 'review-placeholder' : 'verification-placeholder',
      sessionKind: 'review', machineSession: purpose === 'review' ? 'review' : 'verification',
    });
  });

  it.each(['fresh-child', 'same-session'])('retains loop run and chat identity for %s adapters', async contextStrategy => {
    registerDefaultLoopInvoker(manager as never);
    const result = await new Promise(resolveResult => mocks.loop.emit('loop:invoke-iteration', {
      correlationId: 'loop-correlation-placeholder', loopRunId: 'loop-run-placeholder', chatId: 'chat-placeholder',
      provider: 'codex', model: 'model-placeholder', workspaceCwd: '/disposable-absent-fixture-directory', stage: 'IMPLEMENT', seq: 0,
      idempotencyKey: 'loop-run-placeholder:0:output', prompt: 'Check the work', config: { contextStrategy }, callback: resolveResult,
    }));
    expect(result).not.toHaveProperty('error');
    expect(mocks.create.mock.calls[0]?.[0].options).toMatchObject({
      instanceId: 'chat-placeholder', jobId: 'loop-run-placeholder', sessionKind: 'loop', machineSession: 'loop', trialKey: 'loop-run-placeholder',
      ...(contextStrategy === 'same-session' ? { ephemeral: false } : {}),
    });
    mocks.loop.emit('loop:state-changed', { loopRunId: 'loop-run-placeholder', state: { status: 'completed', endedAt: Date.now() } });
  });

  it('retains cross-model review identity at its actual reviewer spawn', async () => {
    const service = CrossModelReviewService.getInstance() as unknown as {
      executeOneReview(request: ReviewDispatchRequest, cli: string, timeout: number, signal: AbortSignal): Promise<unknown>;
    };
    await service.executeOneReview({ id: 'cross-review-placeholder', instanceId: 'owner-placeholder', primaryProvider: 'claude',
      workingDirectory: process.cwd(), content: 'Check the work', taskDescription: 'Check the work', reviewDepth: 'structured', timestamp: 1,
      classification: { type: 'code', shouldReview: true, isComplex: false, complexityReasons: [], codeLineCount: 1, fileCount: 1, stepCount: 0 },
    }, 'codex', 30, new AbortController().signal);
    const options = mocks.create.mock.calls[0]?.[0].options as UnifiedSpawnOptions;
    expect(options).toMatchObject({ instanceId: 'owner-placeholder', jobId: 'cross-review-placeholder', sessionKind: 'review', machineSession: 'review' });
  });
});
