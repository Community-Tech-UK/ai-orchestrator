import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./stall-process-facts', async (original) => {
  const actual = await original<typeof import('./stall-process-facts')>();
  return { ...actual, sampleStallProcessFacts: vi.fn() };
});
import { sampleStallProcessFacts, type StallProcessFacts } from './stall-process-facts';
import { buildSpawnStallNotice, buildStuckNotice } from './stall-notices';
const sample = vi.mocked(sampleStallProcessFacts);
const stopped: StallProcessFacts = { pid: 100, state: 'stopped', cpuPercent: 0, rssMb: 2, child: null, sampledAt: 1234 };
afterEach(() => vi.restoreAllMocks());

describe('stall notices', () => {
  it('keeps the existing stuck notice when sampling fails', async () => {
    sample.mockResolvedValue(null);
    expect(await buildStuckNotice({ elapsedMs: 70_000, pid: null })).toMatchObject({
      id: expect.stringMatching(/^stuck-warn-/), type: 'system',
      content: 'Instance may be stuck — no output for 70s. Will auto-restart if unresponsive.',
      metadata: { watchdogWarning: true, elapsedMs: 70_000 },
    });
  });

  it('appends the process observation with machine-readable metadata', async () => {
    sample.mockResolvedValue(stopped);
    const result = await buildStuckNotice({ elapsedMs: 70_000, pid: 100 });
    expect(result.content).toContain('paused by the system');
    expect(result.metadata).toEqual({ watchdogWarning: true, elapsedMs: 70_000, processFacts: stopped });
  });

  it('keeps the existing spawn notice when sampling fails', async () => {
    sample.mockResolvedValue(null);
    expect(await buildSpawnStallNotice({ timeoutMs: 30_000, pid: null })).toMatchObject({
      id: expect.stringMatching(/^spawn-stall-/), type: 'system',
      content: 'Instance started but produced no output for 30s. It may be stuck. Will auto-restart if unresponsive.',
      metadata: { spawnStall: true, timeoutMs: 30_000 },
    });
  });

  it('appends spawn facts without changing the watchdog flags', async () => {
    sample.mockResolvedValue(stopped);
    const result = await buildSpawnStallNotice({ timeoutMs: 30_000, pid: 100 });
    expect(result.content).toContain('paused by the system');
    expect(result.metadata).toEqual({ spawnStall: true, timeoutMs: 30_000, processFacts: stopped });
  });
});
