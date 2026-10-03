import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { LogManager } from '../logging/logger';
import { ClaudeCliAdapter } from '../cli/adapters/claude-cli-adapter';
import { observeToolLoopEvent } from '../instance/instance-tool-loop-wiring';
import { toProviderOutputEvent } from '../providers/provider-output-event';
import { DoomLoopDetector, getDoomLoopDetector } from '../orchestration/doom-loop-detector';
import { clearInstanceTurnEnding, getInstanceTurnEnding } from '../instance/instance-turn-ending-state';
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
const { mockTraceSink, mockRecordSpan, mockContinuity, mockRecordProviderThreadCompactionMarker, mockRecordLifecycleTrace, mockCrossModelReview, } = vi.hoisted(() => ({
  mockTraceSink: {
    enqueue: vi.fn()
  },
  mockRecordSpan: vi.fn(),
  mockContinuity: {
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    addConversationEntry: vi.fn(),
    patchConversationEntry: vi.fn(async () => true)
  },
  mockRecordProviderThreadCompactionMarker: vi.fn(),
  mockRecordLifecycleTrace: vi.fn(),
  mockCrossModelReview: {
    bufferMessage: vi.fn(),
    onInstanceIdle: vi.fn().mockResolvedValue(undefined),
    cancelPendingReviews: vi.fn(),
    on: vi.fn()
  }
}));
vi.mock('../observability/provider-runtime-trace-sink', () => ({
  getProviderRuntimeTraceSink: vi.fn(() => mockTraceSink)
}));
vi.mock('../observability/otel-spans', () => ({
  recordProviderRuntimeEventSpan: mockRecordSpan
}));
vi.mock('../observability/lifecycle-trace', () => ({
  recordLifecycleTrace: mockRecordLifecycleTrace
}));
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManager: vi.fn(() => mockContinuity)
}));
vi.mock('../app/compaction-runtime', () => ({
  recordProviderThreadCompactionMarker: mockRecordProviderThreadCompactionMarker
}));
vi.mock('../observability', () => ({}));
vi.mock('../observability/otel-setup', () => ({
  getOrchestratorTracer: vi.fn(() => ({
    startSpan: vi.fn(() => ({
      end: vi.fn()
    }))
  }))
}));
vi.mock('../context/compaction-coordinator', () => ({
  getCompactionCoordinator: vi.fn(() => ({
    cleanupInstance: vi.fn(),
    onContextUpdate: vi.fn()
  }))
}));
vi.mock('../context/context-window-guard', () => ({
  evaluateContextWindowGuard: vi.fn(() => ({
    shouldWarn: false,
    allowed: true
  }))
}));
vi.mock('../orchestration/cross-model-review-service', () => ({
  getCrossModelReviewService: vi.fn(() => mockCrossModelReview)
}));
vi.mock('../orchestration/debate-coordinator', () => ({
  getDebateCoordinator: vi.fn(() => ({}))
}));
vi.mock('../orchestration/orchestration-activity-bridge', () => ({
  getOrchestrationActivityBridge: vi.fn(() => ({
    initialize: vi.fn()
  }))
}));
vi.mock('../orchestration/multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: vi.fn(() => ({}))
}));
vi.mock('../memory/memory-monitor', () => ({
  getMemoryMonitor: vi.fn(() => ({
    on: vi.fn()
  }))
}));
const mockObserverClearPrompt = vi.hoisted(() => vi.fn());
vi.mock('../remote/observer-server', () => ({
  getRemoteObserverServer: vi.fn(() => ({
    publishInstanceState: vi.fn(),
    publishInstanceOutput: vi.fn(),
    recordPrompt: vi.fn(),
    clearPrompt: mockObserverClearPrompt
  }))
}));
vi.mock('../repo-jobs', () => ({
  getRepoJobService: vi.fn(() => ({
    on: vi.fn()
  }))
}));
vi.mock('../process/load-balancer', () => ({
  getLoadBalancer: vi.fn(() => ({
    removeMetrics: vi.fn(),
    updateMetrics: vi.fn()
  }))
}));
vi.mock('../workflows/workflow-manager', () => ({
  getWorkflowManager: vi.fn(() => ({
    cleanupInstance: vi.fn()
  }))
}));
vi.mock('../state', () => ({
  getAppStore: vi.fn(),
  setGlobalState: vi.fn()
}));
import { setupInstanceEventForwarding } from '../app/instance-event-forwarding';
import { NotificationService } from '../notifications/notification-service';
const forwardingState = vi.hoisted(() => ({
  auto: false,
  notification: null as import('../notifications/notification-service').NotificationService | null
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => key === 'toolLoopAutoInterrupt' ? forwardingState.auto : undefined,
    getAll: () => ({})
  })
}));
vi.mock('../notifications/notification-service', async (original) => {
  const actual = await original<typeof import('../notifications/notification-service')>();
  return {
    ...actual,
    getNotificationService: () => forwardingState.notification!
  };
});
const marker = 'LOCAL_TEST_SOURCE_SENTINEL';
afterEach(() => {
  vi.restoreAllMocks();
  state.manager!.clearBuffer();
  DoomLoopDetector._resetForTesting();
  clearInstanceTurnEnding('LOCAL_LOOP_INSTANCE');
});
describe('actual native tool names through manager output bridge and loop detector', () => {
  it.each([false, true])('retains human native tool identity while protecting diagnostics with global interruption=%s', async (autoInterrupt) => {
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
    forwardingState.auto = autoInterrupt;
    forwardingState.notification = new NotificationService({
      desktop: {
        isSupported: () => true,
        show: () => undefined
      }
    });
    const renderer = vi.fn();
    const manager = Object.assign(new EventEmitter(), {
      getInstance: () => null,
      getOrchestrationHandler: () => new EventEmitter()
    });
    setupInstanceEventForwarding({
      instanceManager: manager as unknown as import('../instance/instance-manager').InstanceManager,
      windowManager: {
        sendToRenderer: renderer
      } as unknown as import('../window-manager').WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined
    });
    const outputs: import('../../shared/types/instance.types').OutputMessage[] = [];
    const interrupt = vi.fn(() => true);
    const detections: import('../orchestration/doom-loop-detector').ToolLoopDetectionEvent[] = [];
    getDoomLoopDetector().on('tool-loop-detected', v => detections.push(v));
    adapter.on('output', message => {
      outputs.push(message);
      observeToolLoopEvent({
        getProvider: () => 'claude',
        getAutoInterruptSetting: () => autoInterrupt,
        interruptInstance: interrupt
      }, 'LOCAL_LOOP_INSTANCE', toProviderOutputEvent(message));
    });
    adapter.on('error', () => { /* Prevent EventEmitter's fixture error event from throwing. */ });
    try {
      await adapter.spawn();
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      for (let i = 0; i < 6; i++) {
        proc.stdout.write(JSON.stringify({
          type: 'tool_use',
          tool: {
            id: 'LOCAL_LOOP_TOOL_' + i,
            name: marker,
            input: {
              local: true
            }
          }
        }) + '\n');
        proc.stdout.write(JSON.stringify({
          type: 'tool_result',
          tool_use_id: 'LOCAL_LOOP_TOOL_' + i,
          content: 'LOCAL_IDENTICAL_RESULT'
        }) + '\n');
      }
      expect(outputs.filter(m => m.type === 'tool_use')).toHaveLength(6);
      expect(outputs.filter(m => m.type === 'tool_use').every(m => m.metadata?.['name'] === marker)).toBe(true);
      expect(detections.some(d => d.severity === 'critical' && d.toolName === marker)).toBe(true);
      expect(interrupt).toHaveBeenCalledTimes(autoInterrupt ? 1 : 0);
      expect(getDoomLoopDetector().hasAutoInterruptedThisTurn('LOCAL_LOOP_INSTANCE')).toBe(autoInterrupt);
      if (autoInterrupt)
        expect(getInstanceTurnEnding('LOCAL_LOOP_INSTANCE')).toBe('doom_loop');
      expect(renderer.mock.calls.some(([channel, event]) => channel === 'instance:doom-loop' && event.toolName === marker && event.severity === 'critical')).toBe(true);
      expect(forwardingState.notification!.list().some(record => record.body.includes(marker) && record.fingerprint.includes(marker))).toBe(true);
      const rows = state.manager!.getRecentLogs();
      expect(rows.some(row => row.message === 'Forwarding tool loop detection to renderer')).toBe(true);
      expect(rows.some(r => r.subsystem === 'DoomLoopDetector' && r.message === 'Tool loop critical')).toBe(true);
      const sourceInSink = JSON.stringify(rows).includes(marker), sourceInRawArguments = JSON.stringify(log.mock.calls).includes(marker);
      expect(sourceInSink).toBe(false);
      expect(sourceInRawArguments).toBe(false);
    } finally {
      forwardingState.notification!.dispose();
      proc.emit('exit', 0, null);
      proc.emit('close', 0);
      adapter.removeAllListeners();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
});
