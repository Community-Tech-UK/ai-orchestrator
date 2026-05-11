import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted spawn mock ────────────────────────────────────────────────────────

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

vi.mock('../cli-environment', () => ({
  buildCliSpawnOptions: vi.fn(() => ({ env: {} })),
  getCliAdditionalPaths: vi.fn(() => []),
}));

vi.mock('../copilot-cli-launch', () => ({
  resolveCopilotCliLaunch: vi.fn(() => ({ command: 'copilot', argsPrefix: [], displayCommand: 'copilot' })),
  getDefaultCopilotCliLaunch: vi.fn(() => ({ command: 'copilot', argsPrefix: [], displayCommand: 'copilot' })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => proc.emit('close', 1), 0);
  return proc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CliDetectionService — in-flight deduplication', () => {
  let service: import('../cli-detection').CliDetectionService;

  beforeEach(async () => {
    spawnMock.mockImplementation(() => makeFakeProc());
    const { CliDetectionService } = await import('../cli-detection');
    CliDetectionService._resetForTesting();
    service = CliDetectionService.getInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('concurrent detectAll(false) calls share one underlying scan', async () => {
    // Measure how many spawn calls one sequential scan requires
    await service.detectAll(false);
    const singleScanCalls = spawnMock.mock.calls.length;
    service.clearCache();
    spawnMock.mockClear();

    const [r1, r2] = await Promise.all([
      service.detectAll(false),
      service.detectAll(false),
    ]);

    // Both calls resolve to the same object reference
    expect(r1).toBe(r2);

    // Two concurrent calls should not spawn more than one scan's worth
    expect(spawnMock.mock.calls.length).toBeLessThanOrEqual(singleScanCalls);
  });

  it('concurrent detectAll(true) calls share one forced scan', async () => {
    // Measure how many spawn calls one sequential scan requires
    await service.detectAll(true);
    const singleScanCalls = spawnMock.mock.calls.length;
    spawnMock.mockClear();

    const [r1, r2] = await Promise.all([
      service.detectAll(true),
      service.detectAll(true),
    ]);

    expect(r1).toBe(r2);
    expect(spawnMock.mock.calls.length).toBeLessThanOrEqual(singleScanCalls);
  });

  it('returns cached result without spawning when cache is fresh', async () => {
    // Prime the cache
    await service.detectAll(false);
    spawnMock.mockClear();

    // Second call should hit cache
    await service.detectAll(false);
    expect(spawnMock.mock.calls.length).toBe(0);
  });

  it('clearCache causes the next detectAll to run a fresh scan', async () => {
    await service.detectAll(false);
    spawnMock.mockClear();

    service.clearCache();
    await service.detectAll(false);

    expect(spawnMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('normal and forced in-flight are tracked independently', async () => {
    const normalPromise = service.detectAll(false);
    const forcedPromise = service.detectAll(true);

    // They should not be the same promise
    expect(normalPromise).not.toBe(forcedPromise);

    await Promise.all([normalPromise, forcedPromise]);
  });
});
