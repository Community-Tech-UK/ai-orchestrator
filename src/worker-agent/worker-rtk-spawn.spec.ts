import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
vi.mock('fs', async original => ({ ...await original<typeof import('fs')>(), existsSync: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawnSync: vi.fn() }));
vi.mock('../main/cli/cli-path-resolver', () => ({ resolveCommandOnPath: () => null }));
import { resolveWorkerRtkSpawn } from './worker-rtk-spawn';

describe('worker-local RTK spawn configuration', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('keeps disabled requests disabled without probing', () => {
    expect(resolveWorkerRtkSpawn({ enabled: false })).toEqual({ rtk: { enabled: false } });
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it('uses the worker binary and hook and composes the shell environment', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'rtk 0.52.0' } as ReturnType<typeof spawnSync>);
    const result = resolveWorkerRtkSpawn({ enabled: true });
    expect(result.rtk).toMatchObject({ enabled: true, binaryPath: expect.stringContaining('rtk') });
    expect(result.permissionHookPath).toContain('rtk-defer-hook.mjs');
    expect(result.env?.['PATH']).toContain('rtk');
    expect(result.env?.['RTK_TELEMETRY_DISABLED']).toBe('1');
  });
  it('spawns honestly without RTK when the worker has no binary', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveWorkerRtkSpawn({ enabled: true })).toEqual({ rtk: { enabled: false } });
  });
  it('rejects an obsolete binary without breaking the provider spawn', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'rtk 0.22.0' } as ReturnType<typeof spawnSync>);
    expect(resolveWorkerRtkSpawn({ enabled: true })).toEqual({ rtk: { enabled: false } });
  });
});
