/**
 * Step 1c: every Loop Mode path that starts a model session must hand the loop run id to the
 * adapter as the trial key (source 'loop-run'), so a loop's iterations, its persistent
 * session and its branch-select candidates all land in one trial arm. The helper itself is
 * covered in default-loop-invoker-helpers.spec.ts; these cases cover the three call sites in
 * default-invokers.ts that have to pass it.
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultModelForCli } from '../../shared/types/provider.types';
import type { LoopChildResult } from './loop-coordinator';
import { _resetLoopAccountFailoverForTesting } from '../providers/account-pool/loop-account-failover';
import { _resetAdapterLoansForTesting } from '../instance/lifecycle/adapter-loan-registry';
import type { BranchSelectInput } from './loop-branch-select';

// `vi.hoisted` must not reference any imports — it runs before module
// imports resolve. Mock-state is created here and the EventEmitter for the
// loop coordinator is constructed inside beforeEach instead.
const hoisted = vi.hoisted(() => ({
  loopModel: undefined as string | undefined,
  rtkScope: 'off' as 'off' | 'trial',
  initializeForRequest: vi.fn(),
  requestResponse: vi.fn(),
  sendMessage: vi.fn(),
  sendRaw: vi.fn(),
  terminate: vi.fn(),
  interrupt: vi.fn(),
  setStreamIdleTimeoutMs: vi.fn(),
  setDisallowedToolsOverride: vi.fn(),
  setResume: vi.fn(),
  createAdapter: vi.fn(),
  createAutomationWithScheduling: vi.fn(),
  deleteAutomation: vi.fn(),
  resolveCliType: vi.fn(),
  getBreaker: vi.fn(),
  setProviderLimitLedger: vi.fn(),
  providerLimitSchedulerRef: { current: null as unknown as ((request: {
    loopRunId: string;
    chatId: string;
    workspaceCwd: string;
    provider: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor';
    resumeAt: number;
    reason: string;
    source: 'quota' | 'notice' | 'wakeup';
    action: string;
    windowId?: string;
  }) => (() => void) | void) | null },
  maybeExternalizeLoopOutput: vi.fn(),
  loopCoordinatorRef: { current: null as unknown as EventEmitter },
  adapterRef: { current: null as unknown as EventEmitter & {
    initializeForRequest: ReturnType<typeof vi.fn>;
    requestResponse: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendRaw: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    setStreamIdleTimeoutMs: ReturnType<typeof vi.fn>;
    setDisallowedToolsOverride: ReturnType<typeof vi.fn>;
    setResume: ReturnType<typeof vi.fn>;
  } },
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('./loop-coordinator', () => ({
  getLoopCoordinator: vi.fn(() => hoisted.loopCoordinatorRef.current),
}));

vi.mock('./multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('../agents/review-coordinator', () => ({ getReviewCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('./debate-coordinator', () => ({ getDebateCoordinator: vi.fn(() => new EventEmitter()) }));
vi.mock('../workflows/workflow-manager', () => ({
  getWorkflowManager: vi.fn(() => Object.assign(new EventEmitter(), {
    getExecutionByInstance: vi.fn(() => undefined),
  })),
}));

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(),
  resolveCliType: hoisted.resolveCliType,
}));

vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: hoisted.createAdapter })),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: (key: string) => (key === 'rtkEnabled' ? true : key === 'rtkBundledOnly' ? false : undefined),
    getAll: () => ({ defaultCli: 'claude', loopModelByProvider: { opencode: hoisted.loopModel },
      providerAccountProfiles: [], providerAccountPools: {}, auxiliaryLlmRoutingClassificationEnabled: false }),
  })),
}));

vi.mock('../cli/rtk/rtk-rollout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/rtk/rtk-rollout')>();
  return {
    ...actual,
    getAutomationRtk: (key?: string) => hoisted.rtkScope === 'trial' && key
      ? { enabled: true, binaryPath: '/bin/rtk', rtkArm: key.includes('off') ? 'off' : 'on',
          rtkTrialEligible: true, rtkTrialKey: key,
          ...(key.includes('off') ? {} : { yoloHookPath: '/hook.mjs' }) }
      : undefined,
  };
});

vi.mock('../core/circuit-breaker', () => ({
  getCircuitBreakerRegistry: vi.fn(() => ({ getBreaker: hoisted.getBreaker })),
}));

vi.mock('../core/failover-error', () => ({ coerceToFailoverError: vi.fn(() => null) }));
vi.mock('../../shared/types/provider.types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/types/provider.types')>()),
  getDefaultModelForCli: vi.fn(() => 'default-model'),
}));
vi.mock('./loop-output-externalize', () => ({
  maybeExternalizeLoopOutput: hoisted.maybeExternalizeLoopOutput,
}));
vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: hoisted.createAutomationWithScheduling,
}));
vi.mock('../automations', () => ({
  getAutomationStore: vi.fn(() => ({ delete: hoisted.deleteAutomation })),
}));

// The branch-select glue shells out to git/verify commands; keep it off the real filesystem.
vi.mock('./loop-branch-selector-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loop-branch-selector-helpers')>()),
  runVerifyInDir: vi.fn(() => true),
  commitWorktreeChanges: vi.fn(),
}));
vi.mock('./loop-diff', () => ({
  collectWorkspaceDiff: vi.fn(() => ({ changedFiles: [], diff: '' })),
}));
const worktreeManager = vi.hoisted(() => ({
  createWorktree: vi.fn(),
}));
vi.mock('../workspace/git/worktree-manager', () => ({
  getWorktreeManager: vi.fn(() => worktreeManager),
}));

import { registerDefaultLoopInvoker, buildLoopBranchSelectorDeps } from './default-invokers';

describe('Loop run id is passed as the trial key', () => {
  beforeEach(() => {
    _resetAdapterLoansForTesting();
    _resetLoopAccountFailoverForTesting();
    hoisted.rtkScope = 'off';
    vi.mocked(getDefaultModelForCli).mockReturnValue('default-model');
    hoisted.loopCoordinatorRef.current = Object.assign(new EventEmitter(), {
      registerIterationHook: vi.fn(() => () => undefined),
      setProviderLimitLedger: hoisted.setProviderLimitLedger,
      setProviderLimitResumeScheduler: vi.fn(),
      resumeLoop: vi.fn(() => true),
    });
    for (const fn of [hoisted.sendMessage, hoisted.interrupt, hoisted.setStreamIdleTimeoutMs,
      hoisted.setDisallowedToolsOverride, hoisted.setResume, hoisted.createAdapter,
      hoisted.setProviderLimitLedger, worktreeManager.createWorktree]) fn.mockReset();
    hoisted.initializeForRequest.mockReset().mockResolvedValue(undefined);
    hoisted.sendRaw.mockReset().mockResolvedValue(undefined);
    hoisted.terminate.mockReset().mockResolvedValue(undefined);
    hoisted.maybeExternalizeLoopOutput.mockReset().mockImplementation(async (output: string) => output);
    hoisted.resolveCliType.mockReset().mockResolvedValue('claude');
    hoisted.getBreaker.mockImplementation(() => ({ execute: vi.fn(async <T>(fn: () => Promise<T>) => fn()) }));
    worktreeManager.createWorktree.mockResolvedValue({ id: 'candidate-1', worktreePath: '/tmp/never-touched-by-git' });
    const adapter = Object.assign(new EventEmitter(), {
      initializeForRequest: hoisted.initializeForRequest,
      requestResponse: vi.fn(async (message: unknown) => {
        await hoisted.initializeForRequest();
        return hoisted.sendMessage(message);
      }),
      sendMessage: hoisted.sendMessage, sendRaw: hoisted.sendRaw, terminate: hoisted.terminate,
      interrupt: hoisted.interrupt, setStreamIdleTimeoutMs: hoisted.setStreamIdleTimeoutMs,
      setDisallowedToolsOverride: hoisted.setDisallowedToolsOverride, setResume: hoisted.setResume,
    });
    hoisted.createAdapter.mockReturnValue(adapter);
    hoisted.sendMessage.mockResolvedValue({ content: 'ok', usage: { totalTokens: 2 } });
  });

  function emitIteration(extras: Record<string, unknown>): Promise<LoopChildResult | { error: string }> {
    return new Promise((resolve) => {
      hoisted.loopCoordinatorRef.current.emit('loop:invoke-iteration', {
        correlationId: 'run-7::0', loopRunId: 'run-7', chatId: 'chat-7', provider: 'claude',
        workspaceCwd: '/tmp/loop-workspace', stage: 'IMPLEMENT', seq: 0, idempotencyKey: 'run-7:0:output',
        prompt: 'do the thing', callback: resolve, ...extras,
      });
    });
  }

  it.each(['claude', 'codex'] as const)('fresh-child iteration (%s) spawns with trialKey = loop run id', async (cli) => {
    hoisted.resolveCliType.mockResolvedValue(cli);
    registerDefaultLoopInvoker({} as never);
    await emitIteration({ provider: cli, config: { contextStrategy: 'fresh-child' } });
    expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
    expect(hoisted.createAdapter.mock.calls[0][0].options).toMatchObject({ trialKey: 'run-7', trialKeySource: 'loop-run' });
  });

  it.each(['claude', 'codex'] as const)('same-session loop (%s) creates its persistent adapter with trialKey = loop run id', async (cli) => {
    hoisted.resolveCliType.mockResolvedValue(cli);
    registerDefaultLoopInvoker({} as never);
    await emitIteration({ provider: cli, config: { contextStrategy: 'same-session' } });
    // The persistent adapter is created first and reused for the iteration itself.
    expect(hoisted.createAdapter).toHaveBeenCalledTimes(1);
    expect(hoisted.createAdapter.mock.calls[0][0].options).toMatchObject({ trialKey: 'run-7', trialKeySource: 'loop-run' });
  });

  it('branch-select candidates spawn with trialKey = loop run id', async () => {
    const deps = buildLoopBranchSelectorDeps({} as never);
    const input: BranchSelectInput = {
      loopRunId: 'run-7', workspaceCwd: '/ws', goal: 'g',
      exploration: { enabled: true, fanout: 2, crossModel: false, selector: 'verify+listwise' },
      caps: { maxIterations: 50, maxWallTimeMs: 1, maxTokens: 1_000_000, maxCostCents: 1000 },
      spentTokens: 0, spentCents: 0, prompt: 'p', provider: 'claude',
      verifyCommand: 'true', verifyTimeoutMs: 1000, iterationTimeoutMs: 1000,
    };
    await deps.fanout(input);
    expect(hoisted.createAdapter).toHaveBeenCalledTimes(2);
    for (const call of hoisted.createAdapter.mock.calls) {
      expect(call[0].options).toMatchObject({ trialKey: 'run-7', trialKeySource: 'loop-run' });
    }
  });
});
