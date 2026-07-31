import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { GovernedProposalStore, getGovernedProposalStore } from '../memory/governed-proposal-store';
import { GovernedProposalService, getGovernedProposalService } from '../memory/governed-proposal-service';
import { _resetLessonStoreForTesting, getLessonStore } from '../memory/lesson-store';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { registerGovernedProposalHandlers } from './governed-proposal-ipc-handler';

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

type RegisteredHandler = (...args: unknown[]) => unknown;

function handlerFor(channel: string): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as RegisteredHandler;
}

let db: SqliteDriver;

function openMigratedDb(): SqliteDriver {
  const database = defaultDriverFactory(':memory:');
  createTables(database);
  createMigrationsTable(database);
  runMigrations(database);
  return database;
}

describe('registerGovernedProposalHandlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    GovernedProposalStore._resetForTesting();
    GovernedProposalService._resetForTesting();
    _resetLessonStoreForTesting();
    db = openMigratedDb();
    getGovernedProposalStore()._bindDatabaseForTesting(db);
    registerGovernedProposalHandlers();
  });

  afterEach(() => {
    db.close();
  });

  it('lists proposals, defaulting to no filters', async () => {
    getLessonStore().capture('Always validate config before startup');
    getGovernedProposalService().captureMemoryProposal({ text: 'Always validate config before startup' });

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_LIST)(fakeEvent, undefined);
    expect(result).toMatchObject({ success: true });
    expect((result as { data: unknown[] }).data).toHaveLength(1);
  });

  it('rejects an invalid list payload', async () => {
    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_LIST)(fakeEvent, { kind: 'not-a-kind' });
    expect(result).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('gets a proposal with its audit trail', async () => {
    getLessonStore().capture('Prefer const bindings');
    const captured = getGovernedProposalService().captureMemoryProposal({ text: 'Prefer const bindings' })!;

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_GET)(fakeEvent, { id: captured.proposal.id });
    expect(result).toMatchObject({ success: true });
    const data = (result as { data: { proposal: { id: string }; audit: { action: string }[] } }).data;
    expect(data.proposal.id).toBe(captured.proposal.id);
    expect(data.audit.map((a) => a.action)).toEqual(['created']);
  });

  it('returns a structured not-found error for an unknown id', async () => {
    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_GET)(fakeEvent, { id: 'missing' });
    expect(result).toMatchObject({ success: false, error: { code: 'GOVERNED_PROPOSAL_NOT_FOUND' } });
  });

  it('approve() promotes the linked lesson and returns the decided proposal', async () => {
    getLessonStore().capture('Batch writes to reduce IO');
    const captured = getGovernedProposalService().captureMemoryProposal({ text: 'Batch writes to reduce IO' })!;

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE)(fakeEvent, {
      id: captured.proposal.id,
      actor: 'james',
      rationale: 'solid pattern',
    });

    expect(result).toMatchObject({ success: true, data: { status: 'approved', decidedBy: 'james' } });
    expect(getLessonStore().findActiveByNormalizedText('batch writes to reduce io')?.provenance).toBe('user-approved');
  });

  it('approve() on an unknown id returns the typed NOT_FOUND error code', async () => {
    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE)(fakeEvent, {
      id: 'missing',
      actor: 'james',
    });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('approve() on an already-decided proposal returns ALREADY_DECIDED (idempotent-decision guard)', async () => {
    getLessonStore().capture('Deduplicate identical retries');
    const captured = getGovernedProposalService().captureMemoryProposal({ text: 'Deduplicate identical retries' })!;
    await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE)(fakeEvent, { id: captured.proposal.id, actor: 'james' });

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE)(fakeEvent, { id: captured.proposal.id, actor: 'james' });
    expect(result).toMatchObject({ success: false, error: { code: 'ALREADY_DECIDED' } });
  });

  it('reject() deprecates the linked lesson and returns the decided proposal', async () => {
    getLessonStore().capture('Skip caching for one-off scripts');
    const captured = getGovernedProposalService().captureMemoryProposal({ text: 'Skip caching for one-off scripts' })!;

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_REJECT)(fakeEvent, {
      id: captured.proposal.id,
      actor: 'james',
      rationale: 'too narrow',
    });

    expect(result).toMatchObject({ success: true, data: { status: 'rejected' } });
    expect(getLessonStore().findActiveByNormalizedText('skip caching for one-off scripts')).toBeUndefined();
  });

  it('rejects an approve payload missing the required actor field', async () => {
    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_APPROVE)(fakeEvent, { id: 'p1' });
    expect(result).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('honours ensureTrustedSender before touching state', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const trustError = { success: false, error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 } };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerGovernedProposalHandlers({ ensureTrustedSender });

    const result = await handlerFor(IPC_CHANNELS.GOVERNED_PROPOSAL_LIST)(fakeEvent, undefined);
    expect(result).toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(fakeEvent, IPC_CHANNELS.GOVERNED_PROPOSAL_LIST);
  });
});
