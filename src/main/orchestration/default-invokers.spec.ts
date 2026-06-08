import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let multiVerifyCoordinator: EventEmitter;
let reviewCoordinator: EventEmitter;
let debateCoordinator: EventEmitter;
let workflowManager: EventEmitter & {
  getExecutionByInstance: ReturnType<typeof vi.fn>;
};

const hoisted = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  terminate: vi.fn(),
  createCliAdapter: vi.fn(),
  resolveCliType: vi.fn(),
  getBreaker: vi.fn(),
  readCodexAuthMode: vi.fn(() => 'unknown' as 'chatgpt' | 'api-key' | 'unknown'),
  instanceManager: {
    getInstance: vi.fn(),
    getAllInstances: vi.fn(),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('./multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: vi.fn(() => multiVerifyCoordinator),
}));

vi.mock('../agents/review-coordinator', () => ({
  getReviewCoordinator: vi.fn(() => reviewCoordinator),
}));

vi.mock('./debate-coordinator', () => ({
  getDebateCoordinator: vi.fn(() => debateCoordinator),
}));

vi.mock('../workflows/workflow-manager', () => ({
  getWorkflowManager: vi.fn(() => workflowManager),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: hoisted.createCliAdapter,
  resolveCliType: hoisted.resolveCliType,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: () => ({ defaultCli: 'claude' }),
  })),
}));

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: vi.fn(() => ({
    getBreaker: hoisted.getBreaker,
  })),
}));

vi.mock('../core/failover-error', () => ({
  coerceToFailoverError: vi.fn(() => null),
}));

vi.mock('../providers/codex-auth-mode', () => ({
  readCodexAuthMode: hoisted.readCodexAuthMode,
}));

vi.mock('../../shared/types/provider.types', async (importOriginal) => ({
  // Keep the real exports (CLAUDE_MODELS, isModelTier, resolveModelForTier, …)
  // so the routing modules pulled in transitively via default-invokers load
  // correctly; only override the default-model resolver for these tests.
  ...(await importOriginal<typeof import('../../shared/types/provider.types')>()),
  getDefaultModelForCli: vi.fn(() => 'default-model'),
}));

import {
  registerDefaultDebateInvoker,
  registerDefaultMultiVerifyInvoker,
  registerDefaultReviewInvoker,
  registerDefaultWorkflowInvoker,
  resolveModelForInvocation,
} from './default-invokers';
import { DEFAULT_ROUTING_CONFIG } from '../routing/model-router';

describe('default orchestration invokers', () => {
  beforeEach(() => {
    multiVerifyCoordinator = new EventEmitter();
    reviewCoordinator = new EventEmitter();
    debateCoordinator = new EventEmitter();
    workflowManager = Object.assign(new EventEmitter(), {
      getExecutionByInstance: vi.fn((instanceId: string) => (
        instanceId === 'instance-1' ? { id: 'execution-1' } : undefined
      )),
    });
    hoisted.sendMessage.mockReset();
    hoisted.terminate.mockReset();
    hoisted.terminate.mockResolvedValue(undefined);
    hoisted.createCliAdapter.mockImplementation(() => ({ sendMessage: hoisted.sendMessage, terminate: hoisted.terminate }));
    hoisted.resolveCliType.mockResolvedValue('claude');
    hoisted.getBreaker.mockImplementation(() => ({
      execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    }));
    hoisted.instanceManager.getInstance.mockImplementation(() => ({
      id: 'instance-1',
      provider: 'claude-cli',
      workingDirectory: '/tmp/orchestrator-test',
    }));
    hoisted.instanceManager.getAllInstances.mockImplementation(() => [
      { id: 'instance-1', provider: 'claude-cli' },
    ]);
  });

  it('rejects invalid verification payloads at the listener boundary', async () => {
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      requestId: 'verify-1',
      agentId: 'agent-1',
      userPrompt: 'check this',
      callback,
    });

    await Promise.resolve();

    expect(callback).toHaveBeenCalledWith(
      expect.stringContaining('verification:invoke-agent payload validation failed'),
    );
  });

  it('invokes the verification adapter with normalized callback values', async () => {
    hoisted.sendMessage.mockResolvedValue({
      content: 'verified',
      usage: { totalTokens: 42 },
    });
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      instanceId: 'instance-1',
      agentId: 'agent-1',
      model: 'default',
      userPrompt: 'check this',
      callback,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.resolveCliType).toHaveBeenCalled();
    expect(hoisted.createCliAdapter).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(null, 'verified', 42, 0);
    expect(hoisted.terminate).toHaveBeenCalledWith(false);
  });

  it('rejects invalid review payloads at the listener boundary', async () => {
    registerDefaultReviewInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    reviewCoordinator.emit('review:invoke-agent', {
      correlationId: 'review-1:security',
      reviewId: 'review-1',
      agentId: 'security',
      userPrompt: 'review',
      callback,
    });

    await Promise.resolve();

    expect(callback).toHaveBeenCalledWith(
      expect.stringContaining('review:invoke-agent payload validation failed'),
    );
  });

  it('drops invalid debate payloads before invoking a callback', async () => {
    registerDefaultDebateInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    debateCoordinator.emit('debate:generate-response', {
      correlationId: 'debate-1:agent-a:response',
      agentId: 'agent-a',
      prompt: 'argue',
      callback,
    });

    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects invalid workflow payloads with an error response', async () => {
    registerDefaultWorkflowInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    workflowManager.emit('workflow:invoke-agent', {
      correlationId: 'execution-1:agent-1',
      executionId: 'execution-1',
      agentId: 'agent-1',
      prompt: 'do work',
      callback,
    });

    await Promise.resolve();

    expect(callback).toHaveBeenCalledWith(
      expect.stringContaining('[Error: workflow:invoke-agent payload validation failed'),
      0,
    );
  });
});

describe('resolveModelForInvocation (intent-routing Phase 2)', () => {
  beforeEach(() => {
    hoisted.readCodexAuthMode.mockReturnValue('unknown');
  });

  it('without a routingIntent, resolves the strong default (verify/review/debate/workflow path)', () => {
    // getDefaultModelForCli is mocked to 'default-model'.
    expect(
      resolveModelForInvocation({
        cliType: 'claude',
        requestedProvider: 'claude',
        payloadModel: 'default',
        prompt: 'list',
      }),
    ).toBe('default-model');
  });

  it('honours an explicit model even when not routing', () => {
    expect(
      resolveModelForInvocation({
        cliType: 'claude',
        requestedProvider: 'claude',
        payloadModel: 'sonnet',
        prompt: 'list',
      }),
    ).toBe('sonnet');
  });

  it('routes a simple Loop-Mode call to the fast tier when no explicit model is set', () => {
    const model = resolveModelForInvocation({
      cliType: 'claude',
      requestedProvider: 'claude',
      payloadModel: undefined,
      prompt: 'list',
      routingIntent: 'loop',
    });
    expect(model).toBe(DEFAULT_ROUTING_CONFIG.fastModel);
    expect(model).not.toBe('default-model');
  });

  it('does NOT route a Loop-Mode call when the user supplied an explicit model', () => {
    expect(
      resolveModelForInvocation({
        cliType: 'claude',
        requestedProvider: 'claude',
        payloadModel: 'sonnet',
        prompt: 'list',
        routingIntent: 'loop',
      }),
    ).toBe('sonnet');
  });

  it('skips cost-tier routing for codex under ChatGPT-account auth (uses default model)', () => {
    hoisted.readCodexAuthMode.mockReturnValue('chatgpt');
    const model = resolveModelForInvocation({
      cliType: 'codex',
      requestedProvider: 'codex',
      payloadModel: undefined,
      prompt: 'list',
      routingIntent: 'loop',
    });
    // getDefaultModelForCli is mocked to 'default-model' — i.e. routing was
    // skipped rather than resolving a cheaper (and unavailable) codex tier.
    expect(model).toBe('default-model');
  });

  it('still cost-routes codex under API-key auth', () => {
    hoisted.readCodexAuthMode.mockReturnValue('api-key');
    const model = resolveModelForInvocation({
      cliType: 'codex',
      requestedProvider: 'codex',
      payloadModel: undefined,
      prompt: 'list',
      routingIntent: 'loop',
    });
    expect(model).not.toBe('default-model');
    expect(typeof model).toBe('string');
  });
});
