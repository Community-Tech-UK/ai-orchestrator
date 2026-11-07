import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifySize, draftPrompt, leakageCheck, listCandidates, verifyTask } from './mine-tasks';
import { cmdVerifyTask } from './runner-tools';
import type { TaskDefinition } from './types';

let workRoot: string;
let repoPath: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'plan-ex-ab-mine-'));
  repoPath = join(workRoot, 'repo');
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  git(['init', '-q'], repoPath);
  writeFileSync(join(repoPath, 'src/alpha.js'), 'function getAlpha() { return 1; }\nmodule.exports = { getAlpha };\n');
  writeFileSync(join(repoPath, 'src/beta.js'), 'function getBeta() { return 2; }\nmodule.exports = { getBeta };\n');
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'baseline'], repoPath);
  writeFileSync(join(repoPath, 'src/alpha.js'), 'function getAlpha() { return 2; }\nmodule.exports = { getAlpha };\n');
  writeFileSync(
    join(repoPath, 'src/alpha.test.js'),
    'const assert = require("node:assert");\nconst { getAlpha } = require("./alpha.js");\nassert.strictEqual(getAlpha(), 2);\n',
  );
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'fix(alpha): double the alpha value'], repoPath);
  writeFileSync(join(repoPath, 'src/docs.md'), '# docs\n');
  git(['add', '-A'], repoPath);
  git(['commit', '-q', '-m', 'docs: add readme'], repoPath);
});

afterAll(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

describe('mining', () => {
  async function verifyPublic(id: string, amendment: boolean, missingTool = false): Promise<number> {
    const candidate = listCandidates({ repoPath, repoId: 'fixture' })[0];
    const patch = '--- a/src/alpha.test.js\n+++ b/src/alpha.test.js\n@@ -1,3 +1,4 @@\n const assert = require("node:assert");\n const { getAlpha } = require("./alpha.js");\n assert.strictEqual(getAlpha(), 2);\n+process.exit(3);\n';
    const patchFile = join(workRoot, `${id}.patch`);
    writeFileSync(patchFile, patch);
    const task: TaskDefinition = {
      ...candidate, id, repoId: 'fixture', prompt: 'Keep alpha values doubled.',
      hiddenTests: candidate.testFiles, hiddenTestCommand: missingTool ? ['missing-benchmark-fixture-executable'] : ['node', 'src/alpha.test.js'],
      damageCommands: [], verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
      hiddenTestAmendment: amendment ? { version: 'fixture-v2', patchFile, sha256: createHash('sha256').update(patch).digest('hex') } : undefined,
    };
    const taskFile = join(workRoot, `${id}.json`);
    const configPath = join(workRoot, `${id}.config.json`);
    writeFileSync(taskFile, JSON.stringify(task));
    writeFileSync(configPath, JSON.stringify({ repoPaths: { fixture: repoPath }, resultsRoot: join(workRoot, 'public-results'), workRoot: join(workRoot, 'public-workspaces'), localArms: [] }));
    return cmdVerifyTask({ command: 'verify-task', configPath, taskFile, dryRun: false, includeOptional: false, phase: 'pilot' });
  }

  it('public verify-task uses frozen setup and the declared scoring amendment', async () => {
    expect(await verifyPublic('PUBLIC-V2', true)).toBe(1);
    const evidence = join(workRoot, 'public-results/mining/PUBLIC-V2');
    const result = JSON.parse(readFileSync(join(evidence, 'verification.json'), 'utf8'));
    expect(result.commitScore.hiddenTests.exitCode).toBe(3);
    expect(result.commitScore.contract.version).toBe('fixture-v2');
    expect(existsSync(join(evidence, 'commit/dependencies.json'))).toBe(true);
    expect(existsSync(join(workRoot, 'public-workspaces/PUBLIC-V2-verification'))).toBe(false);
  });

  it('public verify-task leaves missing tooling unscored and removes its workspace', async () => {
    await expect(verifyPublic('PUBLIC-INFRA', false, true)).rejects.toThrow(/infrastructure/);
    expect(existsSync(join(workRoot, 'public-workspaces/PUBLIC-INFRA-verification'))).toBe(false);
    expect(existsSync(join(workRoot, 'public-results/mining/PUBLIC-INFRA/verification.json'))).toBe(false);
  });
  it('classifies task size from touched source files', () => {
    expect(classifySize(['a.ts'])).toBe('small');
    expect(classifySize(['a.ts', 'b.ts', 'c.ts'])).toBe('medium');
    expect(classifySize(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'])).toBe('large');
  });

  it('finds only commits that pair test changes with source changes', () => {
    const candidates = listCandidates({ repoPath, repoId: 'fixture' });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].commitMessage).toContain('alpha');
    expect(candidates[0].testFiles).toEqual(['src/alpha.test.js']);
    expect(candidates[0].sourceFiles).toEqual(['src/alpha.js']);
    expect(candidates[0].size).toBe('small');
  });

  it('drafts an outcome prompt without leaking the solution', () => {
    const candidates = listCandidates({ repoPath, repoId: 'fixture' });
    const prompt = draftPrompt(candidates[0]);
    expect(prompt).toContain('Task:');
    const issues = leakageCheck(prompt, { ...candidates[0], patchLines: ['+function getAlpha() { return 2; }'] });
    expect(issues).toEqual([]);
  });

  it('flags prompts that leak shas, file names or diff lines', () => {
    const candidates = listCandidates({ repoPath, repoId: 'fixture' });
    const candidate = candidates[0];
    const leaky = `Change ${candidate.commitSha} in ${candidate.sourceFiles[0]} by adding\n+function getAlpha() { return 2; }\n`;
    const issues = leakageCheck(leaky, { ...candidate, patchLines: ['+function getAlpha() { return 2; }'] });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('verifies fail-on-parent / pass-on-commit against the real test command', async () => {
    const candidates = listCandidates({ repoPath, repoId: 'fixture' });
    const candidate = candidates[0];
    const task: TaskDefinition = {
      id: 'MINE-1',
      repoId: 'fixture',
      commitSha: candidate.commitSha,
      parentSha: candidate.parentSha,
      commitMessage: candidate.commitMessage,
      size: candidate.size,
      prompt: 'Keep alpha values doubled.',
      hiddenTests: candidate.testFiles,
      hiddenTestCommand: ['node', '--test', 'src/alpha.test.js'],
      damageCommands: [],
      sourceFiles: candidate.sourceFiles,
      verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
    };
    const result = await verifyTask({
      task,
      repoPath,
      evidenceDir: join(workRoot, 'evidence'),
      workRoot,
      timeoutMs: 30_000,
    });
    expect(result.failOnParent).toBe(true);
    expect(result.passOnCommit).toBe(true);
  });
});
