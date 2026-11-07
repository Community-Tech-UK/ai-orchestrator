import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capturePatch, exportWorkspace, applyHiddenTests, patchFiles, cleanupWorkspace, writePlanFile } from './task-export';
import { scoreRun, isSolved } from './scorer';
import type { TaskDefinition } from './types';

let workRoot: string;
let repoPath: string;
let parentSha: string;
let commitSha: string;

const task: TaskDefinition = {
  id: 'EXP-1',
  repoId: 'fixture',
  commitSha: 'unused',
  parentSha: 'unused',
  commitMessage: 'feat: add double helper',
  size: 'small',
  prompt: 'Add a double helper.',
  hiddenTests: ['test/double.test.js'],
  hiddenTestCommand: ['node', 'test/double.test.js'],
  damageCommands: [['node', '-e', 'require("./src/lib.js");']],
  sourceFiles: ['src/lib.js'],
  verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
};

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'plan-ex-ab-export-'));
  repoPath = join(workRoot, 'repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  mkdirSync(join(repoPath, 'test'), { recursive: true });
  git(['init', '-q'], repoPath);
  writeFileSync(join(repoPath, 'src/lib.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'baseline'], repoPath);
  parentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  writeFileSync(join(repoPath, 'src/lib.js'), 'function add(a, b) { return a + b; }\nfunction double(x) { return add(x, x); }\nmodule.exports = { add, double };\n');
  writeFileSync(
    join(repoPath, 'test/double.test.js'),
    'const assert = require("node:assert");\nconst { double } = require("../src/lib.js");\nassert.strictEqual(double(21), 42);\n',
  );
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'feat: add double helper'], repoPath);
  commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('task export and scoring', () => {
  it('exports the parent tree with a single baseline commit and no history', async () => {
    const workspace = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-a' });
    const log = execFileSync('git', ['log', '--oneline'], { cwd: workspace.dir, encoding: 'utf8' }).trim();
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toContain('benchmark baseline');
    cleanupWorkspace(workspace.dir);
  });

  it('captures exactly the touched files as a patch', async () => {
    const workspace = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-b' });
    writeFileSync(join(workspace.dir, 'src/lib.js'), 'function add(a, b) { return a + b; }\nfunction double(x) { return add(x, x); }\nmodule.exports = { add, double };\n');
    const patch = await capturePatch(workspace);
    expect(patchFiles(patch)).toEqual(['src/lib.js']);
    expect(patch).toContain('+function double');
    cleanupWorkspace(workspace.dir);
  });

  it('withholds hidden tests until scoring time and scores pass/fail honestly', async () => {
    const good = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-c' });
    writeFileSync(join(good.dir, 'src/lib.js'), 'function add(a, b) { return a + b; }\nfunction double(x) { return add(x, x); }\nmodule.exports = { add, double };\n');
    applyHiddenTests(repoPath, commitSha, task.hiddenTests, good.dir);
    const goodScore = await scoreRun(task, { workspaceDir: good.dir, timeoutMs: 30_000 });
    expect(isSolved(goodScore)).toBe(true);
    cleanupWorkspace(good.dir);

    const bad = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-d' });
    applyHiddenTests(repoPath, commitSha, task.hiddenTests, bad.dir);
    const badScore = await scoreRun(task, { workspaceDir: bad.dir, timeoutMs: 30_000 });
    expect(isSolved(badScore)).toBe(false);
    expect(badScore.hiddenTests.passed).toBe(false);
    cleanupWorkspace(bad.dir);
  });

  it('reports damage when a no-damage check fails', async () => {
    const workspace = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-e' });
    writeFileSync(join(workspace.dir, 'src/lib.js'), 'function add(a, b) { return a + b; }\nfunction double(x) { return add(x, x); }\nmodule.exports = { add, double };\n');
    applyHiddenTests(repoPath, commitSha, task.hiddenTests, workspace.dir);
    const brokenDamageTask: TaskDefinition = {
      ...task,
      damageCommands: [['node', '-e', 'process.exit(2);']],
    };
    const score = await scoreRun(brokenDamageTask, { workspaceDir: workspace.dir, timeoutMs: 30_000 });
    expect(score.hiddenTests.passed).toBe(true);
    expect(score.damageOk).toBe(false);
    cleanupWorkspace(workspace.dir);
  });

  it('applies a hash-pinned scoring amendment on the actual hidden-test path', async () => {
    const workspace = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'amendment' });
    applyHiddenTests(repoPath, commitSha, task.hiddenTests, workspace.dir);
    const patch = '--- a/test/double.test.js\n+++ b/test/double.test.js\n@@ -1,3 +1,4 @@\n const assert = require("node:assert");\n const { double } = require("../src/lib.js");\n assert.strictEqual(double(21), 42);\n+process.exit(3);\n';
    const patchFile = join(workRoot, 'amendment.patch');
    writeFileSync(patchFile, patch);
    const amendedTask: TaskDefinition = { ...task, hiddenTestAmendment: {
      version: 'fixture-v2', patchFile, sha256: createHash('sha256').update(patch).digest('hex'),
    } };
    writeFileSync(join(workspace.dir, 'src/lib.js'), 'module.exports = { double: x => 2 * x };');
    const score = await scoreRun(amendedTask, { workspaceDir: workspace.dir });
    expect(score.hiddenTests.exitCode).toBe(3);
    expect(score.contract?.version).toBe('fixture-v2');
    expect(score.contract?.amendmentSha256).toBe(amendedTask.hiddenTestAmendment?.sha256);
    applyHiddenTests(repoPath, commitSha, task.hiddenTests, workspace.dir);
    writeFileSync(patchFile, patch + '\n');
    await expect(scoreRun(amendedTask, { workspaceDir: workspace.dir })).rejects.toThrow(/hash mismatch/);
    cleanupWorkspace(workspace.dir);
  });

  it('keeps installed dependencies and plan files out of captured patches', async () => {
    const workspace = await exportWorkspace({ repoPath, commitSha: parentSha, workRoot, workspaceName: 'exp-f' });
    mkdirSync(join(workspace.dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(workspace.dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writePlanFile(workspace.dir, '# frozen plan\n');
    writeFileSync(join(workspace.dir, 'src/lib.js'), 'function add(a, b) { return a + b; }\nfunction double(x) { return add(x, x); }\nmodule.exports = { add, double };\n');
    const patch = await capturePatch(workspace);
    expect(patchFiles(patch)).toEqual(['src/lib.js']);
    expect(patch).not.toContain('node_modules');
    expect(patch).not.toContain('PLAN-agent-output.md');
    cleanupWorkspace(workspace.dir);
  });
});

describe('cleanupWorkspace transient removal races (LT-707)', () => {
  it('retries through a transient ENOTEMPTY and then succeeds', () => {
    const calls: string[] = [];
    let failures = 1;
    cleanupWorkspace('/tmp/ws-lt707', {
      rmImpl: (dir) => {
        calls.push(dir);
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
        }
      },
      sleepImpl: () => { /* no waiting in tests */ },
    });
    expect(calls).toHaveLength(2);
  });

  it('rethrows a persistent transient failure after bounded retries', () => {
    let calls = 0;
    expect(() => cleanupWorkspace('/tmp/ws-lt707', {
      rmImpl: () => {
        calls += 1;
        throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
      },
      sleepImpl: () => { /* no waiting in tests */ },
    })).toThrow('ENOTEMPTY');
    expect(calls).toBe(3);
  });

  it('rethrows a non-transient failure immediately', () => {
    let calls = 0;
    expect(() => cleanupWorkspace('/tmp/ws-lt707', {
      rmImpl: () => {
        calls += 1;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      sleepImpl: () => { /* no waiting in tests */ },
    })).toThrow('EACCES');
    expect(calls).toBe(1);
  });
});
