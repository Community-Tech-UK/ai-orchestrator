import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import { Writable } from 'stream';

vi.mock('./base-cli-process-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('./base-cli-process-utils')>(),
  killProcessGroup: vi.fn(() => true),
}));

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
    { value: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro', name: 'Account B' },
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

function holdPreparation(): { promise: Promise<void>; resolve: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}

/** Harness whose `session/new` advertises the free model and answers config writes like OpenCode. */
function openCodeLikeHarness(options: { rejectModel?: boolean } = {}): FakeAcpProcess {
  const proc = createInitializedAgentHarness();
  let current = MODEL_OPTION.currentValue;
  let effort = EFFORT_OPTION.currentValue;
  const optionList = () => [
    { ...MODEL_OPTION, currentValue: current },
    ...(current.startsWith('xiaomi-') ? [{ ...EFFORT_OPTION, currentValue: effort }] : []),
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
    } else if (params.configId === 'effort') {
      effort = params.value;
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

describe('AcpCliAdapter live account switch (MiMo multi-account)', () => {
  it('retains a separately confirmed effort while an earlier model write is still pending', async () => {
    const proc = createInitializedAgentHarness();
    const target = 'aio-mimo-max-b-1a2b/mimo-v2.6-pro';
    let model = MODEL_OPTION.currentValue;
    let effort = 'low';
    const options = () => [{ ...MODEL_OPTION, currentValue: model }, { ...EFFORT_OPTION, currentValue: effort }];
    proc.onRequest('session/new', (request) => proc.respond(request.id, { sessionId: 'sess-acp-1', configOptions: options() }));
    const pendingModel = holdPreparation();
    proc.onRequest('session/set_config_option', async (request) => {
      const params = request.params as { configId: string; value: string };
      if (params.configId === 'model') { await pendingModel.promise; model = params.value; }
      else effort = params.value;
      proc.respond(request.id, { configOptions: options() });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    const switching = adapter.applyLiveSessionConfig({ model: target });
    try {
      await adapter.applyLiveSessionConfig({ effort: 'high' });
      pendingModel.resolve();
      await switching;
      expect((adapter as unknown as { acpConfig: { sessionConfig: unknown } }).acpConfig.sessionConfig)
        .toEqual({ model: target, effort: 'high' });
    } finally { pendingModel.resolve(); await switching; proc.exit(); }
  });

  it('applies a new model to the open session without a restart', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      sessionConfig: { model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' },
    });
    await adapter.spawn();

    await adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' });

    const writes = proc.receivedMessages
      .filter((message): message is AcpJsonRpcRequest =>
        'method' in message && message.method === 'session/set_config_option')
      .map((message) => (message.params as Record<string, unknown>)['value']);
    expect(writes).toContain('aio-mimo-max-b-1a2b/mimo-v2.6-pro');
    proc.exit();
  });

  it('retains startup and live responses through A → B → A and restores model-dependent effort', async () => {
    const proc = createInitializedAgentHarness();
    const free = 'opencode/mimo-v2.6-flash-free';
    const a = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
    const b = 'aio-mimo-max-b-1a2b/mimo-v2.6-pro';
    let current = free;
    let effort = 'low';
    const options = () => [
      { ...MODEL_OPTION, currentValue: current },
      ...(current === a ? [{ ...EFFORT_OPTION, currentValue: effort }] : []),
    ];
    proc.onRequest('session/new', (message) => {
      proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() });
    });
    proc.onRequest('session/set_config_option', (message) => {
      const params = message.params as { configId: string; value: string };
      if (params.configId === 'model') { current = params.value; effort = 'low'; }
      else effort = params.value;
      proc.respond(message.id, { configOptions: options() });
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp', sessionConfig: { model: a, effort: 'high' },
    });
    await adapter.spawn();
    await adapter.applyLiveSessionConfig({ model: free });
    expect(current).toBe(free);
    await adapter.applyLiveSessionConfig({ model: a, effort: 'medium' });
    await adapter.applyLiveSessionConfig({ model: b });
    await adapter.applyLiveSessionConfig({ model: a, effort: 'high' });
    expect(current).toBe(a);
    expect(effort).toBe('high');
    expect(configWrites(proc).map((entry) => entry.value)).toEqual([
      a, 'high', free, a, 'medium', b, a, 'high',
    ]);
    proc.exit();
  });

  it('uses configuration notifications for later model and effort decisions', async () => {
    const proc = createInitializedAgentHarness();
    let model = MODEL_OPTION.currentValue;
    let effort = 'low';
    const options = () => [
      { ...MODEL_OPTION, currentValue: model },
      ...(model.startsWith('xiaomi-') ? [{ ...EFFORT_OPTION, currentValue: effort }] : []),
    ];
    proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() }));
    proc.onRequest('session/set_config_option', (message) => {
      const params = message.params as { configId: string; value: string };
      if (params.configId === 'model') model = params.value;
      else effort = params.value;
      proc.respond(message.id, { configOptions: options() });
    });
    const selectPro = () => {
      model = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'config_option_update', configOptions: options(),
      } });
    };
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    selectPro();
    await adapter.applyLiveSessionConfig({ model: MODEL_OPTION.currentValue });
    expect(configWrites(proc)).toEqual([{ configId: 'model', value: MODEL_OPTION.currentValue }]);
    selectPro();
    await adapter.applyLiveSessionConfig({ effort: 'high' });
    expect(configWrites(proc).at(-1)).toEqual({ configId: 'effort', value: 'high' });
    expect(effort).toBe('high');
    proc.exit();
  });

  it.each(['refused', 'refused-notified', 'mismatched', 'mismatched-notified', 'superseded', 'no-option', 'unsupported-value'] as const)(
    'rejects explicit live effort when %s, retaining the previous confirmed config', async (mode) => {
      const proc = createInitializedAgentHarness();
      const target = 'aio-mimo-max-b-1a2b/mimo-v2.6-pro';
      let model = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
      let effort = 'high';
      const options = () => [
        { ...MODEL_OPTION, currentValue: model },
        ...(model === target && mode === 'no-option' ? [] : [{
          ...EFFORT_OPTION, currentValue: effort,
          ...(model === target && mode === 'unsupported-value' ? { options: [{ value: 'low' }] } : {}),
        }]),
      ];
      proc.onRequest('session/new', (message) => proc.respond(message.id, { sessionId: 'sess-acp-1', configOptions: options() }));
      const notify = () => proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'config_option_update', configOptions: options(),
      } });
      proc.onRequest('session/set_config_option', (message) => {
        const params = message.params as { configId: string; value: string };
        if (params.configId === 'model') {
          model = params.value; effort = 'low';
          proc.respond(message.id, { configOptions: options() });
          return;
        }
        if (mode.startsWith('refused')) proc.respondError(message.id, -32602, 'effort refused');
        else {
          effort = mode.startsWith('mismatched') ? 'low' : params.value;
          proc.respond(message.id, { configOptions: options() });
        }
        if (mode.endsWith('notified') || mode === 'superseded') {
          effort = mode === 'superseded' ? 'low' : 'high';
          notify();
        }
      });
      const config = { model, effort: 'high' };
      const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', sessionConfig: config });
      try {
        await adapter.spawn();
        const interrupted = mode === 'refused' ? adapter.sendMessage({ role: 'user', content: 'Interrupted work' }) : undefined;
        if (interrupted) {
          void interrupted.catch(() => undefined);
          await proc.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
        }
        await expect(adapter.applyLiveSessionConfig({ model: target, effort: 'high' })).rejects.toThrow(/did not switch the session effort/);
        if (interrupted) {
          await expect(interrupted).rejects.toThrow(/cancelled by the client/);
          const methods = proc.receivedMessages.filter((message) => 'method' in message).map((message) => (message as AcpJsonRpcRequest).method);
          expect(methods.indexOf('session/cancel')).toBeLessThan(methods.indexOf('session/set_config_option'));
        }
        expect(model).toBe(target); // Native model may change before the rejected effort; caller must respawn.
        expect((adapter as unknown as { acpConfig: { sessionConfig: unknown } }).acpConfig.sessionConfig).toEqual(config);
        expect(configWrites(proc)).toEqual([
          { configId: 'model', value: target },
          ...(['no-option', 'unsupported-value'].includes(mode) ? [] : [{ configId: 'effort', value: 'high' }]),
        ]);
      } finally { proc.exit(); }
    },
  );

  it('accepts effort already selected after the model change without writing it again', async () => {
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/new', (message) => proc.respond(message.id, {
      sessionId: 'sess-acp-1', configOptions: [MODEL_OPTION, EFFORT_OPTION],
    }));
    const target = 'aio-mimo-max-b-1a2b/mimo-v2.6-pro';
    proc.onRequest('session/set_config_option', (message) => proc.respond(message.id, { configOptions: [
      { ...MODEL_OPTION, currentValue: target }, { ...EFFORT_OPTION, currentValue: 'high' },
    ] }));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    try {
      await adapter.spawn();
      await adapter.applyLiveSessionConfig({ model: target, effort: 'high' });
      expect(configWrites(proc)).toEqual([{ configId: 'model', value: target }]);
    } finally { proc.exit(); }
  });

  it('rejects a successful RPC whose authoritative model remains on the old account', async () => {
    const proc = openCodeLikeHarness();
    proc.onRequest('session/set_config_option', (message) => {
      proc.respond(message.id, { configOptions: [MODEL_OPTION] });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    await expect(adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }))
      .rejects.toThrow(/did not switch the session model/);
    proc.exit();
  });

  it('cancels the in-flight turn first: a stuck retry never moves accounts (probe 0.2b)', async () => {
    const proc = openCodeLikeHarness();
    proc.onRequest('session/prompt', () => { /* stuck forever, like a retry loop */ });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'stuck turn' });
    turn.catch(() => undefined);

    await adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' });

    const order = proc.receivedMessages
      .filter((message): message is AcpJsonRpcRequest => 'method' in message)
      .map((message) => message.method);
    expect(order.indexOf('session/cancel')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('session/cancel')).toBeLessThan(
      order.lastIndexOf('session/set_config_option'),
    );
    // The cancelled prompt settles locally as a client cancellation — never a
    // completed turn the accounting could mistake for success (probe 0.2b).
    await expect(turn).rejects.toThrow(/cancelled by the client/i);
    proc.exit();
  });

  it('throws when the agent refuses the model switch, so the caller respawns instead', async () => {
    const proc = openCodeLikeHarness({ rejectModel: true });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();

    await expect(adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }))
      .rejects.toThrow(/did not switch the session model/);
    proc.exit();
  });

  it('refuses a live account switch during prompt preparation before writing configuration', async () => {
    const proc = openCodeLikeHarness();
    const preparation = holdPreparation();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp', beforeProviderPrompt: () => preparation.promise,
    });
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'prepared work' });
    try {
      await expect(adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }))
        .rejects.toThrow(/prompt.*prepar/i);
      expect(configWrites(proc)).toEqual([]);
      expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
    } finally {
      preparation.resolve();
      await turn;
      proc.exit();
    }
  });

  it.each(['exit', 'terminate'] as const)('prevents a held prompt from dispatching after %s', async (retirement) => {
    const proc = openCodeLikeHarness();
    const preparation = holdPreparation();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp', beforeProviderPrompt: () => preparation.promise,
    });
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    await adapter.spawn();
    const turn = adapter.sendMessage({ role: 'user', content: 'retired work' });
    void turn.catch(() => undefined);
    const retiring = retirement === 'terminate' ? adapter.terminate(false) : proc.exit(1);
    preparation.resolve();
    await retiring;
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
    expect(proc.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
    proc.exit();
  });

  it('retains a second-turn write crash and sends first-turn instructions once on its replacement', async () => {
    const proc = openCodeLikeHarness();
    const replacement = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', model: 'fixture-model',
      systemPrompt: 'Crash recovery instructions', rtkEnabled: true });
    const outputs: OutputMessage[] = [];
    adapter.on('output', (message: OutputMessage) => outputs.push(message));
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    replacement.onRequest('session/prompt', (request) => replacement.respond(request.id, { stopReason: 'end_turn' }));
    await adapter.spawn();
    await adapter.sendMessage({ role: 'user', content: 'successful first turn' });
    const firstPrompt = proc.receivedMessages.find((message) => 'method' in message && message.method === 'session/prompt');
    expect(JSON.stringify(firstPrompt)).toContain('Crash recovery instructions');
    expect(JSON.stringify(firstPrompt)).toContain('[RTK AWARENESS]');
    const writes: unknown[] = [];
    const stdin = new Writable({ write(_chunk, _encoding, callback) {
      writes.push(JSON.parse(_chunk.toString()));
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Observed partial work.' },
      } });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'tool_call', toolCallId: 'pending-tool', title: 'Read fixture', kind: 'read', status: 'in_progress',
      } });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'pending-tool', status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'Observed partial tool output.' } }],
      } });
      queueMicrotask(() => { proc.exit(1); callback(); });
    } });
    (proc as unknown as { stdin: Writable }).stdin = stdin;
    const writePhase = { accepted: false, cancelledByClient: false };
    try {
      const failure = await adapter.sendMessage({ role: 'user', content: 'do work' }, undefined, writePhase)
        .then(() => null, (error: unknown) => error);
      expect(writePhase.accepted).toBe(false);
      expect(outputs).toContainEqual(expect.objectContaining({ type: 'assistant', content: 'Observed partial work.',
        metadata: expect.objectContaining({ streaming: true }) }));
      expect(failure).toMatchObject({ code: 'EPIPE', partialModel: 'fixture-model',
        partialUsage: { totalTokens: expect.any(Number), isEstimated: true } });
      expect(outputs).toContainEqual(expect.objectContaining({ type: 'assistant', content: 'Observed partial work.',
        metadata: expect.objectContaining({ streaming: false }) }));
      expect(outputs).toContainEqual(expect.objectContaining({ type: 'tool_result', content: 'Observed partial tool output.' }));
      expect(writes).toHaveLength(1);
      expect(JSON.stringify(writes[0])).not.toContain('Crash recovery instructions');
      expect(JSON.stringify(writes[0])).not.toContain('[RTK AWARENESS]');
      vi.spyOn(adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }, 'spawnProcess')
        .mockReturnValue(replacement as unknown as ChildProcess);
      await adapter.sendMessage({ role: 'user', content: 'first replacement turn' });
      await adapter.sendMessage({ role: 'user', content: 'following replacement turn' });
      const replacementPrompts = replacement.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt');
      expect(replacementPrompts).toHaveLength(2);
      expect(JSON.stringify(replacementPrompts[0])).toContain('Crash recovery instructions');
      expect(JSON.stringify(replacementPrompts[0])).toContain('[RTK AWARENESS]');
      expect(JSON.stringify(replacementPrompts[1])).not.toContain('Crash recovery instructions');
      expect(JSON.stringify(replacementPrompts[1])).not.toContain('[RTK AWARENESS]');
    } finally { proc.exit(); replacement.exit(); }
  });

  it('keeps a replacement turn and its prompt flags when retired preparation resumes on the same adapter', async () => {
    const oldProcess = openCodeLikeHarness();
    const replacement = openCodeLikeHarness();
    const preparation = holdPreparation();
    let preparations = 0;
    const adapter = new TestAcpCliAdapter(oldProcess, {
      workingDirectory: '/tmp', systemPrompt: 'Fixture instructions',
      beforeProviderPrompt: () => ++preparations === 1 ? preparation.promise : Promise.resolve(),
    });
    replacement.onRequest('session/prompt', (request) => {
      const params = request.params as { prompt: { text?: string }[] };
      if (params.prompt.some((block) => block.text === 'retired work')) {
        replacement.respond(request.id, { stopReason: 'end_turn' });
      }
    });
    await adapter.spawn();
    const oldTurn = adapter.sendMessage({ role: 'user', content: 'retired work' });
    void oldTurn.catch(() => undefined);
    await adapter.terminate(false);
    vi.spyOn(adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }, 'spawnProcess')
      .mockReturnValue(replacement as unknown as ChildProcess);
    await adapter.spawn();
    const newTurn = adapter.sendMessage({ role: 'user', content: 'replacement work' });
    const request = await replacement.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
    const statuses: string[] = [];
    adapter.on('status', (status: string) => statuses.push(status));
    try {
      preparation.resolve();
      await expect(oldTurn).rejects.toMatchObject({ name: 'AbortError' });
      expect(oldProcess.receivedMessages.some((message) => 'method' in message && message.method === 'session/prompt')).toBe(false);
      expect(replacement.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt')).toHaveLength(1);
      expect(statuses).toEqual([]);
      expect(adapter.hasActiveTurn()).toBe(true);
      await expect(adapter.sendMessage({ role: 'user', content: 'racing input' })).rejects.toThrow(/previous turn is still running/);
    } finally {
      if ('id' in request && request.id !== null) replacement.respond(request.id, { stopReason: 'end_turn' });
      await newTurn;
      replacement.onRequest('session/prompt', (message) => replacement.respond(message.id, { stopReason: 'end_turn' }));
      await adapter.sendMessage({ role: 'user', content: 'next work' });
      const prompts = replacement.receivedMessages.filter((message): message is AcpJsonRpcRequest =>
        'method' in message && message.method === 'session/prompt');
      expect(prompts.at(-1)?.params).toEqual({ sessionId: 'sess-acp-1', prompt: [{ type: 'text', text: 'next work' }] });
      replacement.exit();
    }
  });

  it('rejects a late configuration notification that supersedes a model-write acknowledgment', async () => {
    const proc = openCodeLikeHarness();
    proc.onRequest('session/set_config_option', (message) => {
      proc.respond(message.id, { configOptions: [{ ...MODEL_OPTION, currentValue: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }] });
      proc.notify('session/update', { sessionId: 'sess-acp-1', update: {
        sessionUpdate: 'config_option_update', configOptions: [MODEL_OPTION],
      } });
    });
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    await expect(adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }))
      .rejects.toThrow(/did not switch the session model/);
    proc.exit();
  });

  it('retains an accepted selection when a legacy config response has no option list', async () => {
    const proc = openCodeLikeHarness();
    proc.onRequest('session/set_config_option', (message) => proc.respond(message.id, null));
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await adapter.spawn();
    await adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' });
    await adapter.applyLiveSessionConfig({ model: MODEL_OPTION.currentValue });
    expect(configWrites(proc).map((entry) => entry.value)).toEqual([
      'aio-mimo-max-b-1a2b/mimo-v2.6-pro', MODEL_OPTION.currentValue,
    ]);
    proc.exit();
  });

  it('throws when the session is not running (the respawn handoff takes over)', async () => {
    const proc = openCodeLikeHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    await expect(adapter.applyLiveSessionConfig({ model: 'aio-mimo-max-b-1a2b/mimo-v2.6-pro' }))
      .rejects.toThrow(/not running/);
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

  it.each(['before-gate', 'gate'] as const)('releases the concurrency slot when %s acquisition fails', async (stage) => {
    const proc = createInitializedAgentHarness();
    const releaseSlot = vi.fn();
    const startupGate = vi.fn(async () => {
      if (stage === 'gate') throw new Error('gate failed');
      return vi.fn();
    });
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp', concurrencyKey: 'opencode',
      concurrencyLimiter: { acquire: async () => releaseSlot }, startupGate,
      beforeStartupGate: async () => { if (stage === 'before-gate') throw new Error('discovery failed'); },
    });
    await expect(adapter.spawn()).rejects.toThrow(stage === 'gate' ? 'gate failed' : 'discovery failed');
    expect(releaseSlot).toHaveBeenCalledOnce();
    if (stage === 'before-gate') expect(startupGate).not.toHaveBeenCalled();
  });

  it('releases startup and concurrency gates even when failed-spawn cleanup throws', async () => {
    const proc = createInitializedAgentHarness();
    const releaseGate = vi.fn();
    const releaseSlot = vi.fn();
    const adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp', startupGate: async () => releaseGate,
      concurrencyKey: 'opencode', concurrencyLimiter: { acquire: async () => releaseSlot },
      prepareSpawn: () => () => { throw new Error('cleanup failed'); },
    });
    vi.spyOn(adapter as unknown as { spawnProcess: () => unknown }, 'spawnProcess')
      .mockImplementation(() => { throw new Error('spawn failed'); });
    await expect(adapter.spawn()).rejects.toThrow();
    expect(releaseGate).toHaveBeenCalledOnce();
    expect(releaseSlot).toHaveBeenCalledOnce();
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
