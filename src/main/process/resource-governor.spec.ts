import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceGovernor } from './resource-governor';
import type { MemoryPressureLevel } from '../memory/memory-monitor';

describe('ResourceGovernor', () => {
  let governor: ResourceGovernor;

  // Stable mock objects — returned by reference so mockReturnValue calls persist
  const mockMonitor = {
    on: vi.fn(),
    off: vi.fn(),
    requestGC: vi.fn(() => true),
    getPressureLevel: vi.fn((): MemoryPressureLevel => 'normal'),
  };
  const mockInstanceManager = {
    on: vi.fn(),
    getInstanceCount: vi.fn(() => 3),
    getIdleInstances: vi.fn(() => []),
    terminateInstance: vi.fn(),
  };
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };

  const mockDeps = {
    getMemoryMonitor: () => mockMonitor,
    getInstanceManager: () => mockInstanceManager,
    getLogger: () => mockLogger,
  };

  beforeEach(() => {
    // Reset all mocks to default return values before each test
    vi.clearAllMocks();
    mockMonitor.getPressureLevel.mockReturnValue('normal');
    mockInstanceManager.getInstanceCount.mockReturnValue(3);
    mockInstanceManager.getIdleInstances.mockReturnValue([]);

    governor = new ResourceGovernor(mockDeps as any);
  });

  // ---------------------------------------------------------------------------
  // Plan-required tests (from the bigchange spec)
  // ---------------------------------------------------------------------------

  it('should initialize with default config', () => {
    expect(governor.getConfig().maxInstanceMemoryMB).toBe(512);
    expect(governor.getConfig().creationPausedAtPressure).toBe('critical');
  });

  it('should report creation allowed at normal pressure', () => {
    expect(governor.isCreationAllowed()).toBe(true);
  });

  it('should allow creation at warning pressure', () => {
    mockDeps.getMemoryMonitor().getPressureLevel.mockReturnValue('warning');
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(true);
    expect(governor.getCreationBlockReason()).toBeNull();
  });

  it('should configure via configure()', () => {
    governor.configure({ maxInstanceMemoryMB: 256 });
    expect(governor.getConfig().maxInstanceMemoryMB).toBe(256);
  });

  // ---------------------------------------------------------------------------
  // Additional coverage
  // ---------------------------------------------------------------------------

  it('should allow creation at critical pressure', () => {
    mockDeps.getMemoryMonitor().getPressureLevel.mockReturnValue('critical');
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(true);
    expect(governor.getCreationBlockReason()).toBeNull();
  });

  it('should block creation when instance count reaches maxTotalInstances', () => {
    mockInstanceManager.getInstanceCount.mockReturnValue(50);
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(false);
    expect(governor.getCreationBlockReason()).toBe('instance-limit');
  });

  it('should treat maxTotalInstances=0 as unlimited', () => {
    mockInstanceManager.getInstanceCount.mockReturnValue(50);
    governor = new ResourceGovernor(mockDeps as any, { maxTotalInstances: 0 });
    expect(governor.isCreationAllowed()).toBe(true);
    expect(governor.getCreationBlockReason()).toBeNull();
  });

  it('should request GC but not pause creation on warning event', () => {
    // Use a fresh monitor that captures registered handlers
    const capturedHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const capturingMonitor = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!capturedHandlers[event]) capturedHandlers[event] = [];
        capturedHandlers[event].push(handler);
      }),
      off: vi.fn(),
      requestGC: vi.fn(() => true),
      getPressureLevel: vi.fn(() => 'normal' as const),
    };

    const g = new ResourceGovernor({
      ...mockDeps,
      getMemoryMonitor: () => capturingMonitor,
    } as any);
    g.start();

    const emitted: unknown[] = [];
    g.on('creation:paused', (data) => emitted.push(data));

    const warningHandlers = capturedHandlers['warning'];
    expect(warningHandlers?.length).toBeGreaterThan(0);
    warningHandlers[0]({ heapUsedMB: 1100, heapTotalMB: 2048, externalMB: 0, rssMB: 0, percentUsed: 54 });

    expect(capturingMonitor.requestGC).toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(g.isCreationAllowed()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Critical-pressure reclamation
  //
  // Regression guard: `idle` means "waiting for the next user message", which
  // is every healthy session. Reclaiming on that alone once wiped a live deploy
  // session one second after the user sent a message to it.
  // ---------------------------------------------------------------------------

  /** Wire a governor whose critical handler can be fired directly. */
  function makeCriticalHarness(
    idleInstances: { id: string; lastActivity: number; hasConversation?: boolean }[],
    config?: Record<string, unknown>,
  ) {
    const terminateInstance = vi.fn((_id: string, _graceful?: boolean) => Promise.resolve());
    const hibernateInstance = vi.fn((_id: string) => Promise.resolve());
    const emitSystemMessage = vi.fn();
    const getIdleInstances = vi.fn((thresholdMs: number) => {
      const now = Date.now();
      return idleInstances
        .filter((i) => now - i.lastActivity >= thresholdMs)
        .sort((a, b) => a.lastActivity - b.lastActivity);
    });

    const capturedHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const capturingMonitor = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!capturedHandlers[event]) capturedHandlers[event] = [];
        capturedHandlers[event].push(handler);
      }),
      off: vi.fn(),
      requestGC: vi.fn(() => false),
      getPressureLevel: vi.fn(() => 'normal' as const),
    };

    const g = new ResourceGovernor({
      getMemoryMonitor: () => capturingMonitor,
      getInstanceManager: () => ({
        on: vi.fn(),
        getInstanceCount: vi.fn(() => idleInstances.length),
        getIdleInstances,
        terminateInstance,
        hibernateInstance,
        emitSystemMessage,
      }),
      getLogger: () => mockLogger,
    } as any, config as any);

    const terminatedEvents: unknown[] = [];
    g.on('instances:terminated', (data) => terminatedEvents.push(data));
    g.start();

    const fireCritical = () =>
      capturedHandlers['critical'][0]({
        heapUsedMB: 1600, heapTotalMB: 2048, externalMB: 0, rssMB: 0, percentUsed: 78,
      });

    return { g, fireCritical, terminateInstance, hibernateInstance, emitSystemMessage, getIdleInstances, terminatedEvents };
  }

  it('does not capture a heap snapshot unless explicitly opted in', () => {
    const getDiagnosticsDir = vi.fn(() => '/tmp/should-not-be-used');
    delete process.env['HARNESS_HEAP_SNAPSHOT_ON_CRITICAL'];

    const h = makeCriticalHarness([]);
    (h.g as any).deps.getDiagnosticsDir = getDiagnosticsDir;
    h.fireCritical();

    // Snapshotting pauses the isolate for seconds — it must never fire on its own.
    expect(getDiagnosticsDir).not.toHaveBeenCalled();
  });

  it('requests GC at critical, since a jump straight to critical never fires the warning handler', () => {
    const h = makeCriticalHarness([]);
    h.fireCritical();
    // Reaches into the same monitor the governor holds.
    expect((h.g as any).deps.getMemoryMonitor().requestGC).toHaveBeenCalled();
  });

  it('queries idle instances using the configured threshold, never 0', () => {
    const h = makeCriticalHarness([]);
    h.fireCritical();
    expect(h.getIdleInstances).toHaveBeenCalledWith(5 * 60 * 1000);
    expect(h.getIdleInstances).not.toHaveBeenCalledWith(0);
  });

  it('never reclaims an instance that was active more recently than the threshold', async () => {
    const h = makeCriticalHarness([
      { id: 'live-session', lastActivity: Date.now() - 1000, hasConversation: true },
    ]);
    h.fireCritical();
    await Promise.resolve();

    expect(h.hibernateInstance).not.toHaveBeenCalled();
    expect(h.terminateInstance).not.toHaveBeenCalled();
    expect(h.terminatedEvents).toHaveLength(0);
  });

  it('hibernates rather than terminates instances holding a conversation', async () => {
    const h = makeCriticalHarness([
      { id: 'has-work', lastActivity: Date.now() - 10 * 60 * 1000, hasConversation: true },
    ]);
    h.fireCritical();
    await Promise.resolve();

    expect(h.hibernateInstance).toHaveBeenCalledWith('has-work');
    expect(h.terminateInstance).not.toHaveBeenCalled();
  });

  it('terminates instances with no conversation to preserve', async () => {
    const h = makeCriticalHarness([
      { id: 'empty', lastActivity: Date.now() - 10 * 60 * 1000, hasConversation: false },
    ]);
    h.fireCritical();
    await Promise.resolve();

    expect(h.terminateInstance).toHaveBeenCalledWith('empty', true);
    expect(h.hibernateInstance).not.toHaveBeenCalled();
  });

  it('leaves a transcript notice so a reclaim is never silent', async () => {
    const h = makeCriticalHarness([
      { id: 'has-work', lastActivity: Date.now() - 10 * 60 * 1000, hasConversation: true },
    ]);
    h.fireCritical();
    await Promise.resolve();

    expect(h.emitSystemMessage).toHaveBeenCalledWith(
      'has-work',
      expect.stringContaining('hibernated'),
      expect.objectContaining({ reason: 'memory-critical' }),
    );
  });

  it('caps reclamation per episode and takes the longest-idle first', async () => {
    const now = Date.now();
    const h = makeCriticalHarness([
      { id: 'newest', lastActivity: now - 6 * 60 * 1000, hasConversation: false },
      { id: 'oldest', lastActivity: now - 60 * 60 * 1000, hasConversation: false },
      { id: 'middle', lastActivity: now - 30 * 60 * 1000, hasConversation: false },
      { id: 'older', lastActivity: now - 45 * 60 * 1000, hasConversation: false },
    ], { maxReclaimsPerCriticalEpisode: 2 });

    h.fireCritical();
    await Promise.resolve();

    expect(h.terminateInstance.mock.calls.map((c) => c[0])).toEqual(['oldest', 'older']);
    expect((h.terminatedEvents[0] as any).count).toBe(2);
  });

  it('does not escalate a failed hibernate into a terminate', async () => {
    const h = makeCriticalHarness([
      { id: 'has-work', lastActivity: Date.now() - 10 * 60 * 1000, hasConversation: true },
    ]);
    h.hibernateInstance.mockRejectedValueOnce(new Error('hibernate failed'));

    h.fireCritical();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.terminateInstance).not.toHaveBeenCalled();
  });

  it('should not emit creation:resumed after advisory warning pressure', () => {
    const capturedHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const capturingMonitor = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!capturedHandlers[event]) capturedHandlers[event] = [];
        capturedHandlers[event].push(handler);
      }),
      off: vi.fn(),
      requestGC: vi.fn(() => true),
      getPressureLevel: vi.fn(() => 'normal' as const),
    };

    const g = new ResourceGovernor({
      ...mockDeps,
      getMemoryMonitor: () => capturingMonitor,
    } as any);
    g.start();

    capturedHandlers['warning'][0]({ heapUsedMB: 1100, heapTotalMB: 2048, externalMB: 0, rssMB: 0, percentUsed: 54 });
    expect(g.isCreationAllowed()).toBe(true);

    const resumedEvents: unknown[] = [];
    g.on('creation:resumed', () => resumedEvents.push(true));
    capturedHandlers['normal'][0]();
    expect(g.isCreationAllowed()).toBe(true);
    expect(resumedEvents.length).toBe(0);
  });

  it('getStats() returns current pressure level and paused state', () => {
    const stats = governor.getStats();
    expect(stats).toHaveProperty('creationPaused');
    expect(stats).toHaveProperty('pressureLevel');
    expect(stats.creationPaused).toBe(false);
    expect(stats.pressureLevel).toBe('normal');
  });

  it('stop() removes event listeners from the monitor', () => {
    const capturingMonitor = {
      on: vi.fn(),
      off: vi.fn(),
      requestGC: vi.fn(),
      getPressureLevel: vi.fn(() => 'normal' as const),
    };
    const g = new ResourceGovernor({
      ...mockDeps,
      getMemoryMonitor: () => capturingMonitor,
    } as any);
    g.start();
    g.stop();
    expect(capturingMonitor.off).toHaveBeenCalledWith('warning', expect.any(Function));
    expect(capturingMonitor.off).toHaveBeenCalledWith('critical', expect.any(Function));
    expect(capturingMonitor.off).toHaveBeenCalledWith('normal', expect.any(Function));
    expect(capturingMonitor.off).toHaveBeenCalledWith('pressure-change', expect.any(Function));
  });
});
