import { describe, expect, it, vi } from 'vitest';
import { CliAdapterWorkerProxy } from './cli-adapter-worker-proxy';
import type { CliSpawnGatewayPort, SpawnInstanceRequest } from './cli-spawn-worker-gateway';

class FakeGateway implements CliSpawnGatewayPort {
  handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1] | null = null;
  private handlers = new Map<string, Parameters<CliSpawnGatewayPort['registerInstance']>[1]>();
  spawnRequests: SpawnInstanceRequest[] = [];
  writes: { instanceId: string; data: string; closeAfterWrite?: boolean }[] = [];
  terminated: { instanceId: string; graceful: boolean }[] = [];
  signals: { instanceId: string; signal: NodeJS.Signals }[] = [];
  failSpawnWith: Error | null = null;
  autoExitOnSpawn: { code: number | null; signal: string | null; stdout?: string } | null = null;

  registerInstance(instanceId: string, handler: Parameters<CliSpawnGatewayPort['registerInstance']>[1]): void {
    this.handlers.set(instanceId, handler);
    if (!instanceId.includes(':status:')) {
      this.handler = handler;
    }
  }

  unregisterInstance(instanceId: string): void {
    this.handlers.delete(instanceId);
    if (!instanceId.includes(':status:')) {
      this.handler = null;
    }
  }

  async spawnInstance(request: SpawnInstanceRequest): Promise<{ pid: number }> {
    if (this.failSpawnWith) throw this.failSpawnWith;
    this.spawnRequests.push(request);
    const handler = this.handlers.get(request.instanceId);
    handler?.spawned?.(7777);
    if (this.autoExitOnSpawn) {
      if (this.autoExitOnSpawn.stdout) {
        handler?.stdout?.(this.autoExitOnSpawn.stdout);
      }
      handler?.exited?.(this.autoExitOnSpawn.code, this.autoExitOnSpawn.signal);
    }
    return { pid: 7777 };
  }

  async writeStdin(instanceId: string, data: string, options: { closeAfterWrite?: boolean } = {}): Promise<void> {
    this.writes.push({ instanceId, data, closeAfterWrite: options.closeAfterWrite });
  }

  sendSignal(instanceId: string, signal: NodeJS.Signals): void {
    this.signals.push({ instanceId, signal });
  }

  async terminate(instanceId: string, graceful: boolean): Promise<void> {
    this.terminated.push({ instanceId, graceful });
  }
}

describe('CliAdapterWorkerProxy', () => {
  it('spawns Claude through the gateway and formats stdin as stream-json input', async () => {
    const gateway = new FakeGateway();
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-1',
      gateway,
      options: {
        workingDirectory: '/repo',
        model: 'opus[1m]',
        yoloMode: true,
        systemPrompt: 'system',
      },
    });

    const spawned = vi.fn();
    proxy.on('spawned', spawned);

    await expect(proxy.spawn()).resolves.toBe(7777);

    expect(gateway.spawnRequests[0]).toMatchObject({
      instanceId: 'inst-1',
      command: 'claude',
      cwd: '/repo',
    });
    expect(gateway.spawnRequests[0].args).toEqual(
      expect.arrayContaining([
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--dangerously-skip-permissions',
        '--model',
        'opus[1m]',
        '--system-prompt',
        'system',
      ]),
    );
    expect(spawned).toHaveBeenCalledWith(7777);

    await proxy.sendInput('hello');
    expect(gateway.writes[0].data).toContain('"type":"user"');
    expect(gateway.writes[0].data).toContain('"content":"hello"');
    expect(gateway.writes[0].data).toMatch(/\n$/);
    expect(gateway.writes[0].closeAfterWrite).toBeUndefined();
  });

  it('translates worker stdout, stderr, idle, exit, interrupt, and terminate events', async () => {
    const gateway = new FakeGateway();
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-2',
      gateway,
      options: {
        workingDirectory: '/repo',
        model: 'gemini-pro',
      },
    });
    const output = vi.fn();
    const error = vi.fn();
    const idle = vi.fn();
    const exit = vi.fn();
    proxy.on('output', output);
    proxy.on('error', error);
    proxy.on('stream:idle', idle);
    proxy.on('exit', exit);

    await proxy.spawn();
    gateway.handler?.stdout('{"type":"message","role":"assistant","content":"hi"}\n');
    gateway.handler?.stderr('fatal stderr');
    gateway.handler?.streamIdle?.(1234);

    expect(output).toHaveBeenCalledWith(expect.objectContaining({ type: 'assistant', content: 'hi' }));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'fatal stderr' }));
    expect(idle).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1234, pid: expect.any(Number) }));

    const turn = proxy.sendInput('interruptible');
    expect(proxy.interrupt()).toEqual({ status: 'accepted' });
    expect(gateway.signals).toEqual([{ instanceId: 'inst-2', signal: 'SIGINT' }]);
    gateway.handler?.exited(0, null);
    await turn;

    const termGateway = new FakeGateway();
    const termProxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-term',
      gateway: termGateway,
      options: { workingDirectory: '/repo' },
    });
    await termProxy.spawn();
    await termProxy.terminate(false);
    expect(termGateway.terminated).toEqual([{ instanceId: 'inst-term', graceful: false }]);

    const exitGateway = new FakeGateway();
    const exitProxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-3',
      gateway: exitGateway,
      options: { workingDirectory: '/repo' },
    });
    const exitOnly = vi.fn();
    exitProxy.on('exit', exitOnly);
    await exitProxy.spawn();
    exitGateway.handler?.exited(0, null);
    expect(exitOnly).toHaveBeenCalledWith(0, null);
  });

  it('keeps Gemini spawn as readiness-only and runs one worker process per sendInput', async () => {
    const gateway = new FakeGateway();
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-gemini',
      gateway,
      options: { workingDirectory: '/repo', model: 'gemini-pro' },
    });
    const complete = vi.fn();
    proxy.on('complete', complete);

    await expect(proxy.spawn()).resolves.toBeGreaterThan(0);
    expect(gateway.spawnRequests).toHaveLength(1);
    expect(gateway.spawnRequests[0]).toMatchObject({
      instanceId: expect.stringContaining('inst-gemini:status:'),
      args: ['--version'],
    });

    const send = proxy.sendInput('hello gemini');
    expect(gateway.spawnRequests).toHaveLength(2);
    expect(gateway.spawnRequests[1].args).toEqual(expect.arrayContaining(['hello gemini']));

    gateway.handler?.stdout?.('{"type":"message","role":"assistant","content":"hi"}\n');
    gateway.handler?.exited?.(0, null);

    await send;
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ content: 'hi' }));
  });

  it('checks Gemini CLI availability before reporting the proxy as spawned', async () => {
    const gateway = new FakeGateway();
    gateway.failSpawnWith = new Error('spawn gemini ENOENT');
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-gemini-missing',
      gateway,
      options: { workingDirectory: '/repo' },
    });

    await expect(proxy.spawn()).rejects.toThrow('Gemini CLI not available');
    expect(proxy.isRunning()).toBe(false);
  });

  it('rejects sendMessage when the worker spawn fails before a child is available', async () => {
    const gateway = new FakeGateway();
    gateway.failSpawnWith = new Error('spawn gemini ENOENT');
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-missing',
      gateway,
      options: { workingDirectory: '/repo' },
    });

    await expect(proxy.sendMessage({ role: 'user', content: 'hello' })).rejects.toThrow('spawn gemini ENOENT');
  });

  it('resolves sendMessage when a fast worker process exits during spawnInstance', async () => {
    const gateway = new FakeGateway();
    gateway.autoExitOnSpawn = {
      code: 0,
      signal: null,
      stdout: '{"type":"message","role":"assistant","content":"fast"}\n',
    };
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'gemini',
      instanceId: 'inst-fast',
      gateway,
      options: { workingDirectory: '/repo' },
    });

    await expect(proxy.sendMessage({ role: 'user', content: 'hello' })).resolves.toEqual(
      expect.objectContaining({ content: 'fast' }),
    );
  });

  it('closes Claude stdin after one-shot sendMessage writes stream-json input', async () => {
    const gateway = new FakeGateway();
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-claude-one-shot',
      gateway,
      options: { workingDirectory: '/repo' },
    });

    const pending = proxy.sendMessage({ role: 'user', content: 'hello claude' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gateway.writes).toEqual([expect.objectContaining({
      instanceId: 'inst-claude-one-shot',
      data: expect.stringContaining('"content":"hello claude"'),
      closeAfterWrite: true,
    })]);
    gateway.handler?.stdout?.('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    gateway.handler?.exited?.(0, null);

    await expect(pending).resolves.toEqual(expect.objectContaining({ content: 'hi' }));
  });

  it('forwards Claude system/result semantics for session, context, cost, and deferred permission', async () => {
    const gateway = new FakeGateway();
    const proxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-claude-events',
      gateway,
      options: { workingDirectory: '/repo', model: 'opus[1m]' },
    });
    const context = vi.fn();
    const cost = vi.fn();
    const inputRequired = vi.fn();
    const status = vi.fn();
    proxy.on('context', context);
    proxy.on('cost', cost);
    proxy.on('input_required', inputRequired);
    proxy.on('status', status);

    await proxy.spawn();
    gateway.handler?.stdout?.(
      [
        '{"type":"system","subtype":"context_usage","session_id":"sess-123","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":3},"content":"system note"}',
        '{"type":"result","session_id":"sess-123","total_cost_usd":0.42,"modelUsage":{"claude":{"inputTokens":20,"outputTokens":4,"contextWindow":200000}}}',
        '{"type":"result","session_id":"sess-123","stop_reason":"tool_deferred","deferred_tool_use":{"id":"tool-1","name":"Bash","input":{"command":"npm test"}}}',
        '',
      ].join('\n'),
    );

    expect(proxy.getSessionId()).toBe('sess-123');
    expect(context).toHaveBeenCalledWith(expect.objectContaining({ used: 18, total: expect.any(Number), percentage: expect.any(Number) }));
    expect(cost).toHaveBeenCalledWith({ costEstimate: 0.42 });
    expect(status).toHaveBeenCalledWith('waiting_for_permission');
    expect(proxy.getRuntimeCapabilities().supportsDeferPermission).toBe(false);
    expect(proxy.getDeferredToolUse()).toEqual(expect.objectContaining({
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
      toolUseId: 'tool-1',
      sessionId: 'sess-123',
    }));
    expect(inputRequired).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        type: 'deferred_permission',
        tool_name: 'Bash',
        session_id: 'sess-123',
      }),
    }));

    proxy.clearDeferredToolUse();
    expect(proxy.getDeferredToolUse()).toBeNull();
  });

  it('advertises Claude deferred-permission support only when the defer hook is active', () => {
    const activeProxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-defer-active',
      gateway: new FakeGateway(),
      options: { permissionHookPath: '/tmp/defer-hook.mjs' },
    });
    const yoloProxy = new CliAdapterWorkerProxy({
      cliType: 'claude',
      instanceId: 'inst-defer-yolo',
      gateway: new FakeGateway(),
      options: { permissionHookPath: '/tmp/defer-hook.mjs', yoloMode: true },
    });

    expect(activeProxy.getRuntimeCapabilities().supportsDeferPermission).toBe(true);
    expect(yoloProxy.getRuntimeCapabilities().supportsDeferPermission).toBe(false);
  });
});
