import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import { InstanceCommunicationManager } from './instance-communication';
import { InterruptRespawnHandler, type InterruptRespawnDeps } from './lifecycle/interrupt-respawn-handler';
import { getSessionAdmissionService, _resetSessionAdmissionServiceForTesting } from '../session/session-admission-service';
import { SessionAdmissionStore } from '../session/session-admission-store';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import { getLogManager } from '../logging/logger';
const database = vi.hoisted(() => ({ db: null as unknown as SqliteDriver }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => database.db }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));
vi.mock('../session/session-turn-supervisor', () => ({ getOrCreateTurnSupervisor: () => ({ recordAdapterSetup: vi.fn(), recordInterrupt: vi.fn(), recordTurnEnd: vi.fn() }) }));
it.each(['failed-zero', 'accepted-zero', 'accepted-stop', 'accepted-stop-response'] as const)('full main Stop settlement preserves receipt and disarms forced cancellation for %s', async (scenario) => {
  getLogManager().updateConfig({ enableConsole: false, enableFile: false });
  database.db = new Database(':memory:') as unknown as SqliteDriver;
  SessionAdmissionStore._resetForTesting();
  _resetSessionAdmissionServiceForTesting();
  const dir = mkdtempSync(join(tmpdir(), 'codex-main-native-'));
  const file = join(dir, 'fixture.cjs');
  const stopped = scenario === 'accepted-stop' || scenario === 'accepted-stop-response';
  const hasNativeResponse = scenario === 'accepted-zero' || scenario === 'accepted-stop-response';
  writeFileSync(file, scenario === 'failed-zero' ? String.raw`require('node:fs').closeSync(0);setTimeout(()=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'LOCAL_PRIOR_ANSWER'}})+'\n');},80);` : String.raw`let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{process.stderr.write('LOCAL_ACK='+Buffer.byteLength(prompt)+'\n');` + (stopped ? (scenario === 'accepted-stop-response' ? String.raw`const timer=setInterval(()=>{},1000);process.on('SIGINT',()=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'LOCAL_ACCEPTED_ANSWER'}})+'\n');clearInterval(timer);});` : `setInterval(()=>{},1000);`) : String.raw`process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'LOCAL_ACCEPTED_ANSWER'}})+'\n');`) + `});`);
  const adapter = new CodexCliAdapter({ workingDir: dir, timeout: 1000 });
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  const access = adapter as unknown as {
    config: {
      command: string;
      args: string[];
    };
    spawnProcess(args: string[]): ChildProcess;
  };
  access.config.command = process.execPath;
  access.config.args = [file];
  const spawn = access.spawnProcess.bind(adapter);
  const children: ChildProcess[] = [];
  const nativeErrors: Error[] = [];
  let stderr = '';
  access.spawnProcess = args => { const child = spawn(args); children.push(child); child.stdin!.on('error', error => nativeErrors.push(error)); child.stderr!.on('data', chunk => stderr += chunk.toString()); return child; };
  const instance = { id: 'exec-main-' + scenario, provider: 'codex', status: 'idle', sessionId: adapter.getSessionId(), parentId: null, adapterGeneration: 1, restartEpoch: 0, requestCount: 3, lastActivity: 0, errorCount: 0, outputBuffer: [], contextUsage: { used: 0, total: 100000 } } as unknown as Instance;
  let recoveries = 0;
  const providerErrors: unknown[] = [];
  const statuses: string[] = [];
  const complete = vi.fn();
  const turnErrors = vi.fn();
  adapter.on('status', s => statuses.push(s));
  adapter.on('complete', complete);
  adapter.on('turn_error', turnErrors);
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => { recoveries++; }, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined, emitProviderRuntimeEvent: (_id, event) => {
      if (event.kind === 'error')
        providerErrors.push(event);
    }, onInterruptSettled: id => handler.noteInterruptSettled(id)
  });
  const handler = new InterruptRespawnHandler({ getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => undefined, queueUpdate: () => undefined, markInterrupted: (id: string) => { manager.markInterrupted(id); }, clearInterrupted: (id: string) => { manager.clearInterrupted(id); }, addToOutputBuffer: () => undefined, setupAdapterEvents: () => undefined, transitionState: (_instance: Instance, status: InstanceStatus) => { instance.status = status; }, getAdapterRuntimeCapabilities: () => adapter.getRuntimeCapabilities(), resolveCliTypeForInstance: async () => 'codex', getMcpConfig: () => [], getPermissionHookPath: () => undefined, waitForResumeHealth: async () => true, waitForAdapterWritable: async () => true, buildReplayContinuityMessage: () => '', buildFallbackHistory: async () => '', applyRecoveryRespawn: async () => { recoveries++; throw new Error('LOCAL_UNEXPECTED_RECOVERY'); }, emitOutput: () => undefined } satisfies InterruptRespawnDeps);
  manager.setupAdapterEvents(instance.id, adapter);
  try {
    const pending = manager.sendInput(instance.id, scenario === 'failed-zero' ? 'X'.repeat(2 * 1024 * 1024) : 'LOCAL_PROMPT').then(() => ({ ok: true }), error => ({ ok: false, error }));
    if (stopped) {
      await vi.waitFor(() => expect(stderr).toContain('LOCAL_ACK=12'));
      vi.useFakeTimers();
      expect(handler.interrupt(instance.id, 'renderer-ipc')).toBe(true);
      expect(instance.status).toBe('interrupting');
    }
    const result = await pending;
    if (stopped)
      await vi.advanceTimersByTimeAsync(30001);
    const rows = getSessionAdmissionService().listAdmissions({ instanceId: instance.id });
    expect(children).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(recoveries).toBe(0);
    if (hasNativeResponse) {
      expect(result.ok).toBe(true);
      expect(rows[0].state).toBe('delivered');
      expect(rows[0].deliveredAt).not.toBeNull();
      expect(complete).toHaveBeenCalledOnce();
      expect(instance.outputBuffer.some(message => message.content === 'LOCAL_ACCEPTED_ANSWER')).toBe(true);
    }
    else {
      expect(result.ok).toBe(false);
      expect(rows[0]).toMatchObject({ state: 'failed', deliveredAt: null });
      expect(complete).not.toHaveBeenCalled();
      expect(instance.outputBuffer.some(message => message.content === 'LOCAL_PRIOR_ANSWER')).toBe(false);
    }
    if (scenario === 'failed-zero') {
      expect(children[0].exitCode).toBe(0);
      expect(nativeErrors).toHaveLength(1);
      if ('error' in result)
        expect(result.error).toBe(nativeErrors[0]);
      expect(turnErrors).toHaveBeenCalledOnce();
    }
    if (scenario === 'accepted-stop-response') {
      expect(children[0].exitCode).toBe(0);
      expect(statuses).toEqual(['busy', 'idle']);
      expect(instance.status).toBe('idle');
      expect(instance.respawnPromise).toBeUndefined();
      expect(turnErrors).not.toHaveBeenCalled();
      expect(providerErrors).toHaveLength(0);
    }
    if (scenario === 'accepted-stop') {
      expect(children[0].signalCode).toBe('SIGINT');
      if ('error' in result)
        expect(result.error.name).toBe('AbortError');
      expect(statuses).toEqual(['busy']);
      expect(instance.status).toBe('idle');
      expect(instance.lastTurnOutcome).toBe('interrupted');
      expect(instance.interruptPhase).toBe('completed');
      expect(instance.respawnPromise).toBeUndefined();
      expect(turnErrors).not.toHaveBeenCalled();
      expect(providerErrors).toHaveLength(0);
    }
  }
  finally {
    vi.useRealTimers();
    handler.noteInterruptSettled(instance.id);
    manager.cleanupCircuitBreaker(instance.id);
    await adapter.terminate(false);
    _resetSessionAdmissionServiceForTesting();
    SessionAdmissionStore._resetForTesting();
    database.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
