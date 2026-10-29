import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const timestamp = Date.parse('2026-10-25T12:00:00Z');
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'queue-mimo-report-'));
  directories.push(directory);
  const db = join(directory, 'opencode.db'), queue = join(directory, 'queue.db');
  execFileSync('sqlite3', [db, 'CREATE TABLE session(id TEXT, directory TEXT, version TEXT, time_created INTEGER); CREATE TABLE message(session_id TEXT, time_created INTEGER, data TEXT);']);
  execFileSync('sqlite3', [queue, 'CREATE TABLE plan_queue_items(document_path TEXT, state TEXT, park_reason TEXT, worktree_path TEXT, branch_name TEXT, updated_at INTEGER);']);
  const session = (id: string, slug: string, created = timestamp, isQueue = true) => execFileSync('sqlite3', [db,
    `INSERT INTO session VALUES (${quote(id)},${quote(isQueue ? '/repo/.worktrees/queue/' + slug : '/repo/ordinary')},'1.19.4',${created});`]);
  const message = (id: string, input: number, cache: number, time = timestamp, model = 'mimo-v2.6-pro', output = 0, reasoning = 0, role = 'assistant') => execFileSync('sqlite3', [db,
    `INSERT INTO message VALUES (${quote(id)},${time},${quote(JSON.stringify({ role, modelID: model, tokens: { input, output, reasoning, cache: { read: cache } } }))});`]);
  const item = (name: string, path: string | null, branch: string | null, updated = timestamp, state = 'landed') => execFileSync('sqlite3', [queue,
    `INSERT INTO plan_queue_items VALUES (${quote('/repo/docs/plans/' + name + '_plan.md')},${quote(state)},NULL,${path === null ? 'NULL' : quote(path)},${branch === null ? 'NULL' : quote(branch)},${updated});`]);
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'scripts/queue-mimo-spend-report.mjs'), '--opencode-db', db, '--queue-db', queue, '--since', '2026-10-21', ...args], { encoding: 'utf8' });
  const report = () => { const result = invoke('--json'); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout); };
  return { db, queue, session, message, item, invoke, report };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('queue MiMo spend report CLI', () => {
  it('adds output and reasoning separately and uses model-specific rates, with unknown credits explicit', () => {
    const f = fixture(); f.session('pro', 'pro-aaaaaa'); f.message('pro', 10, 100, timestamp, 'mimo-v2.6-pro', 2, 3);
    f.session('flash', 'flash-aaaaaa'); f.message('flash', 10, 100, timestamp, 'mimo-v2.6-flash', 2, 3);
    f.session('other', 'other-aaaaaa'); f.message('other', 10, 100, timestamp, 'mimo-future');
    const result = f.invoke('--json'); expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.documents.find((row: { document: string }) => row.document === 'pro-aaaaaa')).toMatchObject({ credits: 6250, inputCredits: 3000, cachedCredits: 250, outputCredits: 3000 });
    expect(report.documents.find((row: { document: string }) => row.document === 'flash-aaaaaa').credits).toBe(2200);
    expect(report.documents.find((row: { document: string }) => row.document === 'other-aaaaaa').credits).toBeNull();
    expect(report.totals.credits).toBeNull(); expect(report.totals.knownCredits).toBe(8450);
    expect(result.stderr.trim().split('\n')).toEqual(['Unknown MiMo model: mimo-future; credits unavailable']);
  });
  it('matches worktree, branch, document name and unmatched sessions and takes latest item', () => {
    const f = fixture();
    for (const slug of ['path-aaaaaa', 'branch-bbbbbb', 'name-cccccc', 'unknown-dddddd']) { f.session(slug, slug); f.message(slug, 1, 0); }
    f.item('old', '/repo/.worktrees/queue/path-aaaaaa', null, timestamp - 1, 'parked');
    f.item('latest', '/repo/.worktrees/queue/path-aaaaaa', null);
    f.item('branch', null, 'queue/branch-bbbbbb'); f.item('name', null, null);
    const rows = f.report().documents;
    expect(rows.find((row: { document: string }) => row.document === 'latest_plan.md')).toMatchObject({ state: 'landed', matchType: 'worktree or branch', repository: '/repo' });
    expect(rows.find((row: { document: string }) => row.document === 'branch_plan.md').matchType).toBe('worktree or branch');
    expect(rows.find((row: { document: string }) => row.document === 'name_plan.md').matchType).toBe('matched by name');
    expect(rows.find((row: { document: string }) => row.document === 'unknown-dddddd').matchType).toBe('unmatched');
  });
  it('uses the latest document outcome across contributing worktrees regardless of session order', () => {
    const f = fixture();
    f.session('a-old', 'old-aaaaaa'); f.message('a-old', 1, 0);
    f.session('z-new', 'new-bbbbbb'); f.message('z-new', 2, 0);
    f.item('same-document', '/repo/.worktrees/queue/old-aaaaaa', null, timestamp, 'parked');
    f.item('same-document', '/repo/.worktrees/queue/new-bbbbbb', null, timestamp + 1, 'landed');
    const report = f.report();
    expect(report.documents).toHaveLength(1);
    expect(report.documents[0]).toMatchObject({ state: 'landed', parkReason: null, sessions: 2, requests: 2, credits: 900 });
    expect(report.totals).toMatchObject({ landedDocuments: 1, creditsPerLandedDocument: 900 });
  });
  it('counts only cache drops after a previous request and with large new input', () => {
    const f = fixture(); f.session("session'quoted", 'cache-aaaaaa');
    f.message("session'quoted", 20000, 100000); f.message("session'quoted", 25000, 40000, timestamp + 1000);
    f.message("session'quoted", 100, 10000, timestamp + 2000);
    const report = f.report();
    expect(report.documents[0]).toMatchObject({ cacheDrops: 1, cacheDropInputCredits: 7500000 });
    expect(report.cacheDrops).toEqual([{ sessionId: "session'quoted", time: timestamp + 1000, secondsSincePrevious: 1, previousCachedInput: 100000, input: 25000, credits: 7500000 }]);
  });
  it('rejects unsupported schemas with exit 2', () => {
    const f = fixture(); execFileSync('sqlite3', [f.db, 'DROP TABLE message']);
    const missingMessage = f.invoke(); expect(missingMessage.status).toBe(2);
    expect(missingMessage.stderr.trim()).toBe('OpenCode database layout not supported (expected tables session and message)');
    execFileSync('sqlite3', [f.db, 'CREATE TABLE message(session_id TEXT, time_created INTEGER, data TEXT)']);
    execFileSync('sqlite3', [f.queue, 'DROP TABLE plan_queue_items']);
    const missingQueue = f.invoke(); expect(missingQueue.status).toBe(2);
    expect(missingQueue.stderr.trim()).toBe('Queue database layout not supported (expected table plan_queue_items)');
  });
  it('excludes older sessions, includes all MiMo in daily denominator, and emits Markdown and JSON sections', () => {
    const f = fixture(); f.session('old', 'old-aaaaaa', Date.parse('2026-10-20T00:00:00Z')); f.message('old', 1000, 0);
    f.session('new', 'new-aaaaaa'); f.message('new', 10, 0); f.message('new', 10000, 0, timestamp, 'other-model');
    f.session('ordinary', '', timestamp, false); f.message('ordinary', 30, 0);
    f.item('new', '/repo/.worktrees/queue/new-aaaaaa', null);
    const report = f.report();
    expect(report).toHaveProperty('documents'); expect(report).toHaveProperty('days'); expect(report).toHaveProperty('totals');
    expect(report.totals).toMatchObject({ documents: 1, landedDocuments: 1, requests: 1, credits: 3000, creditsPerLandedDocument: 3000 });
    expect(report.days).toEqual([expect.objectContaining({ requests: 2, credits: 12000, queueShare: 0.25 })]);
    const md = f.invoke(); expect(md.status).toBe(0); expect(md.stdout).toContain('Night discount not applied'); expect(md.stdout).toContain('new_plan.md');
    expect(f.invoke('--since', '2026-02-30').status).toBe(2);
  });
});
