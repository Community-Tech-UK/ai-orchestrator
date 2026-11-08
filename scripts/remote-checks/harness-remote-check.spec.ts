import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_SSH } from './fake-ssh.testing';

const require = createRequire(import.meta.url);
const { findProject } = require('./projects.js') as {
  findProject(cwd: string, home?: string): { id: string; suite: string; root: string; sends: string[] } | null;
};

/** Stands in for the project's runner, for the file that stays on the Mac. */
const FAKE_MAC_ONLY = `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_DIR + '/mac-only', process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.FAKE_MAC_ONLY_EXIT ?? 0));
`;

const LIMIT = 60_000;
const SCRIPT = join(__dirname, 'harness-remote-check.js');
const STAY_HERE = 75;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-project-')));
  temps.push(dir);
  return dir;
}

function repository(at: string): void {
  mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', 'main');
  git(at, 'commit', '-q', '--allow-empty', '-m', 'base');
}

/** A home folder holding a listed repository, set up as the real one is. */
function setUp() {
  const base = home();
  const root = join(base, 'work/communitytech/work-finding');
  const desk = join(root, 'apps/desk');
  const fake = join(base, 'fake');
  const dir = join(base, '.ai-orchestrator/remote-checks');
  mkdirSync(desk, { recursive: true });
  mkdirSync(join(fake, 'home/remote-checks'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules\n_scratch\n');
  writeFileSync(join(desk, '.nvmrc'), '24\n');
  writeFileSync(join(desk, 'package-lock.json'), '{}\n');
  writeFileSync(join(desk, 'a.test.ts'), 'one\n');
  mkdirSync(join(desk, 'scripts'));
  writeFileSync(join(desk, 'scripts/run-tests-quiet.mjs'), FAKE_MAC_ONLY);
  mkdirSync(join(root, 'documents'));
  writeFileSync(join(root, 'documents/committed.md'), 'committed\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');

  const ssh = join(fake, 'ssh');
  writeFileSync(ssh, FAKE_SSH);
  chmodSync(ssh, 0o755);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'far', label: 'the PC', ssh, queueChecks: true }));
  return { base, root, desk, fake, dir };
}

type Setup = ReturnType<typeof setUp>;

function run(setup: Setup, { scenario = 'pass', cwd = setup.desk, env = {} }: { scenario?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_QUEUE_SESSION', 'ORCHESTRATOR_LOOP_CONTROL_FILE', 'AIO_REMOTE_CHECKS', 'AIO_REMOTE_CHECKS_DIR']) delete clean[key];
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd, encoding: 'utf8', timeout: LIMIT - 10_000, env: { ...clean, HOME: setup.base, FAKE_DIR: setup.fake, ...env },
  });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const args = read(join(setup.fake, 'run-args')).trim().split(' ');
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    sshCalls: read(join(setup.fake, 'ssh.log')).split('\n').filter(Boolean),
    macOnly: read(join(setup.fake, 'mac-only')).split('\n').filter(Boolean),
    sent: (name: string) => git(join(setup.fake, 'home/remote-checks/projects/work-finding/repo.git'), 'cat-file', 'blob', `${args.at(-3)}:${name}`),
    sentFiles: () => git(join(setup.fake, 'home/remote-checks/projects/work-finding/repo.git'), 'ls-tree', '-r', '--name-only', args.at(-3)!).split('\n'),
    runLog: read(join(setup.dir, 'runs.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('findProject', () => {
  it('knows a listed repository only in the folder its suite lives in', () => {
    const base = home();
    const root = join(base, 'work/communitytech/work-finding');
    repository(root);
    mkdirSync(join(root, 'apps/desk'), { recursive: true });
    mkdirSync(join(root, 'apps/radar'), { recursive: true });
    expect(findProject(join(root, 'apps/desk'), base)).toMatchObject({ id: 'work-finding', suite: 'desk', root });
    expect(findProject(join(root, 'apps/radar'), base)).toBeNull();
    expect(findProject(root, base)).toBeNull();
  });

  it('knows its worktrees, which share its git folder', () => {
    const base = home();
    const root = join(base, 'work/communitytech/work-finding');
    repository(root);
    mkdirSync(join(root, 'apps/desk'), { recursive: true });
    writeFileSync(join(root, 'apps/desk/keep'), '');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'desk');
    const linked = join(root, '.worktrees/queue/one');
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    expect(findProject(join(linked, 'apps/desk'), base)).toMatchObject({ id: 'work-finding', root: linked });
  });

  it.each([
    ['another project', 'work/somewhere-else'],
    ['a copy with the same name', 'work/copies/work-finding'],
    ['a name that starts the same', 'work/communitytech/work-finding-old'],
    ['anything under ebrd', 'work/ebrd/work/communitytech/work-finding'],
    ['a folder of undistilled other than its root', 'work/undistilled/apps'],
    ['12steps, measured and left on the Mac', 'work/12steps'],
  ])('refuses %s', (_label, path) => {
    const base = home();
    repository(join(base, path));
    mkdirSync(join(base, path, 'apps/desk'), { recursive: true });
    expect(findProject(join(base, path, 'apps/desk'), base)).toBeNull();
    expect(findProject(join(base, path), base)).toBeNull();
  });

  it('refuses a link pointing a listed name at another repository', () => {
    const base = home();
    const elsewhere = join(base, 'elsewhere');
    repository(elsewhere);
    mkdirSync(join(elsewhere, 'apps/desk'), { recursive: true });
    mkdirSync(dirname(join(base, 'work/communitytech/work-finding')), { recursive: true });
    symlinkSync(elsewhere, join(base, 'work/communitytech/work-finding'));
    expect(findProject(join(base, 'work/communitytech/work-finding/apps/desk'), base)).toBeNull();
  });

  it('knows undistilled only at its root, and as needing a Mac', () => {
    const base = home();
    const root = join(base, 'work/undistilled');
    repository(root);
    expect(findProject(root, base)).toMatchObject({ id: 'undistilled', suite: 'all', root, needsMac: true });
  });

  it('lists nothing under ebrd, and only what James named', () => {
    const { PROJECTS } = require('./projects.js') as { PROJECTS: { repository: string }[] };
    expect(PROJECTS.map(project => project.repository)).toEqual(['work/communitytech/work-finding', 'work/undistilled']);
    expect(PROJECTS.some(project => project.repository.split('/').includes('ebrd'))).toBe(false);
  });

  it('says nothing outside a repository', () => {
    expect(findProject(home())).toBeNull();
  });
});

describe('harness-remote-check', () => {
  it('prints the far runner\'s output with local paths, and logs where it ran', () => {
    const setup = setUp();
    const result = run(setup);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${setup.root}/apps/desk/x.test.ts`);
    expect(result.stdout).not.toContain('/far/slots');
    expect(result.stderr).toMatch(/passed: 5 tests\. Ran on the PC in \d+s/);
    expect(result.runLog[0]).toMatchObject({ project: 'work-finding', kind: 'project', ranOn: 'far', exitCode: 0, fellBackBecause: null });
  }, LIMIT);

  it('names the project to the far machine in its own store, leaving the default one alone', () => {
    const setup = setUp();
    const result = run(setup);
    expect(result.sshCalls.filter(call => call.includes(' run ') || call.includes(' receive ')).every(call => call.startsWith('AIO_PROJECT=work-finding AIO_SUITE=desk '))).toBe(true);
    expect(existsSync(join(setup.fake, 'home/remote-checks/projects/work-finding/repo.git'))).toBe(true);
    expect(existsSync(join(setup.fake, 'home/remote-checks/repo.git'))).toBe(false);
  }, LIMIT);

  it('sends uncommitted work inside its folders, and only the committed copy of the rest', () => {
    const setup = setUp();
    writeFileSync(join(setup.desk, 'a.test.ts'), 'edited\n');
    writeFileSync(join(setup.desk, 'new.test.ts'), 'new\n');
    writeFileSync(join(setup.root, 'documents/committed.md'), 'private edit\n');
    writeFileSync(join(setup.root, 'documents/untracked-notes.md'), 'private\n');
    const result = run(setup);
    expect(result.sent('apps/desk/a.test.ts')).toBe('edited');
    expect(result.sent('apps/desk/new.test.ts')).toBe('new');
    expect(result.sent('documents/committed.md')).toBe('committed');
    expect(result.sentFiles()).not.toContain('documents/untracked-notes.md');
  }, LIMIT);

  it('hands over all of a long output, even to a slow reader', () => {
    const setup = setUp();
    writeFileSync(join(setup.fake, 'scenario'), 'big-output');
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['CI', 'GITHUB_ACTIONS', 'AIO_REMOTE_CHECKS', 'AIO_REMOTE_CHECKS_DIR']) delete clean[key];
    const lines = spawnSync('bash', ['-c', `"${process.execPath}" "${SCRIPT}" 2>/dev/null | (sleep 1; grep -c 'far output line')`], {
      cwd: setup.desk, encoding: 'utf8', timeout: LIMIT - 10_000, env: { ...clean, HOME: setup.base, FAKE_DIR: setup.fake },
    });
    expect(lines.stdout.trim()).toBe('60000');
  }, LIMIT);

  it('after a failure, keeps the far log, leaves it out of the output, and ends on the verdict', () => {
    const setup = setUp();
    const result = run(setup, { scenario: 'failed-with-log' });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('short summary');
    expect(result.stdout).not.toContain('the long far log');
    const verdict = result.stderr.trim().split('\n').at(-1)!;
    expect(verdict).toContain('FAILED: tests failed on the PC');
    const kept = verdict.split('Its full log: ')[1]!;
    expect(kept.startsWith(`${setup.desk}/_scratch/`)).toBe(true);
    expect(readFileSync(kept, 'utf8')).toContain(`the long far log ${setup.root}/apps/desk/b.test.ts`);
  }, LIMIT);

  it('names the Mac-only tests in the verdict when they are what failed', () => {
    const result = run(setUp(), { env: { FAKE_MAC_ONLY_EXIT: '1' } });
    expect(result.stderr.trim().split('\n').at(-1)).toContain('FAILED: the Mac-only tests failed');
  }, LIMIT);

  it('leaves no log behind after a pass', () => {
    const setup = setUp();
    run(setup);
    expect(readdirSync(join(setup.desk, '_scratch'))).toEqual([]);
  }, LIMIT);

  it('says where to read what the far machine printed when a run falls back', () => {
    const result = run(setUp(), { scenario: 'setup-failed' });
    expect(result.stderr).toMatch(/What it printed: .*_scratch\/test-machine\.pid-\d+\.log/);
  }, LIMIT);

  it('returns failing tests as a result, and never as "run it here"', () => {
    const failing = run(setUp(), { scenario: 'tests-fail' });
    expect(failing.code).toBe(1);
    expect(failing.runLog[0]).toMatchObject({ ranOn: 'far', exitCode: 1 });
    const exit75 = run(setUp(), { scenario: 'exit-75' });
    expect(exit75.code).toBe(1);
  }, LIMIT);

  it('runs the file that stays on the Mac after a run elsewhere, and its failure counts', () => {
    expect(run(setUp()).macOnly).toEqual(['test/unit/panelLayoutCss.test.ts']);
    const failing = run(setUp(), { env: { FAKE_MAC_ONLY_EXIT: '1' } });
    expect(failing.code).toBe(1);
    expect(failing.runLog[0]).toMatchObject({ ranOn: 'far', exitCode: 1 });
    const stray75 = run(setUp(), { env: { FAKE_MAC_ONLY_EXIT: '75' } });
    expect(stray75.code).toBe(1);
  }, LIMIT);

  it('leaves the Mac-only file for the fallback to run, rather than running it twice', () => {
    expect(run(setUp(), { scenario: 'unreachable' }).macOnly).toEqual([]);
  }, LIMIT);

  it.each([
    ['unreachable', 'could not be reached'],
    ['lost', 'connection to the PC was lost'],
    ['no-result', 'connection to the PC was lost'],
    ['no-slot', 'no free slot'],
    ['setup-failed', 'could not set up: npm ci failed'],
    ['wrong-tree', 'did not match the code sent'],
    ['wrong-major', 'did not match the code sent'],
    ['wrong-lock', 'did not match the code sent'],
    ['no-tests', 'no usable report'],
  ])('hands the run back on %s, says why, and logs it', (scenario, reason) => {
    const setup = setUp();
    const result = run(setup, { scenario });
    expect(result.code).toBe(STAY_HERE);
    expect(result.stderr).toContain(`running here because`);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).toBe('');
    expect(result.runLog[0]).toMatchObject({ project: 'work-finding', ranOn: 'mac', fellBackBecause: expect.stringContaining(reason) });
  }, LIMIT);

  it.each([
    ['AIO_REMOTE_CHECKS=off', { AIO_REMOTE_CHECKS: 'off' }],
    ['GitHub', { GITHUB_ACTIONS: 'true' }],
  ])('sends nothing with %s', (_label, env) => {
    const result = run(setUp(), { env });
    expect(result.code).toBe(STAY_HERE);
    expect(result.sshCalls).toEqual([]);
  }, LIMIT);

  it('sends nothing with no config, and hands back a broken one', () => {
    const none = setUp();
    rmSync(join(none.dir, 'config.json'));
    expect(run(none).code).toBe(STAY_HERE);
    const broken = setUp();
    writeFileSync(join(broken.dir, 'config.json'), '{ not json');
    const result = run(broken);
    expect(result.code).toBe(STAY_HERE);
    expect(result.sshCalls).toEqual([]);
  }, LIMIT);

  it('sends nothing from a repository that is not listed', () => {
    const setup = setUp();
    const other = join(setup.base, 'work/12steps');
    repository(other);
    const result = run(setup, { cwd: other });
    expect(result.code).toBe(STAY_HERE);
    expect(result.sshCalls).toEqual([]);
  }, LIMIT);

  it('sends nothing from the wrong folder of a listed repository', () => {
    const setup = setUp();
    const result = run(setup, { cwd: setup.root });
    expect(result.code).toBe(STAY_HERE);
    expect(result.sshCalls).toEqual([]);
  }, LIMIT);
});

describe('a suite that needs a Mac', () => {
  /** Undistilled beside the usual set-up, with a second machine that can be made a Mac. */
  function setUpUndistilled(withMac: boolean) {
    const setup = setUp();
    const root = join(setup.base, 'work/undistilled');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n_scratch\n');
    writeFileSync(join(root, '.nvmrc'), '24.22.1\n');
    writeFileSync(join(root, 'package-lock.json'), '{}\n');
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const macFake = join(setup.base, 'fake-mac');
    mkdirSync(join(macFake, 'home/remote-checks'), { recursive: true });
    writeFileSync(join(macFake, 'scenario'), 'pass');
    const macSsh = join(macFake, 'ssh');
    writeFileSync(macSsh, `#!/bin/bash\nFAKE_DIR=${JSON.stringify(macFake)} exec ${JSON.stringify(join(setup.fake, 'ssh'))} "$@"\n`);
    chmodSync(macSsh, 0o755);
    const first = JSON.parse(readFileSync(join(setup.dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    const second = { host: 'far-mac', label: 'the test Mac', ssh: macSsh, ...(withMac ? { platform: 'darwin' } : {}) };
    writeFileSync(join(setup.dir, 'config.json'), JSON.stringify({ ...first, moreMachines: [second] }));
    const macCalls = (): string[] => (existsSync(join(macFake, 'ssh.log')) ? readFileSync(join(macFake, 'ssh.log'), 'utf8').split('\n').filter(Boolean) : []);
    return { setup, root, macCalls };
  }

  // The stand-in far side stores the snapshot with the real remote-run.sh, which knows Undistilled only on a Mac.
  it.runIf(process.platform === 'darwin')('goes only to a Mac in the list, passing over the PC, and has nothing to run here afterwards', () => {
    const { setup, root, macCalls } = setUpUndistilled(true);
    const result = run(setup, { cwd: root });
    expect(result.code).toBe(0);
    expect(result.sshCalls).toEqual([]);
    expect(macCalls().filter(call => call.includes(' run ')).every(call => call.startsWith('AIO_PROJECT=undistilled AIO_SUITE=all '))).toBe(true);
    expect(macCalls().some(call => call.includes(' run '))).toBe(true);
    expect(result.stderr).toMatch(/passed: 5 tests\. Ran on the test Mac in \d+s\./);
    expect(result.macOnly).toEqual([]);
    expect(result.runLog[0]).toMatchObject({ project: 'undistilled', ranOn: 'far-mac', exitCode: 0 });
  }, LIMIT);

  it('stays here, saying why, when no machine taking test runs is a Mac', () => {
    const { setup, root, macCalls } = setUpUndistilled(false);
    const result = run(setup, { cwd: root });
    expect(result.code).toBe(STAY_HERE);
    expect(result.sshCalls).toEqual([]);
    expect(macCalls()).toEqual([]);
    expect(result.stderr).toContain('running here because no test machine taking test runs is a Mac');
    expect(result.runLog[0]).toMatchObject({ project: 'undistilled', ranOn: 'mac', fellBackBecause: 'no test machine taking test runs is a Mac' });
  }, LIMIT);
});

describe('remote-run.sh and unlisted repositories', () => {
  it.each([['undistilled', 'unit'], ['work-finding', 'radar'], ['../escape', 'desk']])('refuses %s/%s before storing anything', (project, suite) => {
    const base = home();
    cpSync(join(__dirname, 'remote-run.sh'), join(base, 'remote-run.sh'));
    const result = spawnSync('bash', [join(base, 'remote-run.sh'), 'bases'], {
      encoding: 'utf8', env: { ...process.env, AIO_PROJECT: project, AIO_SUITE: suite },
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('not a known repository');
    expect(existsSync(join(base, 'projects'))).toBe(false);
  });

  it.runIf(process.platform === 'linux')('refuses undistilled anywhere but a Mac', () => {
    const base = home();
    cpSync(join(__dirname, 'remote-run.sh'), join(base, 'remote-run.sh'));
    const result = spawnSync('bash', [join(base, 'remote-run.sh'), 'bases'], {
      encoding: 'utf8', env: { ...process.env, AIO_PROJECT: 'undistilled', AIO_SUITE: 'all' },
    });
    expect(result.status).toBe(3);
    expect(existsSync(join(base, 'projects'))).toBe(false);
  });

  it('keeps its list in step with projects.js', () => {
    const { PROJECTS } = require('./projects.js') as { PROJECTS: { id: string; suites: { suite: string }[] }[] };
    const script = readFileSync(join(__dirname, 'remote-run.sh'), 'utf8');
    const listed = [...script.matchAll(/^ {4}([a-z0-9-]+\/[a-z0-9-]+)\)$/gm)].map(match => match[1]);
    expect(listed.sort()).toEqual(PROJECTS.flatMap(project => project.suites.map(entry => `${project.id}/${entry.suite}`)).sort());
  });
});
