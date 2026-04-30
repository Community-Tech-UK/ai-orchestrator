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
    expect(governor.getConfig().creationPausedAtPressure).toBe('warning');
  });

  it('should report creation allowed at normal pressure', () => {
    expect(governor.isCreationAllowed()).toBe(true);
  });

  it('should block creation at warning pressure', () => {
    mockDeps.getMemoryMonitor().getPressureLevel.mockReturnValue('warning');
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(false);
    expect(governor.getCreationBlockReason()).toBe('memory-warning');
  });

  it('should configure via configure()', () => {
    governor.configure({ maxInstanceMemoryMB: 256 });
    expect(governor.getConfig().maxInstanceMemoryMB).toBe(256);
  });

  // ---------------------------------------------------------------------------
  // Additional coverage
  // ---------------------------------------------------------------------------

  it('should block creation at critical pressure', () => {
    mockDeps.getMemoryMonitor().getPressureLevel.mockReturnValue('critical');
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(false);
    expect(governor.getCreationBlockReason()).toBe('memory-critical');
  });

  it('should block creation when instance count reaches maxTotalInstances', () => {
    mockInstanceManager.getInstanceCount.mockReturnValue(50);
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(false);
    expect(governor.getCreationBlockReason()).toBe('instance-limit');
  });

  it('should emit creation:paused on warning event', () => {
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

    expect(emitted.length).toBe(1);
    expect((emitted[0] as any).reason).toBe('memory-warning');
  });

  it('should emit instances:terminated on critical event when idle instances exist', () => {
    const terminateInstance = vi.fn(() => Promise.resolve());
    const getIdleInstances = vi.fn();
    const idleInstances = [
      { id: 'inst-1', lastActivity: Date.now() - 10 * 60 * 1000 },
      { id: 'inst-2', lastActivity: Date.now() - 6 * 60 * 1000 },
    ];
    getIdleInstances.mockReturnValue(idleInstances);

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
        getInstanceCount: vi.fn(() => 2),
        getIdleInstances,
        terminateInstance,
      }),
      getLogger: () => mockLogger,
    } as any);

    const terminatedEvents: unknown[] = [];
    g.on('instances:terminated', (data) => terminatedEvents.push(data));
    g.start();

    const criticalHandlers = capturedHandlers['critical'];
    expect(criticalHandlers?.length).toBeGreaterThan(0);
    criticalHandlers[0]({ heapUsedMB: 1600, heapTotalMB: 2048, externalMB: 0, rssMB: 0, percentUsed: 78 });

    expect(getIdleInstances).toHaveBeenCalledWith(0);
    expect(terminateInstance).toHaveBeenCalledWith('inst-1', true);
    expect(terminateInstance).toHaveBeenCalledWith('inst-2', true);
    expect(terminatedEvents.length).toBe(1);
    expect((terminatedEvents[0] as any).count).toBe(2);
  });

  it('should resume creation when normal event fires after warning', () => {
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

    // Trigger warning to pause
    capturedHandlers['warning'][0]({ heapUsedMB: 1100, heapTotalMB: 2048, externalMB: 0, rssMB: 0, percentUsed: 54 });
    expect(g.isCreationAllowed()).toBe(false);

    // Trigger normal to resume
    const resumedEvents: unknown[] = [];
    g.on('creation:resumed', () => resumedEvents.push(true));
    capturedHandlers['normal'][0]();
    expect(g.isCreationAllowed()).toBe(true);
    expect(resumedEvents.length).toBe(1);
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
