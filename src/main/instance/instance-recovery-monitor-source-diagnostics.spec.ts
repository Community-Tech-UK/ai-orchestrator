import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { LogManager } from '../logging/logger';
import { IdleMonitor, type IdleMonitorDeps } from './lifecycle/idle-monitor';
import { observeToolLoopEvent } from './instance-tool-loop-wiring';
import { DoomLoopDetector, getDoomLoopDetector } from '../orchestration/doom-loop-detector';
import { clearInstanceTurnEnding, getInstanceTurnEnding } from './instance-turn-ending-state';
import type { Instance } from '../../shared/types/instance.types';
const state = vi.hoisted(() => ({ manager: null as LogManager | null }));
vi.mock('../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging/logger')>();
  const manager = new actual.LogManager({ enableConsole: false, enableFile: false, globalLevel: 'debug' });
  state.manager = manager;
  return { ...actual, getLogger: (subsystem: string) => manager.getLogger(subsystem) };
});
const source = 'LOCAL_MONITOR_SOURCE_SENTINEL';
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)])) : item);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); DoomLoopDetector._resetForTesting(); clearInstanceTurnEnding('local-instance'); });
describe('native recovery diagnostics actual sink', () => {
  it.each(['tool-interrupt', 'tool-observation', 'dispatch', 'hibernate', 'terminate', 'cleanup', 'idle-tick', 'zombie-tick'] as const)('preserves %s behavior without source logs', async (mode) => {
    const failure = Object.assign(new Error(source), { name: source, code: source, cause: new Error(source), metadata: { source } });
    const packets: string[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) { packets.push(chunk.toString()); queueMicrotask(() => callback(failure)); } });
    stdin.on('error', () => undefined);
    const nativeFailure = () => new Promise<void>((_resolve, reject) => stdin.write(source, (error) => reject(error)));
    state.manager!.clearBuffer();
    const log = vi.spyOn(state.manager!, 'log'); const logError = vi.spyOn(state.manager!, 'logError');
    const instance = { id: 'local-instance', parentId: 'local-parent', status: mode === 'cleanup' ? 'error' : mode === 'dispatch' ? 'busy' : 'idle',
      displayName: source, lastActivity: Date.now() - 600_000, executionLocation: { type: 'local' }, activityState: 'idle',
      outputBuffer: mode === 'hibernate' ? [{ type: 'user', content: source }] : [] } as unknown as Instance;
    const adapter = { isRunning: () => true, terminate: vi.fn(nativeFailure) };
    const dispatchRecovery = vi.fn(nativeFailure); const hibernateInstance = vi.fn(nativeFailure); const terminateInstance = vi.fn(nativeFailure);
    const deleteAdapter = vi.fn(); const queueUpdate = vi.fn();
    const deps: IdleMonitorDeps = {
      getSettings: () => ({ autoTerminateIdleMinutes: mode === 'hibernate' || mode === 'terminate' ? 5 : 0 }),
      getRecoveryEngine: () => ({ handleFailure: vi.fn(async () => ({ status: 'recovered' })) }) as never,
      getActivityDetectors: () => mode === 'dispatch' ? new Map([[instance.id, { detect: vi.fn(async () => ({ state: 'exited' })) } as never]]) : new Map(),
      getInstance: () => instance, forEachInstance: (callback) => callback(instance, instance.id), getAdapter: () => adapter as never,
      queueUpdate, deleteAdapter, transitionState: vi.fn(), dispatchRecovery, hibernateInstance, terminateInstance, isLifecycleLocked: () => false,
    };
    const monitor = new IdleMonitor(deps);
    try {
      if (mode.startsWith('tool-')) {
        const interrupt = vi.fn(() => { throw failure; });
        const setting = mode === 'tool-observation' ? () => { throw failure; } : () => true;
        for (let i = 0; i < 6; i++) {
          observeToolLoopEvent({ getAutoInterruptSetting: setting, interruptInstance: interrupt }, instance.id,
            { kind: 'tool_use', toolName: 'write', toolUseId: `call-${i}`, input: { content: source } });
          observeToolLoopEvent({ getAutoInterruptSetting: setting, interruptInstance: interrupt }, instance.id,
            { kind: 'tool_result', toolName: 'write', toolUseId: `call-${i}`, success: true, output: source });
        }
        if (mode === 'tool-interrupt') { expect(interrupt).toHaveBeenCalledOnce(); expect(getInstanceTurnEnding(instance.id)).toBeDefined(); expect(getDoomLoopDetector().hasAutoInterruptedThisTurn(instance.id)).toBe(true); }
        else expect(interrupt).not.toHaveBeenCalled();
      } else if (mode.endsWith('tick')) {
        vi.useFakeTimers();
        if (mode === 'idle-tick') deps.getRecoveryEngine = () => { throw failure; };
        else deps.forEachInstance = () => { throw failure; };
        monitor.start(10); await vi.advanceTimersByTimeAsync(10); monitor.stop();
        expect(vi.getTimerCount()).toBe(0);
      } else {
        if (mode === 'cleanup') monitor.cleanupZombieProcesses(); else monitor.check();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(packets).toEqual([source]);
        if (mode === 'dispatch') { expect(dispatchRecovery).toHaveBeenCalledWith(instance.id, expect.objectContaining({ category: 'process_exited_unexpected' })); expect(instance.activityState).toBe('exited'); expect(queueUpdate).toHaveBeenCalled(); }
        if (mode === 'hibernate') expect(hibernateInstance).toHaveBeenCalledWith(instance.id);
        if (mode === 'terminate') expect(terminateInstance).toHaveBeenCalledWith(instance.id, true);
        if (mode === 'cleanup') { expect(adapter.terminate).toHaveBeenCalledWith(false); expect(deleteAdapter).toHaveBeenCalledWith(instance.id); }
      }
      expect(failure.message).toBe(source); expect(failure.cause.message).toBe(source);
      const expected = { 'tool-interrupt': 'Auto-interrupt after critical tool loop failed', 'tool-observation': 'Tool loop observation failed', dispatch: 'Recovery action dispatch failed', hibernate: 'Auto-hibernate failed', terminate: 'Auto-terminate failed', cleanup: 'Error during force cleanup', 'idle-tick': 'Idle check tick failed', 'zombie-tick': 'Zombie cleanup tick failed' }[mode];
      const rows = state.manager!.getRecentLogs(); expect(rows.some((row) => row.message === expected)).toBe(true);
      expect(serialize(rows)).not.toContain(source); expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(source);
    } finally { monitor.stop(); stdin.destroy(); }
  });
});
