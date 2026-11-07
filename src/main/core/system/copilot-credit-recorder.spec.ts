import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCreditRecorder } from './copilot-credit-recorder';
import { CostTracker } from './cost-tracker';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import type { Instance } from '../../../shared/types/instance.types';
describe('Copilot credit recorder', () => {
  let home: string;
  const instance = { id: 'i', provider: 'copilot', sessionId: 's', currentModel: 'gpt', executionLocation: { type: 'local' } } as Instance;
  const checkpoint = (id: string, total: number, premium = 1) => JSON.stringify({ id, type: 'session.usage_checkpoint',
    timestamp: '2026-10-20T12:00:00Z', data: { totalNanoAiu: total, totalPremiumRequests: premium, modelCacheState: [] } }) + '\n';
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'credit-')); await mkdir(join(home, 'session-state', 's'), { recursive: true }); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  it('books a fresh total, the next delta and no duplicate checkpoint', async () => {
    const tracker = new CostTracker();
    const recorder = new CopilotCreditRecorder({ tracker, resolveHome: () => home, delay: async () => undefined });
    const file = join(home, 'session-state', 's', 'events.jsonl');
    await writeFile(file, checkpoint('one', 4e9));
    await recorder.bookAfterTurn(instance, undefined);
    await writeFile(file, checkpoint('one', 4e9) + checkpoint('two', 7e9, 2));
    await Promise.all([recorder.bookAfterTurn(instance, undefined), recorder.bookAfterTurn(instance, undefined)]);
    expect(tracker.getSummary().totalAiCreditsNano).toBe(7e9);
    expect(tracker.getEntries()).toHaveLength(2);
  });
  it('seeds a resumed session from previous and a restarted recorder from the database', async () => {
    const db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    try {
      const tracker = new CostTracker(); tracker.setDatabase(db);
      const file = join(home, 'session-state', 's', 'events.jsonl');
      await writeFile(file, checkpoint('old', 10e9, 10) + checkpoint('new', 12e9, 11));
      const options = { tracker, resolveHome: () => home, delay: async () => undefined };
      await new CopilotCreditRecorder(options).bookAfterTurn(instance, undefined);
      expect(tracker.getSummary().totalAiCreditsNano).toBe(2e9);
      const restored = new CostTracker(); restored.setDatabase(db);
      await new CopilotCreditRecorder({ ...options, tracker: restored }).bookAfterTurn(instance, undefined);
      expect(restored.getEntries()).toHaveLength(1);
      expect(restored.getEntries()[0].aiCreditsNano).toBe(2e9);
    } finally { db.close(); }
  });
  it('retries a stale checkpoint once and picks up the post-reply write', async () => {
    const tracker = new CostTracker();
    const file = join(home, 'session-state', 's', 'events.jsonl');
    await writeFile(file, checkpoint('a', 1e9));
    const recorder = new CopilotCreditRecorder({ tracker, resolveHome: () => home,
      delay: async () => { await writeFile(file, checkpoint('a', 1e9) + checkpoint('b', 3e9)); } });
    await recorder.bookAfterTurn(instance, undefined);
    await recorder.bookAfterTurn(instance, undefined);
    expect(tracker.getSummary().totalAiCreditsNano).toBe(3e9);
  });
  it('fails softly for missing files and ignores remote sessions', async () => {
    const tracker = new CostTracker();
    const recorder = new CopilotCreditRecorder({ tracker, resolveHome: () => home });
    await expect(recorder.bookAfterTurn(instance, undefined)).resolves.toBeUndefined();
    await recorder.bookAfterTurn({ ...instance, executionLocation: { type: 'remote', nodeId: 'worker' } } as Instance, undefined);
    expect(tracker.getEntries()).toEqual([]);
  });
  it('books the delta from a previous checkpoint that sits past the first 256 KiB of the tail', async () => {
    const tracker = new CostTracker();
    const recorder = new CopilotCreditRecorder({ tracker, resolveHome: () => home, delay: async () => undefined });
    const file = join(home, 'session-state', 's', 'events.jsonl');
    const filler = JSON.stringify({ type: 'tool_use', data: 'x'.repeat(300 * 1024) }) + '\n';
    await writeFile(file, checkpoint('previous', 1e9) + filler + checkpoint('current', 2e9));
    await recorder.bookAfterTurn(instance, undefined);
    expect(tracker.getSummary().totalAiCreditsNano).toBe(1e9);
  });
  it('never backfills the running total when the previous checkpoint is beyond the 1 MiB tail', async () => {
    const tracker = new CostTracker();
    const recorder = new CopilotCreditRecorder({ tracker, resolveHome: () => home, delay: async () => undefined });
    const file = join(home, 'session-state', 's', 'events.jsonl');
    const filler = JSON.stringify({ type: 'tool_use', data: 'x'.repeat(1300 * 1024) }) + '\n';
    await writeFile(file, checkpoint('first', 1e9) + filler + checkpoint('current', 2e9));
    await recorder.bookAfterTurn(instance, undefined);
    expect(tracker.getEntries()).toEqual([]);
    await writeFile(file, checkpoint('first', 1e9) + filler + checkpoint('current', 2e9) + checkpoint('next', 3e9));
    await recorder.bookAfterTurn(instance, undefined);
    expect(tracker.getSummary().totalAiCreditsNano).toBe(1e9);
    expect(tracker.getEntries()).toHaveLength(1);
  });
});
