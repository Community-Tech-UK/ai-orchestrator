import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { spawnMock, existsSyncMock, realpathSyncMock, additionalPathsMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
  additionalPathsMock: vi.fn<() => string[]>(() => []),
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

function makeFailingProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  // Non-zero exit, no version output — mimics a probe killed under fork pressure.
  setTimeout(() => proc.emit('close', 143), 0);
  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CliDetectionService — Windows install detection', () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    additionalPathsMock.mockReturnValue(['C:\\Users\\u\\AppData\\Roaming\\npm']);
    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.clearAllMocks();
  });

  it('detects an npm-shim (.cmd) install when the bare-command --version probe fails', async () => {
    // Every spawned --version probe fails (bare `claude` not resolvable in the
    // stripped packaged PATH, and the absolute-path probes also get killed).
    spawnMock.mockImplementation(() => makeFailingProc());

    // Only the npm shim exists on disk: %APPDATA%\npm\claude.cmd
    const shim = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
    existsSyncMock.mockImplementation((p: unknown) => String(p) === shim);

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('claude');
    expect(info.installed).toBe(true);
    expect(info.path).toBe(shim);
  });

  it('detects a native-installer (.exe) install under %USERPROFILE%\\.local\\bin', async () => {
    spawnMock.mockImplementation(() => makeFailingProc());
    additionalPathsMock.mockReturnValue(['C:\\Users\\u\\.local\\bin']);

    const exe = 'C:\\Users\\u\\.local\\bin\\claude.exe';
    existsSyncMock.mockImplementation((p: unknown) => String(p) === exe);

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('claude');
    expect(info.installed).toBe(true);
    expect(info.path).toBe(exe);
  });

  it('reports not installed when no candidate exists on disk', async () => {
    spawnMock.mockImplementation(() => makeFailingProc());
    existsSyncMock.mockReturnValue(false);

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('claude');
    expect(info.installed).toBe(false);
  });
});
