import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from './loop-schema';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { parseOutstandingSections } from './loop-stage-markdown';
import { upsertOutstandingSnapshot, listOutstandingItems, recordOutstandingAnswer } from './loop-store-outstanding';
let db: SqliteDriver;
const state = { id: 'run', chatId: 'chat', config: defaultLoopConfig('/repo', 'goal'), status: 'running', totalIterations: 2 } as LoopState;
beforeEach(() => { db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db); });
afterEach(() => db.close());
const capture = (raw: string, round = 1) => upsertOutstandingSnapshot(db, { state, sections: parseOutstandingSections(raw), round });
describe('live outstanding persistence', () => {
  it('reports a changed recommendation on the existing question id', () => {
    capture('## Needs human\n- Which export format?\n  - Recommendation: CSV');
    const id = listOutstandingItems(db)[0].id;
    const result = capture('## Needs human\n- Which export format?\n  - Recommendation: Publish to production', 2);
    expect(result.insertedIds).toEqual([]);
    expect(result.changedIds).toEqual([id]);
  });
  it('sets first round once, keeps answers and status across recapture, and closes removed answers', () => {
    expect(capture('## Needs human\n- Which name?').insertedIds).toHaveLength(1);
    const id = listOutstandingItems(db)[0].id;
    recordOutstandingAnswer(db, id, { response: 'Parser', status: 'open', outcome: 'answered', answerSentAt: 123 });
    expect(capture('## Needs human\n- Which name?', 2).insertedIds).toEqual([]);
    expect(listOutstandingItems(db)[0]).toMatchObject({ firstSeenRound: 1, userResponse: 'Parser', answerSentAt: 123 });
    expect(capture('', 3).closedIds).toEqual([id]);
    expect(listOutstandingItems(db, { status: 'all' })[0]).toMatchObject({ status: 'resolved', outcome: 'answered' });
  });
  it('supersedes truncated prefixes and flags risky applied decisions', () => {
    capture('## Needs human\n- Which export');
    const id = listOutstandingItems(db)[0].id;
    const result = capture('## Needs human\n- Which export format?\n## Decisions applied\n- Buy the paid tier\n  - Applied: Pro.', 2);
    expect(result.closedIds).toContain(id);
    expect(result.flagged).toHaveLength(1);
    expect(listOutstandingItems(db).find(item => item.kind === 'decision-applied')).toMatchObject({ riskClass: 'money' });
    expect(listOutstandingItems(db, { status: 'all' }).find(item => item.id === id)?.outcome).toBe('superseded');
  });
  it('withdraws unanswered items without reopening already settled choices', () => {
    capture('## Needs human\n- Which helper?');
    const id = listOutstandingItems(db)[0].id;
    recordOutstandingAnswer(db, id, { status: 'resolved', outcome: 'kept' });
    capture('## Needs human\n- Which helper?', 2);
    expect(listOutstandingItems(db)).toEqual([]);
    capture('## Needs human\n- Another name?', 3);
    capture('', 4);
    expect(listOutstandingItems(db, { status: 'all' }).find(item => item.text === 'Another name?')?.outcome).toBe('withdrawn');
  });
});
