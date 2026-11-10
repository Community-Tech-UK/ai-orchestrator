import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Tests run side by side, each in its own folder, so the folders go once the whole file is done.
const temps: string[] = [];
// Hooks get the tests' own limit: on a busy machine the shared git set-up and the removal of every folder at once
// can outlast the 10 s default.
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}, LIMIT);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

interface Setup { base: string; fake: string; project: string; dir: string }

/** The project every test starts from, committed once; each test works on its own copy. */
let template = '';
beforeAll(() => {
  template = join(realpathSync(mkdtempSync(join(tmpdir(), 'quiet-remote-template-'))), 'project');
  temps.push(dirname(template));
  const project = template;
  mkdirSync(join(project, 'scripts/remote-checks'), { recursive: true });
  mkdirSync(join(project, 'node_modules/vitest'), { recursive: true });

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
}, LIMIT);

function setUp(projectFolder = 'project', withConfig = true): Setup {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'quiet-remote-')));
  temps.push(base);
  const project = join(base, projectFolder);
  const fake = join(base, 'fake');
  const dir = join(base, 'remote-checks-config');
  mkdirSync(dirname(project), { recursive: true });
  cpSync(template, project, { recursive: true });
  mkdirSync(join(fake, 'home'), { recursive: true });
  mkdirSync(dir);

  const fakeSsh = join(fake, 'ssh');
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  writeFileSync(join(fake, 'scenario'), 'pass');
  if (withConfig) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'far', label: 'the PC', ssh: fakeSsh }));
  }
  return { base, fake, project, dir };
}

async function runQuiet(setup: Setup, { scenario = 'pass', args = [], env = {} }: {
  scenario?: string; args?: string[]; env?: NodeJS.ProcessEnv;
} = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_TEST_MAX_FORKS', 'AIO_TEST_NO_CACHE', 'AIO_QUEUE_SESSION',
    'ORCHESTRATOR_LOOP_CONTROL_FILE', 'AIO_REMOTE_CHECKS']) delete clean[key];
  // Started without blocking, so other tests' runs go on meanwhile.
  const child = spawn(process.execPath, ['scripts/run-tests-quiet.js', ...args], {
    cwd: setup.project,
    env: { ...clean, AIO_TEST_SUMMARY: '0', AIO_TEST_OUT_SUFFIX: 't', AIO_REMOTE_CHECKS_DIR: setup.dir, FAKE_DIR: setup.fake, ...env },
  });
  child.stdin.end();
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.resume();
  // A hang has to fail the test, not outlive it.
  const hang = setTimeout(() => child.kill(), LIMIT - 10_000);
  const status = await new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  clearTimeout(hang);
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    code: status,
    stdout,
    log: read(join(setup.project, '_scratch/test-run.t.log')),
    report: read(join(setup.project, '_scratch/test-results.t.json')),
    sshCalls: read(join(setup.fake, 'ssh.log')).split('\n').filter(Boolean),
    localRuns: read(join(setup.fake, 'local-runs')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { macOnly: boolean; forks?: string }),
    runArgs: read(join(setup.fake, 'run-args')),
    runLog: read(join(setup.dir, 'runs.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe.concurrent('run-tests-quiet with remote checks', () => {
  it('brings a pass back as if it had run here, and says where it ran', async () => {
    const setup = setUp();
    const run = await runQuiet(setup);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
    expect(run.log).toContain('far machine output');
    expect(run.log).not.toContain('AIO_REMOTE_RESULT');
    expect(run.report).toContain(`${setup.project}/src/a.spec.ts`);
    expect(run.report).not.toContain('/far/slots');
    expect(run.runLog[0]).toMatchObject({ ranOn: 'far', exitCode: 0, fellBackBecause: null });
    expect(run.localRuns.every(entry => entry.macOnly)).toBe(true);
  }, LIMIT);

  it('reports failing tests from the far machine as failures, with local paths, and does not rerun them', async () => {
    const setup = setUp();
    const run = await runQuiet(setup, { scenario: 'tests-fail' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`boom at ${setup.project}/src/a.spec.ts:1`);
    expect(run.stdout).toContain('✗ FAILED');
    expect(run.stdout).not.toContain('Running on the Mac');
    expect(run.localRuns.every(entry => entry.macOnly)).toBe(true);
  }, LIMIT);

  it('fails when the far machine exits non-zero with a clean report, as after an unhandled error', async () => {
    const run = await runQuiet(setUp(), { scenario: 'crash-clean-report' });
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
  ])('falls back to the Mac on %s, says why, and keeps nothing from the far machine', async (scenario, reason) => {
    const run = await runQuiet(setUp(), { scenario });
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
  ])('falls back rather than hanging when the far end stops reading a large snapshot (%s)', async (scenario, reason) => {
    const setup = setUp();
    // Random, so it can't compress below the size of the pipe to ssh.
    writeFileSync(join(setup.project, 'large.bin'), randomBytes(8 * 1024 * 1024));
    const run = await runQuiet(setup, { scenario });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(reason);
    expect(run.stdout).toMatch(/Ran on the Mac in \d+s, because/);
  }, LIMIT);

  it('falls back when the snapshot is refused', async () => {
    const setup = setUp();
    const nested = join(setup.project, 'nested');
    mkdirSync(nested);
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'work.txt'), 'x');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'nested');
    const run = await runQuiet(setup);
    expect(run.stdout).toContain('the snapshot was refused');
    expect(run.sshCalls).toEqual([]);
    expect(run.code).toBe(0);
  }, LIMIT);

  it('falls back rather than crashing when the snapshot has no .nvmrc', async () => {
    const setup = setUp();
    git(setup.project, 'rm', '-q', '.nvmrc');
    git(setup.project, 'commit', '-qm', 'no nvmrc');
    const run = await runQuiet(setup);
    expect(run.stdout).toContain('the run could not be sent');
    expect(run.code).toBe(0);
  }, LIMIT);

  it('keeps a worker count that was already chosen when it falls back', async () => {
    const run = await runQuiet(setUp(), { scenario: 'unreachable', env: { AIO_TEST_MAX_FORKS: '3' } });
    expect(run.localRuns).toEqual([{ macOnly: false, forks: '3' }]);
  }, LIMIT);

  it('passes CI and no-cache through, and nothing else', async () => {
    const quiet = await runQuiet(setUp());
    expect(quiet.runArgs.trim().split(' ').slice(-2)).toEqual(['0', '0']);
    const loop = await runQuiet(setUp(), { env: { CI: '1', AIO_TEST_NO_CACHE: '1', SOME_TOKEN: 'not-for-the-far-machine' } });
    expect(loop.runArgs.trim().split(' ').slice(-2)).toEqual(['1', '1']);
    expect(loop.sshCalls.join('\n')).not.toContain('not-for-the-far-machine');
  }, LIMIT);

  it('runs a short targeted list here, and logs it as a local run', async () => {
    const run = await runQuiet(setUp(), { args: ['src/a.spec.ts', '-t', 'name'] });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.runLog).toEqual([expect.objectContaining({ kind: 'local', ranOn: 'mac', specFiles: 1, exitCode: 0 })]);
  }, LIMIT);

  describe('a long list of spec files', () => {
    const specs = Array.from({ length: 50 }, (_, index) => `src/s${index}.spec.ts`);

    it('goes to the far machine as a list of names sent as data, and is logged as targeted', async () => {
      const setup = setUp();
      const run = await runQuiet(setup, { args: specs });
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
      expect(JSON.parse(readFileSync(join(setup.fake, 'related-list'), 'utf8'))).toEqual(specs);
      expect(run.sshCalls.join('\n')).not.toContain('src/s1.spec.ts');
      expect(run.localRuns).toEqual([]);
      expect(run.runLog[0]).toMatchObject({ kind: 'targeted', ranOn: 'far' });
    }, LIMIT);

    it('falls back to the same list on the Mac, says why, and takes no turn', async () => {
      const setup = setUp();
      const run = await runQuiet(setup, { args: specs, scenario: 'unreachable' });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('Running on the Mac because');
      expect(run.localRuns).toHaveLength(1);
      expect(existsSync(join(setup.dir, 'mac-turn.lock'))).toBe(false);
    }, LIMIT);

    it.runIf(process.platform === 'darwin')('runs a named Mac-only spec here, and no others', async () => {
      const run = await runQuiet(setUp(), { args: [...specs, 'src/main/sandbox/signal-fence.spec.ts'] });
      expect(run.code).toBe(0);
      expect(run.localRuns).toEqual([{ macOnly: true }]);
    }, LIMIT);
  });

  it('changes nothing without a config file', async () => {
    const run = await runQuiet(setUp('project', false));
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.localRuns).toEqual([{ macOnly: false }]);
    expect(run.runLog).toEqual([]);
  }, LIMIT);

  it('stays on the Mac when AIO_REMOTE_CHECKS=off asks for it', async () => {
    const run = await runQuiet(setUp(), { env: { AIO_REMOTE_CHECKS: 'off' } });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('AIO_REMOTE_CHECKS=off');
    expect(run.code).toBe(0);
  }, LIMIT);

  it('keeps queue checks on the Mac and out of the shared lock', async () => {
    const setup = setUp('.worktrees/queue/one');
    const run = await runQuiet(setup);
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('queue checks stay on the Mac');
    expect(existsSync(join(setup.dir, 'mac-turn.lock'))).toBe(false);
  }, LIMIT);

  it('never goes remote on GitHub', async () => {
    const run = await runQuiet(setUp(), { env: { GITHUB_ACTIONS: 'true', CI: 'true' } });
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).not.toContain('Ran on');
    expect(run.runLog).toEqual([]);
  }, LIMIT);

  it.runIf(process.platform === 'darwin')('fails the run when a Mac-only spec fails after a pass elsewhere', async () => {
    const run = await runQuiet(setUp(), { env: { FAKE_MAC_ONLY_FAILS: '1' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('mac boom');
    expect(run.stdout).toContain('✗ FAILED');
  }, LIMIT);

  it.runIf(process.platform === 'darwin')('fails the run when the Mac-only specs exit non-zero with a clean report', async () => {
    const run = await runQuiet(setUp(), { env: { FAKE_MAC_ONLY_CRASHES: '1' } });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✗ FAILED');
  }, LIMIT);

  describe('with two test machines', () => {
    /** A second machine with its own fake far side, listed after the first. `scenario` acts out its runs. */
    function addMachine(setup: Setup, entry: Record<string, unknown>, scenario: string) {
      const fake = join(setup.base, 'fake-2');
      mkdirSync(join(fake, 'home'), { recursive: true });
      writeFileSync(join(fake, 'scenario'), scenario);
      const ssh = join(fake, 'ssh');
      writeFileSync(ssh, `#!/bin/bash\nFAKE_DIR=${JSON.stringify(fake)} exec ${JSON.stringify(join(setup.fake, 'ssh'))} "$@"\n`);
      chmodSync(ssh, 0o755);
      const first = JSON.parse(readFileSync(join(setup.dir, 'config.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(setup.dir, 'config.json'), JSON.stringify({ ...first, moreMachines: [{ ...entry, ssh }] }));
      const read = (file: string): string => (existsSync(join(fake, file)) ? readFileSync(join(fake, file), 'utf8') : '');
      return { fake, runArgs: () => read('run-args'), related: () => read('related-list'), calls: () => read('ssh.log') };
    }

    it('passes a run on to the next machine when the first has no free slot, and only the last waits', async () => {
      const setup = setUp();
      const second = addMachine(setup, { host: 'far-2', label: 'the second PC' }, 'pass');
      const run = await runQuiet(setup, { scenario: 'no-slot' });
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/Ran on the second PC in \d+s\./);
      expect(run.sshCalls.find(call => call.includes(' run '))).toContain('AIO_SLOT_WAIT=0 ');
      expect(second.runArgs()).not.toContain('AIO_SLOT_WAIT');
      expect(run.runLog[0]).toMatchObject({ ranOn: 'far-2', fellBackBecause: null });
    }, LIMIT);

    it('runs here, naming both reasons, when neither machine can', async () => {
      const setup = setUp();
      addMachine(setup, { host: 'far-2', label: 'the second PC' }, 'unreachable');
      const run = await runQuiet(setup, { scenario: 'no-slot' });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('Running on the Mac because the PC had no free slot; the second PC could not be reached');
      expect(run.localRuns).toHaveLength(1);
    }, LIMIT);

    it.runIf(process.platform === 'darwin')('sends the Mac-only specs to a Mac in the list beside the main run, not to this Mac', async () => {
      const setup = setUp();
      const mac = addMachine(setup, { host: 'test-mac', label: 'the test Mac', platform: 'darwin' }, 'mac-only-ran');
      const run = await runQuiet(setup);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
      expect(JSON.parse(mac.related())).toEqual(expect.arrayContaining(['src/main/sandbox/signal-fence.spec.ts']));
      expect(run.localRuns).toEqual([]);
    }, LIMIT);

    it('waits for the Mac-only run beside the main one even when the main run lands on that Mac too', async () => {
      const setup = setUp();
      const mac = addMachine(setup, { host: 'test-mac', label: 'the test Mac', platform: 'darwin' }, 'pass');
      writeFileSync(join(mac.fake, 'related-waits-for-fetch'), '');
      const run = await runQuiet(setup, { scenario: 'no-slot' });
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/Ran on the test Mac in \d+s\./);
      // One fetch for the main run's report and one for the Mac-only run's, which would be lost if it were cut off.
      expect(mac.calls().split('\n').filter(call => call.includes(' fetch '))).toHaveLength(2);
      expect(run.localRuns).toEqual([]);
    }, LIMIT);

    it.runIf(process.platform === 'darwin')('runs the Mac-only specs here when the Mac in the list can\'t', async () => {
      const setup = setUp();
      addMachine(setup, { host: 'test-mac', label: 'the test Mac', platform: 'darwin' }, 'unreachable');
      const run = await runQuiet(setup);
      expect(run.code).toBe(0);
      expect(run.localRuns).toEqual([{ macOnly: true }]);
    }, LIMIT);
  });
});

describe.concurrent('sending a snapshot', () => {
  const farRepo = (setup: Setup): string => join(setup.fake, 'home/remote-checks/repo.git');

  it('sends the whole history first, then only the difference, leaving the source untouched', async () => {
    const setup = setUp();
    const head = git(setup.project, 'rev-parse', 'HEAD');
    expect((await runQuiet(setup)).code).toBe(0);
    expect(git(farRepo(setup), 'for-each-ref', '--format=%(refname)', 'refs/bases/')).toBe(`refs/bases/${head}`);
    const objectsAfterFirst = git(farRepo(setup), 'count-objects', '-v');

    writeFileSync(join(setup.project, 'new.txt'), 'uncommitted\n');
    const refs = git(setup.project, 'for-each-ref');
    const status = git(setup.project, 'status', '--short');
    const second = await runQuiet(setup);
    expect(second.code).toBe(0);

    expect(git(farRepo(setup), 'count-objects', '-v')).not.toBe(objectsAfterFirst);
    const sent = second.runArgs.trim().split(' ').at(-3)!;
    expect(git(farRepo(setup), 'cat-file', 'blob', `${sent}:new.txt`)).toBe('uncommitted');
    expect(git(setup.project, 'for-each-ref')).toBe(refs);
    expect(git(setup.project, 'status', '--short')).toBe(status);
  }, LIMIT);

  it('copes with a base the Mac does not have', async () => {
    const setup = setUp();
    expect((await runQuiet(setup)).code).toBe(0);
    const other = join(setup.base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    const stranger = git(other, 'rev-parse', 'HEAD');
    git(other, 'push', '-q', farRepo(setup), `HEAD:refs/bases/${stranger}`);

    const run = await runQuiet(setup);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Ran on the PC');
  }, LIMIT);

  it('works inside a queue session, with the whole push guard in its environment', async () => {
    const setup = setUp('.worktrees/queue/one');
    const guard = await buildQueuePushGuardEnv(setup.project);
    expect(guard['AIO_QUEUE_SESSION']).toBe('1');

    const run = await runQuiet(setup, { env: guard });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Ran on the PC');
  }, LIMIT);
});
