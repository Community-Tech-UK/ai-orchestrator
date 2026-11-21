import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-coder-outcomes-')); directories.push(dir);
  const db = join(dir, 'queue.db');
  execFileSync('sqlite3', [db, `
    CREATE TABLE plan_queue_runs(id TEXT, config_json TEXT, cost_usd REAL, exact_cost_usd REAL);
    CREATE TABLE plan_queue_items(id TEXT, run_id TEXT, document_path TEXT, state TEXT, park_reason TEXT,
      round INTEGER, errored_rounds INTEGER, stepped_up_at INTEGER, verdict_json TEXT, created_at INTEGER,
      updated_at INTEGER, tokens INTEGER, cost_usd REAL, exact_cost_usd REAL);
    INSERT INTO plan_queue_runs VALUES('trial','{"routing":{"workers":[{"provider":"claude","reasoningEffort":"low"}]}}',0.5,0.3);
    INSERT INTO plan_queue_items VALUES('a','trial','/repo/a_plan.md','landed',NULL,1,0,NULL,
      '{"verdict":"PASS","findings":[]}',1000,61000,100,1.5,1.0);
    INSERT INTO plan_queue_items VALUES('b','trial','/repo/b_plan.md','parked','round-limit',2,1,50000,
      '{"verdict":"FAIL","findings":[{"severity":"high"},{"severity":"low"}]}',1000,121000,100,2,1);
    INSERT INTO plan_queue_items VALUES('c','trial','/repo/c_plan.md','skipped',NULL,0,0,NULL,NULL,1000,1000,0,0,0);
    INSERT INTO plan_queue_runs VALUES('other','{}',0,0);
    INSERT INTO plan_queue_items VALUES('d','other','/repo/d_plan.md','landed',NULL,1,0,NULL,NULL,1000,1000,0,99,99);
  `]);
  const invoke = (...args: string[]) => spawnSync(process.execPath, ['scripts/queue-coder-outcomes-report.mjs', '--queue-db', db, '--run', 'trial', ...args], { encoding: 'utf8' });
  const report = () => { const r = invoke('--json'); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout); };
  return { dir, db, invoke, report };
}

it('collects accepted structured checker calls from archives without treating them as applied verdicts', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'index.json'), JSON.stringify({ entries: [{ id: 'checker', createdAt: 2000, endedAt: 60000 }] }));
  const data = { entry: { id: 'checker', displayName: 'Queue verifier (round 1)' }, messages: [
    { type: 'assistant', content: 'plan_queue_report_verdict PASS', timestamp: 3000 },
    { type: 'tool_use', timestamp: 4000, metadata: { id: 'call-1', name: 'orchestrator.tool_execute', input: {
      name: 'plan_queue_report_verdict', arguments: { item_id: 'a', verdict: 'PASS', findings: [] },
    } } },
    { type: 'tool_result', content: '{"accepted":true}', metadata: { tool_use_id: 'call-1' } },
    { type: 'tool_outcome', content: '[{"type":"text","text":"{\\"accepted\\":true}"}]', metadata: { tool_use_id: 'call-1', is_error: false } },
    { type: 'tool_use', timestamp: 5000, metadata: { id: 'call-2', name: 'plan_queue_report_verdict', input: { item_id: 'b', verdict: 'FAIL' } } },
    { type: 'tool_result', content: '{"accepted":true}', metadata: { tool_use_id: 'call-2', is_error: true } },
  ] };
  writeFileSync(join(f.dir, 'checker.json.gz'), gzipSync(JSON.stringify(data)));
  const result = f.invoke('--history-dir', f.dir, '--json');
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.history).toMatchObject({ archivesRead: 1, acceptedReports: 1 });
  expect(report.documents[0]).toMatchObject({ firstCheckPass: null, totalRounds: null, earliestAvailableReportPass: true,
    checkerReports: [{ timestamp: 4000, reportedRound: 1, verdict: 'PASS', findings: { critical: 0, high: 0, medium: 0, low: 0 } }] });
  expect(report.documents[1].checkerReports).toEqual([]);
  expect(result.stdout).not.toContain('plan_queue_report_verdict PASS');
});

it('keeps every document in the chosen runs, with handovers, phase rounds, costs and severity counts', () => {
  const f = fixture(), before = readFileSync(f.db); const report = f.report();
  expect(report.documents).toHaveLength(3);
  expect(report.documents[0]).toMatchObject({ state: 'landed', currentPhaseRounds: 1, handedOver: false,
    firstCheckPass: null, elapsedMinutes: 1, recordedUsd: 1.5, providerReportedUsd: 1, estimatedUsd: 0.5 });
  expect(report.documents[1]).toMatchObject({ state: 'parked', parkReason: 'round-limit', handedOver: true,
    currentPhaseRounds: 2, findings: { critical: 0, high: 1, medium: 0, low: 1 } });
  expect(report.documents[2].recordedUsd).toBeNull();
  expect(report.runs[0]).toMatchObject({ documents: 3, landed: 1, recordedUsd: 4, providerReportedUsd: 2.3,
    documentsWithoutRecordedCost: 1, costPerLandedUsd: null });
  expect(readFileSync(f.db)).toEqual(before);
});

it('prints a reviewable table and explains why missing history cannot become a first-check pass', () => {
  const f = fixture(); const result = f.invoke();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('| First check |');
  expect(result.stdout).toContain('unknown');
  expect(result.stdout).toContain('round counter resets');
  expect(result.stdout).toContain('pauses');
});

it('keeps missing archives and unknown rounds explicit, deduplicating rearchived checker calls', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'index.json'), JSON.stringify({ entries: [
    { id: 'one', historyThreadId: 'thread', endedAt: null },
    { id: 'two', historyThreadId: 'thread', createdAt: 2000, endedAt: 60000 },
    { id: 'missing', createdAt: 2000, endedAt: 60000 },
  ] }));
  for (const id of ['one', 'two']) writeFileSync(join(f.dir, id + '.json.gz'), gzipSync(JSON.stringify({
    entry: { displayName: 'Renamed checker' }, messages: [
      { type: 'tool_use', timestamp: 5000, metadata: { id: 'call', name: 'orchestrator.plan_queue_report_verdict',
        input: { item_id: 'a', verdict: 'PASS', findings: [] } } },
      { type: 'tool_result', metadata: { tool_use_id: 'call' }, content: [{ type: 'text', text: '{"accepted":true}' }] },
    ],
  })));
  const result = f.invoke('--json', '--history-dir', f.dir);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.history).toMatchObject({ archivesRead: 2, missingArchives: 1, archivesWithoutEndTime: 1, acceptedReports: 1 });
  expect(report.documents[0].checkerReports).toHaveLength(1);
  expect(report.documents[0].checkerReports[0].reportedRound).toBeNull();
  expect(report.documents[0].earliestAvailableReportPass).toBe(true);
  writeFileSync(join(f.dir, 'index.json'), JSON.stringify({ entries: [{ id: '../escape' }] }));
  expect(f.invoke('--history-dir', f.dir).status).toBe(2);
});

it('does not infer complete checker coverage or an applied first pass from a complete archive index', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'index.json'), JSON.stringify({ entries: [{ id: 'later', createdAt: 2000, endedAt: 60000 }] }));
  writeFileSync(join(f.dir, 'later.json.gz'), gzipSync(JSON.stringify({
    entry: { displayName: 'Queue verifier (round 2)' }, messages: [
      { type: 'tool_use', timestamp: 5000, metadata: { id: 'call', name: 'plan_queue_report_verdict',
        input: { item_id: 'a', verdict: 'PASS', findings: [] } } },
      { type: 'tool_result', metadata: { tool_use_id: 'call' }, content: '{"accepted":true}' },
    ],
  })));
  const result = f.invoke('--json', '--history-dir', f.dir); expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.history).toMatchObject({ missingArchives: 0, checkerSessionsComplete: null, appliedVerdictsComplete: false });
  expect(report.documents[0]).toMatchObject({ earliestAvailableReportPass: true, firstCheckPass: null, totalRounds: null });
  expect(report.documents[0]).not.toHaveProperty('firstRecordedCheckPass');
  expect(report.limitations.join(' ')).toContain('never archived');
  expect(report.limitations.join(' ')).toContain('not retained');
});

it('rejects unknown runs and bad arguments without writing or querying a different cohort', () => {
  const f = fixture();
  expect(f.invoke('--run', 'absent').status).toBe(2);
  expect(f.invoke('--run', "trial'); DELETE FROM plan_queue_items; --").status).toBe(2);
  expect(f.invoke('--unexpected').status).toBe(2);
  expect(f.report().documents).toHaveLength(3);
  writeFileSync(join(f.dir, 'bad.db'), 'not sqlite');
  expect(f.invoke('--queue-db', join(f.dir, 'bad.db')).stderr).toContain('Could not read');
});
