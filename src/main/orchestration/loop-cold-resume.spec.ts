import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';

const h = vi.hoisted(() => ({ provider: 'claude' as 'claude' | 'codex' | 'gemini', coordinator: null as unknown, create: vi.fn(), used: 160_000,
  trusted: true, status: 'known', borrowed: false, adapters: [] as EventEmitter[] }));
vi.mock('./loop-coordinator', async original => ({
  ...await original<typeof import('./loop-coordinator')>(), getLoopCoordinator: () => h.coordinator,
}));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: h.create }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => h.provider }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({
  get: () => undefined, getAll: () => ({ defaultCli: 'claude', providerAccountProfiles: [], providerAccountPools: {}, auxiliaryLlmRoutingClassificationEnabled: false }),
}) }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: (fn: () => unknown) => fn() }) }) }));
vi.mock('./loop-output-externalize', () => ({ maybeExternalizeLoopOutput: async (output: string) => output }));
vi.mock('../context/compaction-coordinator', () => ({ getCompactionCoordinator: () => ({
  isSelfManagedAutoCompaction: () => true,
  getBudgetTracker: () => ({ recordContinuation: vi.fn(), checkBudget: () => ({ action: 'continue' }) }),
}) }));
import { LoopCoordinator } from './loop-coordinator';
import { registerDefaultLoopInvoker } from './default-invokers';

describe('first resumed cold loop dispatch', () => {
  let coordinator: LoopCoordinator, workspace: string, clock: number;
  let sends: string[], order: string[], prompts: string[];
  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator(); h.coordinator = coordinator;
    workspace = mkdtempSync(join(tmpdir(), 'cold-resume-'));
    const now = Date.now.bind(Date); clock = 0; vi.spyOn(Date, 'now').mockImplementation(() => now() + clock);
    h.provider = 'claude'; h.used = 160_000; h.trusted = true; h.status = 'known'; h.borrowed = false; h.adapters = []; sends = []; order = []; prompts = [];
    h.create.mockReset().mockImplementation(() => {
      const id = `adapter-${h.adapters.length}`;
      const adapter = Object.assign(new EventEmitter(), {
        initializeForRequest: async () => undefined,
        requestResponse: async (message: { content: string }) => {
          sends.push(id); order.push(`send:${id}`);
          prompts.push(message.content);
          writeFileSync(join(workspace, 'progress.txt'), String(sends.length));
          return { content: 'Progress written.', usage: { totalTokens: 10 } };
        },
        terminate: async () => { order.push(`terminate:${id}`); },
        setResume: vi.fn(), setStreamIdleTimeoutMs: vi.fn(),
        getLastContextUsage: () => ({ status: h.status, used: h.used, total: 1_000_000, windowTrusted: h.trusted }),
      });
      Object.assign(adapter, { sendMessage: adapter.requestResponse });
      h.adapters.push(adapter); return adapter;
    });
    registerDefaultLoopInvoker({ getInstance: () => h.borrowed
      ? { id: 'cold-chat', provider: 'claude', workingDirectory: workspace, outputBuffer: [] } : undefined,
      getAdapter: () => h.adapters[0], queueInstanceUpdate: vi.fn() } as never);
    coordinator.registerIterationHook(({ state }) => { coordinator.pauseLoop(state.id); });
  });
  afterEach(async () => {
    for (const state of coordinator.getActiveLoops()) await coordinator.cancelLoop(state.id);
    vi.restoreAllMocks(); rmSync(workspace, { recursive: true, force: true }); LoopCoordinator._resetForTesting();
  });
  async function run(gapMinutes: number, provider: 'claude' | 'codex' | 'gemini' = 'claude') {
    h.provider = provider;
    const config = defaultLoopConfig(workspace, 'write progress');
    config.provider = provider; config.contextStrategy = 'same-session'; config.initialStage = 'IMPLEMENT';
    config.caps.maxIterations = 4; config.caps.maxWallTimeMs = 24 * 60 * 60_000;
    config.completion.verifyCommand = ''; config.isolateLoopWorkspaces = false;
    config.iterationPrompt = 'Continue the next step.';
    const reasons: string[] = [];
    coordinator.on('loop:activity', p => { if (p.kind === 'status') reasons.push(p.message); });
    const sealed = new Promise<void>(resolve => coordinator.once('loop:iteration-complete', () => resolve()));
    const state = await coordinator.startLoop('cold-chat', config, undefined, { existingSessionContext: 'PARENT_REPLAY_PLACEHOLDER' });
    await sealed;
    await new Promise<void>(resolve => setImmediate(resolve));
    clock += gapMinutes * 60_000;
    const nextSealed = new Promise<void>(resolve => coordinator.once('loop:iteration-complete', () => resolve()));
    coordinator.resumeLoop(state.id);
    await vi.waitFor(() => expect(sends).toHaveLength(2), { timeout: 5_000 });
    await nextSealed;
    return { state, reasons };
  }
  it('recycles the owned adapter before the first resumed send and reports the cold reason', async () => {
    const { reasons } = await run(70);
    expect(sends).toEqual(['adapter-0', 'adapter-1']);
    expect(order.indexOf('terminate:adapter-0')).toBeLessThan(order.indexOf('send:adapter-1'));
    expect(reasons.join('\n')).toContain('starting a fresh session is cheaper');
    expect(prompts[1]).toContain('PARENT_REPLAY_PLACEHOLDER');
    expect(prompts[1]).toContain('write progress');
    const sealed = new Promise<void>(resolve => coordinator.once('loop:iteration-complete', () => resolve()));
    coordinator.resumeLoop(coordinator.getActiveLoops()[0].id);
    await sealed;
    expect(sends).toEqual(['adapter-0', 'adapter-1', 'adapter-1']);
    expect(reasons.filter(reason => reason.includes('starting a fresh session is cheaper'))).toHaveLength(1);
  });
  it.each(['codex', 'gemini'] as const)('keeps the re-warmed %s session after an idle gap', async provider => {
    const { reasons } = await run(70, provider);
    expect(sends).toEqual(['adapter-0', 'adapter-0']);
    const sealed = new Promise<void>(resolve => coordinator.once('loop:iteration-complete', () => resolve()));
    coordinator.resumeLoop(coordinator.getActiveLoops()[0].id);
    await sealed;
    expect(sends).toEqual(['adapter-0', 'adapter-0', 'adapter-0']);
    expect(reasons.join('\n')).not.toContain('starting a fresh session is cheaper');
  });
  it.each(['warm', 'small', 'unknown', 'untrusted', 'borrowed'] as const)('preserves the %s control', async mode => {
    if (mode === 'small') h.used = 149_999;
    if (mode === 'unknown') h.status = 'unknown';
    if (mode === 'untrusted') h.trusted = false;
    if (mode === 'borrowed') { h.borrowed = true; h.create(); }
    await run(mode === 'warm' ? 54 : 70);
    expect(sends).toEqual(['adapter-0', 'adapter-0']);
  });
});
