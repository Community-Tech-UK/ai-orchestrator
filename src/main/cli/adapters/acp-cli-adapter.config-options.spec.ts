import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { AcpJsonRpcRequest } from '../../../shared/types/cli.types';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'opencode/mimo-v2.6-flash-free',
  options: [
    { value: 'opencode/mimo-v2.6-flash-free', name: 'Free' },
    { value: 'xiaomi-token-plan-ams/mimo-v2.6-pro', name: 'Pro' },
  ],
};
const EFFORT_OPTION = {
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'low',
  options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
};

function configWrites(proc: FakeAcpProcess): Array<{ configId: unknown; value: unknown }> {
  return proc.receivedMessages
    .filter((message): message is AcpJsonRpcRequest =>
      'method' in message && message.method === 'session/set_config_option')
    .map((message) => {
      const params = message.params as Record<string, unknown>;
      expect(params['sessionId']).toBe('sess-acp-1');
      return { configId: params['configId'], value: params['value'] };
    });
}

function systemLines(adapter: TestAcpCliAdapter): string[] {
  const lines: string[] = [];
  adapter.on('output', (message: OutputMessage) => {
    if (message.type === 'system') lines.push(message.content);
  });
  return lines;
}

/** Harness whose `session/new` advertises the free model and answers config writes like OpenCode. */
function openCodeLikeHarness(options: { rejectModel?: boolean } = {}): FakeAcpProcess {
  const proc = createInitializedAgentHarness();
  let current = MODEL_OPTION.currentValue;
  const optionList = () => [
    { ...MODEL_OPTION, currentValue: current },
    ...(current.startsWith('xiaomi-') ? [EFFORT_OPTION] : []),
  ];
  proc.onRequest('session/new', (message) => {
    proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: optionList() });
  });
  proc.onRequest('session/set_config_option', (message) => {
    const params = message.params as { configId: string; value: string };
    if (params.configId === 'model') {
      if (options.rejectModel) {
        proc.respondError(message.id, -32602, `Invalid params: model not found: ${params.value}`);
        return;
      }
      current = params.value;
    }
    proc.respond(message.id, { configOptions: optionList() });
  });
  return proc;
}

describe('AcpCliAdapter session config options', () => {
  it('writes model then effort after session/new', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      sessionConfig: { model: 'xiaomi-token-plan-ams/mimo-v2.6-pro', effort: 'high' },
    });
    const lines = systemLines(adapter);

    await adapter.spawn();

    expect(configWrites(proc)).toEqual([
      { configId: 'model', value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
      { configId: 'effort', value: 'high' },
    ]);
    expect(lines).toEqual([]);
    proc.exit();
  });

  it('skips effort when the selected model offers none, with one warning line', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      sessionConfig: { effort: 'high' },
    });
    const lines = systemLines(adapter);

    await expect(adapter.spawn()).resolves.toBe(4242);

    expect(configWrites(proc)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Did not set effort "high"');
    proc.exit();
  });

  it('warns and continues when the requested model is not offered', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      sessionConfig: { model: 'sonnet' },
    });
    const lines = systemLines(adapter);

    await expect(adapter.spawn()).resolves.toBe(4242);

    expect(configWrites(proc)).toEqual([]);
    expect(lines[0]).toContain('Did not set model "sonnet"');
    expect(lines[0]).toContain("The agent's own default is used instead.");
    expect(adapter.getSessionId()).toBe('sess-acp-1');
    proc.exit();
  });

  it('warns and continues when the agent rejects set_config_option', async () => {
    const proc = openCodeLikeHarness({ rejectModel: true });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      sessionConfig: { model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
    });
    const lines = systemLines(adapter);

    await expect(adapter.spawn()).resolves.toBe(4242);

    expect(configWrites(proc)).toEqual([{ configId: 'model', value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' }]);
    expect(lines[0]).toContain('Could not set model');
    expect(lines[0]).toContain('model not found');
    proc.exit();
  });

  it('validates against the options session/load returns on resume', async () => {
    const proc = openCodeLikeHarness();
    proc.onRequest('session/load', (message) => {
      proc.respond(message.id, { configOptions: [{ ...MODEL_OPTION }] });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'sess-acp-1',
      sessionConfig: { model: 'xiaomi-token-plan-ams/mimo-v2.6-pro', effort: 'medium' },
    });

    await adapter.spawn();

    expect(configWrites(proc)).toEqual([
      { configId: 'model', value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
      { configId: 'effort', value: 'medium' },
    ]);
    proc.exit();
  });

  it('sends writes unvalidated when session/load returns no options', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      resume: true,
      sessionId: 'sess-acp-1',
      sessionConfig: { model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
    });

    await adapter.spawn();

    expect(configWrites(proc)).toEqual([{ configId: 'model', value: 'xiaomi-token-plan-ams/mimo-v2.6-pro' }]);
    proc.exit();
  });

  it('sends nothing when no session config is requested', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    expect(configWrites(proc)).toEqual([]);
    proc.exit();
  });
});

describe('AcpCliAdapter startup gate', () => {
  it('holds the gate from spawn until initialize answers', async () => {
    const proc = createInitializedAgentHarness();
    const events: string[] = [];
    proc.onRequest('initialize', (message) => {
      events.push('initialize-received');
      proc.respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    });
    const startupGate = vi.fn(async () => {
      events.push('gate-acquired');
      return () => events.push('gate-released');
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', startupGate });

    await adapter.spawn();

    expect(events).toEqual(['gate-acquired', 'initialize-received', 'gate-released']);
    proc.exit();
  });

  it('releases the gate when the agent exits before answering initialize', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('initialize', () => {
      proc.exit(1);
    });
    const release = vi.fn();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      startupGate: async () => release,
    });

    await expect(adapter.spawn()).rejects.toThrow('ACP agent exited (1)');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
