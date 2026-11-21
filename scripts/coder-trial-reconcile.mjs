#!/usr/bin/env node
/** Offline audit of the saved Haiku/Sonnet trial. Reads files; writes JSON to stdout only. */
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const ARMS = { A: undefined, H: 'high', HM: 'max', S1: 'low', S2: 'medium', S3: 'high', S4: 'max' };
const key = r => `${r.taskId}|${r.armId}|${r.runNumber}`;
const solved = r => r?.score?.hiddenTests?.passed === true && r?.score?.damageOk === true;
const sum = values => values.reduce((a, b) => a + b, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function wilson(p, n) {
  const z2 = 1.959963984540054 ** 2, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = Math.sqrt(z2 * (p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}
async function filesUnder(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(dir, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
async function auditLog(dir, path) {
  const result = { path, usd: 0, invocationsWithoutCost: 0, versions: [], models: [], efforts: [], turnCaps: [], warning: false, limited: false };
  const versions = new Set(), models = new Set(), efforts = new Set(), turnCaps = new Set();
  const hash = createHash('sha256'); let currentCost = null, started = false;
  const stream = createReadStream(join(dir, path)); stream.on('data', chunk => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const closeInvocation = () => {
    if (!started) return;
    if (currentCost === null) result.invocationsWithoutCost++;
    else result.usd += currentCost;
  };
  for await (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('=== ')) {
      closeInvocation(); started = true; currentCost = null;
      efforts.add(/--effort (\S+)/.exec(line)?.[1] ?? 'default');
      turnCaps.add(Number(/--max-turns (\d+)/.exec(line)?.[1] ?? 0));
      const model = /--model (\S+)/.exec(line)?.[1]; if (model) models.add(model);
      continue;
    }
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { throw new Error(`Malformed JSON event in ${path}`); }
    // No prompts, environment variables, transcripts or credentials are copied to the report.
    if (e.type === 'system' && e.subtype === 'init') {
      if (e.claude_code_version) versions.add(e.claude_code_version);
      if (e.model) models.add(e.model);
    }
    if (e.type === 'result' && finite(e.total_cost_usd)) {
      started = true; currentCost = Math.max(currentCost ?? 0, e.total_cost_usd);
    }
    if (e.type === 'rate_limit_event') {
      result.warning ||= e.rate_limit_info?.status === 'allowed_warning';
      result.limited ||= e.rate_limit_info?.status === 'rejected';
    }
  }
  closeInvocation();
  return { ...result, sha256: hash.digest('hex'), versions: [...versions], models: [...models], efforts: [...efforts], turnCaps: [...turnCaps] };
}
async function reconcile(session, bank) {
  const inputHashes = {};
  const readJson = async (path, source = join(session, path)) => {
    const raw = await readFile(source, 'utf8');
    inputHashes[path] = sha256(raw);
    return JSON.parse(raw);
  };
  const raw = await readFile(join(session, 'runs.jsonl'), 'utf8');
  inputHashes['runs.jsonl'] = sha256(raw);
  const tasks = (await readJson('bank.json', bank)).tasks.map(t => t.id);
  if (!tasks.length || tasks.some(t => typeof t !== 'string' || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(t)) || new Set(tasks).size !== tasks.length) throw new Error('Invalid task bank');
  const records = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const cells = new Map();
  for (const r of records) {
    if (!tasks.includes(r.taskId) || !Object.hasOwn(ARMS, r.armId) || ![1, 2, 3].includes(r.runNumber)) throw new Error('Unexpected run cell');
    if (cells.has(key(r))) throw new Error(`Duplicate run cell: ${key(r)}`);
    if (!finite(r.durationMs) || typeof r.score?.hiddenTests?.passed !== 'boolean' || typeof r.score?.damageOk !== 'boolean'
      || !r.coderUsage || !['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(k => finite(r.coderUsage[k]))) throw new Error(`Invalid scored record: ${key(r)}`);
    cells.set(key(r), r);
  }
  const missing = [];
  for (const taskId of tasks) for (const armId of Object.keys(ARMS)) for (let runNumber = 1; runNumber <= 3; runNumber++) {
    const k = key({ taskId, armId, runNumber }); if (!cells.has(k)) missing.push(k);
  }
  const paths = await filesUnder(session);
  const logs = [];
  for (const path of paths.filter(p => p.endsWith('.agent.log') || (/(^|\/)judge\//.test(p) && /-claude-\d+\.log$/.test(p)))) logs.push(await auditLog(session, path));
  const fairnessIssues = [];
  for (const r of records) {
    const path = `${r.taskId}-${r.armId}-run${r.runNumber}.agent.log`;
    const log = logs.find(l => l.path === path);
    if (!log) { fairnessIssues.push(`Missing log: ${key(r)}`); continue; }
    if (log.versions.length !== 1 || log.versions[0] !== '2.1.311') fairnessIssues.push(`CLI version mismatch/unrecorded: ${key(r)}`);
    if (r.coderEffort !== ARMS[r.armId] || log.efforts.some(e => e !== (ARMS[r.armId] ?? 'default')) || !log.efforts.length) fairnessIssues.push(`CLI effort mismatch/unrecorded: ${key(r)}`);
    if (log.turnCaps.length !== 1 || log.turnCaps[0] !== 75) fairnessIssues.push(`CLI turn cap mismatch/unrecorded: ${key(r)}`);
    const expectedModel = r.armId === 'A' ? 'claude-opus-5-5' : r.armId.startsWith('S') ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
    if (!log.models.length || log.models.some(m => m !== expectedModel)) fairnessIssues.push(`CLI model mismatch/unrecorded: ${key(r)}`);
    if (r.planUsed !== (r.armId !== 'A')) fairnessIssues.push(`Frozen plan use mismatch/unrecorded: ${key(r)}`);
  }
  const scoringContracts = tasks.map(task => {
    const contracts = records.filter(r => r.taskId === task).map(r => r.score.contract);
    const signatures = new Set(contracts.map(c => JSON.stringify([c?.version, c?.amendmentSha256, c?.dependencyFingerprint])));
    if (contracts.length && (signatures.size !== 1 || contracts.some(c => !c?.version || !c?.dependencyFingerprint))) {
      fairnessIssues.push(`Mixed/unrecorded scoring contract: ${task}`);
    }
    return { task, contracts: [...signatures].map(s => JSON.parse(s)) };
  });
  const arms = Object.entries(ARMS).map(([id, effort]) => {
    const runs = records.filter(r => r.armId === id);
    const perTask = tasks.map(task => {
      const rs = runs.filter(r => r.taskId === task);
      return { task, runs: rs.length, solved: rs.filter(solved).length, rate: mean(rs.map(r => Number(solved(r)))) };
    });
    const rate = perTask.every(t => t.rate !== null) ? mean(perTask.map(t => t.rate)) : null;
    const armLogs = logs.filter(l => !l.path.includes('/') && /-([A-Z0-9]+)-run[123]\.agent\.log$/.exec(l.path)?.[1] === id);
    const coderUsd = sum(armLogs.map(l => l.usd));
    const successes = runs.filter(solved).length;
    return { id, effort: effort ?? 'default', runs: runs.length, solved: successes, perTask,
      hiddenPasses: runs.filter(r => r.score.hiddenTests.passed).length,
      hiddenPassesWithDamage: runs.filter(r => r.score.hiddenTests.passed && !r.score.damageOk).length,
      rawRate: runs.length ? successes / runs.length : null, rate, ci95: rate === null ? null : wilson(rate, tasks.length),
      averageMinutes: mean(runs.map(r => r.durationMs / 60000)),
      coderTokens: sum(runs.map(r => sum(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(k => r.coderUsage[k])))),
      coderUsd, usdPerSolved: successes ? coderUsd / successes : null,
      invocationsWithoutCost: sum(armLogs.map(l => l.invocationsWithoutCost)),
      warningLogs: armLogs.filter(l => l.warning).length, limitedLogs: armLogs.filter(l => l.limited).length,
      errors: runs.filter(r => r.error !== undefined).length,
    };
  });
  const baseline = arms[0];
  for (const arm of arms) {
    arm.gapPoints = arm.rate === null || baseline.rate === null ? null : (arm.rate - baseline.rate) * 100;
    arm.goodEnough = arm.runs !== tasks.length * 3 || baseline.runs !== tasks.length * 3 || fairnessIssues.length ? null
      : arm.rate + 1e-12 >= baseline.rate - 0.10 && arm.ci95.low + 1e-12 >= baseline.ci95.low - 0.25;
  }
  const candidates = arms.filter(a => a.id !== 'A' && a.goodEnough && a.usdPerSolved !== null)
    .sort((a, b) => a.usdPerSolved - b.usdPerSolved || a.averageMinutes - b.averageMinutes);
  let reusedPlanUsd = 0;
  for (const task of tasks) {
    const usage = await readJson(`plans/${task}.usage.json`);
    const costs = Object.values(usage.models ?? {}).map(m => m.cost);
    if (!costs.length || !costs.every(finite)) throw new Error(`Missing historical plan cost: ${task}`);
    reusedPlanUsd += sum(costs);
  }
  const judging = { eligiblePairs: 0, savedPairs: 0, completePairs: 0, unavailable: { claude: 0, codex: 0 }, missing: [], incomplete: [] };
  for (const task of tasks) for (const arm of Object.keys(ARMS).filter(a => a !== 'A')) {
    // The original runner judges the first saved repeat, once per task and arm.
    const subject = records.find(r => r.taskId === task && r.armId === arm);
    const base = records.find(r => r.taskId === task && r.armId === 'A');
    if (!solved(subject) || !solved(base)) continue;
    judging.eligiblePairs++;
    const path = `judge/${task}-${arm}.json`;
    if (!paths.includes(path)) { judging.missing.push(`${task}|${arm}`); continue; }
    const pairs = await readJson(path);
    if (!Array.isArray(pairs)) throw new Error(`Invalid judge evidence: ${task}|${arm}`);
    judging.savedPairs++;
    for (const judge of ['claude', 'codex']) judging.unavailable[judge] += pairs.filter(p => p.judge === judge && p.verdict === 'judge-unavailable').length;
    const complete = ['claude', 'codex'].every(j => {
      const matches = pairs.filter(p => p.judge === j);
      if (matches.length !== 1) return false;
      const p = matches[0];
      return p.taskId === task && p.armId === arm
        && p.subjectRunNumber === subject.runNumber
        && p.baselineRunNumber === base.runNumber
        && ['arm-win', 'baseline-win', 'tie'].includes(p.verdict)
        && p.orders?.length === 2 && p.orders[0].subjectSide === 'x' && p.orders[1].subjectSide === 'y'
        && p.orders.every(o => ['x', 'y', 'tie'].includes(o.winner) && ['x', 'y'].every(side => {
          const score = o.scores?.[side];
          return score && typeof score.wouldMergeAsIs === 'boolean'
            && ['correctBeyondTests', 'fitsCodebaseStyle', 'noUnrequestedChanges'].every(k => finite(score[k]) && score[k] <= 10);
        }));
    });
    if (complete) judging.completePairs++;
    else judging.incomplete.push(`${task}|${arm}`);
  }
  const accounts = [...new Set(records.filter(r => r.armId === 'A').map(r => r.claudeAccount))];
  const costGaps = { coder: 0, judge: 0, quarantined: 0 };
  for (const log of logs) {
    const category = log.path.startsWith('quarantined/') ? 'quarantined' : log.path.startsWith('judge/') ? 'judge' : 'coder';
    costGaps[category] += log.invocationsWithoutCost;
  }
  return { expected: tasks.length * 21, recorded: records.length, missing, tasks, arms, fairnessIssues, scoringContracts, inputHashes, costGaps,
    recommendedCandidate: candidates[0]?.id ?? null, judging, reusedPlanUsd,
    baselineAccounts: accounts.map(account => {
      const runs = records.filter(r => r.armId === 'A' && r.claudeAccount === account);
      return { account, runs: runs.length, solved: runs.filter(solved).length, rate: mean(runs.map(r => Number(solved(r)))), tasks: [...new Set(runs.map(r => r.taskId))] };
    }),
    accounts: Object.fromEntries([...new Set(records.map(r => r.claudeAccount))].map(a => [a, records.filter(r => r.claudeAccount === a).length])),
    judgeUsd: sum(logs.filter(l => l.path.startsWith('judge/')).map(l => l.usd)),
    quarantinedUsd: sum(logs.filter(l => l.path.startsWith('quarantined/')).map(l => l.usd)),
    loggedUsd: sum(logs.map(l => l.usd)), costIsLowerBound: logs.some(l => l.invocationsWithoutCost > 0),
    runsSha256: createHash('sha256').update(raw).digest('hex'), logs,
  };
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--session' || args[2] !== '--bank') throw new Error('Usage: node scripts/coder-trial-reconcile.mjs --session DIR --bank FILE');
  console.log(JSON.stringify(await reconcile(args[1], args[3]), null, 2));
} catch (error) {
  // Do not echo JSON input, transcript text or child-process output in diagnostics.
  console.error(error instanceof SyntaxError ? 'Invalid JSON evidence' : error.message);
  process.exitCode = 2;
}
