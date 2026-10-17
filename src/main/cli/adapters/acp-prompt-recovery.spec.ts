import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpJsonRpcRequest } from '../../../shared/types/cli.types';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from './acp-cli-adapter.test-helpers';

vi.mock('./base-cli-process-utils', async (original) => ({ ...await original<typeof import('./base-cli-process-utils')>(), killProcessGroup: vi.fn(() => true) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

class RecoveryAdapter extends TestAcpCliAdapter {
  armWatchdog(): unknown { this.resetStreamIdleWatchdog(); return this.watchdog(); }
  watchdog(): unknown { return (this as unknown as { streamIdleTimer: unknown }).streamIdleTimer; }
}

function hold() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function useReplacement(adapter: TestAcpCliAdapter, proc: FakeAcpProcess): void {
  vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
    .mockReturnValue(proc as unknown as ChildProcess);
}

function prompts(proc: FakeAcpProcess): AcpJsonRpcRequest[] {
  return proc.receivedMessages.filter((message): message is AcpJsonRpcRequest => 'method' in message && message.method === 'session/prompt');
}

describe('ACP public input recovery ownership', () => {
  it.each(['resolve', 'reject'] as const)('keeps replacement output, status and watchdog when retired preparation will %s', async (ending) => {
    const oldProcess = createInitializedAgentHarness();
    const replacement = createInitializedAgentHarness();
    const preparation = hold();
    let calls = 0;
    const adapter = new RecoveryAdapter(oldProcess, { workingDirectory: '/tmp',
      beforeProviderPrompt: () => ++calls === 1 ? preparation.promise : Promise.resolve() });
    await adapter.spawn();
    const oldInput = adapter.sendInput('retired input');
    void oldInput.catch(() => undefined);
    await adapter.terminate(false);
    useReplacement(adapter, replacement);
    await adapter.spawn();
    const newInput = adapter.sendInput('replacement input');
    const request = await replacement.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
    const watchdog = adapter.armWatchdog();
    expect(watchdog).not.toBeNull();
    const outputs: OutputMessage[] = [];
    const statuses: string[] = [];
    const errors: Error[] = [];
    adapter.on('output', (output: OutputMessage) => outputs.push(output));
    adapter.on('status', (status: string) => statuses.push(status));
    adapter.on('error', (error: Error) => errors.push(error));
    try {
      if (ending === 'reject') preparation.reject(new Error('Retired checkpoint failed'));
      else preparation.resolve();
      await expect(oldInput).rejects.toMatchObject({ name: 'AbortError' });
      expect(outputs).toEqual([]);
      expect(statuses).toEqual([]);
      expect(errors).toEqual([]);
      expect(adapter.watchdog()).toBe(watchdog);
      expect(adapter.hasActiveTurn()).toBe(true);
      expect(prompts(oldProcess)).toEqual([]);
      expect(prompts(replacement)).toHaveLength(1);
    } finally {
      if ('id' in request && request.id !== null) replacement.respond(request.id, { stopReason: 'end_turn' });
      await newInput;
      replacement.exit();
    }
  });

  it('publishes a current preparation failure through public input', async () => {
    const proc = createInitializedAgentHarness();
    const failure = new Error('Current checkpoint failed');
    const adapter = new RecoveryAdapter(proc, { workingDirectory: '/tmp', beforeProviderPrompt: async () => { throw failure; } });
    const outputs: OutputMessage[] = [];
    const errors: Error[] = [];
    const statuses: string[] = [];
    adapter.on('output', (output: OutputMessage) => outputs.push(output));
    adapter.on('error', (error: Error) => errors.push(error));
    adapter.on('status', (status: string) => statuses.push(status));
    try {
      await expect(adapter.sendInput('current input')).rejects.toBe(failure);
      expect(errors).toEqual([failure]);
      expect(statuses).toContain('error');
      expect(outputs).toContainEqual(expect.objectContaining({ type: 'error', content: failure.message }));
      expect(prompts(proc)).toEqual([]);
    } finally { proc.exit(); }
  });

  it('clears the owning watchdog when external cancellation revokes preparation', async () => {
    const proc = createInitializedAgentHarness();
    const preparation = hold();
    const controller = new AbortController();
    const adapter = new RecoveryAdapter(proc, { workingDirectory: '/tmp', beforeProviderPrompt: () => preparation.promise });
    await adapter.spawn();
    const input = adapter.sendInput('cancelled current input', undefined, { dispatch: { signal: controller.signal } });
    const watchdog = adapter.armWatchdog();
    expect(watchdog).not.toBeNull();
    try {
      controller.abort();
      preparation.resolve();
      await expect(input).rejects.toMatchObject({ name: 'AbortError' });
      expect(adapter.watchdog()).toBeNull();
      expect(prompts(proc)).toEqual([]);
    } finally { proc.exit(); }
  });

  it('publishes an owning startup refusal after its failed-spawn cleanup advances the lifecycle', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new RecoveryAdapter(proc, { workingDirectory: '/tmp', generationBudget: {
      model: 'xiaomi-token-plan/mimo-v2.6-pro', combinedOutputTokens: 1024, reasoningBudgetSupported: false,
    } });
    const outputs: OutputMessage[] = [];
    const errors: Error[] = [];
    adapter.on('output', (output: OutputMessage) => outputs.push(output));
    adapter.on('error', (error: Error) => errors.push(error));
    try {
      await expect(adapter.sendInput('refused startup input')).rejects.toThrow('Unable to confirm the selected model');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Unable to confirm the selected model');
      expect(outputs).toContainEqual(expect.objectContaining({ type: 'error', content: expect.stringContaining('Unable to confirm the selected model') }));
      expect(prompts(proc)).toEqual([]);
    } finally { proc.exit(); }
  });

  it.each(['before-replacement', 'during-replacement'] as const)('delivers first-turn instructions after process exit when old preparation settles %s', async (timing) => {
    const oldProcess = createInitializedAgentHarness();
    const replacement = createInitializedAgentHarness();
    const preparation = hold();
    let calls = 0;
    const adapter = new RecoveryAdapter(oldProcess, { workingDirectory: '/tmp', systemPrompt: 'Recovery system instructions', rtkEnabled: true,
      beforeProviderPrompt: () => ++calls === 1 ? preparation.promise : Promise.resolve() });
    await adapter.spawn();
    const oldInput = adapter.sendInput('retired first input');
    void oldInput.catch(() => undefined);
    oldProcess.exit(1);
    useReplacement(adapter, replacement);
    let firstInput: Promise<void> | undefined;
    try {
      if (timing === 'before-replacement') {
        preparation.resolve();
        await expect(oldInput).rejects.toMatchObject({ name: 'AbortError' });
      }
      await adapter.spawn();
      firstInput = adapter.sendInput('first real input');
      const request = await replacement.waitForMessage((message) => 'method' in message && message.method === 'session/prompt');
      if (timing === 'during-replacement') {
        oldProcess.exit(1);
        expect(adapter.hasActiveTurn()).toBe(true);
        preparation.resolve();
        await expect(oldInput).rejects.toMatchObject({ name: 'AbortError' });
      }
      const first = JSON.stringify(prompts(replacement)[0]?.params);
      expect(first).toContain('Recovery system instructions');
      expect(first).toContain('[RTK AWARENESS]');
      expect(first).not.toContain('retired first input');
      if ('id' in request && request.id !== null) replacement.respond(request.id, { stopReason: 'end_turn' });
      await firstInput;
      replacement.onRequest('session/prompt', (message) => replacement.respond(message.id, { stopReason: 'end_turn' }));
      await adapter.sendInput('following real input');
      const following = JSON.stringify(prompts(replacement)[1]?.params);
      expect(following).not.toContain('Recovery system instructions');
      expect(following).not.toContain('[RTK AWARENESS]');
    } finally {
      preparation.resolve();
      replacement.exit();
      await Promise.allSettled([oldInput, ...(firstInput ? [firstInput] : [])]);
    }
  });
});
