import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/claude-cost-audit-report.mjs');
const tempDirs: string[] = [];

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
}

function createUserDataFixture(): string {
  const userData = mkdtempSync(join(tmpdir(), 'claude-cost-audit-'));
  tempDirs.push(userData);
  mkdirSync(join(userData, 'cost-attribution'), { recursive: true });
  mkdirSync(join(userData, 'rlm'), { recursive: true });
  mkdirSync(join(userData, 'loop-mode'), { recursive: true });

  writeFileSync(
    join(userData, 'cost-attribution', 'cost-attribution-test.jsonl'),
    '{"ts":9999999999999,"source":"one-shot","taskType":"verify-orchestration","provider":"claude","model":"opus","usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":7,"cacheWriteTokens":11,"cost":0.1234},"costKnown":true}\n',
  );

  execFileSync('sqlite3', [
    join(userData, 'rlm', 'rlm.db'),
    `CREATE TABLE cost_entries (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      instance_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0
    );
    INSERT INTO cost_entries VALUES ('c1', 9999999999999, 'i1', 's1', 'opus', 10, 5, 2, 3, 0.0456);`,
  ]);

  execFileSync('sqlite3', [
    join(userData, 'loop-mode', 'loop-mode.db'),
    `CREATE TABLE loop_iterations (
      loop_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO loop_iterations VALUES ('loop-1', 9999999999999, 1234, 789);`,
  ]);

  return userData;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('historical attribution totals through the real audit CLI', () => {
  it('excludes legacy Claude running totals, discloses the missing history and preserves tagged deltas and original logs', () => {
    const userData = mkdtempSync(join(tmpdir(), 'claude-cost-history-'));
    tempDirs.push(userData);
    const directory = join(userData, 'cost-attribution');
    mkdirSync(directory);
    const file = join(directory, 'cost-attribution-test.jsonl');
    const rows = [
      { ts: 1, source: 'instance-turn', taskType: 'chat', provider: 'claude', model: 'opus', usage: { cost: 0.5, inputTokens: 10 } },
      { ts: 2, source: 'instance-turn', taskType: 'chat', provider: 'claude-cli', model: 'opus', usage: { cost: 1.25, inputTokens: 20 } },
      { ts: 3, source: 'instance-turn', taskType: 'chat', provider: 'claude', model: 'opus', costSource: 'provider', costKnown: true, usage: { cost: 0.3 } },
    ];
    const original = rows.map(row => JSON.stringify(row)).join('\n');
    writeFileSync(file, original);
    const invoke = (since?: string) => spawnSync(process.execPath, [scriptPath, '--userdata', userData, ...(since ? ['--since', since] : [])], {
      encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: directory },
    });
    const all = invoke();
    expect(all.status, all.stderr).toBe(0);
    expect(all.stdout).toContain('Total attributed cost: $0.3000 across 3 calls.');
    expect(all.stdout).toContain('2 historical Claude calls have uncorrected running totals');
    expect(all.stdout).toContain('Their dollar amounts are excluded');
    expect(all.stdout).toContain('cost-unknown');
    const later = invoke('1970-01-01T00:00:00.003Z');
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain('Total attributed cost: $0.3000 across 1 calls.');
    expect(later.stdout).not.toContain('uncorrected running totals');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
});

describe.skipIf(!hasSqlite3())('claude-cost-audit-report', () => {
  it('refuses hot-journal recovery without changing the database or rollback journal', () => {
    const userData = createUserDataFixture();
    const database = join(userData, 'rlm', 'rlm.db');
    const journal = `${database}-journal`;
    execFileSync('sqlite3', [database, `
      ALTER TABLE cost_entries ADD COLUMN padding BLOB;
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<200)
      INSERT INTO cost_entries (id,timestamp,instance_id,session_id,model,cost,padding)
        SELECT 'pending-'||n,9999999999999,'fixture-instance','fixture-session','opus',0.25,zeroblob(2048) FROM rows;
    `]);
    // Crash only this owned writer after cache spills; normal close would roll back cleanly.
    const writer = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE cost_entries SET cost=cost+1;');
      process.kill(process.pid, 'SIGKILL');
    `, database], { encoding: 'utf8', timeout: 10_000 });
    expect(writer.signal, writer.stderr).toBe('SIGKILL');
    expect(existsSync(journal)).toBe(true);
    const fingerprints = () => [database, journal].map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const before = fingerprints();
    const readonly = spawnSync('sqlite3', ['-readonly', database, 'SELECT COUNT(*) FROM cost_entries'], { encoding: 'utf8', timeout: 10_000 });
    expect(readonly.status).not.toBe(0);
    expect(readonly.stderr).toContain('readonly database');
    expect(fingerprints()).toEqual(before);

    const result = spawnSync(process.execPath, [scriptPath, '--userdata', userData], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(userData, 'cost-attribution'), AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(journal)).toBe(true);
    expect(fingerprints()).toEqual(before);
    expect(result.stderr).toContain('readonly database');
    expect(result.stdout).not.toContain('Cross-check: cost_entries');
    expect(result.stdout).toContain('| loop-1 | 1 | 1,234 | $7.8900 |');
  });
  it('reports subagent percentiles without increasing the spend call count', () => {
    const userData=createUserDataFixture();
    writeFileSync(join(userData,'cost-attribution','subagents.jsonl'), [100,200].map((size,index)=>JSON.stringify({
      ts:9999999999999,subagentUsage:true,purpose:'subagent',sessionId:'parent',finalContextTokens:size,
      toolUses:index+1,durationMs:size*10,costSource:'unknown',costKnown:false,
    })).join('\n'));
    const result=spawnSync(process.execPath,[scriptPath,'--userdata',userData],{
      encoding:'utf8',env:{...process.env,AIO_COST_ATTRIBUTION_DIR:join(userData,'cost-attribution'),AIO_COST_AUDIT_SQLITE_DRIVER:'cli'},
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('across 1 calls.');
    expect(result.stdout).toContain('Subagents — last context size, not a cost');
    expect(result.stdout).toContain('[parent] | 2 | 100 / 200 | 1 / 2 | 1000 / 2000 |');
  });
  it('splits finished helpers by model, mode, fork and depth', () => {
    const userData=createUserDataFixture();
    const row=(size:number,extra:Record<string,unknown>)=>JSON.stringify({ts:9999999999999,subagentUsage:true,purpose:'subagent',
      sessionId:'parent',finalContextTokens:size,toolUses:2,durationMs:10,costSource:'unknown',costKnown:false,...extra});
    writeFileSync(join(userData,'cost-attribution','helpers.jsonl'),[
      row(100,{model:'claude-sonnet-5-5',helperModelSource:'stream',helperMode:'background',helperFork:false,helperDepth:1}),
      row(300,{model:'claude-sonnet-5-5',helperModelSource:'stream',helperMode:'background',helperFork:false,helperDepth:1}),
      row(500,{model:'claude-opus-5-5',helperModelSource:'transcript',helperMode:'foreground',helperFork:true,helperDepth:2}),
      row(700,{}),
    ].join('\n'));
    const result=spawnSync(process.execPath,[scriptPath,'--userdata',userData],{
      encoding:'utf8',env:{...process.env,AIO_COST_ATTRIBUTION_DIR:join(userData,'cost-attribution'),AIO_COST_AUDIT_SQLITE_DRIVER:'cli'},
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Subagents by model, mode, fork and depth — last context size, not a cost');
    expect(result.stdout).toContain('| claude-sonnet-5-5 (stream) | background | no | 1 | 2 | 100 / 300 |');
    expect(result.stdout).toContain('| claude-opus-5-5 (transcript) | foreground | yes | 2 | 1 | 500 / 500 |');
    expect(result.stdout).toContain('| unknown | ? | ? | ? | 1 | 700 / 700 |');
  });
  it('runs a day comparison through the standalone CLI with profile transcripts and price overrides', () => {
    const userData=createUserDataFixture();
    const timestamp=new Date('1999-01-01T12:00:00').getTime();
    execFileSync('sqlite3',[join(userData,'rlm','rlm.db'),`UPDATE cost_entries SET timestamp=${timestamp},cost=0.00002,input_tokens=10,output_tokens=0,cache_read_tokens=0,cache_write_tokens=0;
      CREATE TABLE cost_entry_model_usage(entry_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cost_usd REAL);`]);
    const projects=join(userData,'claude-cli-profiles','test','projects');mkdirSync(projects,{recursive:true});
    writeFileSync(join(projects,'s1.jsonl'),JSON.stringify({type:'assistant',sessionId:'s1',timestamp:new Date(timestamp).toISOString(),
      message:{id:'fixture-day-message',model:'opus',usage:{input_tokens:10}}}));
    const pricePath=join(userData,'prices.json');writeFileSync(pricePath,JSON.stringify({opus:{input:2,output:10}}));
    const invoke=(day:string)=>spawnSync(process.execPath,[scriptPath,'--userdata',userData,'--compare-transcripts','--day',day,'--projects',projects,'--prices',pricePath,'--json'],{
      encoding:'utf8',env:{...process.env,AIO_COST_ATTRIBUTION_DIR:join(userData,'cost-attribution'),AIO_COST_AUDIT_SQLITE_DRIVER:'cli'},
    });
    const result=invoke('1999-01-01');expect(result.status,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({day:'1999-01-01',stored:0.00002,transcript:0.00002,exceeded:false});
    expect(invoke('1999-02-30').status).not.toBe(0);
  });
  it('uses sqlite3 CLI fallback for read-only cross-checks when requested', () => {
    const userData = createUserDataFixture();
    const result = spawnSync(process.execPath, [scriptPath, '--userdata', userData, '--since', '2026-01-01'], {
      encoding: 'utf8',
      env: { ...process.env, AIO_COST_AUDIT_SQLITE_DRIVER: 'cli' },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(result.status).toBe(0);
    expect(output).toContain('| verify-orchestration [claude/opus] | 1 | 100 | 50 | 7/11 | $0.1234 | 100.0% |');
    expect(output).toContain('(using sqlite3 CLI fallback for');
    expect(output).toContain('| opus | 1 | 10 | 5 | 2/3 | $0.0456 |');
    expect(output).toContain('| loop-1 | 1 | 1,234 | $7.8900 |');
  });
});
