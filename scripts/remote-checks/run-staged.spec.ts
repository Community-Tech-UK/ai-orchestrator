import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SSH } from './fake-ssh.testing';

/**
 * The commit route end to end: real commits through a real hook, the real test-staged.js,
 * the real send into a real far repository, with `ssh` faked for `run` and `fetch`. On the
 * Mac side, `build:main` and run-related-tests.mjs are stand-ins that record being called.
 */
const FAKE_LOCAL_RELATED = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/local-related', readFileSync(0, 'utf8') + '\n');
process.exit(Number(process.env.FAKE_LOCAL_EXIT ?? 0));
`;

const FAKE_MAC_VITEST = String.raw`
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/mac-only-runs', process.argv.slice(2).join(' ') + '\n');
process.exit(Number(process.env.FAKE_MAC_ONLY_EXIT ?? 0));
`;

const LIMIT = 60_000;
const RELATED_SPECS = 60;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

interface Setup { project: string; fake: string; dir: string }

function setUp({ specs = RELATED_SPECS, withConfig = true } = {}): Setup {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'run-staged-')));
  temps.push(base);
  const project = join(base, 'project');
  const fake = join(base, 'fake');
  const dir = join(base, 'config');
  mkdirSync(join(project, 'scripts/remote-checks'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'node_modules/vitest'), { recursive: true });
  mkdirSync(join(fake, 'home'), { recursive: true });
  mkdirSync(dir);

  copyFileSync(join(__dirname, '../test-staged.js'), join(project, 'scripts/test-staged.js'));
  copyFileSync(join(__dirname, '../run-git-hook.js'), join(project, 'scripts/run-git-hook.js'));
  copyFileSync(join(__dirname, '../generated-artifacts.json'), join(project, 'scripts/generated-artifacts.json'));
  for (const file of ['snapshot.js', 'route.js', 'mac-only.js', 'run-remote.js', 'remote-run.sh', 'related-estimate.js', 'run-staged.js']) {
    copyFileSync(join(__dirname, file), join(project, 'scripts/remote-checks', file));
  }
  writeFileSync(join(project, 'scripts/run-related-tests.mjs'), FAKE_LOCAL_RELATED);
  writeFileSync(join(project, 'node_modules/vitest/package.json'), JSON.stringify({ name: 'vitest', bin: { vitest: 'vitest.mjs' } }));
  writeFileSync(join(project, 'node_modules/vitest/vitest.mjs'), FAKE_MAC_VITEST);
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'p', scripts: { 'build:main': 'node -e "require(\'fs\').appendFileSync(process.env.FAKE_DIR+\'/local-builds\',\'b\\n\')"' },
  }));
  writeFileSync(join(project, '.gitignore'), 'node_modules\n_scratch\n');
  writeFileSync(join(project, '.nvmrc'), 'v24.0.0\n');
  writeFileSync(join(project, 'package-lock.json'), '{}\n');
  writeFileSync(join(project, 'src/shared.ts'), 'export const value = 1;\n');
  writeFileSync(join(project, 'src/lonely.ts'), 'export const lonely = 1;\n');
  for (let index = 0; index < specs; index += 1) writeFileSync(join(project, `src/s${index}.spec.ts`), "import './shared';\n");

  const hooks = join(project, '.test-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexec node scripts/test-staged.js\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);

  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'base');

  const fakeSsh = join(fake, 'ssh');
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  if (withConfig) writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'far', label: 'the PC', ssh: fakeSsh }));
  return { project, fake, dir };
}

function hookEnv(setup: Setup, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_QUEUE_SESSION', 'ORCHESTRATOR_LOOP_CONTROL_FILE', 'AIO_REMOTE_CHECKS']) delete clean[key];
  return { ...clean, AIO_REMOTE_CHECKS_DIR: setup.dir, FAKE_DIR: setup.fake, ...env };
}

/** A real `git commit`, firing the real hook. */
function commit(setup: Setup, args: string[], { scenario = 'pass', env = {} }: { scenario?: string; env?: NodeJS.ProcessEnv } = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  const result = spawnSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=.test-hooks', 'commit', '-m', 'next', ...args,
  ], { cwd: setup.project, encoding: 'utf8', timeout: LIMIT - 10_000, env: hookEnv(setup, env) });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const runArgs = read(join(setup.fake, 'run-args')).trim().split(' ');
  return {
    code: result.status,
    output: `${result.stdout}${result.stderr}`,
    sent: (name: string) => git(join(setup.fake, 'home/remote-checks/repo.git'), 'cat-file', 'blob', `${runArgs.at(-3)}:${name}`),
    sshCalls: read(join(setup.fake, 'ssh.log')).split('\n').filter(Boolean),
    relatedList: read(join(setup.fake, 'related-list')),
    localBuilds: read(join(setup.fake, 'local-builds')).split('\n').filter(Boolean).length,
    localRelated: read(join(setup.fake, 'local-related')).split('\n').filter(Boolean),
    macOnlyRuns: read(join(setup.fake, 'mac-only-runs')).split('\n').filter(Boolean),
    runLog: read(join(setup.dir, 'runs.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

const edit = (setup: Setup, text: string, name = 'src/shared.ts'): void => writeFileSync(join(setup.project, name), text);

function stageChange(setup: Setup): void {
  edit(setup, 'export const value = 2;\n');
  git(setup.project, 'add', 'src/shared.ts');
}

describe('commit-time tests through the test machine', () => {
  it('tests what is staged, not another session\'s edit on disk', () => {
    const setup = setUp();
    stageChange(setup);
    edit(setup, 'export const value = "someone else is halfway through this";\n');

    const run = commit(setup, []);

    expect(run.code).toBe(0);
    expect(run.sent('src/shared.ts')).toBe('export const value = 2;');
    expect(run.output).toMatch(/Ran on the PC in \d+s\./);
    expect(run.localBuilds).toBe(0);
    expect(run.localRelated).toEqual([]);
    expect(git(setup.project, 'show', 'HEAD:src/shared.ts')).toBe('export const value = 2;');
    expect(readFileSync(join(setup.project, 'src/shared.ts'), 'utf8')).toContain('halfway');
  }, LIMIT);

  it('tests the temporary index of `git commit -a`', () => {
    const setup = setUp();
    edit(setup, 'export const value = 3;\n');
    const run = commit(setup, ['-a']);
    expect(run.code).toBe(0);
    expect(run.sent('src/shared.ts')).toBe('export const value = 3;');
  }, LIMIT);

  it('tests the temporary index of `git commit <path>`, without what else is staged', () => {
    const setup = setUp();
    edit(setup, 'export const lonely = 2;\n', 'src/lonely.ts');
    git(setup.project, 'add', 'src/lonely.ts');
    edit(setup, 'export const value = 4;\n');

    const run = commit(setup, ['--', 'src/shared.ts']);

    expect(run.code).toBe(0);
    expect(run.sent('src/shared.ts')).toBe('export const value = 4;');
    expect(run.sent('src/lonely.ts')).toBe('export const lonely = 1;');
    expect(git(setup.project, 'diff', '--cached', '--name-only')).toBe('src/lonely.ts');
  }, LIMIT);

  it('keeps file names out of every remote command, sending them as data', () => {
    const setup = setUp();
    const awkward = 'src/odd $(touch pwned);name.ts';
    edit(setup, "import './shared';\n", awkward);
    stageChange(setup);
    git(setup.project, 'add', '-A');

    const run = commit(setup, []);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.relatedList)).toContain(awkward);
    expect(run.sshCalls.join('\n')).not.toContain('pwned');
    expect(run.sshCalls.join('\n')).not.toContain('src/shared.ts');
  }, LIMIT);

  it('blocks the commit on failing tests, shows them with local paths, and does not rerun them', () => {
    const setup = setUp();
    stageChange(setup);
    const before = git(setup.project, 'rev-parse', 'HEAD');

    const run = commit(setup, [], { scenario: 'tests-fail' });

    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`boom at ${setup.project}/src/a.spec.ts:1`);
    expect(run.output).not.toContain('/far/slots');
    expect(run.localRelated).toEqual([]);
    expect(git(setup.project, 'rev-parse', 'HEAD')).toBe(before);
  }, LIMIT);

  it('blocks the commit when the far run exits non-zero with a clean report', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'crash-clean-report' });
    expect(run.code).not.toBe(0);
    expect(run.localRelated).toEqual([]);
  }, LIMIT);

  it('blocks the commit when the report has failures, even if the far run exits 0', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'failed-report-clean-exit' });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain('boom at');
  }, LIMIT);

  it('never lets a far exit code read as "stay on the Mac"', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'exit-75' });
    expect(run.code).not.toBe(0);
    expect(run.localRelated).toEqual([]);
    expect(run.runLog[0]).toMatchObject({ ranOn: 'far', exitCode: 1 });
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
  ])('falls back to the Mac on %s, says why, and the commit goes through', (scenario, reason) => {
    const setup = setUp();
    stageChange(setup);

    const run = commit(setup, [], { scenario });

    expect(run.code).toBe(0);
    expect(run.output).toContain('running on the Mac because');
    expect(run.output).toContain(reason);
    expect(run.localBuilds).toBe(1);
    expect(run.localRelated).toHaveLength(1);
    expect(run.runLog[0]).toMatchObject({ kind: 'commit', ranOn: 'mac', fellBackBecause: expect.stringContaining(reason) });
    expect(git(setup.project, 'show', 'HEAD:src/shared.ts')).toBe('export const value = 2;');
  }, LIMIT);

  it('still blocks on tests that fail on the Mac after a fallback', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'unreachable', env: { FAKE_LOCAL_EXIT: '1' } });
    expect(run.code).not.toBe(0);
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it.each([
    ['receive-refuses', 'could not store the snapshot'],
    ['receive-drops', 'could not be reached'],
  ])('falls back rather than hanging when the far end stops reading a large commit (%s)', (scenario, reason) => {
    const setup = setUp();
    // Random, so it can't compress below the size of the pipe to ssh.
    writeFileSync(join(setup.project, 'large.bin'), randomBytes(8 * 1024 * 1024));
    stageChange(setup);
    git(setup.project, 'add', 'large.bin');

    const run = commit(setup, [], { scenario });

    expect(run.code).toBe(0);
    expect(run.output).toContain(reason);
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it('falls back when a staged secret-looking file can\'t be sent, and sends nothing', () => {
    const setup = setUp();
    stageChange(setup);
    edit(setup, 'SETTING=placeholder\n', '.env');
    git(setup.project, 'add', '.env');

    const run = commit(setup, []);

    expect(run.code).toBe(0);
    expect(run.output).toContain('.env has a secret-looking name');
    expect(run.sshCalls).toEqual([]);
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it('falls back on a broken config rather than blocking the commit', () => {
    const setup = setUp();
    writeFileSync(join(setup.dir, 'config.json'), '{ not json');
    stageChange(setup);
    const run = commit(setup, []);
    expect(run.code).toBe(0);
    expect(run.output).toContain('running on the Mac because');
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it('keeps a small change on the Mac, without saying anything', () => {
    const setup = setUp();
    edit(setup, 'export const lonely = 2;\n', 'src/lonely.ts');
    git(setup.project, 'add', 'src/lonely.ts');

    const run = commit(setup, []);

    expect(run.code).toBe(0);
    expect(run.sshCalls).toEqual([]);
    expect(run.output).not.toContain('running on the Mac because');
    expect(run.runLog).toEqual([]);
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it('goes by how far a change reaches, sending one at the size limit and keeping one just under', () => {
    const atLimit = setUp({ specs: 50 });
    stageChange(atLimit);
    expect(commit(atLimit, []).sshCalls).not.toEqual([]);

    const under = setUp({ specs: 49 });
    stageChange(under);
    expect(commit(under, []).sshCalls).toEqual([]);
  }, LIMIT);

  it.each([
    ['with no config', { withConfig: false }, {}],
    ['when AIO_REMOTE_CHECKS=off asks for it', {}, { AIO_REMOTE_CHECKS: 'off' }],
    ['on GitHub', {}, { GITHUB_ACTIONS: 'true' }],
  ])('stays on the Mac %s', (_label, options, env) => {
    const setup = setUp(options);
    stageChange(setup);
    const run = commit(setup, [], { env });
    expect(run.code).toBe(0);
    expect(run.sshCalls).toEqual([]);
    expect(run.localRelated).toHaveLength(1);
  }, LIMIT);

  it('runs a Mac-only spec here when the far machine\'s report includes it', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'mac-only-ran' });
    expect(run.code).toBe(0);
    expect(run.macOnlyRuns).toEqual(['run src/main/sandbox/signal-fence.spec.ts']);
  }, LIMIT);

  it('leaves Mac-only specs alone when the change does not reach them', () => {
    const setup = setUp();
    stageChange(setup);
    expect(commit(setup, []).macOnlyRuns).toEqual([]);
  }, LIMIT);

  it('blocks the commit when a Mac-only spec fails after a pass elsewhere', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, [], { scenario: 'mac-only-ran', env: { FAKE_MAC_ONLY_EXIT: '1' } });
    expect(run.code).not.toBe(0);
    expect(run.localRelated).toEqual([]);
  }, LIMIT);

  it('leaves no log or report behind after a pass, and keeps them after a failure', () => {
    const scratchFiles = (setup: Setup): string[] => readdirSync(join(setup.project, '_scratch'));
    const passed = setUp();
    stageChange(passed);
    expect(commit(passed, []).code).toBe(0);
    expect(scratchFiles(passed)).toEqual([]);

    const failed = setUp();
    stageChange(failed);
    expect(commit(failed, [], { scenario: 'tests-fail' }).code).not.toBe(0);
    expect(scratchFiles(failed)).toHaveLength(2);
  }, LIMIT);

  it('logs a run as a commit run, with where it went', () => {
    const setup = setUp();
    stageChange(setup);
    const run = commit(setup, []);
    expect(run.runLog).toHaveLength(1);
    expect(run.runLog[0]).toMatchObject({ project: 'project', kind: 'commit', ranOn: 'far', exitCode: 0, fellBackBecause: null });
  }, LIMIT);

  describe('with this Mac switched off', () => {
    const switchOff = (setup: Setup): void => {
      const config = JSON.parse(readFileSync(join(setup.dir, 'config.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(setup.dir, 'config.json'), JSON.stringify({ ...config, useThisMac: false }));
    };
    const WAITS = { AIO_STAGED_WAIT_LIMIT_MS: '300', AIO_REMOTE_RETRY_SLEEP_MS: '100' };

    it('sends even a small change away, in a small slot, and runs nothing here', () => {
      const setup = setUp({ specs: 1 });
      switchOff(setup);
      stageChange(setup);
      const run = commit(setup, [], { env: WAITS });
      expect(run.code).toBe(0);
      expect(run.sshCalls.find(call => call.includes(' run '))).toContain('AIO_SMALL_RUN=1 ');
      expect(run.localBuilds).toBe(0);
      expect(run.localRelated).toEqual([]);
    }, LIMIT);

    it('lets the commit through, saying the tests did not run, when no machine has a free slot', () => {
      const setup = setUp({ specs: 1 });
      switchOff(setup);
      stageChange(setup);
      const before = git(setup.project, 'rev-parse', 'HEAD');
      const run = commit(setup, [], { scenario: 'no-slot', env: WAITS });
      expect(run.code).toBe(0);
      expect(run.output).toContain('Tests not run: no test machine was free. The queue and loop checks will still run them.');
      expect(git(setup.project, 'rev-parse', 'HEAD')).not.toBe(before);
      expect(run.localBuilds).toBe(0);
      expect(run.localRelated).toEqual([]);
      expect(run.runLog).toEqual([expect.objectContaining({ kind: 'commit', ranOn: 'none', exitCode: 69 })]);
    }, LIMIT);

    it('still blocks the commit on tests that fail far away', () => {
      const setup = setUp({ specs: 1 });
      switchOff(setup);
      stageChange(setup);
      const run = commit(setup, [], { scenario: 'tests-fail', env: WAITS });
      expect(run.code).not.toBe(0);
      expect(run.output).not.toContain('Tests not run');
      expect(run.localRelated).toEqual([]);
    }, LIMIT);
  });
});
