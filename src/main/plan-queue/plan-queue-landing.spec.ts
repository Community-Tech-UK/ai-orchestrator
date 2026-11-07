import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { landItemBranch, runPostMergeGate, syncItemWithBase } from './plan-queue-landing';
import type { PlanQueueItem } from './plan-queue.types';

/** One-shot hook used to fail a document-merge write inside the real resolver. */
const hook = vi.hoisted(() => ({ failWrite: '', beforeWrite: null as (() => Promise<void>) | null, target: '' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === hook.target && args[1] === 'w' && hook.beforeWrite) {
        const run = hook.beforeWrite; hook.beforeWrite = null; await run();
      }
      return actual.open(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]) === hook.failWrite) {
        await actual.writeFile(args[0], 'half written');
        throw new Error('disk trouble');
      }
      return actual.writeFile(...args);
    },
  };
});

/** Shrinks the landing hook's 60-minute budget so a real sleeping hook can time out in a test. */
const hookBudget = vi.hoisted(() => ({ timeoutMs: null as number | null }));
vi.mock('./plan-queue-process', async (original) => {
  const actual = await original<typeof import('./plan-queue-process')>();
  return {
    ...actual,
    runInProcessGroup: (...args: Parameters<typeof actual.runInProcessGroup>) => actual.runInProcessGroup(
      args[0], args[1], hookBudget.timeoutMs === null ? args[2] : { ...args[2], timeoutMs: hookBudget.timeoutMs },
    ),
  };
});

// Every test drives real git through dozens of child processes. Alone each takes
// about a second, but under the full suite's load one exceeded the 5s default
// budget, so give the file the same generous budget as the other real-git specs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitOnMain(file: string, content: string): void {
  writeFileSync(join(repo, file), content);
  git(['add', file]);
  git(['commit', '-q', '-m', `main: ${file}`]);
}

/** An item whose worktree holds `files`, committed the way a checkpoint would. */
function makeItemWithWork(files: Record<string, string>, id = 'item-abc123'): PlanQueueItem {
  const branchName = `queue/sample-${id.slice(-6)}`;
  const worktreePath = join(repo, '.worktrees', branchName);
  git(['worktree', 'add', '-q', '-b', branchName, worktreePath, 'main']);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(worktreePath, file), content);
  }
  if (Object.keys(files).length > 0) {
    git(['add', '-A'], worktreePath);
    git(['commit', '-q', '--no-verify', '-m', 'checkpoint'], worktreePath);
  }
  return {
    id,
    runId: 'run-1',
    documentPath: join(repo, 'docs/sample_plan.md'),
    state: 'landing',
    round: 1,
    erroredRounds: 0,
    landingRefusals: 0,
    baseConflicts: 0,
    branchName,
    worktreePath,
    baseCommit: git(['rev-parse', 'main']),
    checkpointCommit: git(['rev-parse', 'HEAD'], worktreePath),
    verifiedMainCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  hookBudget.timeoutMs = null;
  hook.beforeWrite = null;
  hook.target = '';
  hook.failWrite = '';
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-land-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  commitOnMain('a.txt', 'base\n');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('syncItemWithBase', () => {
  it('reports up-to-date when main has not moved', async () => {
    const item = makeItemWithWork({ 'work.txt': 'work\n' });

    expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'up-to-date' });
  });

  it('merges a moved main into the item branch', async () => {
    const item = makeItemWithWork({ 'work.txt': 'work\n' });
    commitOnMain('other.txt', 'landed by someone else\n');

    const result = await syncItemWithBase(item, 'main', repo);

    expect(result.status).toBe('merged');
    expect(existsSync(join(item.worktreePath ?? '', 'other.txt'))).toBe(true);
    expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'up-to-date' });
  });

  it('leaves a conflict in the worktree for the worker and names the files', async () => {
    const item = makeItemWithWork({ 'a.txt': 'item version\n' });
    commitOnMain('a.txt', 'main version\n');

    const result = await syncItemWithBase(item, 'main', repo);

    expect(result).toEqual({ status: 'conflict', conflictFiles: ['a.txt'] });
    expect(readFileSync(join(item.worktreePath ?? '', 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });

  describe('when the only clash is the live-test register', () => {
    const REGISTER = 'docs/plans/livetest-remediation-register.md';
    const register = (...rows: string[]) => ['| Id | Status |', '| --- | --- |', ...rows, '', '## Notes', ''].join('\n');
    const read = (item: PlanQueueItem, file = REGISTER) => readFileSync(join(item.worktreePath ?? '', file), 'utf8');
    beforeEach(() => {
      mkdirSync(join(repo, 'docs/plans'), { recursive: true });
      commitOnMain(REGISTER, register('| LT-1 | open |'));
    });

    it('keeps the rows both sides added', async () => {
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | open |', '| LT-2 | from the job |') });
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-3 | from main |'));

      const result = await syncItemWithBase(item, 'main', repo);

      expect(result.status).toBe('merged');
      expect(read(item)).toBe(register('| LT-1 | open |', '| LT-2 | from the job |', '| LT-3 | from main |'));
      expect(git(['status', '--porcelain'], item.worktreePath ?? '')).toBe('');
      expect(git(['log', '-1', '--format=%p'], item.worktreePath ?? '').split(' ')).toHaveLength(2);
    });

    it('keeps main\'s copy when both sides recorded the same defect or changed the same row', async () => {
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | fixed by the job |', '| LT-2 | the job\'s words |') });
      commitOnMain(REGISTER, register('| LT-1 | fixed on main |', '| LT-2 | main\'s words |'));

      expect((await syncItemWithBase(item, 'main', repo)).status).toBe('merged');
      expect(read(item)).toBe(register('| LT-1 | fixed on main |', '| LT-2 | main\'s words |'));
    });

    it('keeps main\'s copy when both sides added the same new defect', async () => {
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | open |', '| LT-2 | the job\'s words |') });
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-2 | main\'s words |'));

      expect((await syncItemWithBase(item, 'main', repo)).status).toBe('merged');
      expect(read(item)).toBe(register('| LT-1 | open |', '| LT-2 | main\'s words |'));
    });

    it('puts a new section after main\'s lines, so they stay with the section they belong to', async () => {
      const notes = (...lines: string[]) => [register('| LT-1 | open |'), '## LT-1: old', '', 'Details.', ...lines, ''].join('\n');
      commitOnMain(REGISTER, notes());
      const item = makeItemWithWork({ [REGISTER]: notes('## LT-2: new', 'From the job.') });
      commitOnMain(REGISTER, notes('Verified on main.'));

      expect((await syncItemWithBase(item, 'main', repo)).status).toBe('merged');
      expect(read(item)).toBe(notes('Verified on main.', '## LT-2: new', 'From the job.'));
    });

    it('keeps main\'s text for a section both sides added', async () => {
      const section = (words: string) => `${register('| LT-1 | open |')}\n## LT-2: one defect\n\n${words}\n`;
      const item = makeItemWithWork({ [REGISTER]: section('The job\'s words.') });
      commitOnMain(REGISTER, section('Main\'s words.'));

      expect((await syncItemWithBase(item, 'main', repo)).status).toBe('merged');
      expect(read(item)).toBe(section('Main\'s words.'));
    });

    it.each([
      ['both sides changed the same plain line', ['Original.'], ['The job.'], ['Main.']],
      ['the job changed a plain line next to main\'s', ['- one', '- two'], ['- the job', '- two'], ['- one', '- main']],
      ['the job deleted a plain line next to main\'s', ['- one', '- two'], ['- two'], ['- one', '- main']],
      ['the job deleted a plain line main reworded', ['- one'], [], ['- main']],
      ['the job\'s changed line matches another line', ['- a', '- b'], ['- b', '- b'], ['- m', '- n']],
      ['the job deleted text main kept, in a section both changed', ['## LT-5: a', 'Text.'], ['## LT-5: b'], ['## LT-5: c', 'Text.']],
      ['the job deleted a row main left alone', ['| LT-7 | a |', '| LT-8 | b |'], ['| LT-8 | b |'], ['| LT-7 | a |', '| LT-8 | main |']],
      ['the job deleted a row main changed', ['| LT-7 | a |'], [], ['| LT-7 | main |']],
      ['one row holds an id main lacks', [], ['| LT-5, LT-6 | the job |'], ['| LT-5 | main |']],
    ])('leaves the merge for a worker when %s', async (_name, base, job, main) => {
      const notes = (lines: string[]) => `${register('| LT-1 | open |')}\n${[...lines, 'End.'].join('\n')}\n`;
      commitOnMain(REGISTER, notes(base));
      const item = makeItemWithWork({ [REGISTER]: notes(job) });
      commitOnMain(REGISTER, notes(main));

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: [REGISTER] });
      expect(read(item)).toContain('<<<<<<<');
    });

    it('leaves the merge for a worker when the job changed a neighbouring row main left alone', async () => {
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-2 | open |'));
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | fixed by the job |', '| LT-2 | open |') });
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-2 | changed on main |'));

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: [REGISTER] });
    });

    it('leaves the merge for a worker when the job added a row main lacks next to one they share', async () => {
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | open |', '| LT-2 | the job |', '| LT-3 | only the job |') });
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-2 | main |'));

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: [REGISTER] });
    });

    it('reports an ordinary conflict when settling the register fails part way', async () => {
      const item = makeItemWithWork({ [REGISTER]: register('| LT-1 | open |', '| LT-2 | from the job |') });
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-3 | from main |'));
      hook.failWrite = join(item.worktreePath ?? '', REGISTER);

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: [REGISTER] });
      expect(read(item)).toContain('<<<<<<<');
    });

    it('leaves the merge for a worker rather than listing one defect twice', async () => {
      const item = makeItemWithWork({ [REGISTER]: ['| Id | Status |', '| --- | --- |', '| LT-1 | open |', '| LT-9 | the job, first |', '', '## Notes', '', '| LT-4 | clash |', ''].join('\n') });
      commitOnMain(REGISTER, ['| Id | Status |', '| --- | --- |', '| LT-1 | open |', '', '## Notes', '', '| LT-9 | main, elsewhere |', ''].join('\n'));

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: [REGISTER] });
      expect(read(item)).toContain('<<<<<<<');
    });

    it('sends the merge to a worker as usual when any other file clashes too', async () => {
      const item = makeItemWithWork({ 'a.txt': 'item version\n', [REGISTER]: register('| LT-1 | open |', '| LT-2 | from the job |') });
      commitOnMain('a.txt', 'main version\n');
      commitOnMain(REGISTER, register('| LT-1 | open |', '| LT-3 | from main |'));

      const result = await syncItemWithBase(item, 'main', repo);

      expect(result).toEqual({ status: 'conflict', conflictFiles: expect.arrayContaining(['a.txt', REGISTER]) });
    });

    it('leaves other documents to clash', async () => {
      commitOnMain('other.md', 'one\n');
      const item = makeItemWithWork({ 'other.md': 'job\n' });
      commitOnMain('other.md', 'main\n');

      expect(await syncItemWithBase(item, 'main', repo)).toEqual({ status: 'conflict', conflictFiles: ['other.md'] });
    });
  });
});

describe('runPostMergeGate', () => {
  it('says when a command ran out of time, because that is not the same as failing', async () => {
    hookBudget.timeoutMs = 200;
    expect(await runPostMergeGate(['sleep 5'], repo)).toMatchObject({ ok: false, command: 'sleep 5', timedOut: true });
    hookBudget.timeoutMs = null;
    expect(await runPostMergeGate(['exit 3'], repo)).not.toHaveProperty('timedOut');
  });

  it('gives the check a fixed test worker count', async () => {
    const result = await runPostMergeGate(['echo "forks=$AIO_TEST_MAX_FORKS"; exit 3'], repo);
    expect(result.ok === false && result.output).toContain('forks=8');
  });

  it('passes when every command exits 0 and stops at the first failure', async () => {
    expect(await runPostMergeGate(['true', 'true'], repo)).toEqual({ ok: true });

    const result = await runPostMergeGate(['true', 'echo broken >&2; exit 3', 'touch never.txt'], repo);

    expect(result).toMatchObject({ ok: false, command: 'echo broken >&2; exit 3' });
    expect(result.ok === false && result.output).toContain('broken');
    expect(existsSync(join(repo, 'never.txt'))).toBe(false);
  });

  it('runs in the given directory', async () => {
    mkdirSync(join(repo, 'sub'));
    await runPostMergeGate(['touch here.txt'], join(repo, 'sub'));

    expect(existsSync(join(repo, 'sub/here.txt'))).toBe(true);
  });
});

describe('landItemBranch', () => {
  it('lands the item as exactly one commit on main, past untracked root documents', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    writeFileSync(join(item.worktreePath ?? '', 'two.txt'), '2\n');
    git(['add', '-A'], item.worktreePath ?? '');
    git(['commit', '-q', '--no-verify', '-m', 'checkpoint 2'], item.worktreePath ?? '');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs/sample_plan.md'), '# untracked plan\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: sample (plan queue)', []);

    expect(result.status).toBe('landed');
    expect(git(['rev-list', '--count', `${mainBefore}..main`])).toBe('1');
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('feat: sample (plan queue)');
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual(['one.txt', 'two.txt']);
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'docs/sample_plan.md'), 'utf8')).toBe('# untracked plan\n');
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('is a no-op landing when the item changed no tracked files', async () => {
    const item = makeItemWithWork({});
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'unused', []);

    expect(result).toEqual({ status: 'landed', commit: mainBefore });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
  });

  // A livetest item that reproduces no defect changes no tracked file, so its
  // closed document is the whole landing. Without this the evidence would be
  // silently dropped at the "nothing to land" branch.
  it('lands the closed document when the item branch has no commits of its own', async () => {
    const item = makeItemWithWork({});
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'Livetest: sample (plan queue)', [], [
      { relativePath: 'docs/plans/sample_livetest_completed.md', content: 'evidence\n' },
    ]);

    expect(result.status).toBe('landed');
    expect(git(['rev-list', '--count', `${mainBefore}..main`])).toBe('1');
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n')).toEqual(['docs/plans/sample_livetest_completed.md']);
    expect(git(['show', 'main:docs/plans/sample_livetest_completed.md'])).toBe('evidence');
    expect(git(['status', '--porcelain'], item.worktreePath ?? '')).toBe('');
    expect(git(['branch', '--show-current'], item.worktreePath ?? '')).toBe(item.branchName);
  });

  it('answers dirty-overlap, changing nothing, when a root file would be overwritten', async () => {
    const item = makeItemWithWork({ 'clash.txt': 'from item\n' });
    writeFileSync(join(repo, 'clash.txt'), 'operator copy\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: clash', []);

    expect(result).toEqual({
      status: 'dirty-overlap',
      paths: ['clash.txt'],
      reason: "Couldn't merge clash.txt: your untracked file differs from the item's copy.",
    });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(readFileSync(join(repo, 'clash.txt'), 'utf8')).toBe('operator copy\n');
    expect(git(['rev-parse', item.branchName ?? ''])).toBe(item.checkpointCommit);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('reports a conflict when main moved under an unsynced branch', async () => {
    const item = makeItemWithWork({ 'a.txt': 'item version\n' });
    commitOnMain('a.txt', 'main version\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, repo, 'main', 'feat: conflict', []);

    expect(result).toEqual({ status: 'conflict', conflictFiles: ['a.txt'] });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  it('converges when re-run after a crash that followed promotion', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    const first = await landItemBranch(item, repo, 'main', 'feat: once', []);
    expect(first.status).toBe('landed');
    const landedCommit = first.status === 'landed' ? first.commit : '';
    const mainAfter = git(['rev-parse', 'main']);

    const again = await landItemBranch({ ...item, landedCommit }, repo, 'main', 'feat: once', []);

    expect(again).toEqual({ status: 'landed', commit: landedCommit });
    expect(git(['rev-parse', 'main'])).toBe(mainAfter);
  });

  it('rebuilds a stale integration branch left by an interrupted attempt', async () => {
    const item = makeItemWithWork({ 'one.txt': '1\n' });
    git(['branch', `integration/${item.branchName}`, 'main']);
    commitOnMain('other.txt', 'main moved\n');
    await syncItemWithBase(item, 'main', repo);

    const result = await landItemBranch(item, repo, 'main', 'feat: after stale', []);

    expect(result.status).toBe('landed');
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(git(['for-each-ref', 'refs/heads/integration', 'refs/aio'])).toBe('');
  });

  describe('the landing commit is made with the repository hooks', () => {
    /** A repo-local hook that overrides the global hooks path for this test repo. */
    function installHook(script: string): void {
      const hooks = join(repo, 'test-hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(hooks, 'pre-commit'), 0o755);
      git(['config', 'core.hooksPath', hooks]);
      writeFileSync(join(repo, '.git', 'info', 'exclude'), 'test-hooks/\n');
    }

    function checkoutState(item: PlanQueueItem): { head: string; branch: string; status: string } {
      const wt = item.worktreePath ?? '';
      return {
        head: git(['rev-parse', 'HEAD'], wt),
        branch: git(['branch', '--show-current'], wt),
        status: git(['status', '--porcelain'], wt),
      };
    }

    it.each(['green', 'missing-command', 'wrong-command', 'failed', 'timeout', 'empty-tests', 'legacy', 'mixed-tree', 'failed-verdict'] as const)(
      'grants duplicate-test proof only for a complete green checklist: %s', async evidence => {
        installHook('printf "%s\\n" "${AIO_PLAN_QUEUE_TESTS_COVERED:-unset}" > "$(git rev-parse --git-common-dir)/hook-test-proof"');
        const item = makeItemWithWork({ 'one.txt': '1\n' });
        const tree = git(['rev-parse', 'HEAD^{tree}'], item.worktreePath!);
        const commands = ['first-check', 'second-check'];
        item.verdict = { verdict: evidence === 'failed-verdict' ? 'FAIL' : 'PASS', findings: [], documentComplete: true,
          needJames: [], gatesRun: commands.map(command => ({ command, exitCode: 0, testedTree: tree, classification: 'passed' })) };
        const first = item.verdict.gatesRun[0];
        if (evidence === 'missing-command') item.verdict.gatesRun.pop();
        if (evidence === 'wrong-command') first.command = 'a-different-check';
        if (evidence === 'failed') first.exitCode = 1;
        if (evidence === 'timeout') first.timedOut = true;
        if (evidence === 'empty-tests') first.classification = 'no-tests-found';
        if (evidence === 'legacy') delete first.testedTree;
        if (evidence === 'mixed-tree') first.testedTree = git(['rev-parse', 'main^{tree}']);
        const result = await landItemBranch(item, repo, 'main', 'Plan: checked', commands);
        expect(result.status).toBe('landed');
        expect(readFileSync(join(repo, '.git', 'hook-test-proof'), 'utf8').trim()).toBe(evidence === 'green' ? '1' : 'unset');
      },
    );

    it('runs the pre-commit hook, and what the hook stages lands with the commit', async () => {
      installHook('echo generated > generated.txt && git add generated.txt');
      const item = makeItemWithWork({ 'one.txt': '1\n' });

      const result = await landItemBranch(item, repo, 'main', 'feat: hooked', []);

      expect(result.status).toBe('landed');
      expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual(['generated.txt', 'one.txt']);
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
    });

    it('reports a refusing hook with its output, lands nothing, and restores the item checkout', async () => {
      installHook('echo "related tests failed: 2" >&2; exit 1');
      const item = makeItemWithWork({ 'one.txt': '1\n' });
      const mainBefore = git(['rev-parse', 'main']);

      const result = await landItemBranch(item, repo, 'main', 'feat: refused', [], [
        { relativePath: 'docs/x_plan_completed.md', content: 'closed\n' },
      ]);

      expect(result).toEqual({ status: 'hook-failed', output: expect.stringContaining('related tests failed: 2') });
      expect(git(['rev-parse', 'main'])).toBe(mainBefore);
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
      expect(existsSync(join(item.worktreePath ?? '', 'docs/x_plan_completed.md'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('reports a hook that runs out of time as timed out, not as a refusal, and restores the checkout', async () => {
      installHook('sleep 30');
      hookBudget.timeoutMs = 1_500;
      const item = makeItemWithWork({ 'one.txt': '1\n' });
      const mainBefore = git(['rev-parse', 'main']);

      const result = await landItemBranch(item, repo, 'main', 'feat: slow hook', []);

      expect(result).toMatchObject({ status: 'hook-failed', timedOut: true, output: expect.stringContaining('timed out after 1500ms') });
      expect(git(['rev-parse', 'main'])).toBe(mainBefore);
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
    });

    it.each(['q_plan.md', 'q_history.md'])('refuses active %s, but not a standing register', async (document) => {
      const item = makeItemWithWork({ 'one.txt': '1\n', [document]: '# active\n' });
      const mainBefore = git(['rev-parse', 'main']);

      expect(await landItemBranch(item, repo, 'main', 'feat: docs', [])).toEqual({ status: 'active-documents', paths: [document] });
      expect(git(['rev-parse', 'main'])).toBe(mainBefore);

      const register = makeItemWithWork({ 'r_livetest.md': '# R\n**Type: standing register**\n' }, 'item-reg999');
      expect((await landItemBranch(register, repo, 'main', 'feat: register', [])).status).toBe('landed');
    });

    it('lands the closed documents in the same commit as the code', async () => {
      const item = makeItemWithWork({ 'one.txt': '1\n' });

      const result = await landItemBranch(item, repo, 'main', 'Plan: x', [], [
        { relativePath: 'docs/plans/x_plan_completed.md', content: 'spec: x_spec_completed.md\n' },
        { relativePath: 'docs/plans/x_spec_completed.md', content: 'plan: x_plan_completed.md\n' },
      ]);

      expect(result.status).toBe('landed');
      expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: x', 'main: a.txt']);
      expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
        'docs/plans/x_plan_completed.md', 'docs/plans/x_spec_completed.md', 'one.txt',
      ]);
      expect(git(['show', 'main:docs/plans/x_plan_completed.md'])).toBe('spec: x_spec_completed.md');
      expect(checkoutState(item).status).toBe('');
    });

    it('promotes the recorded commit again after a crash between building it and promoting it', async () => {
      const item = makeItemWithWork({ 'clash.txt': 'from item\n' });
      writeFileSync(join(repo, 'clash.txt'), 'operator copy\n');
      let built = '';
      const first = await landItemBranch(item, repo, 'main', 'feat: once', [], [], (commit) => { built = commit; });
      expect(first.status).toBe('dirty-overlap');
      expect(built).not.toBe('');
      rmSync(join(repo, 'clash.txt'));

      const again = await landItemBranch({ ...item, landedCommit: built }, repo, 'main', 'feat: once', []);

      expect(again).toEqual({ status: 'landed', commit: built });
      expect(git(['rev-parse', 'main'])).toBe(built);
    });

    it('recovers a worktree a crash left on the detached squash state', async () => {
      const item = makeItemWithWork({ 'one.txt': '1\n' });
      const wt = item.worktreePath ?? '';
      // As buildLandingCommit detaches: at the base tip's full hash, which the recovery's proof checks.
      git(['checkout', '-q', '--detach', git(['rev-parse', 'main'])], wt);
      git(['merge', '--squash', '-q', item.branchName ?? ''], wt);

      const result = await landItemBranch(item, repo, 'main', 'feat: after crash', []);

      expect(result.status).toBe('landed');
      expect(checkoutState(item)).toEqual({ head: item.checkpointCommit, branch: item.branchName, status: '' });
    });
  });

  describe('a document-merge finish failure after the fast-forward', () => {
    function overlapDocs(): PlanQueueItem {
      writeFileSync(join(repo, 'register.md'), 'base\n');
      writeFileSync(join(repo, 'second.md'), 'second base\n');
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'docs']);
      const item = makeItemWithWork({
        'register.md': 'base\n\n## Item\nWorker edits.\n',
        'second.md': 'second base\n\n## Item\nWorker edits.\n',
      }, 'item-merge1');
      writeFileSync(join(repo, 'register.md'), 'base\n\n## Ours\nUser edits.\n');
      writeFileSync(join(repo, 'second.md'), 'second base\n\n## Ours\nUser edits.\n');
      hook.target = join(realpathSync(repo), 'register.md');
      return item;
    }

    it('lands from the reconciled backup when the interrupted writes can be recovered', async () => {
      const item = overlapDocs();
      const mainBefore = git(['rev-parse', 'main']);
      hook.beforeWrite = async () => { throw new Error('disk full'); };

      const result = await landItemBranch(item, repo, 'main', 'feat: merge', []);

      expect(result).toMatchObject({ status: 'landed', mergedPaths: ['register.md', 'second.md'] });
      const landed = result.status === 'landed' ? result.commit : '';
      expect(git(['rev-parse', 'main'])).toBe(landed);
      expect(git(['rev-list', '--count', `${mainBefore}..main`])).toBe('1');
      const register = readFileSync(join(repo, 'register.md'), 'utf8');
      expect(register).toContain('## Ours'); expect(register).toContain('## Item');
      expect(readFileSync(join(repo, 'second.md'), 'utf8')).toContain('## Ours');
    });

    it('holds with the backup reason when the interrupted writes cannot be reconciled', async () => {
      const item = overlapDocs();
      const mainBefore = git(['rev-parse', 'main']);
      hook.beforeWrite = async () => { writeFileSync(join(repo, 'second.md'), 'Later human edit.\n'); };

      const result = await landItemBranch(item, repo, 'main', 'feat: merge', []);

      expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining('second.md') });
      expect(result.status === 'blocked' ? result.reason : '').toContain('doc-merge/item-merge1');
      // The promotion itself is real; only the document merge is held.
      expect(git(['rev-list', '--count', `${mainBefore}..main`])).toBe('1');
      expect(git(['show', 'main:register.md'])).toContain('## Item');
      expect(readFileSync(join(repo, 'second.md'), 'utf8')).toBe('Later human edit.\n');
    });
  });
});
