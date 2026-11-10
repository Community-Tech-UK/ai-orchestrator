import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { _resetCostAttributionForTesting } from './cost-attribution';
import { costProviderKey, repairCostEntriesA0, repairStoredCostEntriesA0 } from './cost-entries-a0-repair';
import { useSqliteTemplate } from '../../db/sqlite-template.test-helpers';

describe('A0 stored cost repair', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let db: SqliteDriver;
  let directory: string;
  const providers = new Map([[costProviderKey('mixed', 'claude-opus-5'), 'copilot'], [costProviderKey('cursor', 'gpt-6.1-sol'), 'cursor']]);
  const row = (id: string, instance: string, session: string, model: string, timestamp: number,
    cost: number, input = 0, output = 0, read = 0, write = 0) => db.prepare(`INSERT INTO cost_entries
      (id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,timestamp,instance,session,model,input,output,read,write,cost);
  const costs = () => db.prepare('SELECT id,cost FROM cost_entries ORDER BY id').all<{id:string;cost:number}>();
  const backupIds = () => db.prepare('SELECT id FROM cost_entries_a0_backup ORDER BY id').all<{id:string}>().map(r => r.id);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'a0-repair-'));
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory);
    _resetCostAttributionForTesting();
    db = rlmTemplate.open();
    db.prepare("UPDATE maintenance_markers SET completed_at=1000 WHERE name='a0-per-turn-booking-live'").run();
    row('a', 'first', 'shared', 'opus', 100, 0.5);
    row('b', 'second', 'shared', 'sonnet', 200, 1.25);
    row('c', 'second', 'shared', 'opus', 300, 0.2);
    row('d', 'mixed', 'copilot-session', 'claude-opus-5', 100, 10, 100, 10, 70, 20);
    row('e', 'mixed', 'copilot-session', 'claude-opus-5', 200, 20, 150, 20, 100, 30);
    row('f', 'mixed', 'copilot-session', 'claude-opus-5', 300, 4, 20, 3, 10, 5);
    row('g', 'cursor', 'cursor-session', 'gpt-6.1-sol', 100, 5);
    row('h', 'second', 'shared', 'opus', 1000, 0.3);
    row('i', 'mixed', 'copilot-session', 'claude-opus-5', 1100, 0, 10, 5);
    row('j', 'other', 'other-session', 'gemini-unlisted', 100, 0.1);
  });
  afterEach(() => {
    db.close();
    _resetCostAttributionForTesting();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  it('keeps the fixed backup shape when the live table gains columns', () => {
    db.exec('ALTER TABLE cost_entries ADD COLUMN future_cost_tag TEXT');
    const before = db.prepare("SELECT * FROM cost_entries WHERE id='b'").get<Record<string, unknown>>()!;
    delete before['future_cost_tag'];
    delete before['origin'];
    for (const column of ['provider', 'ai_credits_nano', 'premium_requests', 'credit_checkpoint_id', 'credit_checkpoint_total_nano', 'credit_checkpoint_premium_total']) delete before[column];
    expect(repairCostEntriesA0(db, providers).status).toBe('repaired');
    expect(db.prepare("SELECT * FROM cost_entries_a0_backup WHERE id='b'").get()).toEqual(before);
    expect(costs().find(r => r.id === 'b')?.cost).toBe(0.75);
  });
  it('backs up originals and differences Claude by session across instances and models, including counter drops', () => {
    repairCostEntriesA0(db, providers);
    expect(costs().slice(0,3)).toEqual([{id:'a',cost:0.5},{id:'b',cost:0.75},{id:'c',cost:0.2}]);
    expect(backupIds()).toEqual(['a','b','c','d','e','f','g']);
    expect(db.prepare("SELECT cost FROM cost_entries_a0_backup WHERE id='b'").get<{cost:number}>()?.cost).toBe(1.25);
  });
  it('differences Copilot gross counters, splits cache and records zero reseller costs', () => {
    repairCostEntriesA0(db, providers);
    const rows = db.prepare("SELECT id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost FROM cost_entries WHERE id IN ('d','e','f') ORDER BY id").all();
    expect(rows).toEqual([
      {id:'d',input_tokens:10,output_tokens:10,cache_read_tokens:70,cache_write_tokens:20,cost:0},
      {id:'e',input_tokens:10,output_tokens:10,cache_read_tokens:30,cache_write_tokens:10,cost:0},
      {id:'f',input_tokens:5,output_tokens:3,cache_read_tokens:10,cache_write_tokens:5,cost:0},
    ]);
    expect(costs().find(r => r.id==='g')?.cost).toBe(0);
  });
  it('preserves cutoff/new rows and unknown providers, and a second run is inert', () => {
    repairCostEntriesA0(db, providers);
    expect(costs().slice(7)).toEqual([{id:'h',cost:0.3},{id:'i',cost:0},{id:'j',cost:0.1}]);
    const first = costs(); repairCostEntriesA0(db, providers);
    expect(costs()).toEqual(first); expect(backupIds()).toHaveLength(7);
    expect(db.prepare("SELECT name FROM maintenance_markers WHERE name='a0-cost-deltas'").get()).toBeDefined();
  });
  it('protects Claude per-turn rows at its earlier cutoff while repairing Copilot and Cursor until migration time', () => {
    row('k', 'second', 'shared', 'opus', 500, 0.8);
    row('l', 'second', 'shared', 'opus', 501, 1.6);
    row('m', 'mixed', 'copilot-session', 'claude-opus-5', 600, 9, 60, 7, 20, 5);
    row('n', 'cursor', 'cursor-session', 'gpt-6.1-sol', 600, 6);
    repairCostEntriesA0(db, providers, 500);
    expect(costs().filter(r => ['k', 'l', 'm', 'n'].includes(r.id))).toEqual([
      { id: 'k', cost: 0.8 }, { id: 'l', cost: 1.6 }, { id: 'm', cost: 0 }, { id: 'n', cost: 0 },
    ]);
    expect(backupIds()).not.toContain('k');
    expect(backupIds()).not.toContain('l');
    expect(backupIds()).toContain('m');
    expect(backupIds()).toContain('n');
    expect(db.prepare("SELECT input_tokens FROM cost_entries WHERE id='m'").get()).toEqual({ input_tokens: 30 });
  });
  it('keeps the migration boundary when it is earlier than the Claude evidence', () => {
    repairCostEntriesA0(db, providers, 1200);
    expect(backupIds()).not.toContain('h');
    expect(costs().find(r => r.id === 'h')?.cost).toBe(0.3);
  });
  it('uses the first Claude instance-turn purpose record rather than helper or other-provider purposes', () => {
    writeFileSync(join(directory, 'cost-attribution-2026-10-10.jsonl'), [
      { ts: 100, source: 'auxiliary', provider: 'claude', purpose: 'helper' },
      { ts: 200, source: 'instance-turn', provider: 'copilot', purpose: 'chat' },
      { ts: 500, source: 'instance-turn', provider: 'claude-cli', purpose: 'chat' },
    ].map(r => JSON.stringify(r)).join('\n'));
    row('k', 'second', 'shared', 'opus', 500, 0.8);
    repairStoredCostEntriesA0(db);
    expect(costs().find(r => r.id === 'k')?.cost).toBe(0.8);
    expect(backupIds()).not.toContain('k');
  });
  it('pins the documented BST installed-app start before its first purpose record', () => {
    const installedStart = 1792222279000;
    db.prepare("UPDATE maintenance_markers SET completed_at=? WHERE name='a0-per-turn-booking-live'").run(installedStart + 1000);
    writeFileSync(join(directory, 'cost-attribution-2026-10-17.jsonl'), [
      { ts: 1792223492775, source: 'instance-turn', provider: 'claude', purpose: 'chat' },
      { ts: 1792225932751, source: 'instance-turn', provider: 'claude-cli', purpose: 'chat' },
    ].map(r => JSON.stringify(r)).join('\n'));
    row('k', 'installed', 'installed-session', 'opus', installedStart - 1, 0.8);
    row('l', 'installed', 'installed-session', 'opus', installedStart, 1.6);
    repairStoredCostEntriesA0(db);
    expect(costs().find(r => r.id === 'l')?.cost).toBe(1.6);
    expect(backupIds()).toContain('k');
    expect(backupIds()).not.toContain('l');
  });
  it('protects the generic first per-turn row just before its purpose receipt without exempting earlier cumulative history', () => {
    const purposeAt = 10000;
    db.prepare("UPDATE maintenance_markers SET completed_at=? WHERE name='a0-per-turn-booking-live'").run(20000);
    writeFileSync(join(directory, 'cost-attribution-2026-10-18.jsonl'), [
      { ts: purposeAt, source: 'instance-turn', provider: 'claude', purpose: 'chat' },
      { instanceId: 'mixed', model: 'claude-opus-5', provider: 'copilot' },
      { instanceId: 'cursor', model: 'gpt-6.1-sol', provider: 'cursor' },
    ].map(record => JSON.stringify(record)).join('\n'));
    row('k', 'generic', 'generic-session', 'opus', purposeAt - 2000, 0.8);
    row('l', 'generic', 'generic-session', 'opus', purposeAt - 1001, 1.6);
    // recordUsage writes the DB row before recordInstanceTurnAttribution appends JSONL.
    row('m', 'generic', 'generic-session', 'opus', purposeAt - 2, 2.5);
    row('n', 'generic', 'generic-session', 'opus', purposeAt, 3.5);
    row('o', 'mixed', 'copilot-session', 'claude-opus-5', purposeAt - 2, 20, 100, 10, 20, 5);
    row('p', 'cursor', 'cursor-session', 'gpt-6.1-sol', purposeAt - 2, 10);
    const summary = repairStoredCostEntriesA0(db);
    expect(summary.status).toBe('repaired');
    expect(costs().filter(r => ['k', 'l', 'm', 'n', 'o', 'p'].includes(r.id))).toEqual([
      { id: 'k', cost: 0.8 }, { id: 'l', cost: 0.8 }, { id: 'm', cost: 2.5 },
      { id: 'n', cost: 3.5 }, { id: 'o', cost: 0 }, { id: 'p', cost: 0 },
    ]);
    expect(backupIds()).toEqual(expect.arrayContaining(['k', 'l', 'o', 'p']));
    expect(backupIds()).not.toEqual(expect.arrayContaining(['m']));
    expect(backupIds()).not.toEqual(expect.arrayContaining(['n']));
    const repaired = costs();
    expect(repairStoredCostEntriesA0(db).status).toBe('already-repaired');
    expect(costs()).toEqual(repaired);
  });
  it('uses the documented install start when no Claude per-turn record exists, instead of deferring forever', () => {
    // The fixture's marker (1000) is earlier than the documented start, and the earlier of the two wins.
    expect(repairStoredCostEntriesA0(db).status).toBe('repaired');
    // No provider log either, so only the rows whose model names are Claude aliases can be repaired.
    expect(backupIds()).toEqual(['a', 'b', 'c']);
    expect(db.prepare("SELECT name FROM maintenance_markers WHERE name='a0-cost-deltas'").get()).toBeDefined();
    expect(repairStoredCostEntriesA0(db).status).toBe('already-repaired');
  });
  it('rolls the backup, rewrites and marker back together, then safely retries', () => {
    db.exec(`CREATE TRIGGER abort_repair_marker BEFORE INSERT ON maintenance_markers
      WHEN NEW.name='a0-cost-deltas' BEGIN SELECT RAISE(ABORT, 'injected repair failure'); END;`);
    const before = costs(); repairCostEntriesA0(db, providers);
    expect(costs()).toEqual(before); expect(backupIds()).toEqual([]);
    expect(db.prepare("SELECT name FROM maintenance_markers WHERE name='a0-cost-deltas'").get()).toBeUndefined();
    db.exec('DROP TRIGGER abort_repair_marker'); repairCostEntriesA0(db, providers);
    expect(costs().find(r => r.id==='b')?.cost).toBe(0.75); expect(backupIds()).toHaveLength(7);
  });
  it('does nothing and writes no done marker when the cutoff is missing', () => {
    db.prepare("DELETE FROM maintenance_markers WHERE name='a0-per-turn-booking-live'").run();
    const before = costs(); repairCostEntriesA0(db, providers);
    expect(costs()).toEqual(before); expect(backupIds()).toEqual([]);
    expect(db.prepare("SELECT name FROM maintenance_markers WHERE name='a0-cost-deltas'").get()).toBeUndefined();
  });
  it('backs up through the widened cost table whether the backup kept the 12- or 18-column shape', () => {
    db.exec(`ALTER TABLE cost_entries_a0_backup RENAME TO cost_entries_a0_backup_old;
      CREATE TABLE cost_entries_a0_backup AS SELECT * FROM cost_entries WHERE 0;
      CREATE UNIQUE INDEX idx_cost_entries_a0_backup_id_wide ON cost_entries_a0_backup(id);
      DROP TABLE cost_entries_a0_backup_old;`);
    repairCostEntriesA0(db, providers);
    expect(backupIds()).toEqual(['a','b','c','d','e','f','g']);
    expect(db.prepare("SELECT cost FROM cost_entries_a0_backup WHERE id='b'").get<{cost:number}>()?.cost).toBe(1.25);
    expect(costs().slice(0,3)).toEqual([{id:'a',cost:0.5},{id:'b',cost:0.75},{id:'c',cost:0.2}]);
  });
});
