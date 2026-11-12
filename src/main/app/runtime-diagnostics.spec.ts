import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: vi.fn(() => '/harness') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: { on: vi.fn() },
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../observation', () => ({ getObservationIngestor: vi.fn() }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: vi.fn() }));
vi.mock('../process/hibernation-manager', () => ({ getHibernationManager: vi.fn() }));
vi.mock('../process/pool-manager', () => ({ getPoolManager: vi.fn() }));
vi.mock('../runtime/main-process-watchdog', () => ({ readPriorWatchdogReport: vi.fn() }));
vi.mock('../runtime/system-load-monitor', () => ({ getSystemLoadMonitor: vi.fn() }));
vi.mock('../logging/renderer-heartbeat-monitor', () => ({ getRendererHeartbeatMonitor: vi.fn() }));
vi.mock('../runtime/event-loop-lag-monitor', () => ({ getEventLoopLagMonitor: vi.fn() }));
vi.mock('../instance/context-worker-client', () => ({ getContextWorkerClient: vi.fn() }));
vi.mock('../codemem', () => ({ getCodemem: vi.fn() }));

import { installChatToolUsageLog, startMainProcessCpuSampler } from './runtime-diagnostics';

const MINUTE = 60_000;

describe('startMainProcessCpuSampler', () => {
  let cpuMicros: number;
  let coresPerMinute: number[];
  const log = { info: vi.fn(), warn: vi.fn() };

  /** Advances one sample with the main process using `cores` over the minute. */
  const minute = (cores: number): void => {
    coresPerMinute.push(cores);
    cpuMicros += cores * MINUTE * 1000;
    vi.advanceTimersByTime(MINUTE);
  };

  const start = () => startMainProcessCpuSampler({
    cpuUsage: () => ({ user: cpuMicros, system: 0 }),
    now: () => Date.now(),
    readActivity: () => ({ activeChats: coresPerMinute.length }),
    log,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    cpuMicros = 0;
    coresPerMinute = [];
    log.info.mockReset();
    log.warn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays quiet while use is at or under half a core', () => {
    const sampler = start();
    for (let i = 0; i < 10; i++) minute(0.5);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(sampler.samples().at(-1)?.cores).toBeCloseTo(0.5);
    sampler.stop();
  });

  it('does not warn when a busy run is broken before five minutes', () => {
    const sampler = start();
    [1, 1, 1, 1, 0.1, 1, 1, 1, 1].forEach(minute);
    expect(log.warn).not.toHaveBeenCalled();
    sampler.stop();
  });

  it('warns once after five busy minutes with average, peak and the busiest minute activity, then logs recovery', () => {
    const sampler = start();
    [0.8, 0.9, 1.5, 0.7].forEach(minute);
    expect(log.warn).not.toHaveBeenCalled();

    minute(0.6);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Main process CPU stayed high', expect.objectContaining({
      averageCores: 0.9,
      peakCores: 1.5,
      minutes: 5,
      busiestMinuteActivity: { activeChats: 3 },
      latestActivity: { activeChats: 5 },
    }));

    [2, 0.9, 0.9].forEach(minute);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();

    minute(0.2);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('Main process CPU back to normal', expect.objectContaining({
      coresNow: 0.2,
      peakCores: 2,
      busyForMinutes: 8,
    }));

    for (let i = 0; i < 5; i++) minute(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
    sampler.stop();
  });

  it('stop clears the timer', () => {
    const sampler = start();
    expect(vi.getTimerCount()).toBe(1);
    sampler.stop();
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 6; i++) minute(2);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('installChatToolUsageLog', () => {
  it('logs per-chat tool counts by name on removal, without arguments, deduping repeated tool ids', () => {
    const source = new EventEmitter();
    const log = { info: vi.fn() };
    installChatToolUsageLog(source, log);
    const toolUse = (instanceId: string, toolName: string, toolUseId?: string) =>
      source.emit('provider:normalized-event', {
        instanceId,
        event: { kind: 'tool_use', toolName, toolUseId, input: { query: 'private text' } },
      });

    toolUse('chat-1', 'mcp__atlassian__search', 't1');
    toolUse('chat-1', 'mcp__atlassian__search', 't1');
    toolUse('chat-1', 'mcp__atlassian__get_issue', 't2');
    toolUse('chat-1', 'Bash', 't3');
    toolUse('chat-2', 'Read');
    source.emit('provider:normalized-event', { instanceId: 'chat-1', event: { kind: 'output', content: 'x' } });

    source.emit('instance:removed', 'chat-1');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith('Chat tool use summary', {
      instanceId: 'chat-1',
      toolCalls: 3,
      helperToolCalls: 2,
      helperServers: { atlassian: 2 },
      tools: { 'mcp__atlassian__search': 1, 'mcp__atlassian__get_issue': 1, Bash: 1 },
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('private text');

    source.emit('instance:removed', 'chat-1');
    source.emit('instance:removed', 'chat-unknown');
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
