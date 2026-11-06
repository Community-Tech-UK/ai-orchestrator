import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CliResponse } from './base-cli-adapter';
import type { Instance } from '../../../shared/types/instance.types';
import { DeferredPermissionHandler } from '../../instance/lifecycle/deferred-permission-handler';
import { ClaudeResidentRequest } from './claude-resident-request';

vi.mock('./base-cli-process-utils', () => ({ killProcessGroup: vi.fn() }));
class ResidentFixture extends ClaudeCliAdapter {
  readonly children: ChildProcess[] = [];
  readonly spawnArgs: string[][] = [];
  constructor() { super({ residentClaude: true, yoloMode: true, timeout: 10_000, model: 'opus' }); }
  override async checkStatus() { return { available: true, version: '2.1.310', path: 'claude' }; }
  protected override spawnProcess(args: string[]): ChildProcess {
    this.spawnArgs.push(args);
    const child = Object.assign(new EventEmitter(), { pid: 100000 + this.children.length,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false }) as unknown as ChildProcess;
    this.children.push(child);
    return child;
  }
  receipt(total: number, child = this.children.at(-1)!) {
    child.stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result', total_cost_usd: total,
      usage: { input_tokens: 10, output_tokens: 20 }, result: 'finished' }) + '\n'));
  }
  close() { this.children.at(-1)?.emit('close', 0, null); }
}
const adapters: ResidentFixture[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) { adapter.close(); await adapter.terminate(false); } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('borrowed Claude resident requests', () => {
  it('retains paid usage if cancelled while restoring a wrap-up runtime', async () => {
    const source = Object.assign(new EventEmitter(), { getDeferredToolUse: () => null });
    const request = new ClaudeResidentRequest(source);
    let finishRestore!: () => void;
    const pending = request.run(async () => undefined, () => new Promise<void>(resolve => { finishRestore = resolve; }));
    void pending.catch(() => undefined);
    source.emit('complete', { id: 'paid', role: 'assistant', content: 'done', usage: { cost: 0.5, inputTokens: 10 } });
    await tick(); request.cancel();
    await expect(pending).rejects.toMatchObject({ partialUsage: { cost: 0.5, inputTokens: 10 } });
    finishRestore(); await tick();
    expect(source.listenerCount('complete')).toBe(0);
    expect(request.pending).toBe(false);
  });
  it('refuses one-shot and streaming sends that would overwrite an owned resident', async () => {
    const adapter = new ResidentFixture(); adapters.push(adapter); await adapter.spawn();
    await expect(adapter.sendMessage({ role: 'user', content: 'invalid one-shot' })).rejects.toThrow('already spawned');
    await expect(adapter.sendMessageStream({ role: 'user', content: 'invalid stream' })[Symbol.asyncIterator]().next()).rejects.toThrow('already spawned');
    await adapter.sendInput('an ordinary active chat turn');
    await expect(adapter.requestResponse({ role: 'user', content: 'overlapping loop' })).rejects.toThrow('previous turn');
    expect(adapter.children).toHaveLength(1);
  });
  it('reaps the old resident before applying a wrap-up spawn-time tool restriction', async () => {
    const adapter = new ResidentFixture(); adapters.push(adapter); await adapter.spawn();
    const original = adapter.children[0];
    adapter.setDisallowedToolsOverride(['Bash']);
    const pending = adapter.requestResponse({ role: 'user', content: 'wrap up' }); void pending.catch(() => undefined);
    await tick();
    expect(adapter.children).toHaveLength(1);
    original.emit('exit', 0); original.emit('close', 0, null);
    await tick(); await tick();
    expect(adapter.children).toHaveLength(2);
    expect(adapter.spawnArgs[1]).toContain('--resume');
    expect(adapter.spawnArgs[1][adapter.spawnArgs[1].indexOf('--disallowedTools') + 1]).toContain('Bash');
    adapter.receipt(0.5);
    await tick();
    adapter.children[1].emit('exit', 0); adapter.children[1].emit('close', 0, null);
    await pending;
    expect(adapter.children).toHaveLength(3);
    expect(adapter.spawnArgs[2][adapter.spawnArgs[2].indexOf('--disallowedTools') + 1]).not.toContain('Bash');
  });
  it('uses the original resident pipe and keeps cumulative settlement across loop turns', async () => {
    const adapter = new ResidentFixture(); adapters.push(adapter); await adapter.spawn();
    const original = adapter.children[0];
    const completed: CliResponse[] = []; adapter.on('complete', response => completed.push(response));
    const first = adapter.requestResponse({ role: 'user', content: 'first loop round' }); void first.catch(() => undefined);
    await tick();
    expect(adapter.children).toHaveLength(1);
    expect(adapter.getPid()).toBe(original.pid);
    adapter.receipt(0.5, original);
    expect((await first).usage?.cost).toBe(0.5);
    const second = adapter.requestResponse({ role: 'user', content: 'second loop round' }); void second.catch(() => undefined);
    await tick(); adapter.receipt(1.25, original);
    expect((await second).usage?.cost).toBe(0.75);
    expect(completed.map(response => response.usage?.cost)).toEqual([0.5, 0.75]);
    expect(original.stdin?.writable).toBe(true);
    expect(adapter.children).toHaveLength(1);
  });

  it('keeps a deferred native request pending until recovery rather than completing the loop', async () => {
    const adapter = new ResidentFixture(); adapters.push(adapter); await adapter.spawn();
    let settled = false;
    const pending = adapter.requestResponse({ role: 'user', content: 'held command' });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    expect(adapter.children).toHaveLength(1);
    adapter.children[0].stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result',
      session_id: 'deferred-session', stop_reason: 'tool_deferred', total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20 },
      deferred_tool_use: { id: 'held-tool', name: 'Bash', input: { command: 'pwd' } } }) + '\n'));
    adapter.close(); await tick();
    expect(settled).toBe(false);
    await adapter.terminate(false);
    await expect(pending).rejects.toThrow('cancelled');
    await expect(pending).rejects.toMatchObject({ partialUsage: { cost: 0.5, inputTokens: 10, outputTokens: 20 } });
  });

  it.each([true, false])('recovers the same borrowed request after an explicit decision (%s), without replaying input', async approved => {
    const adapter = new ResidentFixture(); adapters.push(adapter); await adapter.spawn();
    const input: unknown[] = []; adapter.children[0].stdin!.on('data', chunk => input.push(chunk));
    const recorded: number[] = [];
    adapter.on('usage', usage => recorded.push(usage.cost));
    adapter.on('complete', response => recorded.push(response.usage.cost));
    const pending = adapter.requestResponse({ role: 'user', content: 'held command' }); void pending.catch(() => undefined);
    await tick();
    adapter.children[0].stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'result',
      session_id: 'deferred-session', stop_reason: 'tool_deferred', total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20 },
      deferred_tool_use: { id: 'held-tool', name: 'Bash', input: { command: 'pwd' } } }) + '\n'));
    adapter.close();
    const instance = { id: 'borrowed', status: 'waiting_for_permission', provider: 'claude', currentModel: 'opus',
      executionLocation: { type: 'local' }, workingDirectory: '/workspace', yoloMode: false,
      outputBuffer: [], contextUsage: { used: 0, total: 1000, percentage: 0 } } as unknown as Instance;
    const deps = { getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(),
      deleteAdapter: vi.fn(), setupAdapterEvents: vi.fn(), queueUpdate: vi.fn() };
    const ops = { transitionState: (target: Instance, status: Instance['status']) => { target.status = status; },
      resolveCliTypeForInstance: vi.fn(), getMcpConfig: vi.fn(), getPermissionHookPath: vi.fn(),
      waitForResumeHealth: async () => true, createCliAdapter: vi.fn(),
      acquireSessionMutex: async () => () => undefined };
    const services = { writeDecision: vi.fn(), getDecisionDir: () => '/disposable-decisions', createDiffTracker: vi.fn() };
    await new DeferredPermissionHandler(deps, ops, services).resumeAfterDeferredPermission(instance.id, approved);
    expect(services.writeDecision).toHaveBeenCalledWith('held-tool', approved ? 'allow' : 'deny', expect.any(String), undefined);
    expect(deps.setAdapter).not.toHaveBeenCalled();
    expect(deps.deleteAdapter).not.toHaveBeenCalled();
    expect(ops.createCliAdapter).not.toHaveBeenCalled();
    expect(adapter.children).toHaveLength(2);
    expect(input).toHaveLength(1);
    expect(instance.status).toBe('busy');
    adapter.children[1].stdout!.emit('data', Buffer.from(JSON.stringify({ type: 'assistant',
      message: { content: [{ type: 'text', text: approved ? 'approved once' : 'refused visibly' }] } }) + '\n'));
    adapter.receipt(1.25);
    const result = await pending;
    expect(result.content).toBe(approved ? 'approved once' : 'refused visibly');
    expect(result.usage?.cost).toBe(1.25);
    expect(recorded).toEqual([0.5, 0.75]);
    expect(adapter.hasPendingResidentRequest()).toBe(false);
    expect(adapter.listenerCount('exit')).toBe(0);
  });
});
