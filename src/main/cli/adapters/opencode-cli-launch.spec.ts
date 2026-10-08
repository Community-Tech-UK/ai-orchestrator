import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectOpenCodeLaunch } from './opencode-cli-launch';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('./opencode-effective-budget-config', () => ({ runOpenCodeCapture: mocks.capture }));

describe('OpenCode CLI selection', () => {
  const params = { workingDirectory: '/tmp', env: {}, candidates: ['/opt/old/opencode', '/Applications/OpenCode.app/Contents/Resources/opencode-cli'] };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capture.mockImplementation(async (call: { command: string; args: string[] }) => {
      if (call.command.endsWith('/old/opencode')) return { code: 1, stdout: '' };
      if (call.args[0] === '--version') return { code: 0, stdout: 'opencode v2.0.18\n' };
      return { code: 0, stdout: '[]' };
    });
  });

  it('skips a CLI that cannot print config and uses the next install', async () => {
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({
      command: '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
      major: 2,
    });
    expect(mocks.capture.mock.calls.map(([call]) => [call.command, call.args])).toEqual([
      ['/opt/old/opencode', ['debug', 'config']],
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', ['debug', 'config']],
      ['/Applications/OpenCode.app/Contents/Resources/opencode-cli', ['--version']],
    ]);
  });

  it('keeps the first CLI that prints a config document', async () => {
    mocks.capture.mockImplementation(async (call: { args: string[] }) => (
      call.args[0] === '--version' ? { code: 0, stdout: '1.18.35\n' } : { code: 0, stdout: '{}' }
    ));
    await expect(selectOpenCodeLaunch(params)).resolves.toEqual({ command: '/opt/old/opencode', major: 1 });
  });

  it('refuses startup when every install fails the config read', async () => {
    mocks.capture.mockResolvedValue({ code: 1, stdout: '' });
    await expect(selectOpenCodeLaunch(params)).rejects.toThrow(/^Unable to resolve OpenCode model limits safely; refusing to replace native configuration\.$/);
  });
});
