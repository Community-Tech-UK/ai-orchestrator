import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { judgePair, stripIdentifyingText } from './judge';
import type { JudgeRunner } from './judge';
import { buildReport, renderReportMarkdown } from './report';
import { scoreRun, isSolved } from './scorer';
import { applyHiddenTests, capturePatch, cleanupWorkspace, exportWorkspace, patchFiles } from './task-export';
import type { AgentRunResult, RunRecord, TaskDefinition } from './types';
import { emptyUsage } from './types';

const PARENT_MATH = [
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'module.exports = { add };',
  '',
].join('\n');

const SOLUTION_MATH = [
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function clamp(value, min, max) {',
  '  return Math.min(Math.max(value, min), max);',
  '}',
  '',
  'module.exports = { add, clamp };',
  '',
].join('\n');

const BROKEN_MATH = [
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function clamp(value, min, max) {',
  '  return min;',
  '}',
  '',
  'module.exports = { add, clamp };',
  '',
].join('\n');

const HIDDEN_TEST = [
  'const assert = require("node:assert");',
  'const { clamp } = require("../src/math.js");',
  'assert.strictEqual(clamp(5, 0, 10), 5);',
  'assert.strictEqual(clamp(-1, 0, 10), 0);',
  'assert.strictEqual(clamp(99, 0, 10), 10);',
  'console.log("clamp ok");',
  '',
].join('\n');

const COMMIT_MESSAGE = 'feat: add clamp helper for bounded values';

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.name=plan-execute-ab', '-c', 'user.email=plan-execute-ab@local', ...args], {
    cwd,
    stdio: 'pipe',
  });
}

export interface FixtureRepo {
  repoPath: string;
  parentSha: string;
  commitSha: string;
  task: TaskDefinition;
}

export function createFixtureRepo(workRoot: string): FixtureRepo {
  const repoPath = join(workRoot, 'fixture-repo');
  rmSync(repoPath, { recursive: true, force: true });
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'test'), { recursive: true });

  git(['init', '-q'], repoPath);
  writeFileSync(join(repoPath, 'src/math.js'), PARENT_MATH);
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'baseline math helpers'], repoPath);
  const parentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

  writeFileSync(join(repoPath, 'src/math.js'), SOLUTION_MATH);
  writeFileSync(join(repoPath, 'test/clamp.test.js'), HIDDEN_TEST);
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', COMMIT_MESSAGE], repoPath);
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();

  const task: TaskDefinition = {
    id: 'SELF-TEST-1',
    repoId: 'fixture-repo',
    commitSha,
    parentSha,
    commitMessage: COMMIT_MESSAGE,
    size: 'small',
    prompt: 'Add a clamp function to src/math.js that limits a value to a [min, max] range, with tests.',
    hiddenTests: ['test/clamp.test.js'],
    hiddenTestCommand: ['node', 'test/clamp.test.js'],
    damageCommands: [['node', '-e', 'require("./src/math.js");']],
    sourceFiles: ['src/math.js'],
    verification: {
      failOnParent: true,
      passOnCommit: true,
      checkedAt: new Date().toISOString(),
      evidenceDir: '',
    },
  };
  return { repoPath, parentSha, commitSha, task };
}

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestResult {
  checks: SelfTestCheck[];
  passed: boolean;
}

function fakeJudge(finalText: string): JudgeRunner {
  return async (): Promise<AgentRunResult> => ({
    finalText,
    usage: emptyUsage(),
    turns: 1,
    toolErrors: [],
    hitTurnCap: false,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    rawLogPath: '',
  });
}

function judgePreferring(preferred: 'subject' | 'first'): JudgeRunner {
  return async (prompt: string): Promise<AgentRunResult> => {
    const xSection = prompt.split('Patch X:')[1]?.split('Patch Y:')[0] ?? '';
    const subjectIsX = xSection.includes('+good');
    const winner = preferred === 'first' ? 'x' : subjectIsX ? 'x' : 'y';
    const winScore = { correctBeyondTests: 9, fitsCodebaseStyle: 9, noUnrequestedChanges: 10, wouldMergeAsIs: true, notes: '' };
    const loseScore = { correctBeyondTests: 2, fitsCodebaseStyle: 5, noUnrequestedChanges: 4, wouldMergeAsIs: false, notes: '' };
    return fakeJudge(JSON.stringify({
      x: winner === 'x' ? winScore : loseScore,
      y: winner === 'y' ? winScore : loseScore,
      winner,
    }))('');
  };
}

export async function runSelfTest(workRoot: string): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];
  const scratch = join(workRoot, 'self-test-run');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  const fixture = createFixtureRepo(scratch);

  const goodWorkspace = await exportWorkspace({
    repoPath: fixture.repoPath,
    commitSha: fixture.parentSha,
    workRoot: scratch,
    workspaceName: 'good-workspace',
  });
  writeFileSync(join(goodWorkspace.dir, 'src/math.js'), SOLUTION_MATH);
  applyHiddenTests(fixture.repoPath, fixture.commitSha, fixture.task.hiddenTests, goodWorkspace.dir);
  const goodScore = await scoreRun(fixture.task, { workspaceDir: goodWorkspace.dir, timeoutMs: 60_000 });
  checks.push({
    name: 'known-good patch passes hidden tests and damage checks',
    ok: isSolved(goodScore),
    detail: `hidden exit ${goodScore.hiddenTests.exitCode}, damageOk ${goodScore.damageOk}`,
  });

  const brokenWorkspace = await exportWorkspace({
    repoPath: fixture.repoPath,
    commitSha: fixture.parentSha,
    workRoot: scratch,
    workspaceName: 'broken-workspace',
  });
  writeFileSync(join(brokenWorkspace.dir, 'src/math.js'), BROKEN_MATH);

  const patch = await capturePatch(brokenWorkspace);
  const files = patchFiles(patch);
  checks.push({
    name: 'patch capture lists exactly the touched file',
    ok: files.length === 1 && files[0] === 'src/math.js',
    detail: `files: ${files.join(', ') || '(none)'}`,
  });

  applyHiddenTests(fixture.repoPath, fixture.commitSha, fixture.task.hiddenTests, brokenWorkspace.dir);
  const brokenScore = await scoreRun(fixture.task, { workspaceDir: brokenWorkspace.dir, timeoutMs: 60_000 });
  checks.push({
    name: 'deliberately broken patch is caught by hidden tests',
    ok: !brokenScore.hiddenTests.passed,
    detail: `hidden exit ${brokenScore.hiddenTests.exitCode} (must be non-zero)`,
  });

  const stripped = stripIdentifyingText([
    'diff --git a/x b/x',
    '-old',
    '+new',
    '+// Generated with Claude Code',
    '+Co-Authored-By: Claude <noreply@anthropic.com>',
  ].join('\n'));
  checks.push({
    name: 'label stripping removes model-identifying trailers',
    ok: !stripped.includes('Claude') && !stripped.includes('Co-Authored-By') && stripped.includes('+new'),
    detail: stripped,
  });

  const subjectJudge = judgePreferring('subject');
  const firstBiasJudge = judgePreferring('first');

  const pairWinBoth = await judgePair('claude', subjectJudge, fixture.task, 'D', '+good', '+bad');
  checks.push({
    name: 'judge: subject winning both orders is an arm-win',
    ok: pairWinBoth.verdict === 'arm-win',
    detail: `verdict ${pairWinBoth.verdict}`,
  });

  const pairMixed = await judgePair('claude', firstBiasJudge, fixture.task, 'D', '+good', '+bad');
  checks.push({
    name: 'judge: winning only one order collapses to a tie',
    ok: pairMixed.verdict === 'tie',
    detail: `verdict ${pairMixed.verdict}`,
  });

  const pairUnavailable = await judgePair('codex', async () => {
    throw new Error('judge CLI missing');
  }, fixture.task, 'G', '+good', '+bad');
  checks.push({
    name: 'judge: an unavailable judge is recorded, never silently replaced',
    ok: pairUnavailable.verdict === 'judge-unavailable' && Boolean(pairUnavailable.error),
    detail: `verdict ${pairUnavailable.verdict}, error ${pairUnavailable.error ?? ''}`,
  });

  const runRecord = (armId: RunRecord['armId'], passed: boolean): RunRecord => ({
    taskId: fixture.task.id,
    armId,
    runNumber: 1,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 60_000,
    workspaceDir: 'synthetic',
    planUsed: armId !== 'A',
    plannerUsage: emptyUsage(),
    coderUsage: emptyUsage(),
    takeoverUsage: emptyUsage(),
    turns: 3,
    flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
    score: {
      hiddenTests: {
        passed,
        command: fixture.task.hiddenTestCommand,
        exitCode: passed ? 0 : 1,
        timedOut: false,
        outputTail: '',
      },
      damage: [],
      damageOk: true,
    },
    patchPath: '',
  });
  const report = buildReport(
    'synthetic',
    [runRecord('A', true), runRecord('D', true), runRecord('C1', false)],
    [pairWinBoth],
    null,
    'pilot',
  );
  const markdown = renderReportMarkdown(report);
  checks.push({
    name: 'report aggregates arms and renders decision rules',
    ok: report.arms.length === 3 && markdown.includes('Pre-agreed decision rules')
      && markdown.includes('Local model speeds') && markdown.includes('| A | 1 |'),
    detail: `arms ${report.arms.length}, rules ${report.decisionRules.length}`,
  });
  checks.push({
    name: 'report renders uncertainty ranges, gaps vs A, and cost per solved task',
    ok: report.arms.every((arm) => arm.solvedRateCI95.high >= arm.solvedRateCI95.low)
      && report.baselineGaps.length === 2
      && markdown.includes('Uncertainty (95% ranges)')
      && markdown.includes('Solved-rate gap vs arm A')
      && markdown.includes('Cost (metered USD)'),
    detail: `gaps ${report.baselineGaps.map((gap) => gap.armId).join(',')}, cost ${report.cost ? 'collected' : 'not collected'}`,
  });

  cleanupWorkspace(goodWorkspace.dir);
  cleanupWorkspace(brokenWorkspace.dir);

  return { checks, passed: checks.every((check) => check.ok) };
}

export function renderSelfTest(result: SelfTestResult): string {
  const lines = result.checks.map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  lines.push(result.passed ? 'SELF-TEST PASS' : 'SELF-TEST FAIL');
  return lines.join('\n');
}

export function assertSelfTestFixtureClean(workRoot: string): void {
  rmSync(join(workRoot, 'self-test-run'), { recursive: true, force: true });
}
