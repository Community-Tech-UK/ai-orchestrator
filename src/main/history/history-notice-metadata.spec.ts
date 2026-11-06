import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgent } from '../../shared/types/agent.types';
import { buildRequestReceiptMetadata } from '../../shared/utils/request-receipt-message';
import { isToolResultFailed } from '../../shared/tool-outcome';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { outputMessagesToContinuityEntries, continuityEntryToOutputMessage } from '../session/continuity-message-projection';
import { normalizeConversationHistory } from '../session/session-continuity-state';
import { codexCommandTranscript } from '../cli/adapters/codex/codex-command-transcript.test-helpers';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let userData = '';
afterEach(() => {
  vi.doUnmock('electron');
  vi.resetModules();
  if (userData) fs.rmSync(userData, { recursive: true, force: true });
});

describe('continuity notices and outcomes through actual history disk reload', () => {
  it('keeps bounded receipt, routine, Details and check facts across restore, archive and a new manager', async () => {
    vi.resetModules();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'phasee-history-notices-'));
    vi.doMock('electron', () => ({ app: { getPath: () => userData } }));
    const { HistoryManager } = await import('./history-manager');
    const history = new HistoryManager();
    await history.startupTasks;
    const receipt = { ...buildRequestReceiptMetadata({ requestId: 'request-1', outcome: 'answered', subject: 'Question', requestedAt: 100 }), severity: 'info' };
    const instance = buildInstanceRecord({ workingDirectory: '/tmp/placeholder', provider: 'codex' }, getDefaultAgent(), {
      defaultYoloMode: false, getParent: () => undefined, now: () => 100,
    });
    const source = [
      { id: 'user', timestamp: 100, type: 'user' as const, content: 'Placeholder request' },
      { id: 'answer', timestamp: 101, type: 'assistant' as const, content: 'Placeholder answer' },
      { id: 'receipt', timestamp: 102, type: 'system' as const, content: 'You answered: ready', metadata: receipt },
      { id: 'routine', timestamp: 103, type: 'system' as const, content: 'Interrupted — waiting for input', metadata: { audience: 'routine', severity: 'warning' } },
      { id: 'error', timestamp: 104, type: 'system' as const, content: 'A request failed.', metadata: { errorPresentation: {
        category: 'network', headline: 'Connection interrupted.', whatToDo: 'What to do: Try again.', rawDetail: 'ECONNRESET',
      } } },
      ...codexCommandTranscript([{ id: 'check', command: 'npm test', exitCode: 1, output: '3 failed' }, { id: 'search', command: 'rg needle src', exitCode: 1 }]),
    ];
    const persisted = normalizeConversationHistory(outputMessagesToContinuityEntries(source), false);
    instance.outputBuffer = JSON.parse(JSON.stringify(persisted)).map(continuityEntryToOutputMessage);
    instance.status = 'idle';
    expect(await history.archiveInstance(instance)).toBe('archived');
    const restarted = new HistoryManager();
    await restarted.startupTasks;
    const reloaded = await restarted.loadConversation(restarted.getEntries()[0].id);
    const messages = reloaded?.messages ?? [];
    expect(messages.find(message => message.id === 'receipt')?.metadata).toEqual(receipt);
    expect(messages.find(message => message.id === 'routine')?.metadata).toMatchObject({ audience: 'routine', severity: 'warning' });
    expect(messages.find(message => message.id === 'error')?.metadata?.['errorPresentation']).toMatchObject({ rawDetail: 'ECONNRESET' });
    const results = messages.filter(message => message.type === 'tool_result');
    expect(results.map(message => isToolResultFailed('Bash', message.metadata))).toEqual([true, false]);
    expect(results.map(message => message.metadata?.['exitCode'])).toEqual([1, 1]);
  });
});
