import { describe, expect, it, vi } from 'vitest';
import { CliUpdateService, type CliUpdateServiceDeps } from './cli-update-service';
import { openCodeProcessGate } from './adapters/opencode-process-gate';

function fixture(version = '2.0.30') {
  const selected = '/tmp/LOCAL_SELECTED_OPENCODE_PLACEHOLDER';
  const state = { version, present: true, resolved: selected };
  const updates: string[][] = [];
  const execute = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe(selected);
    if (args.length === 1 && args[0] === '--version') return { stdout: `opencode v${state.version}\n`, stderr: '' };
    updates.push(args);
    return { stdout: 'Fixture update completed.', stderr: '' };
  });
  const info = { name: 'opencode' as const, command: 'opencode', displayName: 'OpenCode', installed: true, path: selected, version };
  const detection: NonNullable<CliUpdateServiceDeps['detection']> = {
    clearCache: vi.fn(), detectOne: vi.fn(async () => info), scanAllCliInstalls: vi.fn(async () => [info]),
    detectAll: vi.fn(async () => ({ detected: [info], available: [info], unavailable: [], timestamp: new Date(0) })),
  };
  const service = new CliUpdateService({ detection, exists: () => state.present, realpath: () => state.resolved,
    resolveOpenCodeLatestVersion: async () => '2.0.31', execFileAsync: execute, env: {}, platform: 'darwin' });
  return { service, state, execute, updates, selected, detection, info };
}

async function afterPlanning(f: ReturnType<typeof fixture>, change: () => void) {
  const release = await openCodeProcessGate();
  let planned!: () => void;
  const ready = new Promise<void>(resolve => { planned = resolve; });
  const original = f.service.getUpdatePlan.bind(f.service);
  vi.spyOn(f.service, 'getUpdatePlan').mockImplementation(async type => {
    const plan = await original(type); planned(); return plan;
  });
  const updating = f.service.updateOne('opencode');
  try { await ready; expect(f.execute).not.toHaveBeenCalled(); change(); }
  finally { release(); }
  return updating;
}

describe('OpenCode update execution boundary', () => {
  it.each([['1.19.1', '2.0.30'], ['2.0.30', '1.19.1'], ['2.0.30', '2.0.32'],
    ['2.0.30', '3.0.0'], ['2.0.30', '2.0.30-preview'], ['2.0.30', 'unknown']])(
    'refuses an executable changed during the startup gate wait: %s to %s', async (before, after) => {
      const f = fixture(before);
      const result = await afterPlanning(f, () => { f.state.version = after; });
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/version|install.*changed/i);
      expect(f.updates).toEqual([]);
    });

  it('refuses a missing selected install without running an unrelated PATH command', async () => {
    const f = fixture('1.19.1'); f.state.present = false;
    await expect(f.service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false, reason: expect.stringMatching(/selected.*install|path/i) });
    await expect(f.service.updateOne('opencode')).resolves.toMatchObject({ status: 'skipped' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('refuses a selected install removed after planning while waiting for the gate', async () => {
    const f = fixture();
    expect((await afterPlanning(f, () => { f.state.present = false; })).status).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, 'opencode'])('refuses an unconfirmed selected path %j without substituting a scanned install', async path => {
    const f = fixture();
    vi.mocked(f.detection.detectOne).mockResolvedValue({ ...f.info, path });
    await expect(f.service.getUpdatePlan('opencode')).resolves.toMatchObject({ supported: false });
    await expect(f.service.updateOne('opencode')).resolves.toMatchObject({ status: 'skipped' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['/Applications/OpenCode.app/Contents/Resources/opencode-cli',
    '/opt/homebrew/Cellar/opencode-v2/2.0.30/bin/opencode'])('refuses a selected symlink retargeted to %s', async resolved => {
      const f = fixture();
      expect((await afterPlanning(f, () => { f.state.resolved = resolved; })).status).toBe('failed');
      expect(f.updates).toEqual([]);
    });

  it.each([['1.19.1', ['upgrade']], ['2.0.30', ['upgrade', '2.0.31']]] as const)(
    'probes the same selected %s executable before executing its validated update', async (version, args) => {
      const f = fixture(version);
      await expect(f.service.updateOne('opencode')).resolves.toMatchObject({ status: 'updated' });
      expect(f.execute.mock.calls.map(([file, argv]) => [file, argv])).toEqual([
        [f.selected, ['--version']], [f.selected, args],
      ]);
    });

  it('fails closed without exposing native version-probe error output', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_ERROR_PLACEHOLDER'), {
      stdout: 'PRIVATE_OUTPUT_PLACEHOLDER', stderr: 'PRIVATE_STDERR_PLACEHOLDER',
    }));
    const result = await f.service.updateOne('opencode');
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/confirm|version/i);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(f.updates).toEqual([]);
  });
});
