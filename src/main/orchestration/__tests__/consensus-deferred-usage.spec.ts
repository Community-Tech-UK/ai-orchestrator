import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ adapter: undefined as unknown }));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({ createAdapter: () => fixture.adapter }),
}));
vi.mock('../../instance/lifecycle/provider-route-preflight', () => ({
  attachProviderRoutes: async (_type: unknown, options: unknown) => options,
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({}) }),
}));
vi.mock('../../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: vi.fn() }));
vi.mock('../../cli/adapters/claude-transcript-registry', () => ({
  nativeTranscriptExists: () => true,
  nativeSessionIdInUse: () => false,
  readLastClaudeCostState: () => undefined,
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import { ConsensusCoordinator } from '../consensus-coordinator';
import { CliDetectionService } from '../../cli/cli-detection';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';

afterEach(() => {
  ConsensusCoordinator._resetForTesting();
  vi.restoreAllMocks();
});

describe('consensus native usage settlement', () => {
  it.each([
    { failed: false, cost: 0.25, cancelled: false, costSource: 'provider' },
    { failed: false, cost: undefined, cancelled: false, costSource: 'priced' },
    { failed: true, cost: 0.25, cancelled: false, costSource: 'provider' },
    { failed: true, cost: 0, cancelled: false, costSource: 'provider' },
    { failed: true, cost: undefined, cancelled: false, costSource: 'unknown' },
    { failed: true, cost: 0.25, cancelled: true, costSource: 'provider' },
  ])('records settled billing once for %j', async ({ failed, cost, cancelled, costSource }) => {
    const adapter = new ClaudeCliAdapter({ model: 'claude-opus-5', workingDirectory: '/tmp' });
    fixture.adapter = adapter;
    const child = Object.assign(new EventEmitter(), {
      pid: 10101,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      exitCode: null,
    });
    vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
      .mockReturnValue(child as unknown as ChildProcess);
    vi.spyOn(CliDetectionService.getInstance(), 'detectAll').mockResolvedValue({
      available: [{ name: 'claude' }],
      unavailable: [],
    } as unknown as Awaited<ReturnType<CliDetectionService['detectAll']>>);

    let aborted = false;
    const coordinator = ConsensusCoordinator.getInstance();
    coordinator.on('consensus:progress', (event: { queryId: string; phase: string }) => {
      if (event.phase === 'dispatching') {
        // Registration follows dispatching; the transport callback aborts later.
        child.stdin.once('data', () => { if (cancelled) aborted = coordinator.abortQuery(event.queryId); });
      }
    });
    const feed = (frame: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'));
    child.stdin.once('data', () => queueMicrotask(() => {
      feed({ type: 'assistant', message: {
        content: [{ type: 'text', text: 'Partial consensus answer' }],
        usage: { input_tokens: 100, output_tokens: 20 },
      } });
      const finish = () => {
        feed({ type: 'result', subtype: failed ? 'error_during_execution' : 'success',
          is_error: failed, total_cost_usd: cost, usage: { input_tokens: 100, output_tokens: 20 } });
        child.emit('exit', failed ? 1 : 0, null);
        child.emit('close', failed ? 1 : 0, null);
      };
      if (failed) {
        feed({ type: 'error', error: { code: 'overloaded_error', message: 'Overloaded fixture' } });
        setTimeout(finish, 5);
      } else finish();
    }));

    const rows: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(row => rows.push(row));
    try {
      const result = await coordinator.query('Compare scheduling options', undefined, {
        providers: [{ provider: 'claude', model: 'claude-opus-5' }], workingDirectory: '/tmp', timeout: 1,
      });
      expect(result.responses[0]?.content).toBe('Partial consensus answer');
      expect(aborted).toBe(cancelled);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ purpose: 'consensus', costSource,
        outcome: cancelled ? 'cancelled' : failed ? 'error' : 'success' });
      if (cost !== undefined) expect(rows[0].usage?.cost).toBe(cost);
      else if (failed) {
        expect(rows[0].costKnown).toBe(false);
        expect(rows[0].usage?.cost).toBeUndefined();
      } else expect(rows[0].usage?.cost).toBeGreaterThan(0);
      for (const event of ['usage', 'complete', 'error', 'turn_error', 'output', 'status', 'exit']) {
        expect(adapter.listenerCount(event)).toBe(0);
      }
      expect(coordinator.getActiveQueryCount()).toBe(0);
    } finally {
      stop();
      await adapter.terminate(false);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
});
