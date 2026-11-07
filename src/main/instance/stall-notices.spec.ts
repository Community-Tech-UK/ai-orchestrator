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
      content: 'No output for 70s. If it stays silent, Harness will restart the session.',
      metadata: { watchdogWarning: true, elapsedMs: 70_000, detail: '70s without output' },
    });
  });

  it('appends the process observation with machine-readable metadata', async () => {
    sample.mockResolvedValue(stopped);
    const result = await buildStuckNotice({ elapsedMs: 70_000, pid: 100 });
    expect(result.content).toContain('paused by the system');
    expect(result.metadata).toEqual({ watchdogWarning: true, elapsedMs: 70_000, processFacts: stopped, detail: '70s without output' });
  });

  it('keeps the existing spawn notice when sampling fails', async () => {
    sample.mockResolvedValue(null);
    expect(await buildSpawnStallNotice({ timeoutMs: 30_000, pid: null })).toMatchObject({
      id: expect.stringMatching(/^spawn-stall-/), type: 'system',
      content: "The session started 30s ago and hasn't responded yet. It may still be loading. If nothing happens, restart the session.",
      metadata: { spawnStall: true, timeoutMs: 30_000 },
    });
  });

  it('appends spawn facts without changing the watchdog flags', async () => {
    sample.mockResolvedValue(stopped);
    const result = await buildSpawnStallNotice({ timeoutMs: 30_000, pid: 100 });
    expect(result.content).toContain('paused by the system');
    expect(result.metadata).toEqual({ spawnStall: true, timeoutMs: 30_000, processFacts: stopped });
  });

  it('uses only the worker observation for remote warnings, never a local PID sample', async () => {
    sample.mockClear();
    const sampleProcessFacts = vi.fn().mockResolvedValue(stopped);
    const notice = await buildStuckNotice({ elapsedMs: 70_000, pid: null, sampleProcessFacts });
    expect(sampleProcessFacts).toHaveBeenCalledWith(70_000);
    expect(sample).not.toHaveBeenCalled();
    expect(notice.metadata).toMatchObject({ watchdogWarning: true, processFacts: stopped });
  });

  it('keeps the warning without inspecting local processes when a worker cannot sample', async () => {
    sample.mockClear();
    const notice = await buildStuckNotice({ elapsedMs: 70_000, pid: null, sampleProcessFacts: async () => null });
    expect(sample).not.toHaveBeenCalled();
    expect(notice.content).toBe('No output for 70s. If it stays silent, Harness will restart the session.');
    expect(notice.metadata).not.toHaveProperty('processFacts');
  });
});
