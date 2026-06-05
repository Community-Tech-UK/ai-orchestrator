import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { CompletedFileWatcher } from './loop-completion-detector';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../shared/types/provider-quota.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-usage-throttle-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-usage-throttle"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator usage-aware throttling', () => {
  it('reactive backstop: a provider-notice iteration terminates as provider-limit (no resume info)', async () => {
    let invokeCount = 0;
    const events: unknown[] = [];
    coordinator.on('loop:provider-limit', (e) => events.push(e));
    coordinator.setQuotaSnapshotProvider(() => null); // no reset info → terminate
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult("You've hit your session limit · resets 6:30pm"));
    });

    const state = await startLoop('chat-notice-terminate');
    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'provider-limit', 5000);
      expect(coordinator.getLoop(state.id)?.status).toBe('provider-limit');
      // The notice iteration must NOT be counted as real work.
      expect(coordinator.getLoop(state.id)?.totalIterations ?? 0).toBe(0);
      expect(invokeCount).toBe(1);
      expect(events).toHaveLength(1);
      expect((events[0] as { source: string }).source).toBe('notice');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('reactive backstop: parks (auto-resume) when the quota snapshot has a future reset', async () => {
    const resetsAt = Date.now() + 60_000;
    const scheduler = vi.fn(() => () => { /* noop */ });
    coordinator.setProviderLimitResumeScheduler(scheduler);
    // Headroom so the preventive ladder does not park before the iteration runs;
    // the reactive path still derives resumeAt from this window's resetsAt.
    coordinator.setQuotaSnapshotProvider(() => snapshot([win({ used: 20, resetsAt })]));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      p.callback(iterationResult('usage limit reached'));
    });

    const state = await startLoop('chat-notice-park');
    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'paused', 5000);
      expect(coordinator.getLoop(state.id)?.status).toBe('paused');
      expect(scheduler).toHaveBeenCalledWith(expect.objectContaining({
        loopRunId: state.id,
        resumeAt: resetsAt,
        reason: expect.stringContaining('provider usage/limit notice'),
        source: 'notice',
      }));
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('preventive: parks before spawning the first iteration when the window is >= 90%', async () => {
    let invokeCount = 0;
    const events: unknown[] = [];
    coordinator.on('loop:provider-limit', (e) => events.push(e));
    coordinator.setQuotaSnapshotProvider(() =>
      snapshot([win({ used: 95, resetsAt: Date.now() + 120_000 })]),
    );
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult('work'));
    });

    const state = await startLoop('chat-preventive-park');
    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'paused', 5000);
      expect(coordinator.getLoop(state.id)?.status).toBe('paused');
      expect(invokeCount).toBe(0); // never spawned a paid iteration
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect((events[0] as { source: string }).source).toBe('quota');
      expect((events[0] as { action: string }).action).toBe('throttle');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('preventive: downshifts to sonnet before spawning when weekly all-model usage is high', async () => {
    let invokeCount = 0;
    const models: Array<string | undefined> = [];
    const events: unknown[] = [];
    coordinator.on('loop:provider-limit', (e) => events.push(e));
    coordinator.setQuotaSnapshotProvider(() =>
      snapshot([
        win({ id: 'claude.weekly', label: 'Weekly (all models)', used: 95, resetsAt: Date.now() + 120_000 }),
        win({ id: 'claude.weekly-sonnet', label: 'Weekly (Sonnet)', used: 7, resetsAt: Date.now() + 120_000 }),
      ]),
    );
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void; model?: string };
      invokeCount += 1;
      models.push(p.model);
      p.callback(iterationResult('work'));
    });

    const state = await startLoop('chat-downshift');
    try {
      await waitForCondition(() => invokeCount >= 1, 5000);
      expect(models[0]).toBe('sonnet');
      expect(events).toEqual([]);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('provider-limit');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('preventive: overage guard fires when paid credits are being consumed', async () => {
    let invokeCount = 0;
    coordinator.setQuotaSnapshotProvider(() =>
      snapshot([
        win({ used: 50 }),
        win({ id: 'claude.credits', label: 'Credits', unit: 'usd', used: 10, limit: 100, remaining: 90 }),
      ]),
    );
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult('work'));
    });

    const state = await startLoop('chat-overage-guard');
    try {
      // No reset on the credits window → terminates as provider-limit.
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'provider-limit', 5000);
      expect(invokeCount).toBe(0);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('preventive: does NOT terminate on a stale snapshot whose window reset has already passed', async () => {
    // Simulates the post-auto-resume state: used is still 100% but the window's
    // own resetsAt is now in the past, so the data predates the reset. The loop
    // must run, not re-terminate on stale numbers.
    let invokeCount = 0;
    coordinator.setQuotaSnapshotProvider(() =>
      snapshot([win({ used: 100, resetsAt: Date.now() - 10_000 })]),
    );
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult('real work happened'));
    });

    const state = await startLoop('chat-stale-snapshot');
    try {
      await waitForCondition(() => invokeCount >= 1, 5000);
      expect(invokeCount).toBeGreaterThanOrEqual(1);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('provider-limit');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('allows the loop to run normally with quota headroom', async () => {
    let invokeCount = 0;
    coordinator.setQuotaSnapshotProvider(() => snapshot([win({ used: 20 })]));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      invokeCount += 1;
      p.callback(iterationResult('real work happened'));
    });

    const state = await startLoop('chat-headroom');
    try {
      await waitForCondition(() => invokeCount >= 1, 5000);
      expect(invokeCount).toBeGreaterThanOrEqual(1);
      // Did not park/terminate on a provider limit.
      expect(coordinator.getLoop(state.id)?.status).not.toBe('provider-limit');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });
});

async function startLoop(chatId: string) {
  return coordinator.startLoop(chatId, {
    initialPrompt: 'keep going',
    workspaceCwd: workspace,
    caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
    blockSanityProbe: { enabled: false },
    completion: {
      ...defaultLoopConfig(workspace, 'x').completion,
      verifyCommand: 'false',
      runVerifyTwice: false,
      requireCompletedFileRename: false,
      crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
    },
  });
}

function win(overrides: Partial<ProviderQuotaWindow>): ProviderQuotaWindow {
  return {
    kind: 'rolling-window',
    id: 'claude.5h',
    label: '5-hour session',
    unit: 'messages',
    used: 0,
    limit: 100,
    remaining: 100,
    resetsAt: null,
    ...overrides,
  };
}

function snapshot(windows: ProviderQuotaWindow[]): ProviderQuotaSnapshot {
  return { provider: 'claude', takenAt: Date.now(), source: 'admin-api', ok: true, windows };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met before timeout');
}

function iterationResult(output: string, overrides?: Partial<LoopChildResult>): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
    ...overrides,
  };
}
