import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { spawnMock, existsSyncMock, realpathSyncMock, additionalPathsMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  additionalPathsMock: vi.fn<() => string[]>(() => ['C:\\Users\\User/.local/bin']),
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
  buildCliSpawnOptions: vi.fn(() => ({ env: {}, shell: true })),
  getCliAdditionalPaths: additionalPathsMock,
}));

vi.mock('../copilot-cli-launch', () => ({
  resolveCopilotCliLaunch: vi.fn(() => ({
    command: 'copilot',
    argsPrefix: [],
    displayCommand: 'copilot',
  })),
  getDefaultCopilotCliLaunch: vi.fn(() => ({
    command: 'copilot',
    argsPrefix: [],
    displayCommand: 'copilot',
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    proc.stdout.emit('data', Buffer.from(`${version} (Claude Code)\n`));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

function makeFailingProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => proc.emit('close', 143), 0);
  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CliDetectionService.scanAllCliInstalls — Windows .exe-only install', () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    additionalPathsMock.mockReturnValue(['C:\\Users\\User/.local/bin']);
    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.clearAllMocks();
  });

  it('finds claude when only `claude.exe` exists (no extensionless shim)', async () => {
    // Native installer layout: `claude.exe` present, bare `claude` absent.
    existsSyncMock.mockImplementation((p: unknown) =>
      String(p) === 'C:\\Users\\User/.local/bin/claude.exe',
    );
    realpathSyncMock.mockImplementation((p: unknown) => String(p));
    spawnMock.mockImplementation(() => makeVersionProc('2.1.195'));

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const installs = await service.scanAllCliInstalls('claude');
    expect(installs).toHaveLength(1);
    expect(installs[0]?.path).toBe('C:\\Users\\User/.local/bin/claude.exe');
    expect(installs[0]?.version).toBe('2.1.195');
    expect(installs[0]?.installed).toBe(true);
  });

  it('reports a single install per directory when both bare and .exe exist', async () => {
    // npm-style trio plus an .exe in the same dir must not become 3 installs.
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === 'C:\\Users\\User/.local/bin/claude'
        || s === 'C:\\Users\\User/.local/bin/claude.exe';
    });
    realpathSyncMock.mockImplementation((p: unknown) => String(p));
    spawnMock.mockImplementation(() => makeVersionProc('2.1.195'));

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const installs = await service.scanAllCliInstalls('claude');
    // The Windows executable wins over the POSIX shell stub → exactly one entry, not three.
    expect(installs).toHaveLength(1);
    expect(installs[0]?.path).toBe('C:\\Users\\User/.local/bin/claude.exe');
  });

  it('quotes active Program Files shims and ranks them before stale nvm version dirs', async () => {
    additionalPathsMock.mockReturnValue([
      'C:\\Program Files\\nodejs',
      'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0',
    ]);
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === 'C:\\Program Files\\nodejs/claude.cmd'
        || s === 'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0/claude.cmd';
    });
    realpathSyncMock.mockImplementation((p: unknown) => String(p));
    spawnMock.mockImplementation((command: string) => {
      const version = command.includes('Program Files') ? '2.1.183' : '2.1.100';
      return makeVersionProc(version);
    });

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const installs = await service.scanAllCliInstalls('claude');

    expect(spawnMock).toHaveBeenCalledWith(
      '"C:\\Program Files\\nodejs/claude.cmd"',
      ['--version'],
      expect.objectContaining({ shell: true }),
    );
    expect(installs.map((install) => install.path)).toEqual([
      'C:\\Program Files\\nodejs/claude.cmd',
      'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0/claude.cmd',
    ]);
    expect(installs.map((install) => install.version)).toEqual(['2.1.183', '2.1.100']);
  });

  it('keeps an existing active Program Files shim first even when its version probe fails', async () => {
    additionalPathsMock.mockReturnValue([
      'C:\\Program Files\\nodejs',
      'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0',
    ]);
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return s === 'C:\\Program Files\\nodejs/claude.cmd'
        || s === 'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0/claude.cmd';
    });
    realpathSyncMock.mockImplementation((p: unknown) => String(p));
    spawnMock.mockImplementation((command: string) =>
      command.includes('Program Files') ? makeFailingProc() : makeVersionProc('2.1.100'),
    );

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const installs = await service.scanAllCliInstalls('claude');

    expect(installs).toHaveLength(2);
    expect(installs[0]).toMatchObject({
      path: 'C:\\Program Files\\nodejs/claude.cmd',
      installed: true,
    });
    expect(installs[0]?.version).toBeUndefined();
    expect(installs[1]).toMatchObject({
      path: 'C:\\Users\\User\\AppData\\Roaming\\nvm\\v22.10.0/claude.cmd',
      installed: true,
      version: '2.1.100',
    });
  });
});
