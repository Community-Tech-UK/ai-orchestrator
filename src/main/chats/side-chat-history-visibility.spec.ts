import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSideChatHarness, type SideChatHarness } from './side-chat.test-helpers';

const location = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => location.userData } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

let h: SideChatHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  if (location.userData) fs.rmSync(location.userData, { recursive: true, force: true });
});

it('archives an actual sidechat runtime as hidden history', async () => {
  location.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sidechat-history-'));
  const { HistoryManager } = await import('../history/history-manager');
  const history = new HistoryManager();
  await history.startupTasks;
  h = createSideChatHarness();
  await h.service.whenReady();
  h.runtimes.addSession({ historyThreadId: 'parent', workingDirectory: '/work', displayName: 'Parent' });
  const created = await h.service.sideChats.create({
    parent: { kind: 'session', historyThreadId: 'parent', originNodeId: null },
    selection: { provider: 'claude', model: 'sonnet' }, currentCwd: '/work',
  });
  await h.service.sideChats.send({ chatId: created.chat.id, text: 'Question' });
  const detail = await h.service.getChat(created.chat.id);
  const runtime = h.runtimes.getInstance(detail.chat.currentInstanceId!)!;
  runtime.outputBuffer = [{ id: 'question', type: 'user', content: 'Question', timestamp: Date.now() }];

  expect(await history.archiveInstance(runtime)).toBe('archived');
  const [entry] = history.getEntries();
  expect(entry?.historyThreadId).toBe(created.chat.ledgerThreadId);
  expect(entry?.hideFromProjectRail).toBe(true);
  expect((await history.loadConversation(entry.id))?.entry.hideFromProjectRail).toBe(true);
});
