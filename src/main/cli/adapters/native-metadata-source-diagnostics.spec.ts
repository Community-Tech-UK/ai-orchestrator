import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { LogManager } from '../../logging/logger';
import { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../../cli/adapters/acp-cli-adapter.test-helpers';
import { attachUsageOverageStopGuard, configureUsageOverageStop, resetUsageOverageStopForTesting } from '../../instance/instance-usage-overage-wiring';
import type { UsageOverageStopDeps } from '../../instance/instance-usage-overage-wiring';
import type { InstanceProviderLimitHandlerDeps } from '../../instance/instance-provider-limit-handler';
import { InstanceProviderLimitHandler } from '../../instance/instance-provider-limit-handler';
const state = vi.hoisted(() => ({
  manager: null as LogManager | null
}));
vi.mock('../../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/logger')>();
  state.manager = new actual.LogManager({
    enableConsole: false,
    enableFile: false,
    globalLevel: 'debug'
  });
  return {
    ...actual,
    getLogger: (name: string) => state.manager!.getLogger(name)
  };
});
const marker = 'LOCAL_TIED_SOURCE_SENTINEL';
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map(key => [key, Reflect.get(item, key)])) : item);
}
afterEach(() => {
  vi.restoreAllMocks();
  state.manager!.clearBuffer();
  resetUsageOverageStopForTesting();
});
describe('native cumulative diagnostics and real overage parking', () => {
  it.each(['totalTokens', 'inputTokens', 'outputTokens'].flatMap(field => ['string', 'array'].map(shape => ({
    field,
    shape
  }))))('retains two native turns with malformed $field/$shape but protects warning counters', async ({ field, shape }) => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp'
    });
    const usage = {
      [field]: shape === 'string' ? marker : [marker]
    };
    let turn = 0;
    proc.onRequest('session/prompt', packet => {
      turn++;
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'LOCAL_NATIVE_ANSWER_' + turn
          }
        }
      });
      proc.respond(packet.id, {
        stopReason: 'end_turn',
        usage: turn === 1 ? usage : {
          costUsd: 0.01
        }
      });
    });
    try {
      await adapter.spawn();
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      const contexts: unknown[] = [];
      adapter.on('context', value => contexts.push(value));
      const first = await adapter.sendMessage({
        role: 'user',
        content: 'LOCAL_PROMPT_1'
      });
      const second = await adapter.sendMessage({
        role: 'user',
        content: 'LOCAL_PROMPT_2'
      });
      expect(first.content).toBe('LOCAL_NATIVE_ANSWER_1');
      expect(second.content).toBe('LOCAL_NATIVE_ANSWER_2');
      expect(first.usage?.[field as 'totalTokens' | 'inputTokens' | 'outputTokens']).toEqual(usage[field]);
      expect(contexts).toHaveLength(1);
      expect(serialize(contexts)).toContain(marker);
      expect(proc.receivedMessages.filter(p => 'method' in p && p.method === 'session/prompt')).toHaveLength(2);
      const rows = state.manager!.getRecentLogs();
      expect(rows.some(row => row.message === 'ACP turn reported no token usage where usage was expected')).toBe(true);
      expect(serialize(rows)).not.toContain(marker);
      expect(serialize(log.mock.calls)).not.toContain(marker);
    } finally {
      proc.exit();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
  it.each([false, true])('keeps original telemetry/hold reason and exact park controls with auto-resume=%s', async (autoResume) => {
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
    const handler = new InstanceProviderLimitHandler();
    const wait = vi.fn(), resend = vi.fn(), schedule = vi.fn<NonNullable<InstanceProviderLimitHandlerDeps['scheduleResume']>>(() => () => undefined), notice = vi.fn(), interrupt = vi.fn(() => true);
    handler.configure({
      isEnabled: () => autoResume,
      setWaitReason: wait,
      resendInput: resend,
      getQuotaSnapshot: () => null,
      getWorkspaceCwd: () => '/tmp',
      getProviderModel: () => ({
        provider: 'claude',
        model: null
      }),
      emitSystemMessage: notice,
      scheduleResume: schedule
    });
    const hold = vi.fn<UsageOverageStopDeps['holdOnUsageLimit']>((id, signal) => {
      handler.maybeParkOnUsageLimit({
        instanceId: id,
        ...signal
      });
    });
    configureUsageOverageStop({
      getAllowOverageSetting: () => false,
      interruptInstance: interrupt,
      holdOnUsageLimit: hold
    });
    const teardown = attachUsageOverageStopGuard(adapter, 'LOCAL_OVERAGE_INSTANCE');
    const telemetry: unknown[] = [];
    adapter.on('rate-limit-telemetry', value => telemetry.push(value));
    adapter.on('error', () => undefined);
    try {
      await adapter.spawn();
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      const info = {
        status: 'rejected',
        rateLimitType: marker,
        resetsAt: Math.ceil((Date.now() + 60000) / 1000)
      };
      proc.stdout.write(JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: info
      }) + '\n');
      expect(telemetry).toEqual([info]);
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(hold).toHaveBeenCalledTimes(1);
      expect(hold.mock.calls[0][1].reason).toContain(marker);
      expect(handler.isParked('LOCAL_OVERAGE_INSTANCE')).toBe(true);
      expect(wait).toHaveBeenCalledWith('LOCAL_OVERAGE_INSTANCE', {
        kind: 'quota-park',
        provider: 'claude',
        resumeAt: info.resetsAt * 1000
      });
      expect(resend).not.toHaveBeenCalled();
      expect(schedule).toHaveBeenCalledTimes(autoResume ? 1 : 0);
      expect(notice).toHaveBeenCalledTimes(1);
      if (autoResume)
        expect(schedule.mock.calls[0][0].request.reason).toBe(hold.mock.calls[0][1].reason);
      const rows = state.manager!.getRecentLogs();
      expect(rows.some(row => row.subsystem === 'InstanceProviderLimitHandler' && row.message.includes('window reset'))).toBe(true);
      expect(rows.some(row => row.message === 'Stopped session on usage-overage telemetry')).toBe(true);
      expect(serialize(rows)).not.toContain(marker);
      expect(serialize(log.mock.calls)).not.toContain(marker);
    } finally {
      teardown();
      handler._resetForTesting();
      proc.emit('exit', 0, null);
      proc.emit('close', 0);
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
});
describe('complete native diagnostic payloads', () => {
  it.each(['allowed', 'rejected'].flatMap(status => ['string', 'array', 'object', 'number'].map(shape => ({
    status,
    shape
  }))))('keeps $status reset telemetry with $shape reset while projecting log numbers', async ({ status, shape }) => {
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
    const telemetry: unknown[] = [], output: unknown[] = [];
    adapter.on('rate-limit-telemetry', value => telemetry.push(value));
    adapter.on('output', value => output.push(value));
    adapter.on('error', () => undefined);
    const resetsAt = shape === 'number' ? 123 : shape === 'string' ? marker : shape === 'array' ? [marker] : {
      source: marker
    };
    const info = {
      status,
      resetsAt,
      rateLimitType: 'LOCAL_WINDOW',
      overageStatus: 'LOCAL_OVERAGE'
    };
    try {
      await adapter.spawn();
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      const logError = vi.spyOn(state.manager!, 'logError');
      proc.stdout.write(JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: info
      }) + '\n');
      proc.stdout.write(JSON.stringify({
        type: 'system',
        content: 'LOCAL_FOLLOWUP'
      }) + '\n');
      expect(telemetry).toEqual([info]);
      expect(adapter.getLastRateLimitInfo()).toEqual(info);
      expect(serialize(output)).toContain('LOCAL_FOLLOWUP');
      const rows = state.manager!.getRecentLogs();
      const diagnostic = rows.find(row => row.message === (status === 'allowed' ? 'Rate limit telemetry' : 'Provider rate limit active'));
      expect(diagnostic).toBeDefined();
      expect(diagnostic!.data?.['resetsAt']).toBe(shape === 'number' ? status === 'allowed' ? 123 : 123000 : undefined);
      expect(serialize(rows)).not.toContain(marker);
      expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(marker);
    } finally {
      proc.emit('exit', 0, null);
      proc.emit('close', 0);
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
  it.each([false, true])('counts arbitrary usage keys while preserving native turns with prior measured usage=%s', async (measuredFirst) => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp'
    });
    let turn = 0;
    proc.onRequest('session/prompt', packet => {
      turn++;
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'LOCAL_ANSWER_' + turn
          }
        }
      });
      proc.respond(packet.id, {
        stopReason: 'end_turn',
        usage: measuredFirst && turn === 1 ? {
          inputTokens: 4,
          outputTokens: 5,
          totalTokens: 9
        } : {
          [marker]: {
            source: marker
          },
          costUsd: 0.01
        }
      });
    });
    try {
      await adapter.spawn();
      state.manager!.clearBuffer();
      const log = vi.spyOn(state.manager!, 'log');
      const logError = vi.spyOn(state.manager!, 'logError');
      const first = await adapter.sendMessage({
        role: 'user',
        content: 'LOCAL_PROMPT'
      });
      expect(first.content).toBe('LOCAL_ANSWER_1');
      if (measuredFirst)
        expect((await adapter.sendMessage({
          role: 'user',
          content: 'LOCAL_PROMPT_2'
        })).content).toBe('LOCAL_ANSWER_2');
      expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/prompt')).toHaveLength(measuredFirst ? 2 : 1);
      const rows = state.manager!.getRecentLogs();
      const diagnostic = rows.find(row => row.message === (measuredFirst ? 'ACP turn reported no token usage where usage was expected' : 'ACP turn reported no token usage; context bar stays empty for this session'));
      expect(diagnostic).toBeDefined();
      expect(diagnostic!.data?.['usageKeyCount']).toBe(2);
      expect(diagnostic!.data).not.toHaveProperty('usageKeys');
      if (measuredFirst)
        expect(diagnostic!.data?.['cumulativeTokens']).toBe(9);
      expect(serialize(rows)).not.toContain(marker);
      expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(marker);
    } finally {
      proc.exit();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
    }
  });
  it('keeps the generic logger positive control source-bearing', () => {
    state.manager!.getLogger('LOCAL_GENERIC_CONTROL').warn('LOCAL_CONTROL', {
      source: marker
    });
    expect(serialize(state.manager!.getRecentLogs())).toContain(marker);
  });
});
