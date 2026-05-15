import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { spawnMock, existsSyncMock, realpathSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  realpathSyncMock: vi.fn(),
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

function makeFakeProc(exitCode: number) {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CliDetectionService — cursor existsSync fallback', () => {
  beforeEach(async () => {
    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks cursor installed when every --version spawn fails but the binary exists at a known alt path', async () => {
    // Every spawn returns a non-zero exit code with no version in output —
    // simulates the fork-pressure timeout case where --version was killed.
    spawnMock.mockImplementation(() => makeFakeProc(143));

    // /opt/homebrew/bin/cursor-agent absent, /usr/local/bin/cursor-agent absent,
    // ~/.local/bin/cursor-agent present, ~/.cursor/bin/cursor-agent absent.
    existsSyncMock.mockImplementation((p: unknown) => {
      const str = String(p);
      return str.endsWith(`${process.env['HOME']}/.local/bin/cursor-agent`);
    });

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('cursor');
    expect(info.installed).toBe(true);
    expect(info.path).toBe(`${process.env['HOME']}/.local/bin/cursor-agent`);
    // version is undefined because the spawn never produced a match
    expect(info.version).toBeUndefined();
  });

  it('does not fall back when no alternative path contains the binary', async () => {
    spawnMock.mockImplementation(() => makeFakeProc(143));
    existsSyncMock.mockReturnValue(false);

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('cursor');
    expect(info.installed).toBe(false);
  });

  it('prefers a successful --version probe over the existsSync fallback (keeps the parsed version)', async () => {
    // Primary spawn for `cursor-agent` succeeds with a version line.
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('2026.04.28-e984b46\n'));
        proc.emit('close', 0);
      }, 0);
      return proc;
    });
    existsSyncMock.mockReturnValue(true);

    const { CliDetectionService } = await import('../cli-detection');
    const service = CliDetectionService.getInstance();

    const info = await service.detectOne('cursor');
    expect(info.installed).toBe(true);
    expect(info.version).toBe('2026.04.28');
  });
});
