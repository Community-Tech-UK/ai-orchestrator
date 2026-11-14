import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueProjectCheckResultSchema } from '../../main/remote-node/queue-job-rpc-schemas';
import type { QueueProcessRunner } from './queue-process';
import { JOB, PROJECT, makeFixture, runGit, sendCommit, type Fixture } from './queue-job-fixture.test-helpers';

let fx: Fixture | null = null;
afterEach(() => { fx?.dispose(); fx = null; });

async function setup(runner: QueueProcessRunner, install?: Fixture['install']): Promise<{ commit: string }> {
  fx = makeFixture({ runner, ...(install ? { install } : {}) });
  const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
  await sendCommit(fx, { commit });
  return { commit };
}
const call = (scripts: string[]) => fx!.host.projectCheck({ project: PROJECT, jobId: JOB, scripts });
const scratch = (): string => join(fx!.root, 'queue-worktrees', 'queue', `projectcheck-${JOB}`);

describe('queue.projectCheck', () => {
  it('installs, runs each named step in the installed checkout, times a fresh folder\'s dependency setup and cleans up', async () => {
    const runner = vi.fn<QueueProcessRunner>().mockResolvedValue({ code: 0, timedOut: false, tail: 'all good' });
    await setup(runner);
    const result = await call(['typecheck', 'lint']);
    expect(QueueProjectCheckResultSchema.parse(result)).toMatchObject({ ok: true, problem: null });
    expect(result.steps.map(step => [step.name, step.ok])).toEqual([['install dependencies', true], ['npm run typecheck', true], ['npm run lint', true]]);
    expect(runner.mock.calls.map(call => [call[0], call[1], call[2].cwd])).toEqual([
      ['npm', ['run', 'typecheck'], join(fx!.root, 'queue-repos', `${PROJECT}-installed`)],
      ['npm', ['run', 'lint'], join(fx!.root, 'queue-repos', `${PROJECT}-installed`)],
    ]);
    expect(result.copyMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(scratch())).toBe(false);
    expect(runGit(['worktree', 'list'], join(fx!.root, 'queue-repos', `${PROJECT}.git`))).not.toContain('projectcheck');
    expect(existsSync(join(fx!.root, 'queue-repos', `${PROJECT}-installed`, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('says in plain words which step failed, keeps its output tail, and stops there', async () => {
    const runner = vi.fn<QueueProcessRunner>()
      .mockResolvedValueOnce({ code: 0, timedOut: false, tail: '' })
      .mockResolvedValueOnce({ code: 2, timedOut: false, tail: 'error TS2304: Cannot find name' });
    await setup(runner);
    const result = await call(['typecheck', 'lint', 'test']);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('The step "npm run lint" failed on this computer (exit code 2). Its last output is in the step\'s details.');
    expect(result.steps.at(-1)).toMatchObject({ name: 'npm run lint', ok: false, tail: 'error TS2304: Cannot find name' });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.copyMs).toBeNull();
  });

  it('reports a step that ran out of time', async () => {
    await setup(vi.fn<QueueProcessRunner>().mockResolvedValue({ code: null, timedOut: true, tail: '' }));
    const result = await call(['test']);
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('did not finish within') });
  });

  it('reports a failed install without running any step', async () => {
    const runner = vi.fn<QueueProcessRunner>();
    const install = vi.fn().mockRejectedValue(new Error('Installing the project\'s dependencies failed (npm ci exit 1): ENOSPC'));
    await setup(runner, install);
    const result = await call(['test']);
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('Installing the project\'s dependencies on this computer failed') });
    expect(result.steps).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it('says so when this computer has not been sent the code', async () => {
    fx = makeFixture();
    const result = await call(['test']);
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('has not been sent the project') });
  });

  it('replaces a scratch folder a crashed check left behind', async () => {
    await setup(vi.fn<QueueProcessRunner>().mockResolvedValue({ code: 0, timedOut: false, tail: '' }));
    expect((await call([])).ok).toBe(true);
    runGit(['worktree', 'add', '--detach', scratch(), runGit(['rev-parse', 'HEAD'], fx!.mac)], join(fx!.root, 'queue-repos', `${PROJECT}.git`));
    expect((await call([])).ok).toBe(true);
    expect(readdirSync(join(fx!.root, 'queue-worktrees', 'queue'))).toEqual([]);
  });
});
