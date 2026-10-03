import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { LogManager } from '../logging/logger';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import type { Instance } from '../../shared/types/instance.types';
const state = vi.hoisted(() => ({
  manager: null as LogManager | null
}));
vi.mock('../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging/logger')>();
  const manager = new actual.LogManager({
    enableConsole: false,
    enableFile: false,
    globalLevel: 'debug'
  });
  state.manager = manager;
  return {
    ...actual,
    getLogger: (name: string) => manager.getLogger(name)
  };
});
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn(),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({
      blocked: false
    })
  })
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      outputBufferSize: 100,
      enableDiskStorage: false
    })
  })
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    storeMessages: vi.fn(),
    deleteInstance: vi.fn()
  })
}));
const marker = 'LOCAL_TEST_SOURCE_SENTINEL';
afterEach(() => {
  vi.restoreAllMocks();
  state.manager!.clearBuffer();
});
describe('actual native permission metadata reaches downstream diagnostic boundary', () => {
  it.each(['input-required', 'input-required-object', 'deferred-tool'] as const)('%s preserves native permission and excludes source from communication logger', async (mode) => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        }
      })
    });
    const adapter = new ClaudeCliAdapter({
      workingDirectory: '/tmp',
      residentClaude: true
    });
    vi.spyOn(adapter as unknown as {
      spawnProcess: (args: string[]) => ChildProcess;
    }, 'spawnProcess').mockReturnValue(proc as unknown as ChildProcess);
    adapter.on('error', () => { /* Prevent EventEmitter's fixture error event from throwing. */ });
    const instance = {
      id: 'LOCAL_TEST_INSTANCE',
      provider: 'claude',
      status: 'idle',
      sessionId: null,
      adapterGeneration: 1,
      requestCount: 3,
      restartEpoch: 0,
      lastActivity: 0,
      errorCount: 0,
      contextUsage: {
        used: 0,
        total: 200000
      },
      outputBuffer: []
    } as unknown as Instance;
    const onInterruptedExit = vi.fn().mockResolvedValue(undefined);
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance,
      getAdapter: () => adapter,
      setAdapter: () => undefined,
      deleteAdapter: () => false,
      queueUpdate: () => undefined,
      processOrchestrationOutput: () => undefined,
      onInterruptedExit,
      ingestToRLM: () => undefined,
      ingestToUnifiedMemory: () => undefined
    });
    const permissions: unknown[] = [];
    manager.on('input-required', v => permissions.push(v));
    try {
      await adapter.spawn();
      manager.setupAdapterEvents(instance.id, adapter);
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      if (mode !== 'deferred-tool') {
        const metadataType = mode === 'input-required-object' ? {
          source: marker
        } : marker;
        proc.stdout.write(JSON.stringify({
          type: 'input_required',
          prompt: 'LOCAL_HUMAN_PERMISSION',
          metadata: {
            type: metadataType
          }
        }) + '\n');
        expect(permissions).toHaveLength(1);
        expect((permissions[0] as {
          metadata: {
            type: string;
          };
          prompt: string;
        }).metadata.type).toEqual(metadataType);
        expect((permissions[0] as {
          prompt: string;
        }).prompt).toBe('LOCAL_HUMAN_PERMISSION');
      } else {
        proc.stdout.write(JSON.stringify({
          type: 'result',
          stop_reason: 'tool_deferred',
          deferred_tool_use: {
            name: marker,
            id: 'LOCAL_TOOL_ID',
            input: {
              local: true
            }
          },
          session_id: 'LOCAL_SESSION'
        }) + '\n');
        expect(permissions).toHaveLength(1);
        expect(adapter.getDeferredToolUse()?.toolName).toBe(marker);
        expect((permissions[0] as {
          prompt: string;
        }).prompt.includes(marker)).toBe(true);
        proc.emit('exit', 0, null);
        proc.emit('close', 0);
        expect(onInterruptedExit).not.toHaveBeenCalled();
        expect(state.manager!.getRecentLogs().some(r => r.message.includes('skipping respawn'))).toBe(true);
      }
      const rows = state.manager!.getRecentLogs();
      const sourceInSink = JSON.stringify(rows).includes(marker), sourceInRawArguments = JSON.stringify(log.mock.calls).includes(marker);
      expect(sourceInSink).toBe(false);
      expect(sourceInRawArguments).toBe(false);
    } finally {
      manager.cleanupCircuitBreaker(instance.id);
      proc.emit('exit', 0, null);
      proc.emit('close', 0);
      adapter.removeAllListeners();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
});
