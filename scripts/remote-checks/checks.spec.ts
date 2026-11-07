import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SSH } from './fake-ssh.testing';

/** The real checks runner and the real send, against the fake `ssh` in fake-ssh.testing.ts. */

const require = createRequire(import.meta.url);
const { CHECK_SETS, DEFAULT_CHECKS, KNOWN_CHECKS, parseArgs } = require('./checks.js') as {
  CHECK_SETS: Record<string, string[]>;
  DEFAULT_CHECKS: string[];
  KNOWN_CHECKS: string[];
  parseArgs: (argv: string[]) => { jsonPath: string | null; checks: string[] };
};

const LIMIT = 60_000;
const CHECKS = ['npm run lint', 'npm run typecheck'];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

interface Setup { fake: string; project: string; dir: string }

function setUp(projectFolder = 'project', withConfig = true): Setup {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'checks-remote-')));
  temps.push(base);
  const project = join(base, projectFolder);
  const fake = join(base, 'fake');
  const dir = join(base, 'remote-checks-config');
  mkdirSync(join(project, 'scripts/remote-checks'), { recursive: true });
  mkdirSync(join(fake, 'home'), { recursive: true });
  mkdirSync(dir);
  for (const file of ['checks.js', 'snapshot.js', 'route.js', 'run-remote.js', 'remote-run.sh']) {
    copyFileSync(join(__dirname, file), join(project, 'scripts/remote-checks', file));
  }
  // Run here, each check says so; LINT_FAILS makes lint fail with a message naming this folder.
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'project',
    scripts: {
      lint: 'node -e "if (process.env.LINT_FAILS) { console.log(\'lint broke at \' + process.cwd()); process.exit(3) } console.log(\'lint here\')"',
      typecheck: 'node -e "console.log(\'typecheck here\')"',
    },
  }));
  writeFileSync(join(project, '.gitignore'), 'node_modules\n_scratch\n');
  writeFileSync(join(project, '.nvmrc'), 'v24.0.0\n');
  writeFileSync(join(project, 'package-lock.json'), '{}\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'base');

  const fakeSsh = join(fake, 'ssh');
  writeFileSync(fakeSsh, FAKE_SSH);
  chmodSync(fakeSsh, 0o755);
  if (withConfig) writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'far', label: 'the PC', ssh: fakeSsh }));
  return { fake, project, dir };
}

function runChecks(setup: Setup, { scenario = 'pass', args = CHECKS, env = {} }: {
  scenario?: string; args?: string[]; env?: NodeJS.ProcessEnv;
} = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_QUEUE_SESSION', 'ORCHESTRATOR_LOOP_CONTROL_FILE', 'AIO_REMOTE_CHECKS']) delete clean[key];
  const jsonPath = join(setup.fake, 'outcome.json');
  const result = spawnSync(process.execPath, ['scripts/remote-checks/checks.js', '--json', jsonPath, ...args], {
    cwd: setup.project,
    encoding: 'utf8',
    timeout: LIMIT - 10_000,
    env: { ...clean, AIO_REMOTE_CHECKS_DIR: setup.dir, FAKE_DIR: setup.fake, ...env },
  });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outcome: read(jsonPath) ? JSON.parse(read(jsonPath)) as {
      ranOn: string; fellBackBecause: string | null; checks: { command: string; exitCode: number; output: string }[];
    } : null,
    sent: read(join(setup.fake, 'checks-list')).split('\n').filter(Boolean),
    sshCalls: read(join(setup.fake, 'ssh.log')).split('\n').filter(Boolean),
    runLog: read(join(setup.dir, 'runs.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
    logs: existsSync(join(setup.project, '_scratch')) ? readdirSync(join(setup.project, '_scratch')) : [],
  };
}

describe('checks on the test machine', () => {
  it('sends the checks as data, brings back each result, and says where they ran', () => {
    const setup = setUp();
    const run = runChecks(setup);
    expect(run.code).toBe(0);
    expect(run.sent).toEqual(CHECKS);
    expect(run.sshCalls.join('\n')).not.toContain('npm run lint');
    expect(run.stdout).toContain('✓ npm run lint');
    expect(run.stdout).toMatch(/Ran on the PC in \d+s\./);
    expect(run.outcome).toMatchObject({ ranOn: 'the PC', fellBackBecause: null });
    expect(run.outcome?.checks.map(check => check.command)).toEqual(CHECKS);
    expect(run.runLog).toEqual([expect.objectContaining({
      kind: 'checks', ranOn: 'far', exitCode: 0, fellBackBecause: null,
      checks: [expect.objectContaining({ command: 'npm run lint', exitCode: 0 }), expect.objectContaining({ command: 'npm run typecheck' })],
    })]);
    expect(run.logs).toEqual([]);
  }, LIMIT);

  it('fails with the failing check\'s code, shows its output with this folder\'s paths, and keeps the log', () => {
    const setup = setUp();
    const run = runChecks(setup, { scenario: 'checks-fail' });
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('✓ npm run lint');
    expect(run.stdout).toContain('✗ npm run typecheck: exit 2');
    expect(run.stdout).toContain(`at ${setup.project}/src/x.ts`);
    expect(run.stdout).not.toContain('/far/slots');
    expect(run.outcome?.checks[1]).toMatchObject({ exitCode: 2 });
    expect(run.stdout).toMatch(/Full output: _scratch\/checks\.pid-\d+\.log/);
  }, LIMIT);

  for (const [scenario, why] of [
    ['unreachable', 'could not be reached'],
    ['no-slot', 'had no free slot'],
    ['lost', 'was lost during the run'],
    ['checks-short', 'sent back no usable report'],
    ['wrong-tree', 'did not match the code sent'],
  ] as const) {
    it(`runs every check here when the far machine ${why}, and says so`, () => {
      const run = runChecks(setUp(), { scenario });
      expect(run.code).toBe(0);
      expect(run.stderr).toContain(`running on the Mac because`);
      expect(run.stdout).toContain(why);
      expect(run.outcome).toMatchObject({ ranOn: 'the Mac' });
      // npm may print its own lines around a script's, and does on Linux.
      expect(run.outcome?.checks.map(check => check.output)).toEqual([expect.stringContaining('lint here'), expect.stringContaining('typecheck here')]);
      expect(run.runLog[0]).toMatchObject({ kind: 'checks', ranOn: 'mac' });
      expect(String(run.runLog[0]?.['fellBackBecause'])).toContain(why);
    }, LIMIT);
  }

  it('runs every check here, even after one fails, and fails with the first failure\'s code', () => {
    const run = runChecks(setUp(), { env: { AIO_REMOTE_CHECKS: 'off', LINT_FAILS: '1' } });
    expect(run.code).toBe(3);
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('✗ npm run lint: exit 3');
    expect(run.stdout).toContain('✓ npm run typecheck');
    expect(run.stdout).toContain('because AIO_REMOTE_CHECKS=off asked for it');
  }, LIMIT);

  it('keeps queue checks here unless the config lets them go', () => {
    const run = runChecks(setUp('.worktrees/queue/one'));
    expect(run.sshCalls).toEqual([]);
    expect(run.stdout).toContain('queue checks stay on the Mac');
  }, LIMIT);

  it('runs here and logs nothing without a config file, or on GitHub', () => {
    for (const run of [runChecks(setUp('project', false)), runChecks(setUp(), { env: { GITHUB_ACTIONS: 'true' } })]) {
      expect(run.code).toBe(0);
      expect(run.sshCalls).toEqual([]);
      expect(run.stdout).not.toContain('Ran on');
      expect(run.runLog).toEqual([]);
      expect(run.outcome).toMatchObject({ ranOn: null });
    }
  }, LIMIT);

  it('refuses a command that is not a known check, before sending anything', () => {
    const run = runChecks(setUp(), { args: ['npm run lint', 'rm -rf /'] });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('not a check this can run: rm -rf /');
    expect(run.sshCalls).toEqual([]);
  }, LIMIT);

  it('runs the usual list when given none', () => {
    expect(parseArgs([]).checks).toEqual(DEFAULT_CHECKS);
    expect(parseArgs(['--json', 'out.json', '--', 'npm run lint'])).toEqual({ jsonPath: 'out.json', checks: ['npm run lint'] });
    expect(parseArgs(['--set', 'push']).checks).toEqual(CHECK_SETS['push']);
    expect(() => parseArgs(['--set', 'nope'])).toThrow(/--set takes one of default, push/);
    expect(() => parseArgs(['--set', 'push', 'npm run lint'])).toThrow();
    expect(Object.values(CHECK_SETS).flat().every(check => KNOWN_CHECKS.includes(check))).toBe(true);
  });

  it('knows exactly the checks the far machine will run', () => {
    const script = readFileSync(join(__dirname, 'remote-run.sh'), 'utf8');
    const body = script.slice(script.indexOf('known_check() {'), script.indexOf('esac', script.indexOf('known_check() {')));
    const listed = [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(listed).toEqual(KNOWN_CHECKS);
  });

  it('matches the list the Plan Queue sends as one batch', () => {
    const source = readFileSync(join(__dirname, '../../src/main/plan-queue/plan-queue-gate-receipts.ts'), 'utf8');
    const body = source.slice(source.indexOf('const BATCHED_CHECKS = new Set(['), source.indexOf(']);', source.indexOf('const BATCHED_CHECKS')));
    expect([...body.matchAll(/'([^']+)'/g)].map(match => match[1])).toEqual(KNOWN_CHECKS);
  });

  it('is refused by the far machine for a command it does not know', () => {
    const setup = setUp();
    const home = join(setup.fake, 'home');
    mkdirSync(join(home, 'remote-checks'), { recursive: true });
    copyFileSync(join(__dirname, 'remote-run.sh'), join(home, 'remote-checks/remote-run.sh'));
    const refused = spawnSync('bash', ['remote-checks/remote-run.sh', 'checks', 'r1'], {
      cwd: home, input: 'npm run lint\nnpm run lint; touch owned\n', encoding: 'utf8',
    });
    expect(refused.status).toBe(4);
    expect(existsSync(join(home, 'remote-checks/runs/r1'))).toBe(false);
    const accepted = spawnSync('bash', ['remote-checks/remote-run.sh', 'checks', 'r2'], {
      cwd: home, input: 'npm run lint\n\nnpm run build:main\n', encoding: 'utf8',
    });
    expect(accepted.status).toBe(0);
    expect(readFileSync(join(home, 'remote-checks/runs/r2/checks.list'), 'utf8')).toBe('npm run lint\nnpm run build:main\n');
  });
});
