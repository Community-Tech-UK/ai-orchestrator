import { afterEach, expect, it, vi } from 'vitest';
import type { LogManager } from '../../logging/logger';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { OutputMessage } from '../../../shared/types/instance.types';
const state = vi.hoisted(() => ({ manager: null as LogManager | null }));
vi.mock('../../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/logger')>();
  const manager = new actual.LogManager({ enableConsole: false, enableFile: false, globalLevel: 'debug' });
  state.manager = manager;
  return { ...actual, getLogger: (name: string) => manager.getLogger(name) };
});
const SOURCE = 'LOCAL_STARTUP_SOURCE_SENTINEL';
const MODEL = 'xiaomi-token-plan/mimo-v2.6-pro';
afterEach(() => { vi.restoreAllMocks(); state.manager!.clearBuffer(); });
it.each([false, true])('keeps native rejected effort warning and budget=%s outside diagnostic logs', async (budgeted) => {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/set_config_option', request => {
    const params = request.params as {
      configId: string;
      value: string;
    };
    if (params.configId === 'model')
      proc.respond(request.id, null);
    else
      proc.respondError(request.id, -32602, SOURCE);
  });
  proc.onRequest('session/prompt', request => {
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LOCAL_NATIVE_ANSWER' } } });
    proc.respond(request.id, { stopReason: 'end_turn' });
  });
  const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', model: MODEL, sessionConfig: { model: MODEL, effort: 'high' }, ...(budgeted ? { generationBudget: { model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false as const } } : {}) });
  const output: OutputMessage[] = [];
  const statuses: string[] = [];
  adapter.on('output', message => output.push(message));
  adapter.on('status', status => statuses.push(status));
  const logs = vi.spyOn(state.manager!, 'log');
  try {
    await adapter.spawn();
    expect(statuses).toContain('ready');
    expect(output).toContainEqual(expect.objectContaining({ type: 'system', content: `Could not set effort "high": ACP session/set_config_option failed: ${SOURCE} (-32602) The agent's own default is used instead.` }));
    const response = await adapter.sendMessage({ role: 'user', content: 'LOCAL_NATIVE_PROMPT' });
    expect(response.content).toBe('LOCAL_NATIVE_ANSWER');
    expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/set_config_option').map(packet => 'params' in packet ? packet.params : undefined)).toEqual([{ sessionId: 'sess-acp-1', configId: 'model', value: MODEL }, { sessionId: 'sess-acp-1', configId: 'effort', value: 'high' }]);
    expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/prompt')).toHaveLength(1);
    if (budgeted)
      expect(response.metadata?.['generationBudget']).toEqual({ model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false });
    expect(state.manager!.getRecentLogs()).toContainEqual(expect.objectContaining({ message: 'ACP session config not fully applied', data: { adapter: 'opencode-acp', warningCount: 1 } }));
    expect(JSON.stringify(state.manager!.getRecentLogs())).not.toContain(SOURCE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(SOURCE);
  }
  finally {
    proc.exit();
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
  }
});
it.each(['supported', 'unsupported', 'missing-control'] as const)('preserves native config and human %s selection with metadata-only logs', async (scenario) => {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/new', request => proc.respond(request.id, { sessionId: 'sess-acp-1', configOptions: scenario === 'missing-control' ? [] : [{ id: 'model', category: 'model', currentValue: 'LOCAL_DEFAULT_MODEL', options: [{ value: scenario === 'supported' ? SOURCE : 'LOCAL_OTHER_MODEL' }] }] }));
  proc.onRequest('session/set_config_option', request => proc.respond(request.id, null));
  proc.onRequest('session/prompt', request => proc.respond(request.id, { stopReason: 'end_turn' }));
  const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', sessionConfig: { model: SOURCE } });
  const output: OutputMessage[] = [];
  adapter.on('output', message => output.push(message));
  const logs = vi.spyOn(state.manager!, 'log');
  try {
    await expect(adapter.spawn()).resolves.toBe(4242);
    await adapter.sendMessage({ role: 'user', content: 'LOCAL_PROMPT' });
    const writes = proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/set_config_option');
    if (scenario === 'supported') {
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ params: { configId: 'model', value: SOURCE } });
      expect(output.filter(message => message.type === 'system')).toEqual([]);
    }
    else {
      expect(writes).toEqual([]);
      expect(output.some(message => message.type === 'system' && message.content.includes(SOURCE) && message.content.includes("The agent's own default is used instead."))).toBe(true);
      expect(state.manager!.getRecentLogs()).toContainEqual(expect.objectContaining({ message: 'ACP session config not fully applied', data: { adapter: 'opencode-acp', warningCount: 1 } }));
    }
    expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/prompt')).toHaveLength(1);
    expect(JSON.stringify(state.manager!.getRecentLogs())).not.toContain(SOURCE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(SOURCE);
  }
  finally {
    proc.exit();
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
  }
});
it('retains fail-closed native budget model selection without a prompt or leaked rejection', async () => {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/set_config_option', request => proc.respondError(request.id, -32602, SOURCE));
  const adapter = new TestAcpCliAdapter(proc, { adapterName: 'opencode-acp', workingDirectory: '/tmp', generationBudget: { model: MODEL, combinedOutputTokens: 1024, reasoningBudgetSupported: false }, sessionConfig: { model: MODEL } });
  const statuses: string[] = [];
  adapter.on('status', status => statuses.push(status));
  const logs = vi.spyOn(state.manager!, 'log');
  try {
    await expect(adapter.spawn()).rejects.toThrow('Unable to confirm the selected model');
    expect(statuses).not.toContain('ready');
    expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/set_config_option')).toHaveLength(1);
    expect(proc.receivedMessages.filter(packet => 'method' in packet && packet.method === 'session/prompt')).toEqual([]);
    expect(JSON.stringify(state.manager!.getRecentLogs())).not.toContain(SOURCE);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(SOURCE);
  }
  finally {
    proc.exit();
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
  }
});
