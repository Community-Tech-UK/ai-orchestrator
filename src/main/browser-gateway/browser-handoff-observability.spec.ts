import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAuditEntrySchema } from '@contracts/schemas/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserAuditStore } from './browser-audit-store';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import { BrowserGatewayResultRecorder } from './browser-gateway-result';
import { makeService } from './browser-gateway-service.test-helpers';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => logs }));

const queueKey = 'node:windows-pc';
const pollOptions = { timeoutMs: 10_000, deferHandoffConfirmation: true };
const tab = {
  profileId: 'existing-tab:7:42', targetId: 'existing-tab:7:42:target',
  nodeId: 'windows-pc', title: 'Example', url: 'https://example.com/', origin: 'https://example.com',
  allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'example.com', includeSubdomains: false }],
};
const request = { instanceId: 'reader-1', provider: 'codex', profileId: tab.profileId, targetId: tab.targetId };

describe('browser handoff observability', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let commands: BrowserExtensionCommandStore;
  let db: SqliteDriver;
  let audit: BrowserAuditStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.clearAllMocks();
    commands = new BrowserExtensionCommandStore();
    db = rlmTemplate.open();
    audit = new BrowserAuditStore(db);
  });

  afterEach(() => {
    commands.rejectQueue(queueKey, 'fixture_cleanup');
    db.close();
    vi.useRealTimers();
  });

  function gateway() {
    const fixture = makeService({ existingTab: tab, extensionCommandStore: commands });
    fixture.auditStore.record.mockImplementation((entry) => audit.record(entry));
    fixture.auditStore.list.mockImplementation(() => audit.list({}));
    return fixture.service;
  }

  it('joins the original command to one durable audit row after a failed handoff and FIFO-head redelivery', async () => {
    const service = gateway();
    const read = service.queryElements({ ...request, query: 'private page query' });
    const first = await commands.pollCommand(queueKey, pollOptions);
    expect(first).not.toBeNull();
    const laterRead = service.queryElements({ ...request, instanceId: 'reader-2' });
    const replacementPoll = commands.pollCommand(queueKey, pollOptions);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(commands.requeueUndeliveredCommand(queueKey, first!.id)).toBe(true);
    const redelivered = await replacementPoll;
    expect(redelivered!.id).toBe(first!.id);
    commands.confirmCommandHandoff(queueKey, redelivered!.id);
    commands.markReceived(queueKey, redelivered!.id);
    commands.resolveCommand({ queueKey, commandId: redelivered!.id, ok: true, result: [] });
    const result = await read;
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect(result).not.toHaveProperty('requestId');

    const later = await commands.pollCommand(queueKey, pollOptions);
    commands.confirmCommandHandoff(queueKey, later!.id);
    commands.markReceived(queueKey, later!.id);
    commands.resolveCommand({ queueKey, commandId: later!.id, ok: true, result: [] });
    await laterRead;
    // Duplicate results are visible but cannot resolve/audit the tool twice.
    commands.resolveCommand({ queueKey, commandId: first!.id, ok: true, result: ['private page result'] });
    commands.resolveCommand({ queueKey, commandId: 'non_identifier_page_content', ok: false, error: 'private page error' });
    const rows = audit.list({}).filter((row) => row.commandId === first!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.auditId, commandId: first!.id, instanceId: 'reader-1' });
    expect(BrowserAuditEntrySchema.parse(rows[0])).toMatchObject({ commandId: first!.id });
    const exposed = await service.getAuditLog({ ...request });
    expect(exposed.data).toEqual(expect.arrayContaining([expect.objectContaining({ commandId: first!.id })]));

    expect(logs.info).toHaveBeenCalledWith('Browser command requeued at FIFO head', expect.objectContaining({
      commandId: first!.id, queueKey, queuePosition: 0, queuedCount: 2,
      nextCommandId: later!.id, undeliveredDeadlineAt: first!.createdAt + 90_000, remainingMs: 89_000,
    }));
    expect(logs.info).toHaveBeenCalledWith('Browser command received', expect.objectContaining({ commandId: first!.id }));
    expect(logs.info).toHaveBeenCalledWith('Browser command result', expect.objectContaining({ commandId: first!.id, accepted: true, ok: true }));
    expect(logs.info).toHaveBeenCalledWith('Browser command result', expect.objectContaining({ commandId: first!.id, accepted: false, ok: true }));
    const dispatches = logs.info.mock.calls.filter(([event, detail]) => event === 'Browser command dispatched' && detail.commandId === first!.id);
    expect(dispatches.map(([, detail]) => detail.deliveryAttempt)).toEqual([1, 2]);
    expect(logs.info.mock.calls.filter(([event, detail]) => event === 'Browser command received' && detail.commandId === first!.id)).toHaveLength(1);
    expect(first).not.toHaveProperty('onQueued');
    expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(/private page query|private page result|private page error|non_identifier_page_content|https:\/\/example/);
  });

  it('surfaces a broken correlation callback without leaving a live command or timer', async () => {
    await expect(commands.sendCommand({
      queueKey, command: 'query_elements', onQueued: () => { throw new Error('fixture_callback_failed'); },
    })).rejects.toThrow('fixture_callback_failed');
    expect(commands.describeQueue(queueKey)).toMatchObject({ queuedCount: 0, inFlightCount: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes duplicate and late receipts without granting another execution window', async () => {
    const pending = commands.sendCommand({ queueKey, command: 'query_elements', timeoutMs: 2_000 });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_timeout');
    const command = await commands.pollCommand(queueKey, pollOptions);
    commands.confirmCommandHandoff(queueKey, command!.id);
    commands.markReceived(queueKey, command!.id);
    await vi.advanceTimersByTimeAsync(1_500);
    commands.markReceived(queueKey, command!.id);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    commands.markReceived(queueKey, command!.id);
    const receipts = logs.info.mock.calls.filter(([event, detail]) => event === 'Browser command received' && detail.commandId === command!.id);
    expect(receipts.map(([, detail]) => detail.accepted)).toEqual([true, false, false]);
    commands.markReceived(queueKey, 'non_identifier_page_content');
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('non_identifier_page_content');
  });

  it('removes a requeued copy when a delayed original receipt makes execution ambiguous', async () => {
    const pending = commands.sendCommand({ queueKey, command: 'query_elements' });
    void pending.catch(() => undefined);
    const first = await commands.pollCommand(queueKey, pollOptions);
    expect(commands.requeueUndeliveredCommand(queueKey, first!.id)).toBe(true);
    commands.markReceived(queueKey, first!.id);
    expect(commands.describeQueue(queueKey)).toMatchObject({ queuedCount: 0, inFlightCount: 1 });
    expect(commands.requeueUndeliveredCommand(queueKey, first!.id)).toBe(false);
    const poll = commands.pollCommand(queueKey, { timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(poll).resolves.toBeNull();
    commands.resolveCommand({ queueKey, commandId: first!.id, ok: true, result: [] });
    await expect(pending).resolves.toEqual([]);
  });

  it('keeps concurrent out-of-order successful and failed reads attached to their own commands', async () => {
    const service = gateway();
    const firstRead = service.queryElements(request);
    const first = await commands.pollCommand(queueKey, pollOptions);
    commands.confirmCommandHandoff(queueKey, first!.id);
    const secondRead = service.queryElements({ ...request, instanceId: 'reader-2' });
    const second = await commands.pollCommand(queueKey, pollOptions);
    commands.confirmCommandHandoff(queueKey, second!.id);
    commands.resolveCommand({ queueKey, commandId: second!.id, ok: false, error: 'fixture_read_failed' });
    commands.resolveCommand({ queueKey, commandId: first!.id, ok: true, result: [] });
    const [firstResult, secondResult] = await Promise.all([firstRead, secondRead]);
    expect(audit.list({})).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstResult.auditId, commandId: first!.id, instanceId: 'reader-1', outcome: 'succeeded' }),
      expect.objectContaining({ id: secondResult.auditId, commandId: second!.id, instanceId: 'reader-2', outcome: 'failed' }),
    ]));
  });

  it('records a queued read failure against its command and leaves denied reads unassigned', async () => {
    const service = gateway();
    const read = service.queryElements(request);
    await vi.advanceTimersByTimeAsync(90_000);
    const result = await read;
    const row = audit.list({}).find((entry) => entry.id === result.auditId)!;
    expect(row).toMatchObject({ outcome: 'failed', commandId: expect.any(String) });
    expect(commands.describeQueue(queueKey).queuedCount).toBe(0);

    const deniedService = makeService({ existingTab: { ...tab, allowedOrigins: [] }, extensionCommandStore: commands });
    const denied = await deniedService.service.queryElements(request);
    expect(denied).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(deniedService.audits[0].commandId).toBeUndefined();
  });

  it('refuses a replay after a receipt, and preserves the original deadline through repeated unsent handoffs', async () => {
    const pending = commands.sendCommand({ queueKey, command: 'query_elements', undeliveredWaitMs: 90_000 });
    const rejected = expect(pending).rejects.toThrow('browser_extension_command_not_delivered');
    const first = await commands.pollCommand(queueKey, pollOptions);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commands.requeueUndeliveredCommand(queueKey, first!.id)).toBe(true);
    const second = await commands.pollCommand(queueKey, pollOptions);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(commands.requeueUndeliveredCommand(queueKey, second!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(70_000);
    await rejected;
    expect(commands.describeQueue(queueKey).queuedCount).toBe(0);

    const received = commands.sendCommand({ queueKey, command: 'query_elements' });
    const command = await commands.pollCommand(queueKey, pollOptions);
    commands.markReceived(queueKey, command!.id);
    expect(commands.requeueUndeliveredCommand(queueKey, command!.id)).toBe(false);
    commands.confirmCommandHandoff(queueKey, command!.id);
    commands.resolveCommand({ queueKey, commandId: command!.id, ok: true, result: [] });
    await received;
    expect(logs.info).toHaveBeenCalledWith('Browser command requeue refused', expect.objectContaining({
      commandId: command!.id, reason: 'receipt_received',
    }));
  });

  it('keeps approval request IDs independent and accepts historical audit rows without a command', () => {
    const recorder = new BrowserGatewayResultRecorder(audit);
    const result = recorder.record({
      context: request, action: 'click', toolName: 'browser.click', actionClass: 'input',
      decision: 'requires_user', outcome: 'not_run', summary: 'Approval required', data: null,
      requestId: 'approval-request', commandId: 'command-placeholder',
    });
    expect(result.requestId).toBe('approval-request');
    const row = audit.list({})[0];
    expect(BrowserAuditEntrySchema.parse(row)).toMatchObject({ requestId: 'approval-request', commandId: 'command-placeholder' });
    const { commandId, ...historical } = row;
    void commandId;
    expect(BrowserAuditEntrySchema.safeParse(historical).success).toBe(true);
  });
});
