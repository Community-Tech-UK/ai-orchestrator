import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat-service';
import { getHistoryManager, HistoryManager } from '../history/history-manager';
import { createSideChatHarness, type SideChatHarness } from './side-chat.test-helpers';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from '../browser-gateway/browser-approval-store';

const electron = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electron.userData } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({
  getActiveLoops: () => [], cancelLoop: vi.fn(async () => true),
}) }));

describe('sidechat history deletion', () => {
  let h: SideChatHarness;
  let chats: ChatService;
  let approvalDb: SqliteDriver;
  let approvals: BrowserApprovalStore;
  beforeEach(() => {
    electron.userData = mkdtempSync(join(tmpdir(), 'sidechat-history-delete-'));
    h = createSideChatHarness();
    h.service.dispose();
    approvalDb = defaultDriverFactory(':memory:');
    createTables(approvalDb); createMigrationsTable(approvalDb); runMigrations(approvalDb);
    approvals = new BrowserApprovalStore(approvalDb);
    chats = ChatService.getInstance({
      db: h.db, ledger: h.ledger, instanceManager: h.runtimes as never,
      resolveAgentPermissions: async () => ({ read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' }),
      drainEvidenceCapture: async () => undefined,
      expireSideChatApprovals: async (instanceId) => {
        expect(h.runtimes.getInstance(instanceId)?.status).toBe('terminated');
        approvals.expireForInstance(instanceId);
      },
      evidenceDeletion: { revokeConversation: (conversationId) => h.ledger.softDeleteConversationWithEvidence({
        conversationId, deletedAt: new Date().toISOString(), graceDeadline: Date.now(),
      }) },
    });
    chats.initialize();
  });
  afterEach(async () => {
    await getHistoryManager().startupTasks;
    ChatService._resetForTesting();
    HistoryManager._resetForTesting();
    await h.dispose();
    approvalDb.close();
    rmSync(electron.userData, { recursive: true, force: true });
  });

  async function addParent(thread: string) {
    const parent = h.runtimes.addSession({
      historyThreadId: thread, workingDirectory: '/work', displayName: thread,
      transcript: [{ type: 'user', content: `Work on ${thread}` }],
    });
    const history = getHistoryManager();
    await history.startupTasks;
    await history.archiveInstance(parent);
    const { chat } = await chats.sideChats.create({
      parent: { kind: 'session', historyThreadId: thread, originNodeId: null },
      selection: { provider: 'claude', model: null }, currentCwd: '/work',
    });
    return { history, side: chat, entry: history.getEntries().find((entry) => entry.historyThreadId === thread)! };
  }

  it('deleting a history session deletes its sidechats while retaining another parent', async () => {
    const { history, side, entry } = await addParent('parent-a');
    const other = await addParent('parent-b');
    await history.deleteEntry(entry.id);
    expect(chats.tryGetChat(side.id)).toBeNull();
    expect(chats.tryGetChat(other.side.id)).not.toBeNull();
    expect(history.getEntries().map((entry) => entry.historyThreadId)).toEqual(['parent-b']);
  });

  it('clearing history also deletes all owned sidechats', async () => {
    const { history } = await addParent('parent-a');
    await addParent('parent-b');
    await history.clearAll();
    expect(chats.listChats({ includeArchived: true })).toEqual([]);
    expect(h.db.prepare('SELECT * FROM side_chat_links').all()).toEqual([]);
  });

  it('archiving a history session keeps its sidechats', async () => {
    const { history, side, entry } = await addParent('parent-a');
    await history.archiveEntry(entry.id);
    expect(chats.tryGetChat(side.id)).not.toBeNull();
  });

  it('hides a legacy unmarked sidechat runtime when archiving and serializes the hidden flag', async () => {
    const { history, side } = await addParent('parent-a');
    await chats.sideChats.send({ chatId: side.id, text: 'Legacy question' });
    const runtime = h.runtimes.getInstance(chats.tryGetChat(side.id)!.currentInstanceId!)!;
    runtime.metadata = {};
    runtime.outputBuffer = [{ id: 'legacy-question', type: 'user', content: 'Legacy question', timestamp: 1 }];

    await history.archiveInstance(runtime);

    const entry = history.getEntries().find((entry) => entry.historyThreadId === side.ledgerThreadId)!;
    expect(entry.hideFromProjectRail).toBe(true);
    expect((await history.loadConversation(entry.id))?.entry.hideFromProjectRail).toBe(true);
  });

  it('hides legacy persisted sidechat history on listing without rewriting old records', async () => {
    const { history, side } = await addParent('parent-a');
    const oldEntry = {
      ...history.getEntries()[0], id: 'legacy-sidechat-entry', historyThreadId: side.ledgerThreadId,
      originalInstanceId: 'legacy-sidechat-runtime', sessionId: 'legacy-provider-placeholder',
      displayName: 'Legacy question', hideFromProjectRail: undefined,
    };
    const indexPath = join(history.getStoragePath(), 'index.json');
    writeFileSync(indexPath, JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [oldEntry, ...history.getEntries()] }));
    writeFileSync(join(history.getStoragePath(), `${oldEntry.id}.json.gz`), gzipSync(JSON.stringify({ entry: oldEntry, messages: [] })));
    const reloaded = new HistoryManager();
    await reloaded.startupTasks;

    expect(reloaded.getEntries().find((entry) => entry.id === oldEntry.id)?.hideFromProjectRail).toBe(true);
    expect(JSON.parse(readFileSync(indexPath, 'utf8')).entries.find((entry: { id: string }) => entry.id === oldEntry.id).hideFromProjectRail)
      .toBeUndefined();
  });

  it('discard suppresses a legacy autosave after restart even when no history archive exists', async () => {
    const { history, side } = await addParent('parent-a');
    await chats.sideChats.send({ chatId: side.id, text: 'Legacy question' });
    const binding = h.db.prepare('SELECT session_id FROM chat_session_bindings WHERE chat_id = ?')
      .get<{ session_id: string }>(side.id)!;
    // Startup clears this link before the sidechat is discarded; the old
    // continuity files still refer to the durable ledger thread and native session.
    h.db.prepare('UPDATE chats SET current_instance_id = NULL WHERE id = ?').run(side.id);
    const lastActivityAt = Date.now() - 1;
    await chats.sideChats.discard(side.id);
    const reloaded = new HistoryManager();
    await reloaded.startupTasks;

    expect(history.getEntries().some((entry) => entry.historyThreadId === side.ledgerThreadId)).toBe(false);
    expect(reloaded.isRecoverySuppressed({ provider: 'claude', historyThreadId: side.ledgerThreadId, lastActivityAt })).toBe(true);
    expect(reloaded.isRecoverySuppressed({ provider: 'claude', sessionId: binding.session_id, lastActivityAt })).toBe(true);
  });

  it.each(['delete', 'clear'] as const)('prevents a pending sidechat creation from surviving history %s', async (action) => {
    const { history, side, entry } = await addParent('parent-a');
    await chats.sideChats.discard(side.id);
    let release!: () => void;
    let started!: () => void;
    const entering = new Promise<void>((resolve) => { started = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const startConversation = h.ledger.startConversation.bind(h.ledger);
    let createdThreadId = '';
    vi.spyOn(h.ledger, 'startConversation').mockImplementationOnce(async (input) => {
      const thread = await startConversation(input);
      createdThreadId = thread.id;
      started();
      await resume;
      return thread;
    });
    const creation = chats.sideChats.create({
      parent: { kind: 'session', historyThreadId: 'parent-a', originNodeId: null },
      selection: { provider: 'claude', model: null }, currentCwd: '/work',
    }).then(() => 'created', () => 'refused');
    await entering;
    if (action === 'delete') await history.deleteEntry(entry.id);
    else await history.clearAll();
    release();

    expect(await creation).toBe('refused');
    expect(chats.listChats({ includeArchived: true })).toEqual([]);
    expect(await h.ledger.getThread(createdThreadId)).toBeNull();
    expect(h.db.prepare('SELECT * FROM side_chat_policies').all()).toEqual([]);
  });

  it('discard deletes the hidden runtime archive as well as the chat conversation', async () => {
    const { history, side, entry } = await addParent('parent-a');
    await chats.sideChats.send({ chatId: side.id, text: 'Explain the work' });
    const runtimeId = chats.tryGetChat(side.id)!.currentInstanceId!;
    const runtime = h.runtimes.getInstance(runtimeId)!;
    const pending = approvals.createRequest({
      instanceId: runtimeId, provider: 'claude', profileId: 'profile-placeholder',
      toolName: 'browser.click', action: 'click', actionClass: 'submit', expiresAt: Date.now() + 60_000,
      proposedGrant: { mode: 'per_action', allowedOrigins: [], allowedActionClasses: ['submit'],
        allowExternalNavigation: false, autonomous: false },
    });
    runtime.outputBuffer = [{ id: 'question', type: 'user', content: 'Explain the work', timestamp: 1 }];
    await history.archiveInstance(runtime);
    expect(history.getEntries()).toHaveLength(2);

    await chats.sideChats.discard(side.id);

    expect(history.getEntries().map((item) => item.id)).toEqual([entry.id]);
    expect(await h.ledger.getThread(side.ledgerThreadId)).toBeNull();
    expect(approvals.getRequest(pending.requestId)?.status).toBe('expired');
  });
});
