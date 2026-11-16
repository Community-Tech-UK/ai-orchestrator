import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSideChatHarness, type SideChatHarness } from './side-chat.test-helpers';
import { setInitializedChatService } from './chat-service-instance';

const location = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => location.userData } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

let h: SideChatHarness | undefined;
afterEach(async () => {
  setInitializedChatService(null);
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

it.each([false, true])('skips archived sidechat title backfill while still naming hidden workers (legacy runtime: %s)', async (legacy) => {
  location.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sidechat-history-titles-'));
  const { HistoryManager } = await import('../history/history-manager');
  const history = new HistoryManager();
  await history.startupTasks;
  h = createSideChatHarness();
  await h.service.whenReady();
  setInitializedChatService(h.service);
  h.runtimes.addSession({ historyThreadId: 'parent', workingDirectory: '/work', displayName: 'Parent' });
  const created = await h.service.sideChats.create({
    parent: { kind: 'session', historyThreadId: 'parent', originNodeId: null },
    selection: { provider: 'claude', model: 'sonnet' }, currentCwd: '/work',
  });
  const question = 'How far through this task are you, and what work remains?';
  await h.service.sideChats.send({ chatId: created.chat.id, text: question });
  const detail = await h.service.getChat(created.chat.id);
  const runtime = h.runtimes.getInstance(detail.chat.currentInstanceId!)!;
  runtime.isRenamed = false;
  runtime.aiTitle = undefined;
  if (legacy) runtime.metadata = {};
  runtime.outputBuffer = [{ id: 'question', type: 'user', content: question, timestamp: Date.now() }];
  const workerPrompt = 'Review the implementation and report any remaining problems.';
  const worker = h.runtimes.addSession({
    historyThreadId: 'ordinary-worker', workingDirectory: '/work', displayName: 'Worker',
    transcript: [{ type: 'user', content: workerPrompt }],
  });
  worker.metadata = { hideFromProjectRail: true };
  worker.isRenamed = false;
  await history.archiveInstance(worker);
  await history.archiveInstance(runtime);
  const entries = history.getEntries();
  expect(entries[0]).toMatchObject({ historyThreadId: created.chat.ledgerThreadId, hideFromProjectRail: true });
  expect(entries[1]).toMatchObject({ historyThreadId: 'ordinary-worker', hideFromProjectRail: true });
  const generate = vi.fn(async () => 'Implementation review');

  await history.backfillMissingAiTitles(entries, generate, { maxPerCall: 1 });

  expect(generate).toHaveBeenCalledExactlyOnceWith(workerPrompt);
  expect((await history.loadConversation(entries[0].id))?.entry.aiTitle).toBeUndefined();
  expect((await history.loadConversation(entries[1].id))?.entry.aiTitle).toBe('Implementation review');
});
