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
  auxGenerate: vi.fn(),
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

vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate: hoisted.auxGenerate }),
}));

vi.mock('../../shared/types/provider.types', async (importOriginal) => ({
  // Keep the real exports (CLAUDE_MODELS, isModelTier, resolveModelForTier, …)
  // so the routing modules pulled in transitively via default-invokers load
  // correctly; only override the default-model resolver for these tests.
  ...(await importOriginal<typeof import('../../shared/types/provider.types')>()),
  getDefaultModelForCli: vi.fn(() => 'default-model'),
}));

import {
  classifyCheapModelEligible,
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
    // Clear call HISTORY too — `not.toHaveBeenCalledWith(...)` assertions
    // otherwise see adapter calls accumulated from earlier tests in this file.
    hoisted.createCliAdapter.mockClear();
    hoisted.resolveCliType.mockClear();
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

  it('routes verification scaffolding to local Ollama first when the server has models', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'ollama' || requested === 'gemini' ? requested : 'claude'
    ));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2:3b', size: 2_000_000_000 },
          { name: 'qwen3:32b', size: 20_000_000_000 },
        ],
      }),
    })));
    hoisted.sendMessage.mockResolvedValue({
      content: 'verified',
      usage: { totalTokens: 42 },
    });
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      instanceId: 'instance-1',
      agentId: 'agent-1',
      model: 'default',
      userPrompt: 'check this implementation',
      callback: vi.fn(),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        model: 'qwen3:32b',
        ollamaEndpoint: { host: '127.0.0.1', port: 11434 },
      }),
      undefined,
    );
    vi.unstubAllGlobals();
  });

  it('never dials a connected worker Ollama directly when localhost is empty', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'gemini' ? 'gemini' : 'claude'
    ));
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    hoisted.sendMessage.mockResolvedValue({
      content: 'verified',
      usage: { totalTokens: 42 },
    });
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      instanceId: 'instance-1',
      agentId: 'agent-1',
      model: 'default',
      userPrompt: 'check this implementation',
      callback: vi.fn(),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-3-flash-preview',
      }),
      undefined,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.any(Object),
    );
    expect(fetchSpy.mock.calls.flat().join(' ')).not.toContain('100.113.93.104');
    vi.unstubAllGlobals();
  });

  it('falls through to the cloud CLIs when the local Ollama server is unreachable', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'ollama' || requested === 'gemini' ? requested : 'claude'
    ));
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    hoisted.sendMessage.mockResolvedValue({
      content: 'verified',
      usage: { totalTokens: 42 },
    });
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      instanceId: 'instance-1',
      agentId: 'agent-1',
      model: 'default',
      userPrompt: 'check this implementation',
      callback: vi.fn(),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-3-flash-preview',
      }),
      undefined,
    );
    vi.unstubAllGlobals();
  });

  it('routes verification scaffolding to the first available non-Claude CLI', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'gemini' ? 'gemini' : 'claude'
    ));
    hoisted.sendMessage.mockResolvedValue({
      content: 'verified',
      usage: { totalTokens: 42 },
    });
    registerDefaultMultiVerifyInvoker(hoisted.instanceManager as never);

    multiVerifyCoordinator.emit('verification:invoke-agent', {
      correlationId: 'verify-1:agent-1',
      requestId: 'verify-1',
      instanceId: 'instance-1',
      agentId: 'agent-1',
      model: 'default',
      userPrompt: 'check this implementation',
      callback: vi.fn(),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-3-flash-preview',
      }),
      undefined,
    );
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

  it('routes review scaffolding to the first available non-Claude CLI', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'gemini' ? 'gemini' : 'claude'
    ));
    // The scaffolding resolver probes the local Ollama server first; stub
    // fetch so the probe fails fast and deterministically in tests.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no local server')));
    hoisted.sendMessage.mockResolvedValue({
      content: 'reviewed',
      usage: { totalTokens: 20 },
    });
    registerDefaultReviewInvoker(hoisted.instanceManager as never);

    reviewCoordinator.emit('review:invoke-agent', {
      correlationId: 'review-1:security',
      reviewId: 'review-1',
      instanceId: 'instance-1',
      agentId: 'security',
      model: 'default',
      // systemPrompt + context are REQUIRED by ReviewAgentInvocationPayloadSchema
      // (the real ReviewCoordinator always sends both).
      systemPrompt: 'You are a strict code review agent.',
      context: 'diff --git a/src/example.ts b/src/example.ts',
      userPrompt: 'review this implementation for correctness',
      callback: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(hoisted.createCliAdapter).toHaveBeenCalledWith(
        'gemini',
        expect.objectContaining({
          model: 'gemini-3-flash-preview',
        }),
        undefined,
      );
    });
    vi.unstubAllGlobals();
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

  it('never routes workflow invocations to the text-only Ollama adapter', async () => {
    // Workflow steps are caller-authored and may need tool use; even with a
    // healthy local server, ollama must be skipped for the workflow intent.
    hoisted.createCliAdapter.mockClear();
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'ollama' ? 'ollama' : 'claude'
    ));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    hoisted.sendMessage.mockResolvedValue({
      content: 'done',
      usage: { totalTokens: 10 },
    });
    registerDefaultWorkflowInvoker(hoisted.instanceManager as never);

    workflowManager.emit('workflow:invoke-agent', {
      correlationId: 'execution-1:agent-1',
      executionId: 'execution-1',
      agentId: 'agent-1',
      agentType: 'code-reviewer',
      prompt: 'list the changed files',
      model: 'default',
      callback: vi.fn(),
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).not.toHaveBeenCalledWith(
      'ollama',
      expect.anything(),
      undefined,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('routes workflow invocations through the workflow intent on a non-Claude CLI when no model is explicit', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'gemini' ? 'gemini' : 'claude'
    ));
    hoisted.sendMessage.mockResolvedValue({
      content: 'done',
      usage: { totalTokens: 10 },
    });
    registerDefaultWorkflowInvoker(hoisted.instanceManager as never);
    const callback = vi.fn();

    workflowManager.emit('workflow:invoke-agent', {
      correlationId: 'execution-1:agent-1',
      executionId: 'execution-1',
      agentId: 'agent-1',
      agentType: 'code-reviewer',
      prompt: 'list the changed files',
      model: 'default',
      callback,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenLastCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-2.5-flash',
      }),
      undefined,
    );
  });

  it('routes debate scaffolding away from Claude and synthesis to the balanced tier', async () => {
    hoisted.resolveCliType.mockImplementation(async (requested?: string) => (
      requested === 'gemini' ? 'gemini' : 'claude'
    ));
    hoisted.sendMessage.mockResolvedValue({
      content: 'critique',
      usage: { totalTokens: 12 },
    });
    registerDefaultDebateInvoker(hoisted.instanceManager as never);

    debateCoordinator.emit('debate:generate-response', {
      correlationId: 'debate-1:response:agent-1',
      debateId: 'debate-1',
      agentId: 'agent-1',
      agentIndex: 0,
      prompt: 'argue one side of the technical decision',
      model: 'default',
      callback: vi.fn(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenLastCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-3-flash-preview',
      }),
      undefined,
    );

    debateCoordinator.emit('debate:generate-critiques', {
      correlationId: 'debate-1:critique:agent-1',
      debateId: 'debate-1',
      agentId: 'agent-1',
      agentIndex: 0,
      prompt: 'critique the other response',
      model: 'default',
      callback: vi.fn(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenLastCalledWith(
      'gemini',
      expect.objectContaining({
        model: 'gemini-3-flash-preview',
      }),
      undefined,
    );

    hoisted.sendMessage.mockResolvedValue({
      content: 'synthesis',
      usage: { totalTokens: 14 },
    });
    debateCoordinator.emit('debate:generate-synthesis', {
      correlationId: 'debate-1:synthesis:moderator',
      debateId: 'debate-1',
      agentId: 'moderator',
      prompt: 'synthesize the debate',
      model: 'default',
      callback: vi.fn(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Synthesis stays on the debate's provider (no scaffolding steering) but
    // downshifts to the balanced tier — the fan-out audit measured a single
    // Opus synthesis call as the most expensive call in the run.
    expect(hoisted.createCliAdapter).toHaveBeenLastCalledWith(
      'claude',
      expect.objectContaining({
        model: DEFAULT_ROUTING_CONFIG.balancedModel,
      }),
      undefined,
    );
  });

  it('honours an explicit synthesis model instead of tier-routing it', async () => {
    hoisted.sendMessage.mockResolvedValue({
      content: 'synthesis',
      usage: { totalTokens: 14 },
    });
    registerDefaultDebateInvoker(hoisted.instanceManager as never);

    debateCoordinator.emit('debate:generate-synthesis', {
      correlationId: 'debate-1:synthesis:moderator',
      debateId: 'debate-1',
      agentId: 'moderator',
      prompt: 'synthesize the debate',
      model: 'opus',
      callback: vi.fn(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(hoisted.createCliAdapter).toHaveBeenLastCalledWith(
      'claude',
      expect.objectContaining({
        model: 'opus',
      }),
      undefined,
    );
  });
});

describe('resolveModelForInvocation (intent-routing Phase 2)', () => {
  beforeEach(() => {
    hoisted.readCodexAuthMode.mockReturnValue('unknown');
  });

  it('without a routingIntent, resolves the strong default', () => {
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

  it('routes a Loop-Mode call to the balanced tier regardless of prompt keywords', () => {
    // Loop iteration prompts are dominated by the stage-machine template, so
    // keyword-complexity scoring is meaningless for them — 'loop' intent pins
    // the balanced tier (the aux cheap-model classifier can still downshift).
    const simple = resolveModelForInvocation({
      cliType: 'claude',
      requestedProvider: 'claude',
      payloadModel: undefined,
      prompt: 'list',
      routingIntent: 'loop',
    });
    expect(simple).toBe(DEFAULT_ROUTING_CONFIG.balancedModel);
    expect(simple).not.toBe('default-model');

    const reviewHeavy = resolveModelForInvocation({
      cliType: 'claude',
      requestedProvider: 'claude',
      payloadModel: undefined,
      prompt: 'Re-review your own work with fresh eyes. Audit, analyze, and fix everything you find in this architecture.',
      routingIntent: 'loop',
    });
    expect(reviewHeavy).toBe(DEFAULT_ROUTING_CONFIG.balancedModel);
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

describe('classifyCheapModelEligible (routingClassification slot)', () => {
  beforeEach(() => {
    hoisted.auxGenerate.mockReset();
  });

  it('returns true when the aux model reports eligible', async () => {
    hoisted.auxGenerate.mockResolvedValue({
      text: JSON.stringify({ eligible: true, reason: 'simple summarization' }),
      decision: { slot: 'routingClassification' },
    });
    expect(await classifyCheapModelEligible('summarize this paragraph')).toBe(true);
  });

  it('returns false when the aux model reports ineligible', async () => {
    hoisted.auxGenerate.mockResolvedValue({
      text: JSON.stringify({ eligible: false, reason: 'multi-file refactor' }),
      decision: { slot: 'routingClassification' },
    });
    expect(await classifyCheapModelEligible('refactor the auth subsystem')).toBe(false);
  });

  it('falls back to false on non-JSON output or aux failure', async () => {
    hoisted.auxGenerate.mockResolvedValue({ text: 'not json', decision: {} });
    expect(await classifyCheapModelEligible('x')).toBe(false);
    hoisted.auxGenerate.mockRejectedValue(new Error('aux timed out'));
    expect(await classifyCheapModelEligible('x')).toBe(false);
  });

  it('classifies the persistent goal instead of the surrounding loop scaffold', async () => {
    hoisted.auxGenerate.mockResolvedValue({
      text: JSON.stringify({ eligible: true, reason: 'simple goal' }),
      decision: { slot: 'routingClassification' },
    });
    const loopPrompt = [
      '# Loop Mode — Iteration 4',
      'many coordinator instructions that should not be classified',
      '## Goal (persistent across iterations)',
      'Summarize the README in three bullets.',
      '## Step 2 — Do this iteration\'s work',
      'more scaffold',
    ].join('\n');

    await classifyCheapModelEligible(loopPrompt);

    const userPrompt = hoisted.auxGenerate.mock.calls[0]?.[2] as string;
    expect(userPrompt).toContain('Summarize the README in three bullets.');
    expect(userPrompt).not.toContain('many coordinator instructions');
    expect(userPrompt).not.toContain('more scaffold');
  });
});
