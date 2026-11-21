import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'coder-trial-reconcile-')); dirs.push(dir);
  for (const name of ['plans', 'judge', 'quarantined']) mkdirSync(join(dir, name));
  const tasks = ['T1', 'T2'];
  const arms = { A: undefined, H: 'high', HM: 'max', S1: 'low', S2: 'medium', S3: 'high', S4: 'max' };
  const records = [];
  const event = value => JSON.stringify(value);
  const log = (arm, cost = 1) => `=== claude --model ${arm.startsWith('S') ? 'claude-sonnet-5-5' : arm === 'A' ? 'claude-opus-5-5' : 'claude-haiku-5-5'} --max-turns 75${arms[arm] ? ' --effort ' + arms[arm] : ''} ===\n`
    + event({ type: 'system', subtype: 'init', claude_code_version: '2.1.311' }) + '\n'
    + event({ type: 'result', total_cost_usd: cost }) + '\n';
  for (const taskId of tasks) {
    writeFileSync(join(dir, 'plans', taskId + '.usage.json'), event({ models: { opus: { cost: 2 } } }));
    for (const [armId, coderEffort] of Object.entries(arms)) for (let runNumber = 1; runNumber <= 3; runNumber++) {
      records.push({ taskId, armId, runNumber, coderEffort, claudeAccount: 'allowed', durationMs: 60000, planUsed: armId !== 'A',
        coderUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        score: { contract: { version: 'historical-v1', dependencyFingerprint: 'fixture-dependencies' },
          hiddenTests: { passed: taskId === 'T1' }, damageOk: true } });
      writeFileSync(join(dir, `${taskId}-${armId}-run${runNumber}.agent.log`), log(armId, armId === 'S1' ? 0.1 : 1));
    }
  }
  writeFileSync(join(dir, 'bank.json'), event({ tasks: tasks.map(id => ({ id })) }));
  const save = () => writeFileSync(join(dir, 'runs.jsonl'), records.map(event).join('\n') + '\n'); save();
  const invoke = (...args) => spawnSync(process.execPath, ['scripts/coder-trial-reconcile.mjs', '--session', dir, '--bank', join(dir, 'bank.json'), ...args], { encoding: 'utf8' });
  const report = () => { const result = invoke(); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  return { dir, records, save, invoke, report, log, event };
}

function judgedPairs() {
  const score = () => ({ correctBeyondTests: 8, fitsCodebaseStyle: 8, noUnrequestedChanges: 8, wouldMergeAsIs: true });
  return ['claude', 'codex'].map(judge => ({
    taskId: 'T1', armId: 'S1', judge, verdict: 'tie', subjectRunNumber: 1, baselineRunNumber: 1,
    orders: ['x', 'y'].map(subjectSide => ({ subjectSide, winner: 'tie', scores: { x: score(), y: score() } })),
  }));
}

test('reconciles complete cells, task-level uncertainty and incremental versus reused plan cost', () => {
  const f = fixture(); const before = readFileSync(join(f.dir, 'runs.jsonl'), 'utf8'); const r = f.report();
  assert.equal(r.expected, 42); assert.equal(r.recorded, 42); assert.deepEqual(r.missing, []);
  assert.equal(r.recommendedCandidate, 'S1'); assert.equal(r.arms[4].effort, 'medium');
  const sonnet = r.arms.find(a => a.id === 'S1');
  assert.equal(sonnet.rate, 0.5); assert.ok(Math.abs(sonnet.ci95.low - 0.0945312057) < 1e-8);
  assert.equal(sonnet.coderTokens, 60); assert.ok(Math.abs(sonnet.coderUsd - 0.6) < 1e-8);
  assert.equal(r.reusedPlanUsd, 4); assert.equal(sonnet.goodEnough, true);
  assert.equal(readFileSync(join(f.dir, 'runs.jsonl'), 'utf8'), before);
});
test('keeps missing scores open and uses equal task weights instead of inflating a partial arm', () => {
  const f = fixture(); f.records.splice(f.records.findIndex(r => r.taskId === 'T2' && r.armId === 'H'), 1); f.save();
  const r = f.report(); assert.deepEqual(r.missing, ['T2|H|1']);
  const h = r.arms.find(a => a.id === 'H'); assert.equal(h.rate, 0.5); assert.equal(h.rawRate, 0.6);
  assert.equal(h.goodEnough, null); assert.equal(h.coderUsd, 6);
});
test('counts cumulative costs once per invocation, includes orphan/quarantine spend and marks censored costs', () => {
  const f = fixture(); const path = join(f.dir, 'T1-S1-run1.agent.log');
  writeFileSync(path, f.log('S1', 0.1) + f.event({ type: 'result', total_cost_usd: 0.2 }) + '\n' + f.log('S1', 0.3));
  writeFileSync(join(f.dir, 'quarantined', 'interrupted.agent.log'), '=== claude ===\n');
  mkdirSync(join(f.dir, 'quarantined', 'judge'));
  writeFileSync(join(f.dir, 'quarantined', 'judge', 'T1-S1-claude-1.log'), f.log('A', 0.4));
  const r = f.report(); assert.ok(Math.abs(r.arms.find(a => a.id === 'S1').coderUsd - 1) < 1e-8);
  assert.equal(r.logs.find(l => l.path.includes('quarantined')).invocationsWithoutCost, 1);
  assert.equal(r.costIsLowerBound, true);
  assert.equal(r.quarantinedUsd, 0.4);
});
test('reports model, version, effort and turn-cap violations and never recommends from an unfair trial', () => {
  const f = fixture(); writeFileSync(join(f.dir, 'T1-S1-run1.agent.log'), f.log('S1').replace('2.1.311', 'other').replace('--effort low', '--effort max').replace('--max-turns 75', '--max-turns 9').replace('claude-sonnet-5-5', 'claude-haiku-5-5'));
  const r = f.report(); assert.ok(r.fairnessIssues.some(x => x.includes('version')));
  assert.ok(r.fairnessIssues.some(x => x.includes('effort'))); assert.ok(r.fairnessIssues.some(x => x.includes('turn cap')));
  assert.ok(r.fairnessIssues.some(x => x.includes('model')));
  assert.equal(r.recommendedCandidate, null);
});
test('separates rate-limit warnings/stops and requires both judges and both orders', () => {
  const f = fixture(); const logPath = join(f.dir, 'T1-A-run1.agent.log');
  writeFileSync(logPath, f.log('A') + ['allowed_warning', 'rejected'].map(status => f.event({ type: 'rate_limit_event', rate_limit_info: { status } })).join('\n'));
  writeFileSync(join(f.dir, 'judge', 'T1-S1.json'), f.event([
    { judge: 'claude', verdict: 'arm-win', orders: [{}, {}] }, { judge: 'codex', verdict: 'judge-unavailable', orders: [] },
  ]));
  const r = f.report(); assert.equal(r.arms[0].warningLogs, 1); assert.equal(r.arms[0].limitedLogs, 1);
  assert.equal(r.judging.eligiblePairs, 6); assert.equal(r.judging.savedPairs, 1); assert.equal(r.judging.completePairs, 0);
  assert.equal(r.judging.unavailable.codex, 1); assert.equal(r.baselineAccounts[0].rate, 0.5);
});
test('rejects duplicate, unexpected and malformed input instead of silently changing the denominator', () => {
  const f = fixture();
  const rejects = (result, message) => { assert.equal(result.status, 2); assert.match(result.stderr, message); };
  f.records.push(f.records[0]); f.save(); rejects(f.invoke(), /Duplicate run cell/);
  f.records.pop(); f.records[0].armId = 'unexpected'; f.save(); rejects(f.invoke(), /Unexpected run cell/);
  writeFileSync(join(f.dir, 'runs.jsonl'), 'bad json\n'); rejects(f.invoke(), /Invalid JSON evidence/);
  f.records[0].armId = 'A'; f.save(); rejects(f.invoke('--unknown'), /Usage:/);
});
test('handles an entirely absent task and rejects missing scored evidence', () => {
  const f = fixture(); f.records.splice(0, f.records.length, ...f.records.filter(r => r.taskId !== 'T1')); f.save();
  const r = f.report(); assert.equal(r.missing.length, 21); assert.equal(r.recommendedCandidate, null);
  assert.equal(r.arms[0].rate, null); assert.equal(r.judging.eligiblePairs, 0);
  delete f.records[0].score; f.save(); assert.equal(f.invoke().status, 2);
});

test('withholds recommendations when the saved plan or scoring conditions differ', () => {
  const cases = [
    ['plan use', rs => { rs[0].planUsed = !rs[0].planUsed; }],
    ['scoring contract', rs => { rs[0].score.contract.dependencyFingerprint = 'different-install'; }],
    ['scoring contract', rs => { rs[0].score.contract.version = 'different-tests'; }],
    ['scoring contract', rs => { rs[0].score.contract.amendmentSha256 = 'fixture-amendment'; }],
    ['scoring contract', rs => { for (const r of rs) delete r.score.contract; }],
    ['scoring contract', rs => { for (const r of rs) delete r.score.contract.version; }],
    ['scoring contract', rs => { for (const r of rs) delete r.score.contract.dependencyFingerprint; }],
  ];
  for (const [issue, mutate] of cases) {
    const f = fixture(); mutate(f.records.filter(r => r.taskId === 'T1')); f.save();
    const r = f.report();
    assert.equal(r.recommendedCandidate, null);
    assert.ok(r.fairnessIssues.some(x => x.includes(issue)));
  }
});

test('counts a judged pair only for the right cells and opposite presentation orders', () => {
  const f = fixture();
  const pairs = judgedPairs();
  const save = () => writeFileSync(join(f.dir, 'judge', 'T1-S1.json'), f.event(pairs));
  save(); assert.equal(f.report().judging.completePairs, 1);
  pairs[1].orders[1].subjectSide = 'x'; save();
  assert.equal(f.report().judging.completePairs, 0);
  pairs[1].orders[1].subjectSide = 'y'; pairs[1].subjectRunNumber = 3; save();
  assert.equal(f.report().judging.completePairs, 0);
  pairs[1].subjectRunNumber = 1; pairs[1].taskId = 'T2'; save();
  assert.equal(f.report().judging.completePairs, 0);
  pairs[1].taskId = 'T1'; delete pairs[1].subjectRunNumber; save();
  assert.equal(f.report().judging.completePairs, 0);
  pairs[1].subjectRunNumber = 1; delete pairs[1].baselineRunNumber; save();
  assert.equal(f.report().judging.completePairs, 0);
});

test('rejects the wrong judge arm, unavailable verdicts and invalid rubric scores', () => {
  const mutations = [
    p => { p.armId = 'S2'; },
    p => { p.verdict = 'judge-unavailable'; },
    p => { p.orders[0].scores.x.correctBeyondTests = 11; },
    p => { p.orders[1].scores.y.wouldMergeAsIs = 'yes'; },
    p => { delete p.orders[1].scores.y; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), pairs = judgedPairs();
    const save = () => writeFileSync(join(f.dir, 'judge', 'T1-S1.json'), f.event(pairs));
    save(); assert.equal(f.report().judging.completePairs, 1);
    mutate(pairs[1]); save(); assert.equal(f.report().judging.completePairs, 0);
  }
});

test('seals every consumed JSON input and separates cost gaps by category', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'judge', 'T1-S1-claude-1.log'), '=== claude ===\n');
  writeFileSync(join(f.dir, 'quarantined', 'interrupted.agent.log'), '=== claude ===\n');
  const r = f.report();
  assert.deepEqual(r.costGaps, { coder: 0, judge: 1, quarantined: 1 });
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(r.inputHashes['bank.json'], hash(join(f.dir, 'bank.json')));
  assert.equal(r.inputHashes['runs.jsonl'], r.runsSha256);
  assert.equal(r.inputHashes['plans/T1.usage.json'], hash(join(f.dir, 'plans', 'T1.usage.json')));
  assert.equal(r.arms[0].hiddenPasses, 3);
  assert.equal(r.arms[0].hiddenPassesWithDamage, 0);
});
