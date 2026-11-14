import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Profiler } from 'node:inspector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainProcessStallProfiler, summarizeCpuProfile } from './main-process-stall-profiler';

function node(id: number, functionName: string, children: number[] = [], url = '', lineNumber = 0): Profiler.ProfileNode {
  return { id, callFrame: { functionName, scriptId: '1', url, lineNumber, columnNumber: 0 }, children };
}

/** root → main → (busyWork → JSON.stringify), plus idle. 10 ms per sample. */
function sampleProfile(): Profiler.Profile {
  return {
    nodes: [
      node(1, '(root)', [2, 5]),
      node(2, 'tick', [3], 'file:///Users/someone/app/dist/main/runtime/timer.js', 9),
      node(3, 'busyWork', [4], 'file:///Users/someone/app/dist/main/providers/catalog.js', 41),
      node(4, 'stringify'),
      node(5, '(idle)'),
    ],
    startTime: 0,
    endTime: 100_000,
    samples: [4, 4, 4, 4, 4, 4, 3, 3, 5, 5],
    timeDeltas: Array.from({ length: 10 }, () => 10_000),
  };
}

describe('summarizeCpuProfile', () => {
  it('ranks self time, ignores idle, and shows the call path', () => {
    const summary = summarizeCpuProfile(sampleProfile());

    expect(summary.sampledMs).toBe(100);
    expect(summary.busyPercent).toBe(80);
    expect(summary.hotFrames).toEqual([
      {
        frame: 'stringify',
        selfMs: 60,
        busyPercent: 75,
        calledFrom: ['busyWork main/providers/catalog.js:42', 'tick main/runtime/timer.js:10'],
      },
      {
        frame: 'busyWork main/providers/catalog.js:42',
        selfMs: 20,
        busyPercent: 25,
        calledFrom: ['tick main/runtime/timer.js:10'],
      },
    ]);
  });

  it('handles an empty profile', () => {
    expect(summarizeCpuProfile({ nodes: [node(1, '(root)')], startTime: 0, endTime: 0, samples: [] }))
      .toEqual({ sampledMs: 0, busyPercent: 0, hotFrames: [] });
  });
});

describe('MainProcessStallProfiler', () => {
  let outputDir: string;
  let now: number;
  const log = { warn: vi.fn() };
  const captureProfile = vi.fn<(durationMs: number) => Promise<Profiler.Profile>>();

  function makeProfiler(): MainProcessStallProfiler {
    return new MainProcessStallProfiler({ outputDir, now: () => now, captureProfile, log });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-profiler-'));
    now = Date.parse('2026-11-13T12:00:00Z');
    captureProfile.mockResolvedValue(sampleProfile());
  });

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('captures only once stalls repeat within a minute', async () => {
    const profiler = makeProfiler();
    expect(profiler.noteStall()).toBeNull();
    now += 40_000;
    expect(profiler.noteStall()).toBeNull();
    now += 40_000; // the first stall is now outside the window
    expect(profiler.noteStall()).toBeNull();
    now += 10_000;
    const capture = profiler.noteStall();
    expect(capture).not.toBeNull();
    await capture;
    expect(captureProfile).toHaveBeenCalledTimes(1);
  });

  it('saves the profile and logs what was busy', async () => {
    const profiler = makeProfiler();
    profiler.noteStall();
    profiler.noteStall();
    await profiler.noteStall();

    const files = await fs.readdir(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^main-stall-.+\.cpuprofile$/);
    expect(JSON.parse(await fs.readFile(path.join(outputDir, files[0]), 'utf8'))).toEqual(sampleProfile());
    expect(log.warn).toHaveBeenCalledWith('Main process stall profile captured', expect.objectContaining({
      file: path.join(outputDir, files[0]),
      busyPercent: 80,
      hotFrames: expect.arrayContaining([expect.objectContaining({ frame: 'stringify' })]),
    }));
  });

  it('waits half an hour between captures and never overlaps them', async () => {
    let finish: (profile: Profiler.Profile) => void = () => undefined;
    captureProfile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const profiler = makeProfiler();
    profiler.noteStall();
    profiler.noteStall();
    const first = profiler.noteStall();
    for (let i = 0; i < 3; i += 1) expect(profiler.noteStall()).toBeNull(); // still capturing
    finish(sampleProfile());
    await first;

    now += 29 * 60_000;
    for (let i = 0; i < 3; i += 1) expect(profiler.noteStall()).toBeNull();
    now += 2 * 60_000;
    profiler.noteStall();
    profiler.noteStall();
    await profiler.noteStall();
    expect(captureProfile).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest five profiles', async () => {
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(outputDir, `main-stall-2000-01-0${i + 1}.cpuprofile`), '{}');
    }
    await fs.writeFile(path.join(outputDir, 'unrelated.txt'), 'keep me');
    const profiler = makeProfiler();
    for (let round = 0; round < 2; round += 1) {
      profiler.noteStall();
      profiler.noteStall();
      await profiler.noteStall();
      now += 31 * 60_000;
    }

    const files = (await fs.readdir(outputDir)).sort();
    expect(files.filter((name) => name.endsWith('.cpuprofile'))).toHaveLength(5);
    expect(files).not.toContain('main-stall-2000-01-01.cpuprofile');
    expect(files).toContain('unrelated.txt');
  });

  it('logs a failed capture instead of throwing', async () => {
    captureProfile.mockRejectedValueOnce(new Error('inspector unavailable'));
    const profiler = makeProfiler();
    profiler.noteStall();
    profiler.noteStall();
    await expect(profiler.noteStall()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('Main process stall profile could not be captured', {
      error: 'inspector unavailable',
    });
  });
});
