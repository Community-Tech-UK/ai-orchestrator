import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { GlobalPauseStore } from './global-pause-store';
import { GlobalPauseService } from './global-pause-service';
import { GlobalPauseUnsafeError, type GlobalPauseRuntime, type PauseSessionSnapshot } from './global-pause-runtime.types';

describe('GlobalPauseService', () => {
  let db: SqliteDriver;
  let store: GlobalPauseStore;
  let runtime: GlobalPauseRuntime;
  let service: GlobalPauseService;
  let now: number;
  const session: PauseSessionSnapshot = { id: 'chat', displayName: 'Chat', busy: true, lastRequest: 'Fix export', lastReply: 'Added guard', helperReplies: [] };
  beforeEach(() => {
    db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new GlobalPauseStore(db); now = 100;
    runtime = { sessions: () => [session], engines: async () => [], pauseEngines: async () => undefined, stopHelpers: async () => undefined,
      interruptSession: async () => true,
      collectNote: async () => 'Next step: build', resumeSession: async () => 'chat', resumeEngine: async () => undefined, level: () => 3 };
    service = new GlobalPauseService({ store, runtime, setAdmissionPhase: vi.fn(), now: () => now });
  });
  afterEach(() => { service.shutdown(); db.close(); });

  it('persists hold without expiring it or preventing manual chats', () => {
    service.hold('Held by James'); now += 20 * 86400000; service.sweep();
    expect(service.getState()).toMatchObject({ phase: 'holding', stale: true });
    expect(service.holdsAutomaticInput('chat')).toBe(false);
    service.release(); expect(store.getOpenBatch()).toBeNull();
  });
  it('holds sessions before collecting, then consumes notes exactly once on resume', async () => {
    runtime.collectNote = async () => {
      expect(service.holdsAutomaticInput('chat')).toBe(true);
      return 'Next step: build';
    };
    await service.pauseForRestart({ withNotes: true });
    expect(service.getState()).toMatchObject({ phase: 'ready', completedNotes: 1 });
    expect(service.getState().entries[0]).toMatchObject({ noteKind: 'agent', noteText: 'Next step: build' });
    const resume = vi.spyOn(runtime, 'resumeSession');
    await service.resume(); await service.resume();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(service.getState().phase).toBe('none');
  });
  it('retains captured helper replies even when the provider writes a successful note', async () => {
    runtime.sessions = () => [{ ...session, helperReplies: ['Helper: Unique helper result: export still fails on row 23'] }];
    await service.pauseForRestart({ withNotes: true });
    const saved = service.getState().entries[0];
    expect(saved.noteKind).toBe('agent');
    expect(saved.noteText).toContain('Next step: build');
    expect(saved.noteText).toContain('Unique helper result: export still fails on row 23');
    const resume = vi.spyOn(runtime, 'resumeSession');
    await service.resume();
    expect(resume.mock.calls[0][0].noteText).toContain('Unique helper result: export still fails on row 23');
  });
  it('voids the note when James types while collection is in flight', async () => {
    runtime.collectNote = async () => { service.manualInput('chat'); return 'Stale note'; };
    await service.pauseForRestart({ withNotes: true });
    expect(service.getState().entries[0]).toMatchObject({ state: 'void', noteText: null });
    expect(service.holdsAutomaticInput('chat')).toBe(false);
  });
  it('leaves James new turn alone when he picks up a session while helpers stop', async () => {
    let helpersStarted!: () => void;
    let releaseHelpers!: () => void;
    const started = new Promise<void>((resolve) => { helpersStarted = resolve; });
    const stopped = new Promise<void>((resolve) => { releaseHelpers = resolve; });
    runtime.stopHelpers = async () => { helpersStarted(); await stopped; };
    const interrupt = vi.spyOn(runtime, 'interruptSession');
    const collect = vi.spyOn(runtime, 'collectNote');
    const pausing = service.pauseForRestart({ withNotes: true });
    await started;
    service.manualInput('chat');
    releaseHelpers();
    await pausing;
    expect(interrupt).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(service.getState().entries[0]).toMatchObject({ state: 'void', noteText: null });
    expect(service.holdsAutomaticInput('chat')).toBe(false);
  });
  it('matches a new live session through its saved history identity before binding revival', async () => {
    runtime.sessions = () => [{ ...session, historyThreadId: 'saved-thread' }];
    Object.assign(runtime, { sessionIdentities: () => ['new-live-chat', 'saved-thread'] });
    await service.pauseForRestart({ withNotes: false });
    runtime.sessions = () => [{ ...session, id: 'new-live-chat', historyThreadId: 'saved-thread' }];
    expect(service.getState().heldInstanceIds).toEqual(['chat', 'new-live-chat']);
    expect(service.holdsAutomaticInput('new-live-chat')).toBe(true);
    service.manualInput('new-live-chat');
    expect(service.holdsAutomaticInput('chat')).toBe(false);
    expect(service.getState().entries[0].state).toBe('void');
  });
  it('recovers an interrupted collection with a basic note and waits for manual resume', async () => {
    const batch = store.createBatch('collecting', null, now);
    store.addEntry(batch.id, { kind: 'session', targetId: 'chat', displayName: 'Chat', wasBusy: true });
    service.bootstrap();
    expect(service.getState()).toMatchObject({ phase: 'ready', totalNotes: 1 });
    expect(service.getState().entries[0]).toMatchObject({ noteKind: 'basic', state: 'ready' });
  });
  it('expires notes after fourteen days while leaving recorded engines paused', async () => {
    runtime.engines = async () => [{ kind: 'queue-run', id: 'queue', displayName: 'Queue' }];
    await service.pauseForRestart({ withNotes: false });
    now += 14 * 86400000; service.sweep();
    expect(service.getState().phase).toBe('none');
    expect(service.getState().summary).toContain('stay paused');
  });
  it('isolates revival failures and resumes only recorded engines', async () => {
    runtime.engines = async () => [{ kind: 'loop', id: 'running-loop', displayName: 'Loop' }];
    runtime.resumeSession = async () => { throw new Error('Reopen from History by hand'); };
    const resumeEngine = vi.spyOn(runtime, 'resumeEngine');
    await service.pauseForRestart({ withNotes: false }); await service.resume();
    expect(resumeEngine).toHaveBeenCalledTimes(1);
    expect(service.getState().summary).toContain('1 could not resume');
  });
  it('preserves manual pickup if an in-flight resume then fails', async () => {
    runtime.resumeSession = async () => {
      service.manualInput('chat');
      throw new Error('Cancelled by manual pickup');
    };
    await service.pauseForRestart({ withNotes: false });
    await service.resume();
    expect(service.getState().entries).toEqual([]);
    expect(service.getState().summary).not.toContain('could not resume');
  });
  it('interrupts busy sessions even when notes are skipped', async () => {
    const interrupt = vi.spyOn(runtime, 'interruptSession');
    const collect = vi.spyOn(runtime, 'collectNote');
    await service.pauseForRestart({ withNotes: false });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(collect).not.toHaveBeenCalled();
    expect(service.getState().entries[0]).toMatchObject({ state: 'ready', noteKind: 'basic' });
  });
  it('waits for an empty chat initialization without inventing a continuation task', async () => {
    runtime.sessions = () => [{ ...session, busy: false, waitingForInitialization: true, lastRequest: '', lastReply: '' }];
    const interrupt = vi.spyOn(runtime, 'interruptSession').mockRejectedValueOnce(new GlobalPauseUnsafeError('Initialization is still running'));
    const collect = vi.spyOn(runtime, 'collectNote');
    await expect(service.pauseForRestart({ withNotes: true })).rejects.toThrow('Initialization is still running');
    expect(service.getState().phase).toBe('collecting');
    interrupt.mockResolvedValue(false);
    await service.pauseForRestart({ withNotes: true });
    expect(service.getState().entries[0]).toMatchObject({ state: 'ready', wasBusy: false, noteKind: 'none', noteText: null });
    expect(collect).not.toHaveBeenCalled();
  });
  it('never says safe to restart when a note turn could not stop', async () => {
    runtime.collectNote = async () => { throw new GlobalPauseUnsafeError('Note turn is still running'); };
    await expect(service.pauseForRestart({ withNotes: true })).rejects.toThrow('still running');
    expect(service.getState().phase).toBe('collecting');
    expect(service.getState().summary).toContain('did not finish');
  });
  it('clears an obsolete failure summary when a repeated pause succeeds', async () => {
    vi.spyOn(runtime, 'pauseEngines').mockRejectedValueOnce(new Error('Checkpoint could not finish'));
    await expect(service.pauseForRestart({ withNotes: false })).rejects.toThrow('Checkpoint could not finish');
    expect(service.getState().summary).toContain('did not finish');
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState()).toMatchObject({ phase: 'ready', summary: null });
  });
  it.each([true, false])('rearms picked-up busy work on explicit repeat pause (notes %s)', async (withNotes) => {
    const interrupt = vi.spyOn(runtime, 'interruptSession');
    await service.pauseForRestart({ withNotes: true });
    const id = service.getState().entries[0].id;
    service.manualInput('chat');
    runtime.sessions = () => [{ ...session, lastRequest: 'New task', helperReplies: ['New helper progress'] }];
    runtime.collectNote = async () => 'Updated note';
    await service.pauseForRestart({ withNotes });
    expect(service.holdsAutomaticInput('chat')).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(service.getState().entries[0]).toMatchObject({ id, wasBusy: true, state: 'ready', noteKind: withNotes ? 'agent' : 'basic' });
    expect(service.getState().entries[0].noteText).toContain(withNotes ? 'Updated note' : 'New task');
    expect(service.getState().entries[0].noteText).toContain('New helper progress');
  });
  it('refreshes picked-up idle and newly busy ready snapshots', async () => {
    await service.pauseForRestart({ withNotes: false });
    service.manualInput('chat');
    runtime.sessions = () => [{ ...session, busy: false, displayName: 'Renamed' }];
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().entries[0]).toMatchObject({ wasBusy: false, displayName: 'Renamed', noteText: null, state: 'ready' });
    runtime.sessions = () => [{ ...session, lastRequest: 'New busy task' }];
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().entries[0]).toMatchObject({ wasBusy: true, state: 'ready' });
    expect(service.getState().entries[0].noteText).toContain('New busy task');
  });
  it.each(['historyThreadId', 'providerSessionId'] as const)('reuses a saved entry for a new runtime identity matching %s', async (identity) => {
    runtime.sessions = () => [{ ...session, [identity]: 'shared-identity' }];
    await service.pauseForRestart({ withNotes: true });
    const original = service.getState().entries[0];
    runtime.sessions = () => [{ ...session, id: 'revived-chat', [identity]: 'shared-identity' }];
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().entries).toHaveLength(1);
    expect(service.getState().entries[0]).toMatchObject({ id: original.id, targetId: 'revived-chat', originalInstanceId: 'chat' });
    const resume = vi.spyOn(runtime, 'resumeSession');
    await service.resume();
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it('preserves saved notes for absent sessions and untouched held idle sessions', async () => {
    runtime.sessions = () => [session, { ...session, id: 'absent' }];
    await service.pauseForRestart({ withNotes: true });
    const saved = service.getState().entries;
    runtime.sessions = () => [{ ...session, busy: false }];
    const collect = vi.spyOn(runtime, 'collectNote');
    await service.pauseForRestart({ withNotes: true });
    expect(service.getState().entries).toEqual(saved);
    expect(collect).not.toHaveBeenCalled();
  });
  it('preserves pickup triggered by the new collecting state notification', async () => {
    await service.pauseForRestart({ withNotes: true });
    let pickedUp = false;
    service.on('state-changed', (state) => {
      if (state.phase === 'collecting' && !pickedUp) { pickedUp = true; service.manualInput('chat'); }
    });
    await service.pauseForRestart({ withNotes: true });
    expect(service.getState().entries[0].state).toBe('void');
  });
  it('preserves a new pickup while a repeated pause waits for helpers', async () => {
    await service.pauseForRestart({ withNotes: true });
    service.manualInput('chat');
    let started!: () => void, stopped!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { stopped = resolve; });
    runtime.stopHelpers = async () => { started(); await release; };
    const interrupt = vi.spyOn(runtime, 'interruptSession');
    const pausing = service.pauseForRestart({ withNotes: true });
    await waiting;
    service.manualInput('chat'); stopped(); await pausing;
    expect(service.getState().entries[0].state).toBe('void');
    expect(interrupt).not.toHaveBeenCalled();
  });
  it('rearms only running engine snapshots and keeps absent paused engines recorded', async () => {
    runtime.engines = async () => [{ kind: 'loop', id: 'loop', displayName: 'Old loop' }, { kind: 'queue-run', id: 'queue', displayName: 'Queue' }];
    await service.pauseForRestart({ withNotes: false });
    service.voidTarget('loop', 'finished');
    runtime.engines = async () => [{ kind: 'loop', id: 'loop', displayName: 'Running again' }];
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().entries.find((entry) => entry.targetId === 'loop')).toMatchObject({ state: 'pending', displayName: 'Running again', voidReason: null });
    const resume = vi.spyOn(runtime, 'resumeEngine');
    await service.resume();
    expect(resume.mock.calls.map(([entry]) => entry.targetId).sort()).toEqual(['loop', 'queue']);
  });
  it('records new sessions into the existing batch when Pause is pressed again', async () => {
    await service.pauseForRestart({ withNotes: false });
    const batchId = service.getState().batchId;
    runtime.sessions = () => [session, { ...session, id: 'new-chat' }];
    await service.pauseForRestart({ withNotes: false });
    expect(service.getState().batchId).toBe(batchId);
    expect(service.holdsAutomaticInput('new-chat')).toBe(true);
    expect(service.getState().entries).toHaveLength(2);
  });
  it('waits for every note worker before exposing a failed collection for retry', async () => {
    runtime.sessions = () => [session, { ...session, id: 'other-chat' }];
    let releaseOther!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseOther = resolve; });
    runtime.collectNote = async (snapshot) => {
      if (snapshot.id === 'chat') throw new GlobalPauseUnsafeError('Could not stop chat');
      await waiting;
      return 'Saved other note';
    };
    let finished = false;
    const collecting = service.pauseForRestart({ withNotes: true }).catch(() => { finished = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(service.getState().phase).toBe('collecting');
    releaseOther(); await collecting;
    expect(finished).toBe(true);
  });
  it('retains failed session names and reasons after consuming the batch', async () => {
    runtime.resumeSession = async () => { throw new Error('Reopen from History'); };
    await service.pauseForRestart({ withNotes: false }); await service.resume();
    expect(service.getState().entries[0]).toMatchObject({ displayName: 'Chat', state: 'failed', voidReason: 'Reopen from History', noteText: null });
    expect(service.holdsAutomaticInput('chat')).toBe(false);
  });
  it('keeps an already collected agent note when boot repairs a collecting batch', () => {
    const batch = store.createBatch('collecting', null);
    const entry = store.addEntry(batch.id, { kind: 'session', targetId: 'chat', displayName: 'Chat', wasBusy: true });
    store.setEntry(entry.id, { noteText: 'Agent note', noteKind: 'agent', state: 'ready' });
    service.bootstrap();
    expect(service.getState().entries[0]).toMatchObject({ noteText: 'Agent note', noteKind: 'agent' });
  });
});
