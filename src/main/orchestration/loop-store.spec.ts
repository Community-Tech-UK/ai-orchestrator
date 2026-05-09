/**
 * Unit tests for the main-process `LoopStore` — focused on the
 * read-side parsing that surfaces `initialPrompt` / `iterationPrompt`
 * from the persisted `config_json` blob.
 *
 * Uses an in-memory better-sqlite3 database (`:memory:`) so the tests
 * are self-contained and don't touch the user's app data dir. Schema is
 * applied via `runLoopMigrations` exactly as in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  LoopConfig,
  LoopState,
} from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { runLoopMigrations } from './loop-schema';
import { LoopStore } from './loop-store';

let driver: SqliteDriver;
let store: LoopStore;

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  const config: LoopConfig = {
    ...defaultLoopConfig('/tmp/project', 'goal-of-the-loop'),
    iterationPrompt: 'continue toward the goal',
  };
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config,
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_120_000,
    totalIterations: 4,
    totalTokens: 5_000,
    totalCostCents: 42,
    currentStage: 'IMPLEMENT',
    completedFileRenameObserved: false,
    highestTestPassCount: 0,
    endReason: 'all done',
    pendingInterventions: [],
    tokensSinceLastTestImprovement: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}

beforeEach(() => {
  driver = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(driver);
  store = new LoopStore(driver);
});

afterEach(() => {
  driver.close();
});

describe('LoopStore.getRunSummary', () => {
  it('parses initialPrompt + iterationPrompt out of config_json', () => {
    store.upsertRun(makeState());

    const summary = store.getRunSummary('loop-1');

    expect(summary).not.toBeNull();
    expect(summary?.initialPrompt).toBe('goal-of-the-loop');
    expect(summary?.iterationPrompt).toBe('continue toward the goal');
    expect(summary?.totalIterations).toBe(4);
    expect(summary?.endReason).toBe('all done');
  });

  it('returns iterationPrompt=null when the loop reused initialPrompt', () => {
    const state = makeState();
    state.config.iterationPrompt = undefined;
    store.upsertRun(state);

    const summary = store.getRunSummary('loop-1');

    expect(summary?.iterationPrompt).toBeNull();
  });

  it('returns iterationPrompt=null when the persisted value is empty', () => {
    const state = makeState();
    state.config.iterationPrompt = '';
    store.upsertRun(state);

    expect(store.getRunSummary('loop-1')?.iterationPrompt).toBeNull();
  });

  it('returns null when the run id is unknown', () => {
    expect(store.getRunSummary('nope')).toBeNull();
  });

  it('falls back to empty prompts when config_json is corrupt rather than throwing', () => {
    // Insert a row with deliberately broken config_json so we can verify
    // the JSON.parse failure path. The schema's NOT NULL constraint
    // prevents writing null, so we use a non-JSON string.
    driver.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason, end_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-broken',
      'chat-1',
      null,
      '{ this-is-not-valid-json',
      'error',
      1,
      2,
      0,
      0,
      0,
      'IMPLEMENT',
      0,
      0,
      null,
      null,
    );

    const summary = store.getRunSummary('loop-broken');

    expect(summary).not.toBeNull();
    expect(summary?.initialPrompt).toBe('');
    expect(summary?.iterationPrompt).toBeNull();
  });
});

describe('LoopStore.listRunsForChat', () => {
  it('returns runs newest-first with prompts populated', () => {
    store.upsertRun(makeState({ id: 'loop-1', startedAt: 1, totalIterations: 1 }));
    store.upsertRun(makeState({ id: 'loop-2', startedAt: 2, totalIterations: 2 }));
    store.upsertRun(makeState({ id: 'loop-3', startedAt: 3, totalIterations: 3 }));

    const runs = store.listRunsForChat('chat-1');

    expect(runs.map((r) => r.id)).toEqual(['loop-3', 'loop-2', 'loop-1']);
    for (const run of runs) {
      expect(run.initialPrompt).toBe('goal-of-the-loop');
      expect(run.iterationPrompt).toBe('continue toward the goal');
    }
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.upsertRun(makeState({ id: `loop-${i}`, startedAt: i }));
    }
    expect(store.listRunsForChat('chat-1', 2)).toHaveLength(2);
  });

  it('returns an empty array when no runs exist for the chat', () => {
    store.upsertRun(makeState({ id: 'loop-x', chatId: 'chat-other' }));
    expect(store.listRunsForChat('chat-1')).toEqual([]);
  });
});
