import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runLoopMigrations } from '../../orchestration/loop-schema';
import { LoopStore } from '../../orchestration/loop-store';
import { defaultLoopConfig, type LoopState } from '../../../shared/types/loop.types';
import { parseOutstandingSections } from '../../orchestration/loop-stage-markdown';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('./loop-transcript-dispatch', () => ({ appendLoopStartPrompt: vi.fn(), appendLoopInterveneMessage: vi.fn() }));
import { answerOutstanding } from './loop-outstanding-handlers';
import { appendLoopInterveneMessage } from './loop-transcript-dispatch';
it('rejects a stale suggestion without recording or sending the replacement as human authority', () => {
  const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
  const store = new LoopStore(db);
  const state = { id: 'run', chatId: 'chat', status: 'running', endedAt: null, config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  const capture = (recommendation: string) => store.upsertOutstandingSnapshot({ state, round: 1, sections: parseOutstandingSections(`## Needs human\n- Which export format?\n  - Recommendation: ${recommendation}`) });
  capture('CSV'); const id = store.listOutstandingItems()[0].id;
  capture('Publish to production');
  const intervene = vi.fn();
  const deps = { store, coordinator: { intervene, getLoop: () => state }, send: vi.fn(), chatService: {}, instanceManager: {} } as unknown as Parameters<typeof answerOutstanding>[1];
  try {
    expect(() => answerOutstanding({ id, action: 'use-suggestion', expectedRecommendation: 'CSV' }, deps)).toThrow(/changed/);
    expect(intervene).not.toHaveBeenCalled();
    expect(store.getOutstandingItem(id)?.userResponse).toBeNull();
  } finally { db.close(); }
});
it.each([{ action: 'use-suggestion', heading: 'Needs human' }, { action: 'keep', heading: 'Decisions applied' }] as const)('rejects changed low-risk content for $action too', ({ action, heading }) => {
  const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
  const store = new LoopStore(db);
  const state = { id: 'run', chatId: 'chat', status: 'running', endedAt: null, config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  const capture = (recommendation: string) => store.upsertOutstandingSnapshot({ state, round: 1, sections: parseOutstandingSections(`## ${heading}\n- Which export format?\n  - Recommendation: ${recommendation}`) });
  capture('CSV'); const id = store.listOutstandingItems()[0].id; capture('JSON');
  const intervene = vi.fn();
  const deps = { store, coordinator: { intervene, getLoop: () => state }, send: vi.fn(), chatService: {}, instanceManager: {} } as unknown as Parameters<typeof answerOutstanding>[1];
  try {
    expect(() => answerOutstanding({ id, action, expectedRecommendation: 'CSV' }, deps)).toThrow(/changed/);
    expect(intervene).not.toHaveBeenCalled();
    expect(store.getOutstandingItem(id)).toMatchObject({ status: 'open', userResponse: null });
  } finally { db.close(); }
});
it('sends a live suggestion through human direction while keeping it open, or saves for ended runs', () => {
  const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
  const store = new LoopStore(db);
  const state = { id: 'run', chatId: 'chat', status: 'running', endedAt: null, config: defaultLoopConfig('/repo', 'goal') } as LoopState;
  store.upsertOutstandingSnapshot({ state, round: 1, sections: parseOutstandingSections('## Needs human\n- Which helper?\n  - Recommendation: existing helper') });
  const id = store.listOutstandingItems()[0].id;
  const intervene = vi.fn().mockReturnValue(true); const getLoop = vi.fn().mockReturnValue(state); const send = vi.fn();
  const deps = { store, coordinator: { intervene, getLoop }, send, chatService: {}, instanceManager: {} } as unknown as Parameters<typeof answerOutstanding>[1];
  try {
    expect(answerOutstanding({ id, action: 'use-suggestion', expectedRecommendation: 'existing helper' }, deps)).toEqual({ ok: true, delivery: 'sent-to-loop' });
    expect(intervene).toHaveBeenCalledWith('run', expect.stringContaining('accepted your recommendation: existing helper'), 'queue', undefined, 'human');
    expect(store.getOutstandingItem(id)).toMatchObject({ userResponse: 'existing helper', status: 'open', answerSentAt: expect.any(Number) });
    expect(appendLoopInterveneMessage).toHaveBeenCalled();
    getLoop.mockReturnValue(undefined); intervene.mockClear();
    expect(answerOutstanding({ id, action: 'answer', response: 'Different helper', expectedRecommendation: 'existing helper' }, deps)).toEqual({ ok: true, delivery: 'saved-for-resume' });
    expect(intervene).not.toHaveBeenCalled();
    expect(store.getOutstandingItem(id)?.userResponse).toBe('Different helper');
    store.upsertOutstandingSnapshot({ state, round: 2, sections: parseOutstandingSections('## Decisions applied\n- Choose local helper naming\n  - Applied: Existing style.') });
    const applied = store.listOutstandingItems()[0];
    getLoop.mockReturnValue(state);
    expect(answerOutstanding({ id: applied.id, action: 'undo', response: 'Use shorter names', expectedRecommendation: applied.recommendedAnswer }, deps).delivery).toBe('sent-to-loop');
    expect(store.getOutstandingItem(applied.id)).toMatchObject({ status: 'open', outcome: 'undone' });
    expect(intervene.mock.calls.at(-1)).toEqual(['run', expect.stringContaining('Use shorter names'), 'queue', undefined, 'human']);
    expect(answerOutstanding({ id: applied.id, action: 'keep', expectedRecommendation: applied.recommendedAnswer }, deps)).toEqual({ ok: true, delivery: 'recorded' });
    expect(store.getOutstandingItem(applied.id)).toMatchObject({ status: 'resolved', outcome: 'kept' });

  } finally { db.close(); }
});
