import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replay, type ReplayRow } from '../context-ceiling-replay.mjs';

const dirs: string[] = [];
const prices = { fixture: { inputPerMTok: 1, outputPerMTok: 1 } };
const script = join(process.cwd(), 'scripts/context-ceiling-replay.mjs');
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function requests(summaries: number) {
  const contexts = Array.from({ length: summaries }, (_, i) => 200_000 + i * 140_000);
  contexts.push(...Array<number>(10).fill(contexts.at(-1) ?? 0));
  return contexts.map((context, at) => ({ at, context, model: 'fixture', input: 0,
    cacheRead: 0, cacheWrite5m: context, cacheWrite1h: 0, output: 10 }));
}
function writeTranscript(path: string, summaries: number, harness = false) {
  const lines = requests(summaries).map((r, i) => JSON.stringify({ type: 'assistant',
    entrypoint: harness ? 'sdk-cli' : 'cli', timestamp: new Date(1_790_000_000_000 + i * 1000).toISOString(),
    message: { id: `m${i}`, model: r.model, usage: { input_tokens: r.input,
      cache_read_input_tokens: r.cacheRead, cache_creation_input_tokens: r.cacheWrite5m,
      output_tokens: r.output } } }));
  if (harness) lines.unshift(JSON.stringify({ type: 'user', message: { content: '[Tool Permissions]' } }));
  writeFileSync(path, lines.join('\n'));
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ceiling-owned-'));
  dirs.push(dir);
  const root = join(dir, 'projects');
  const project = join(root, 'project-a');
  mkdirSync(project, { recursive: true });
  const child = (base: string, parent: string, summaries: number) => {
    const subdir = join(base, parent, 'subagents');
    mkdirSync(subdir, { recursive: true });
    const path = join(subdir, 'agent-test.jsonl');
    writeTranscript(path, summaries);
    return path;
  };
  const run = (extra: string[] = [], explicitProjects = true) => {
    const result = spawnSync(process.execPath, [script, ...(explicitProjects ? ['--projects', root] : []), '--userdata', join(dir, 'empty'),
      '--prices', JSON.stringify(prices), '--json', ...extra], { encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    return JSON.parse(result.stdout) as {
      sessions: number; sessionsByClass: [string, number][];
      cohorts: Record<string, Record<string, ReplayRow>>;
      ownership: { children: Record<string, number>; parentClasses: Record<string, number> };
      decision: { harness: { ceiling: number | null; reason: string }; ownChat: { ceiling: number | null; reason: string } };
    };
  };
  return { dir, root, project, child, run };
}

describe('parent-owned context-ceiling decision cohorts', () => {
  it('keeps display classes while pricing each owned transcript once and pooling its actual count', () => {
    const f = fixture();
    writeTranscript(join(f.project, 'machine.jsonl'), 1, true);
    f.child(f.project, 'machine', 5);
    writeTranscript(join(f.project, 'own.jsonl'), 1);
    f.child(f.project, 'own', 3);
    const report = f.run();
    expect(Object.fromEntries(report.sessionsByClass)).toEqual({ 'own-chat': 1, subagent: 2, unclassified: 1 });
    expect(report.ownership.children).toEqual({ harness: 1, 'own-chat': 1, unknown: 0 });
    expect(report.ownership.parentClasses).toEqual({ unclassified: 1, 'own-chat': 1 });
    const direct = replay([{ className: 'harness', requests: requests(1) },
      { className: 'harness', requests: requests(5) }, { className: 'own-chat', requests: requests(1) },
      { className: 'own-chat', requests: requests(3) }], 40_000, 2000, prices);
    // Discovery order is a filesystem property; sample order is not a statistic.
    for (const rows of [...Object.values(report.cohorts), ...Object.values(direct)]) {
      for (const row of Object.values(rows)) row.summariesPerSession.sort((a, b) => a - b);
    }
    expect(report.cohorts).toEqual(direct);
    expect(report.cohorts['harness']['200000'].summariesPerSession.sort()).toEqual([1, 5]);
    expect(report.cohorts['harness']['200000'].summariesP90).toBe(5);
    expect(report.cohorts['own-chat']['200000'].summariesP90).toBe(3);
    expect(report.decision.harness.ceiling).not.toBe(200_000);
    expect(report.decision.ownChat.ceiling).not.toBe(200_000);
  });

  it('inherits a joined purpose only from a marker-positive same-project parent', () => {
    const f = fixture();
    const data = join(f.dir, 'empty');
    mkdirSync(join(data, 'loop-mode'), { recursive: true });
    mkdirSync(join(data, 'rlm'), { recursive: true });
    const loop = spawnSync('sqlite3', [join(data, 'loop-mode', 'loop-mode.db'), `
      CREATE TABLE plan_queue_items (id TEXT, worker_instance_id TEXT, verifier_instance_id TEXT);
      CREATE TABLE loop_iterations (loop_run_id TEXT, child_instance_id TEXT);
      CREATE TABLE loop_runs (chat_id TEXT);
      INSERT INTO plan_queue_items VALUES ('item', 'worker', NULL);
    `], { encoding: 'utf8' });
    const ledger = spawnSync('sqlite3', [join(data, 'rlm', 'rlm.db'), `
      CREATE TABLE automation_runs (instance_id TEXT);
      CREATE TABLE cost_entries (session_id TEXT, instance_id TEXT);
      INSERT INTO cost_entries VALUES ('shared', 'worker');
    `], { encoding: 'utf8' });
    expect(loop.status, loop.stderr).toBe(0);
    expect(ledger.status, ledger.stderr).toBe(0);
    writeTranscript(join(f.project, 'shared.jsonl'), 1, true);
    f.child(f.project, 'shared', 1);
    const other = join(f.root, 'project-b');
    mkdirSync(other);
    writeTranscript(join(other, 'shared.jsonl'), 1);
    f.child(other, 'shared', 1);
    const report = f.run();
    expect(Object.fromEntries(report.sessionsByClass)).toEqual({ 'own-chat': 1, 'plan-queue': 1, subagent: 2 });
    expect(report.ownership.parentClasses).toEqual({ 'plan-queue': 1, 'own-chat': 1 });
    expect(report.cohorts['harness']['200000'].sessions).toBe(2);
    expect(report.cohorts['own-chat']['200000'].sessions).toBe(2);
  });

  it('uses the exact same-project parent even when its usage is outside the mtime selection', () => {
    const f = fixture();
    const parent = join(f.project, 'shared.jsonl');
    writeTranscript(parent, 5, true);
    utimesSync(parent, new Date('2020-01-01'), new Date('2020-01-01'));
    f.child(f.project, 'shared', 1);
    const otherProject = join(f.root, 'project-b');
    mkdirSync(otherProject);
    writeTranscript(join(otherProject, 'shared.jsonl'), 0);
    f.child(otherProject, 'shared', 3);
    const report = f.run(['--since', '2026-01-01']);
    expect(report.sessions).toBe(3);
    expect(report.cohorts['harness']['200000'].sessions).toBe(1);
    expect(report.cohorts['harness']['200000'].summariesPerSession).toEqual([1]);
    expect(report.cohorts['own-chat']['200000'].sessions).toBe(2);
    expect(report.cohorts['own-chat']['200000'].summarisingShare).toBe(0.5);
    expect(report.ownership.children).toEqual({ harness: 1, 'own-chat': 1, unknown: 0 });
  });

  it('keeps orphans separate and withholds a default claim when ownership is incomplete', () => {
    const f = fixture();
    writeTranscript(join(f.project, 'machine.jsonl'), 1, true);
    f.child(f.project, 'machine', 1);
    f.child(f.project, 'missing', 5);
    const report = f.run();
    expect(report.ownership.children).toEqual({ harness: 1, 'own-chat': 0, unknown: 1 });
    expect(report.cohorts['harness']['200000'].sessions).toBe(2);
    expect(report.cohorts['unknown']['200000'].sessions).toBe(1);
    expect(report.cohorts['unknown']['200000'].summariesPerSession).toEqual([5]);
    expect(report.decision.harness.ceiling).toBeNull();
    expect(report.decision.harness.reason).toContain('unresolved');
  });

  it('uses affirmative marker provenance from a stale parent without billed requests', () => {
    const f = fixture();
    const parent = join(f.project, 'provenance-only.jsonl');
    writeFileSync(parent, [JSON.stringify({ type: 'user', message: { content: '[Tool Permissions]' } }),
      JSON.stringify({ type: 'assistant', entrypoint: 'sdk-cli', message: { id: 'identity', model: 'fixture' } })].join('\n'));
    utimesSync(parent, new Date('2020-01-01'), new Date('2020-01-01'));
    f.child(f.project, 'provenance-only', 1);
    const report = f.run(['--since', '2026-01-01']);
    expect(report.sessions).toBe(1);
    expect(report.cohorts['harness']['200000'].sessions).toBe(1);
    expect(report.ownership.parentClasses).toEqual({ unclassified: 1 });
  });

  it('keeps empty or malformed parent provenance unknown rather than treating it as own-chat', () => {
    const f = fixture();
    writeFileSync(join(f.project, 'bad.jsonl'), 'invalid json');
    writeFileSync(join(f.project, 'empty.jsonl'), '');
    f.child(f.project, 'bad', 1);
    f.child(f.project, 'empty', 1);
    const report = f.run();
    expect(report.sessions).toBe(2);
    expect(report.ownership.children).toEqual({ harness: 0, 'own-chat': 0, unknown: 2 });
    expect(report.cohorts['harness']).toBeUndefined();
    expect(report.cohorts['own-chat']).toBeUndefined();
    expect(report.decision.ownChat.ceiling).toBeNull();
  });

  it('discovers Harness account-profile histories when no projects override is supplied', () => {
    const f = fixture();
    writeTranscript(join(f.project, 'same.jsonl'), 1, true);
    f.child(f.project, 'same', 1);
    const profile = join(f.dir, 'empty', 'claude-cli-profiles', 'profile-a', 'projects', 'project-a');
    mkdirSync(profile, { recursive: true });
    writeTranscript(join(profile, 'same.jsonl'), 3);
    f.child(profile, 'same', 3);
    const report = f.run([], false);
    expect(report.sessions).toBe(4);
    expect(report.cohorts['harness']['200000'].sessions).toBe(2);
    expect(report.cohorts['own-chat']['200000'].sessions).toBe(2);
  });

  it('keeps config roots separate and deduplicates repeated project roots', () => {
    const f = fixture();
    writeTranscript(join(f.project, 'same.jsonl'), 1, true);
    f.child(f.project, 'same', 1);
    const otherRoot = join(f.dir, 'other-projects');
    const other = join(otherRoot, 'project-a');
    mkdirSync(other, { recursive: true });
    writeTranscript(join(other, 'same.jsonl'), 3);
    f.child(other, 'same', 3);
    const report = f.run(['--projects', otherRoot, '--projects', f.root]);
    expect(report.sessions).toBe(4);
    expect(report.cohorts['harness']['200000'].sessions).toBe(2);
    expect(report.cohorts['own-chat']['200000'].sessions).toBe(2);
    expect(report.ownership.children).toEqual({ harness: 1, 'own-chat': 1, unknown: 0 });
  });
});
