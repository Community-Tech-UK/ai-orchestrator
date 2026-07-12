import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { additionalPathsMock, existsSyncMock, realpathSyncMock, spawnMock } = vi.hoisted(() => ({
  additionalPathsMock: vi.fn<() => string[]>(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

vi.mock('fs', () => ({
  default: { existsSync: existsSyncMock, realpathSync: realpathSyncMock },
  existsSync: existsSyncMock,
  realpathSync: realpathSyncMock,
}));

vi.mock('../cli-environment', () => ({
  buildCliSpawnOptions: vi.fn(() => ({ env: {} })),
  getCliAdditionalPaths: additionalPathsMock,
}));

vi.mock('../copilot-cli-launch', () => ({
  resolveCopilotCliLaunch: vi.fn(() => null),
}));

function makeVersionProc(version: string) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(`codex-cli ${version}\n`));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

describe('CliDetectionService.scanAllCliInstalls — macOS app bundles', () => {
  const originalPath = process.env['PATH'];
  const originalPlatform = process.platform;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env['PATH'] = '';
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/Applications/ChatGPT.app/Contents/Resources',
    ]);
    existsSyncMock.mockImplementation((path: unknown) => [
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ].includes(String(path)));
    realpathSyncMock.mockImplementation((path: unknown) => String(path));
    spawnMock.mockImplementation((command: string) => makeVersionProc(
      command.includes('ChatGPT.app') ? '0.144.0-alpha.4' : '0.144.1',
    ));

    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = originalPath;
    }
    vi.clearAllMocks();
  });

  it('excludes host-app resources from user-managed CLI installs', async () => {
    const { CliDetectionService } = await import('../cli-detection');

    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('codex');

    expect(installs).toEqual([
      {
        path: '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
        version: '0.144.1',
        installed: true,
        error: undefined,
      },
    ]);
    expect(spawnMock).not.toHaveBeenCalledWith(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not report an app-owned copy as a shadow install', async () => {
    const { CliDetectionService } = await import('../cli-detection');

    const report = await CliDetectionService.getInstance().detectShadowInstalls('codex');

    expect(report).toBeNull();
  });

  it('excludes a user-visible symlink that resolves into an app bundle', async () => {
    additionalPathsMock.mockReturnValue([
      '/Users/test/.nvm/versions/node/v24.15.0/bin',
      '/usr/local/bin',
    ]);
    existsSyncMock.mockImplementation((path: unknown) => [
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
      '/usr/local/bin/codex',
    ].includes(String(path)));
    realpathSyncMock.mockImplementation((path: unknown) =>
      String(path) === '/usr/local/bin/codex'
        ? '/Applications/ChatGPT.app/Contents/Resources/codex'
        : String(path),
    );

    const { CliDetectionService } = await import('../cli-detection');
    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('codex');

    expect(installs.map((install) => install.path)).toEqual([
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
    ]);
  });

  it('does not treat app-shaped paths as bundles on non-macOS platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { CliDetectionService } = await import('../cli-detection');

    const installs = await CliDetectionService.getInstance().scanAllCliInstalls('codex');

    expect(installs.map((install) => install.path)).toEqual([
      '/Users/test/.nvm/versions/node/v24.15.0/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ]);
  });
});
