import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn() }));
vi.mock('../adapters/opencode-cli-launch', () => ({ resolveOpenCodeLaunch: mocks.resolve }));
vi.mock('child_process', async (original) => { const actual = await original<typeof import('child_process')>(); return { ...actual, default: { ...actual, spawn: mocks.spawn }, spawn: mocks.spawn }; });
import { CliDetectionService } from '../cli-detection';

describe('OpenCode detection agrees with session selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CliDetectionService._resetForTesting();
    mocks.resolve.mockResolvedValue({ command: '/opt/selected/opencode2', major: 2 });
    mocks.spawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      queueMicrotask(() => { proc.stdout.emit('data', '2.0.30'); proc.emit('close', 0); });
      return proc;
    });
  });
  it('reports the selected supported command and version', async () => {
    await expect(CliDetectionService.getInstance().detectOne('opencode')).resolves.toMatchObject({ installed: true, path: '/opt/selected/opencode2', version: '2.0.30' });
    expect(mocks.resolve).toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith('/opt/selected/opencode2', ['--version'], expect.any(Object));
  });
  it('surfaces an unsupported install without claiming it can run', async () => {
    mocks.resolve.mockRejectedValue(new Error('Update OpenCode 2 to at least 2.0.30'));
    await expect(CliDetectionService.getInstance().detectOne('opencode')).resolves.toMatchObject({ installed: false, error: expect.stringContaining('2.0.30') });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
