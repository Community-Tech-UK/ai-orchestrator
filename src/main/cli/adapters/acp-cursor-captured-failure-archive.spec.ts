import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

/**
 * The same two Cursor wire shapes pinned in `acp-cursor-captured-failure-shapes.spec.ts`
 * (captured from a real `cursor-agent` ACP session; strings replaced by placeholders),
 * followed through the PRODUCTION persistence path with nothing mocked but the Electron
 * `userData` directory: real `AcpCliAdapter` -> real `OutputStorageManager` (disk chunks) ->
 * real `HistoryManager.archiveInstance` -> `loadConversation` from the gzip file ->
 * `extractToolInvocations` / `mineCorrections` on the reloaded transcript.
 */
describe('captured Cursor failure shapes through real storage, archive and reload', () => {
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-failure-archive-'));
    vi.doMock('electron', () => ({
      app: { getPath: (name: string) => {
        if (name === 'userData') return userDataDir;
        throw new Error(`Unexpected path lookup: ${name}`);
      } },
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.resetModules();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('keeps hidden outcomes out of the buffer, archives them once, drains the side store, and mines the reload', async () => {
    const { AcpCliAdapter } = await import('./acp-cli-adapter');
    const { getOutputStorageManager } = await import('../../memory/output-storage');
    const { getHistoryManager } = await import('../../history/history-manager');
    const { recordToolOutcome, getToolOutcomes } = await import('../../learning/tool-outcome-store');
    const { extractToolInvocations, mineCorrections } = await import('../../learning/correction-miner');

    const adapter = new AcpCliAdapter({ workingDirectory: '/tmp/placeholder', adapterName: 'cursor' });
    const emitted: OutputMessage[] = [];
    adapter.on('output', message => emitted.push(message));
    const wire = adapter as unknown as {
      handleToolCallCreated(update: Record<string, unknown>): void;
      handleToolCallDelta(update: Record<string, unknown>): void;
    };
    const run = (created: Record<string, unknown>, settled: Record<string, unknown>): void => {
      wire.handleToolCallCreated(created);
      wire.handleToolCallDelta({ sessionUpdate: 'tool_call_update', toolCallId: created['toolCallId'], status: 'in_progress' });
      wire.handleToolCallDelta(settled);
    };
    run(
      { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read File', kind: 'read', status: 'pending', rawInput: { path: 'placeholder' }, locations: [{ path: 'placeholder' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed' },
    );
    run(
      { sessionUpdate: 'tool_call', toolCallId: 'sh-1', title: 'Shell', kind: 'execute', status: 'pending', rawInput: { command: 'ls --placeholder-option .' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'sh-1', status: 'completed', rawOutput: { exitCode: 1, stdout: '', stderr: 'placeholder: unrecognized option' } },
    );

    // Same split InstanceCommunication makes: hidden outcomes to the side store, the rest to the buffer.
    const instanceId = 'cursor-archive-1';
    const hidden = emitted.filter(message => message.type === 'tool_outcome');
    const visible = emitted.filter(message => message.type !== 'tool_outcome');
    expect(hidden).toHaveLength(1);
    for (const message of hidden) recordToolOutcome(instanceId, message);
    expect(visible.some(message => message.type === 'tool_outcome')).toBe(false);

    const prompt: OutputMessage = { id: 'prompt-1', type: 'user', content: 'placeholder prompt', timestamp: 1 };
    // Spill the early part of the transcript to real disk chunks; keep the tail in the buffer.
    const storage = getOutputStorageManager();
    const spilled = [prompt, ...visible.slice(0, 2)];
    const tail = visible.slice(2);
    await storage.storeMessages(instanceId, spilled);
    expect(fs.readdirSync(path.join(userDataDir, 'output-storage')).length).toBeGreaterThan(0);

    const instance = {
      id: instanceId, displayName: 'Cursor failure shapes', createdAt: 1, historyThreadId: 'thread-cursor-1',
      parentId: null, childrenIds: [], status: 'idle', lastActivity: 2, provider: 'cursor',
      workingDirectory: '/tmp/placeholder', sessionId: 'session-cursor-1', providerSessionId: 'session-cursor-1',
      retainedPrompts: [], outputBuffer: tail, outputBufferMaxSize: 1000, restartEpoch: 0,
    } as unknown as Instance;

    const history = getHistoryManager();
    await history.startupTasks;
    await expect(history.archiveInstance(instance)).resolves.toBe('archived');
    expect(getToolOutcomes(instanceId)).toHaveLength(0); // side store drained by the archive
    expect(instance.outputBuffer.some(message => message.type === 'tool_outcome')).toBe(false);

    const [entry] = history.getEntries();
    expect(fs.existsSync(path.join(userDataDir, 'conversation-history', `${entry!.id}.json.gz`))).toBe(true);

    // A fresh manager forces the reload to come from the gzip file, not memory.
    const { HistoryManager } = await import('../../history/history-manager');
    const reloadedManager = new HistoryManager();
    await reloadedManager.startupTasks;
    const reloaded = (await reloadedManager.loadConversation(entry!.id))?.messages as OutputMessage[];
    expect(reloaded).toBeDefined();

    const ids = reloaded.map(message => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(reloaded.filter(message => message.type === 'tool_outcome')).toHaveLength(1);
    expect(reloaded.filter(message => message.type === 'tool_use')).toHaveLength(2);
    const shellResult = reloaded.find(message => message.type === 'tool_result');
    expect(shellResult?.content).toContain('unrecognized option');
    expect(shellResult?.content).toContain('(exit code 1)');
    expect(shellResult?.metadata).toMatchObject({ exitCode: 1, is_error: false });
    const readOutcome = reloaded.find(message => message.type === 'tool_outcome');
    expect(readOutcome?.metadata).toMatchObject({ is_error: false });

    // Miner on the RELOADED transcript: the shell invocation survives, the read is not minable.
    const invocations = extractToolInvocations(reloaded as never);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ command: 'ls --placeholder-option .', isError: false });
    expect(mineCorrections(reloaded as never)).toEqual([]);
  });
});
