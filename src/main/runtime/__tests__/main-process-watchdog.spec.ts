import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Worker } from 'node:worker_threads';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

// ── Fake Worker ───────────────────────────────────────────────────────────────

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeWorker(): FakeWorker {
  const emitter = new EventEmitter() as FakeWorker;
  emitter.postMessage = vi.fn();
  emitter.terminate = vi.fn().mockResolvedValue(0);
  return emitter;
}

// ── Fake metrics provider ─────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<Record<string, () => number | boolean>> = {}) {
  return {
    getEventLoopLagP95Ms: () => 1,
    getEventLoopLagMaxMs: () => 2,
    getProviderBusEmitted: () => 10,
    getProviderBusDroppedStatus: () => 0,
    getContextWorkerInFlight: () => 0,
    getContextWorkerDegraded: () => false,
    getIndexWorkerInFlight: () => 0,
    getIndexWorkerDegraded: () => false,
    getActiveInstanceCount: () => 3,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MainProcessWatchdog', () => {
  let fakeWorker: FakeWorker;
  let watchdog: import('../main-process-watchdog').MainProcessWatchdog;
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    fakeWorker = createFakeWorker();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-test-'));

    const { MainProcessWatchdog, _resetMainProcessWatchdogForTesting } = await import('../main-process-watchdog');
    _resetMainProcessWatchdogForTesting();

    watchdog = new MainProcessWatchdog({
      userDataPath: tmpDir,
      appVersion: '1.0.0-test',
      metricsProvider: makeMetrics(),
      workerFactory: () => fakeWorker as unknown as Worker,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    await watchdog.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  it('sends a heartbeat immediately on start', () => {
    watchdog.start();
    const calls = fakeWorker.postMessage.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [msg] = calls[0] as [{ type: string; timestamp: number; metrics: object }];
    expect(msg.type).toBe('heartbeat');
    expect(typeof msg.timestamp).toBe('number');
    expect(msg.metrics).toBeDefined();
  });

  it('sends heartbeat on each interval tick', () => {
    watchdog.start();
    fakeWorker.postMessage.mockClear();

    vi.advanceTimersByTime(3_000);

    // Should have sent ~3 more heartbeats (one per second)
    expect(fakeWorker.postMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops sending heartbeats after stop()', async () => {
    watchdog.start();
    await watchdog.stop();
    const countAfterStop = fakeWorker.postMessage.mock.calls.length;
    fakeWorker.postMessage.mockClear();

    vi.advanceTimersByTime(3_000);
    expect(fakeWorker.postMessage.mock.calls.length).toBe(0);
    void countAfterStop;
  });

  // ── Worker shutdown ───────────────────────────────────────────────────────

  it('sends shutdown message and terminates worker on stop', async () => {
    watchdog.start();
    await watchdog.stop();

    const shutdownCall = fakeWorker.postMessage.mock.calls.find(
      ([m]) => (m as { type: string }).type === 'shutdown',
    );
    expect(shutdownCall).toBeDefined();
    expect(fakeWorker.terminate).toHaveBeenCalled();
  });

  // ── Worker error / degradation ────────────────────────────────────────────

  it('silently stops heartbeats when worker emits error', () => {
    watchdog.start();
    fakeWorker.emit('error', new Error('crash'));

    fakeWorker.postMessage.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(fakeWorker.postMessage.mock.calls.length).toBe(0);
  });
});

// ── readPriorWatchdogReport ───────────────────────────────────────────────────

describe('readPriorWatchdogReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no report file exists', async () => {
    const { readPriorWatchdogReport } = await import('../main-process-watchdog');
    expect(readPriorWatchdogReport(tmpDir)).toBeNull();
  });

  it('reads report and removes file', async () => {
    const { readPriorWatchdogReport } = await import('../main-process-watchdog');
    const reportDir = path.join(tmpDir, 'diagnostics');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, 'watchdog-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      stallDetectedAt: 1234567890,
      lastHeartbeatAt: 1234567000,
      stalledForMs: 890,
      lastMetrics: null,
      appVersion: '1.0.0',
    }), 'utf8');

    const report = readPriorWatchdogReport(tmpDir);
    expect(report).not.toBeNull();
    expect(report!.stalledForMs).toBe(890);
    // File removed after read
    expect(fs.existsSync(reportPath)).toBe(false);
  });

  it('returns null and does not throw on malformed report', async () => {
    const { readPriorWatchdogReport } = await import('../main-process-watchdog');
    const reportDir = path.join(tmpDir, 'diagnostics');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'watchdog-report.json'), 'not-json', 'utf8');

    expect(() => readPriorWatchdogReport(tmpDir)).not.toThrow();
    // Returns null on parse error
    expect(readPriorWatchdogReport(tmpDir)).toBeNull();
  });
});
