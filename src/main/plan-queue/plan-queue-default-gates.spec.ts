import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { defaultRunConfigFor, findThisRepository, THIS_REPOSITORY_ROOT_COMMIT } from './plan-queue-default-gates';

let root: string;
/** The first commit of the folder under test, standing in for this repository's. */
let rootCommit: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plan-queue-gates-'));
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  rootCommit = git('rev-list', '--max-parents=0', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const allScripts = Object.fromEntries(
  [...DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates, ...DEFAULT_PLAN_QUEUE_CONFIG.plans.postMergeGate]
    .flatMap((command) => /^npm run (\S+)/.exec(command)?.[1] ?? []).map((name) => [name, 'true']),
);

const own = (scripts: Record<string, string>) => JSON.stringify({ name: 'harness', scripts });

describe('defaultRunConfigFor', () => {
  it('keeps this repository\'s checklists for this repository when it defines every script and has a tsconfig', async () => {
    writeFileSync(join(root, 'package.json'), own(allScripts));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect(await defaultRunConfigFor(root, 'plans', rootCommit)).toEqual(DEFAULT_PLAN_QUEUE_CONFIG.plans);
    expect(await defaultRunConfigFor(root, 'livetests', rootCommit)).toEqual(DEFAULT_PLAN_QUEUE_CONFIG.livetests);
  });

  const none = { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: [], postMergeGate: [] };

  it('gives another project no checklist, even one that copies the package name, scripts and tsconfig', async () => {
    writeFileSync(join(root, 'package.json'), own(allScripts));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    // The folder's own history does not start with this repository's first commit.
    expect(await defaultRunConfigFor(root, 'plans', THIS_REPOSITORY_ROOT_COMMIT)).toEqual(none);
    expect((await defaultRunConfigFor(root, 'livetests', THIS_REPOSITORY_ROOT_COMMIT)).verifierGates).toEqual([]);
    expect(THIS_REPOSITORY_ROOT_COMMIT).not.toBe(rootCommit);
  });

  it('starts a folder that is not a git repository, or has no package.json, with no checklist', async () => {
    expect(await defaultRunConfigFor(root, 'plans', rootCommit)).toEqual(none);
    const plain = mkdtempSync(join(tmpdir(), 'plan-queue-gates-plain-'));
    try {
      writeFileSync(join(plain, 'package.json'), own(allScripts));
      writeFileSync(join(plain, 'tsconfig.json'), '{}');
      expect(await defaultRunConfigFor(plain, 'plans', rootCommit)).toEqual(none);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does the same for this repository when one script is missing, or there is no tsconfig for the type-check', async () => {
    const { lint: _lint, ...withoutLint } = allScripts;
    writeFileSync(join(root, 'package.json'), own(withoutLint));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect((await defaultRunConfigFor(root, 'plans', rootCommit)).verifierGates).toEqual([]);
    writeFileSync(join(root, 'package.json'), own(allScripts));
    rmSync(join(root, 'tsconfig.json'));
    expect((await defaultRunConfigFor(root, 'plans', rootCommit)).verifierGates).toEqual([]);
  });

  it('keeps every other default (slots, rounds, load limit) for a project without the scripts', async () => {
    const config = await defaultRunConfigFor(root, 'livetests', THIS_REPOSITORY_ROOT_COMMIT);
    expect(config).toMatchObject({ workerSlots: 1, verificationSlots: 1, maxRounds: 3, maxLoadAverage: 30 });
  });
});

describe('findThisRepository', () => {
  it('returns the first folder holding this repository, skipping other projects, missing folders and .worktrees copies', async () => {
    const other = mkdtempSync(join(tmpdir(), 'plan-queue-gates-other-'));
    const copy = join(root, '.worktrees', 'queue');
    try {
      execFileSync('git', ['init', '-q'], { cwd: other });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'other'], { cwd: other });
      git('worktree', 'add', '-q', '--detach', copy);
      expect(await findThisRepository([other, join(root, 'gone'), copy, root], rootCommit)).toBe(root);
      expect(await findThisRepository([other, copy], rootCommit)).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
