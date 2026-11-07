import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

import { readTestMachineHealth } from './plan-queue-test-machine';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OFF = 'AIO_REMOTE_CHECKS=off asked for it';
const UNREACHABLE = 'the Windows PC could not be reached';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(runs: object[] | null, config: string | null = '{"host":"pc","label":"the Windows PC"}'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pq-test-machine-'));
  dirs.push(dir);
  if (config !== null) writeFileSync(join(dir, 'config.json'), config);
  if (runs) writeFileSync(join(dir, 'runs.jsonl'), runs.map(run => JSON.stringify(run)).join('\n') + '\n');
  return dir;
}

const run = (agoMs: number, ranOn: string, fellBackBecause: string | null = null, kind?: string) => ({
  at: new Date(NOW - agoMs).toISOString(), ranOn, fellBackBecause, ...(kind ? { kind } : {}),
});
const read = (dir: string) => readTestMachineHealth(NOW, 14, dir);

describe('readTestMachineHealth', () => {
  it('says nothing when no test machine is set up, or its config cannot be read', () => {
    expect(read(folder(null, null))).toBeUndefined();
    expect(read(folder([run(MIN, 'pc')], '{ broken'))).toBeUndefined();
  });

  it('reports no runs as nothing measured, not as zero', () => {
    expect(read(folder(null))).toEqual({
      label: 'the Windows PC',
      ranThere: { count: 0, of: 0, share: null },
      movedToMac: { count: 0, of: 0, share: null },
      unreachable: false,
    });
  });

  it('counts where full runs went, and does not call a chosen Mac run a fallback', () => {
    const health = read(folder([run(3 * MIN, 'pc'), run(2 * MIN, 'mac', OFF), run(MIN, 'pc'), run(30 * MIN, 'mac', 'the Windows PC had no free slot')]));
    expect(health?.ranThere).toEqual({ count: 2, of: 4, share: 0.5 });
    expect(health?.movedToMac).toEqual({ count: 1, of: 3, share: 1 / 3 });
  });

  it('leaves commit and targeted runs out of the full-run figures', () => {
    const health = read(folder([run(MIN, 'pc'), run(MIN, 'mac', UNREACHABLE, 'commit'), run(MIN, 'pc', null, 'targeted')]));
    expect(health?.ranThere).toEqual({ count: 1, of: 1, share: 1 });
    expect(health?.movedToMac).toEqual({ count: 0, of: 1, share: 0 });
  });

  it('leaves out runs older than the window', () => {
    expect(read(folder([run(15 * DAY, 'pc'), run(MIN, 'pc')]))?.ranThere.of).toBe(1);
  });

  it('survives half-written lines', () => {
    const dir = folder([run(MIN, 'pc')]);
    writeFileSync(join(dir, 'runs.jsonl'), `{"at":"half\n${JSON.stringify(run(MIN, 'pc'))}\nnull\n`);
    expect(read(dir)?.ranThere.of).toBe(1);
  });

  describe('the notice', () => {
    it.each([
      ['the machine could not be reached', UNREACHABLE],
      ['the connection dropped', 'the connection to the Windows PC was lost during the run'],
    ])('shows when %s and tests moved to the Mac', (_label, reason) => {
      expect(read(folder([run(5 * MIN, 'pc'), run(MIN, 'mac', reason)]))?.unreachable).toBe(true);
    });

    it('counts a commit run, which proves the same thing', () => {
      expect(read(folder([run(MIN, 'mac', UNREACHABLE, 'commit')]))?.unreachable).toBe(true);
    });

    it('clears once a run reaches the machine again', () => {
      expect(read(folder([run(5 * MIN, 'mac', UNREACHABLE), run(MIN, 'pc')]))?.unreachable).toBe(false);
    });

    it('stays quiet for faults that are not about reaching the machine', () => {
      for (const reason of ['the Windows PC had no free slot', 'the Windows PC could not set up: npm ci failed', 'the snapshot failed']) {
        expect(read(folder([run(MIN, 'mac', reason)]))?.unreachable).toBe(false);
      }
    });

    it('ignores a small run that never tried the machine', () => {
      expect(read(folder([run(5 * MIN, 'mac', UNREACHABLE), run(MIN, 'mac', null, 'local')]))?.unreachable).toBe(true);
      expect(read(folder([run(MIN, 'pc'), run(MIN, 'mac', null, 'local')]))?.ranThere).toEqual({ count: 1, of: 1, share: 1 });
    });

    it('ignores a run someone chose to keep on the Mac, which proves nothing either way', () => {
      expect(read(folder([run(5 * MIN, 'mac', UNREACHABLE), run(MIN, 'mac', OFF)]))?.unreachable).toBe(true);
      expect(read(folder([run(5 * MIN, 'pc'), run(MIN, 'mac', OFF)]))?.unreachable).toBe(false);
    });

    it('goes away after an hour with no new runs', () => {
      expect(read(folder([run(59 * MIN, 'mac', UNREACHABLE)]))?.unreachable).toBe(true);
      expect(read(folder([run(61 * MIN, 'mac', UNREACHABLE)]))?.unreachable).toBe(false);
    });
  });
});
