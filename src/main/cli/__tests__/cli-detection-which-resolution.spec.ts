import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { spawnMock, spawnSyncMock, existsSyncMock, realpathSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { spawn: spawnMock, spawnSync: spawnSyncMock },
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock('fs', () => ({
  default: { existsSync: existsSyncMock, realpathSync: realpathSyncMock },
  existsSync: existsSyncMock,
  realpathSync: realpathSyncMock,
}));

vi.mock('../cli-environment', () => ({
  buildCliSpawnOptions: vi.fn(() => ({ env: {} })),
  getCliAdditionalPaths: vi.fn(() => []),
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

function makeFailingProc(exitCode: number) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => proc.emit('close', exitCode), 0);
  return proc;
}

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
    proc.stdout.emit('data', Buffer.from(`${version}\n`));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

const RESOLVED_AGY = '/custom/tools/agy';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CliDetectionService — which/where resolution', () => {
  beforeEach(async () => {
    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('detects agy at a non-standard path via `which` when the bare spawn fails', async () => {
    // Bare `agy --version` fails (stripped PATH); the same probe against the
    // which-resolved absolute path succeeds.
    spawnMock.mockImplementation((command: string) =>
      command === RESOLVED_AGY ? makeVersionProc('1.4.2') : makeFailingProc(127),
    );
    // `which agy` returns a dir that is NOT one of the hardcoded alt paths.
    spawnSyncMock.mockReturnValue({ status: 0, stdout: `${RESOLVED_AGY}\n`, stderr: '' });
    // Only the which-resolved path exists on disk.
    existsSyncMock.mockImplementation((p: unknown) => String(p) === RESOLVED_AGY);

    const { CliDetectionService } = await import('../cli-detection');
    const info = await CliDetectionService.getInstance().detectOne('antigravity');

    expect(info.installed).toBe(true);
    expect(info.path).toBe(RESOLVED_AGY);
    expect(info.version).toBe('1.4.2');
  });

  it('stays unavailable when `which` finds nothing and no alt path has the binary', async () => {
    spawnMock.mockImplementation(() => makeFailingProc(127));
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'not found' });
    existsSyncMock.mockReturnValue(false);

    const { CliDetectionService } = await import('../cli-detection');
    const info = await CliDetectionService.getInstance().detectOne('antigravity');

    expect(info.installed).toBe(false);
  });

  it('never breaks detection when the resolver itself throws', async () => {
    spawnMock.mockImplementation(() => makeFailingProc(127));
    spawnSyncMock.mockImplementation(() => {
      throw new Error('which is unavailable');
    });
    existsSyncMock.mockReturnValue(false);

    const { CliDetectionService } = await import('../cli-detection');
    // Should resolve (not reject) and report not-installed rather than crash.
    const info = await CliDetectionService.getInstance().detectOne('antigravity');

    expect(info.installed).toBe(false);
  });
});
