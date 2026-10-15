import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeepAwakeState } from '@contracts/schemas/observability';
import type { InstanceManager } from '../instance/instance-manager';

const mocks = vi.hoisted(() => ({
  mode: 'while-working' as KeepAwakeState['mode'],
  queueWork: false,
  loops: [] as { status: string }[],
  held: new Set<number>(),
  updates: [] as KeepAwakeState[],
}));
const settings = Object.assign(new EventEmitter(), { get: () => mocks.mode });
const monitor = new EventEmitter();
vi.mock('electron', () => ({
  powerMonitor: { on: (...args: Parameters<EventEmitter['on']>) => monitor.on(...args),
    removeListener: (...args: Parameters<EventEmitter['removeListener']>) => monitor.removeListener(...args) },
  powerSaveBlocker: { start: () => { mocks.held.add(7); return 7; }, stop: (id: number) => mocks.held.delete(id) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, state: KeepAwakeState) => mocks.updates.push(state) } }] },
}));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => settings }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ getActiveLoops: () => mocks.loops }) }));
vi.mock('../plan-queue/plan-queue-bootstrap', () => ({ getPlanQueueStoreIfInitialized: () => ({ hasActiveWork: () => mocks.queueWork }) }));
import { KeepAwakeService, getKeepAwakeService } from './keep-awake-service';
import { initializeKeepAwakeRuntime } from './keep-awake-runtime';

describe('keep-awake runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers(); mocks.mode = 'while-working'; mocks.queueWork = false; mocks.loops = [];
    mocks.held.clear(); mocks.updates = []; settings.removeAllListeners(); monitor.removeAllListeners();
  });
  afterEach(() => { KeepAwakeService._resetForTesting(); vi.useRealTimers(); });
  const initialize = () => initializeKeepAwakeRuntime({ getAllInstances: () => [] } as unknown as InstanceManager);
  it('keeps idle-session queue verification awake, excludes paused loops, and applies Off immediately', () => {
    mocks.queueWork = true; mocks.loops = [{ status: 'provider-limit' }]; initialize();
    expect(mocks.held.size).toBe(1); expect(getKeepAwakeService().getState().reason).toBe('plan-queue');
    mocks.mode = 'off'; settings.emit('setting:keepAwakeMode', 'off');
    expect(mocks.held.size).toBe(0); expect(mocks.updates.at(-1)?.active).toBe(false);
  });
  it('rechecks at resume and removes subscriptions at shutdown', () => {
    initialize(); mocks.loops = [{ status: 'running' }]; monitor.emit('resume');
    expect(getKeepAwakeService().getState().reason).toBe('loop');
    getKeepAwakeService().shutdown(); expect(monitor.listenerCount('resume')).toBe(0);
    expect(settings.listenerCount('setting:keepAwakeMode')).toBe(0);
    monitor.emit('resume'); expect(mocks.held.size).toBe(0);
  });
});
