import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { costProviderKey, repairCostEntriesA0 } from './cost-entries-a0-repair';

describe('A0 stored cost repair', () => {
  let db: SqliteDriver;
  const providers = new Map([[costProviderKey('mixed', 'claude-opus-5'), 'copilot'], [costProviderKey('cursor', 'gpt-6.1-sol'), 'cursor']]);
  const row = (id: string, instance: string, session: string, model: string, timestamp: number,
    cost: number, input = 0, output = 0, read = 0, write = 0) => db.prepare(`INSERT INTO cost_entries
      (id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,timestamp,instance,session,model,input,output,read,write,cost);
  const costs = () => db.prepare('SELECT id,cost FROM cost_entries ORDER BY id').all<{id:string;cost:number}>();
  const backupIds = () => db.prepare('SELECT id FROM cost_entries_a0_backup ORDER BY id').all<{id:string}>().map(r => r.id);
  beforeEach(() => {
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
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
  afterEach(() => db.close());
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
});
