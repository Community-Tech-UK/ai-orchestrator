import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildQueuePushGuardEnv } from '../../src/main/plan-queue/plan-queue-push-guard';
import { FAKE_SSH } from './fake-ssh.testing';

/** The real runner and the real send, against the fake `ssh` in fake-ssh.testing.ts. */

/** Stands in for Vitest on the Mac, and records how it was started. */
const FAKE_VITEST = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=')[1];
const macOnly = process.argv.some(arg => arg.includes('signal-fence'));
appendFileSync(process.env.FAKE_DIR + '/local-runs', JSON.stringify({ macOnly, forks: process.env.AIO_TEST_MAX_FORKS }) + '\n');
console.log('mac vitest ran');
const failed = macOnly && process.env.FAKE_MAC_ONLY_FAILS === '1';
const crashed = macOnly && process.env.FAKE_MAC_ONLY_CRASHES === '1';
const name = process.cwd() + (macOnly ? '/src/main/sandbox/signal-fence.spec.ts' : '/src/a.spec.ts');
writeFileSync(output, JSON.stringify({
  numTotalTests: 1, numPassedTests: failed ? 0 : 1, numFailedTests: failed ? 1 : 0,
  testResults: [{ name, status: failed ? 'failed' : 'passed', assertionResults: [{
    status: failed ? 'failed' : 'passed', title: 'm', fullName: 'mac test', failureMessages: failed ? ['mac boom'] : [],
  }] }],
}));
process.exit(failed || crashed ? 1 : 0);
`;

const LIMIT = 60_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

interface Setup { base: string; fake: string; project: string; dir: string }

function setUp(projectFolder = 'project', withConfig = true): Setup {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'quiet-remote-')));
  temps.push(base);
  const project = join(base, projectFolder);
  const fake = join(base, 'fake');
  const dir = join(base, 'remote-checks-config');
  mkdirSync(join(project, 'scripts/remote-checks'), { recursive: true });
  mkdirSync(join(project, 'node_modules/vitest'), { recursive: true });
  mkdirSync(join(fake, 'home'), { recursive: true });
  mkdirSync(dir);

  copyFileSync(join(__dirname, '../run-tests-quiet.js'), join(project, 'scripts/run-tests-quiet.js'));
  for (const file of ['snapshot.js', 'route.js', 'mac-turn.js', 'mac-only.js', 'run-remote.js', 'remote-run.sh', 'related-estimate.js']) {
    copyFileSync(join(__dirname, file), join(project, 'scripts/remote-checks', file));
  }
  writeFileSync(join(project, 'scripts/check-node.js'), '');
  writeFileSync(join(project, 'scripts/verify-package-exports.js'), '');
  writeFileSync(join(project, 'node_modules/vitest/package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: 'vitest.mjs' } }));
  writeFileSync(join(project, 'node_modules/vitest/vitest.mjs'), FAKE_VITEST);
  writeFileSync(join(project, '.gitignore'), 'node_modules\n_scratch\n');
  writeFileSync(join(project, '.nvmrc'), 'v24.0.0\n');
  writeFileSync(join(project, 'package-lock.json'), '{}\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'base');

  const fakeSsh = join(fake, 'ssh');
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(fake, 'scenario'), 'pass');
  if (withConfig) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'far', label: 'the PC', ssh: fakeSsh }));
  }
  return { base, fake, project, dir };
}

function runQuiet(setup: Setup, { scenario = 'pass', args = [], env = {} }: {
  scenario?: string; args?: string[]; env?: NodeJS.ProcessEnv;
} = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_TEST_MAX_FORKS', 'AIO_TEST_NO_CACHE', 'AIO_QUEUE_SESSION',
    'ORCHESTRATOR_LOOP_CONTROL_FILE', 'AIO_REMOTE_CHECKS']) delete clean[key];
  const result = spawnSync(process.execPath, ['scripts/run-tests-quiet.js', ...args], {
    cwd: setup.project,
    encoding: 'utf8',
    // A hang has to fail the test, not outlive it.
    timeout: LIMIT - 10_000,
    env: { ...clean, AIO_TEST_SUMMARY: '0', AIO_TEST_OUT_SUFFIX: 't', AIO_REMOTE_CHECKS_DIR: setup.dir, FAKE_DIR: setup.fake, ...env },
  });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    code: result.status,
    stdout: result.stdout,
    log: read(join(setup.project, '_scratch/test-run.t.log')),
    report: read(join(setup.project, '_scratch/test-results.t.json')),
    sshCalls: read(join(setup.fake, 'ssh.log')).split('\n').filter(Boolean),
    localRuns: read(join(setup.fake, 'local-runs')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { macOnly: boolean; forks?: string }),
    runArgs: read(join(setup.fake, 'run-args')),
    runLog: read(join(setup.dir, 'runs.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('run-tests-quiet with remote checks', () => {
  it('brings a pass back as if it had run here, and says where it ran', () => {
    const setup = setUp();
    const run = runQuiet(setup);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
    expect(run.log).toContain('far machine output');
    expect(run.log).not.toContain('AIO_REMOTE_RESULT');
    expect(run.report).toContain(`${setup.project}/src/a.spec.ts`);
    expect(run.report).not.toContain('/far/slots');
    expect(run.runLog[0]).toMatchObject({ ranOn: 'far', exitCode: 0, fellBackBecause: null });
    expect(run.localRuns.every(entry => entry.macOnly)).toBe(true);
  }, LIMIT);

  it('reports failing tests from the far machine as failures, with local paths, and does not rerun them', () => {
    const setup = setUp();
    const run = runQuiet(setup, { scenario: 'tests-fail' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`boom at ${setup.project}/src/a.spec.ts:1`);
    expect(run.stdout).toContain('✗ FAILED');
    expect(run.stdout).not.toContain('Running on the Mac');
    expect(run.localRuns.every(entry => entry.macOnly)).toBe(true);
  }, LIMIT);

  it('fails when the far machine exits non-zero with a clean report, as after an unhandled error', () => {
    const run = runQuiet(setUp(), { scenario: 'crash-clean-report' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ FAILED');
    expect(run.stdout).not.toContain('Running on the Mac');
  }, LIMIT);

  it.each([
    ['unreachable', 'could not be reached'],
    ['lost', 'connection to the PC was lost'],
    ['no-result', 'connection to the PC was lost'],
    ['no-slot', 'no free slot'],
    ['setup-failed', 'could not set up: npm ci failed'],
    ['wrong-tree', 'did not match the code sent'],
    ['wrong-node', 'did not match the code sent'],
    ['wrong-lock', 'did not match the code sent'],
    ['missing-report', 'no usable report'],
    ['empty-report', 'no usable report'],
  ])('falls back to the Mac on %s, says why, and keeps nothing from the far machine', (scenario, reason) => {
    const run = runQuiet(setUp(), { scenario });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`Running on the Mac because`);
    expect(run.stdout).toContain(reason);
    expect(run.stdout).toMatch(/Ran on the Mac in \d+s, because/);
    expect(run.log).toContain('mac vitest ran');
    expect(run.log).not.toContain('far machine output');
    expect(run.localRuns).toEqual([{ macOnly: false, forks: '8' }]);
    expect(run.runLog[0]).toMatchObject({ ranOn: 'mac', fellBackBecause: expect.stringContaining(reason) });
  }, LIMIT);

  it.each([
    ['receive-refuses', 'could not store the snapshot'],
    ['receive-drops', 'could not be reached'],
  ])('falls back rather than hanging when the far end stops reading a large snapshot (%s)', (scenario, reason) => {
    const setup = setUp();
    // Random, so it can't compress below the size of the pipe to ssh.
    writeFileSync(join(setup.project, 'large.bin'), randomBytes(8 * 1024 * 1024));
    const run = runQuiet(setup, { scenario });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(reason);
    expect(run.stdout).toMatch(/Ran on the Mac in \d+s, because/);
  }, LIMIT);

  it('falls back when the snapshot is refused', () => {
    const setup = setUp();
    const nested = join(setup.project, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'work.txt'), 'x');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'nested');
    const run = runQuiet(setup);
    expect(run.stdout).toContain('the snapshot was refused');
    expect(run.sshCalls).toEqual([]);
    expect(run.code).toBe(0);
  }, LIMIT);

  it('falls back rather than crashing when the snapshot has no .nvmrc', () => {
    const setup = setUp();
    git(setup.project, 'rm', '-q', '.nvmrc');
    git(setup.project, 'commit', '-qm', 'no nvmrc');
    const run = runQuiet(setup);
    expect(run.stdout).toContain('the run could not be sent');
    expect(run.code).toBe(0);
  }, LIMIT);

  it('keeps a worker count that was already chosen when it falls back', () => {
    const run = runQuiet(setUp(), { scenario: 'unreachable', env: { AIO_TEST_MAX_FORKS: '3' } });
    expect(run.localRuns).toEqual([{ macOnly: false, forks: '3' }]);
  }, LIMIT);

  it('passes CI and no-cache through, and nothing else', () => {
    const quiet = runQuiet(setUp());
    expect(quiet.runArgs.trim().split(' ').slice(-2)).toEqual(['0', '0']);
    const loop = runQuiet(setUp(), { env: { CI: '1', AIO_TEST_NO_CACHE: '1', SOME_TOKEN: 'not-for-the-far-machine' } });
    expect(loop.runArgs.trim().split(' ').slice(-2)).toEqual(['1', '1']);
    expect(loop.sshCalls.join('\n')).not.toContain('not-for-the-far-machine');
  }, LIMIT);

  it('runs a short targeted list here, and logs it as a local run', () => {
    const run = runQuiet(setUp(), { args: ['src/a.spec.ts', '-t', 'name'] });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.runLog).toEqual([expect.objectContaining({ kind: 'local', ranOn: 'mac', specFiles: 1, exitCode: 0 })]);
  }, LIMIT);

  describe('a long list of spec files', () => {
    const specs = Array.from({ length: 50 }, (_, index) => `src/s${index}.spec.ts`);

    it('goes to the far machine as a list of names sent as data, and is logged as targeted', () => {
      const setup = setUp();
      const run = runQuiet(setup, { args: specs });
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
      expect(JSON.parse(readFileSync(join(setup.fake, 'related-list'), 'utf8'))).toEqual(specs);
      expect(run.sshCalls.join('\n')).not.toContain('src/s1.spec.ts');
      expect(run.localRuns).toEqual([]);
      expect(run.runLog[0]).toMatchObject({ kind: 'targeted', ranOn: 'far' });
    }, LIMIT);

    it('falls back to the same list on the Mac, says why, and takes no turn', () => {
      const setup = setUp();
      const run = runQuiet(setup, { args: specs, scenario: 'unreachable' });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('Running on the Mac because');
      expect(run.localRuns).toHaveLength(1);
      expect(existsSync(join(setup.dir, 'mac-turn.lock'))).toBe(false);
    }, LIMIT);

    it.runIf(process.platform === 'darwin')('runs a named Mac-only spec here, and no others', () => {
      const run = runQuiet(setUp(), { args: [...specs, 'src/main/sandbox/signal-fence.spec.ts'] });
      expect(run.code).toBe(0);
      expect(run.localRuns).toEqual([{ macOnly: true }]);
    }, LIMIT);
  });

  it('changes nothing without a config file', () => {
    const run = runQuiet(setUp('project', false));
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.localRuns).toEqual([{ macOnly: false }]);
    expect(run.runLog).toEqual([]);
  }, LIMIT);

  it('stays on the Mac when AIO_REMOTE_CHECKS=off asks for it', () => {
    const run = runQuiet(setUp(), { env: { AIO_REMOTE_CHECKS: 'off' } });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('AIO_REMOTE_CHECKS=off');
    expect(run.code).toBe(0);
  }, LIMIT);

  it('keeps queue checks on the Mac and out of the shared lock', () => {
    const setup = setUp('.worktrees/queue/one');
    const run = runQuiet(setup);
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('queue checks stay on the Mac');
    expect(existsSync(join(setup.dir, 'mac-turn.lock'))).toBe(false);
  }, LIMIT);

  it('never goes remote on GitHub', () => {
    const run = runQuiet(setUp(), { env: { GITHUB_ACTIONS: 'true', CI: 'true' } });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.runLog).toEqual([]);
  }, LIMIT);

  it.runIf(process.platform === 'darwin')('fails the run when a Mac-only spec fails after a pass elsewhere', () => {
    const run = runQuiet(setUp(), { env: { FAKE_MAC_ONLY_FAILS: '1' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('mac boom');
    expect(run.stdout).toContain('✗ FAILED');
  }, LIMIT);

  it.runIf(process.platform === 'darwin')('fails the run when the Mac-only specs exit non-zero with a clean report', () => {
    const run = runQuiet(setUp(), { env: { FAKE_MAC_ONLY_CRASHES: '1' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ FAILED');
  }, LIMIT);
});

describe('sending a snapshot', () => {
  const farRepo = (setup: Setup): string => join(setup.fake, 'home/remote-checks/repo.git');

  it('sends the whole history first, then only the difference, leaving the source untouched', () => {
    const setup = setUp();
    const head = git(setup.project, 'rev-parse', 'HEAD');
    expect(runQuiet(setup).code).toBe(0);
    expect(git(farRepo(setup), 'for-each-ref', '--format=%(refname)', 'refs/bases/')).toBe(`refs/bases/${head}`);
    const objectsAfterFirst = git(farRepo(setup), 'count-objects', '-v');

    writeFileSync(join(setup.project, 'new.txt'), 'uncommitted\n');
    const refs = git(setup.project, 'for-each-ref');
    const status = git(setup.project, 'status', '--short');
    const second = runQuiet(setup);
    expect(second.code).toBe(0);

    expect(git(farRepo(setup), 'count-objects', '-v')).not.toBe(objectsAfterFirst);
    const sent = second.runArgs.trim().split(' ').at(-3)!;
    expect(git(farRepo(setup), 'cat-file', 'blob', `${sent}:new.txt`)).toBe('uncommitted');
    expect(git(setup.project, 'for-each-ref')).toBe(refs);
    expect(git(setup.project, 'status', '--short')).toBe(status);
  }, LIMIT);

  it('copes with a base the Mac does not have', () => {
    const setup = setUp();
    expect(runQuiet(setup).code).toBe(0);
    const other = join(setup.base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    const stranger = git(other, 'rev-parse', 'HEAD');
    git(other, 'push', '-q', farRepo(setup), `HEAD:refs/bases/${stranger}`);

    const run = runQuiet(setup);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Ran on the PC');
  }, LIMIT);

  it('works inside a queue session, with the whole push guard in its environment', async () => {
    const setup = setUp('.worktrees/queue/one');
    const guard = await buildQueuePushGuardEnv(setup.project);
    expect(guard['AIO_QUEUE_SESSION']).toBe('1');

    const run = runQuiet(setup, { env: guard });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Ran on the PC');
  }, LIMIT);
});
