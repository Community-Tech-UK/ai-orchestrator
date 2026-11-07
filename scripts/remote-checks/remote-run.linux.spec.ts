import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * remote-run.sh for real: real systemd scopes, real `flock`, real detached processes. Only
 * a Linux machine with a user systemd can run these, which every machine that runs the
 * script has. The repository under test carries stubs for npm, tsc and Vitest.
 */
function hasUserSystemd(): boolean {
  if (process.platform !== 'linux') return false;
  const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` };
  return spawnSync('systemctl', ['--user', 'is-system-running'], { env, encoding: 'utf8' }).stdout?.trim() === 'running';
}

const FAKE_INSTALL = `#!/usr/bin/env bash
mkdir -p node_modules/.bin node_modules/vitest
printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/tsc
chmod +x node_modules/.bin/tsc
cp stub-vitest.mjs node_modules/vitest/vitest.mjs
`;

const FAKE_VITEST = `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [behaviour, pidFile] = readFileSync('behaviour', 'utf8').trim().split(' ');
const output = process.argv.find(arg => arg.startsWith('--outputFile.json=')).split('=')[1];
const detached = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
detached.unref();
writeFileSync(pidFile, process.pid + ' ' + detached.pid);
console.log('stub vitest running');
if (behaviour === 'hang') setInterval(() => {}, 1000);
else {
  writeFileSync(output, JSON.stringify({ numTotalTests: 1, testResults: [{ name: process.cwd() + '/a.spec.ts' }] }));
  process.exit(behaviour === 'fail' ? 1 : 0);
}
`;

/** Stands in for scripts/run-related-tests.mjs: reports what it was asked to relate to. */
const FAKE_RELATED = `
import { readFileSync, writeFileSync } from 'node:fs';
const files = JSON.parse(readFileSync(0, 'utf8'));
console.log('stub related running');
writeFileSync(process.argv[2], JSON.stringify({ numTotalTests: files.length, testResults: files.map(name => ({ name })) }));
process.exit(files.some(file => file.includes('fails')) ? 3 : 0);
`;

const temps: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.stdin.end();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return check();
}

/** A machine folder holding the script, and a repository whose snapshot it has received. */
function setUp(slotWaitSeconds = 180) {
  const root = mkdtempSync(join(homedir(), '.remote-run-spec-'));
  temps.push(root);
  const base = join(root, 'machine');
  const project = join(root, 'project');
  mkdirSync(join(base, `node/${process.version}/bin`), { recursive: true });
  mkdirSync(join(project, 'scripts'), { recursive: true });
  symlinkSync(process.execPath, join(base, `node/${process.version}/bin/node`));
  const script = join(base, 'remote-run.sh');
  writeFileSync(script, readFileSync(join(__dirname, 'remote-run.sh'), 'utf8')
    .replace('SLOT_WAIT_SECONDS=180', `SLOT_WAIT_SECONDS=${slotWaitSeconds}`));
  chmodSync(script, 0o755);

  writeFileSync(join(project, '.nvmrc'), `${process.version}\n`);
  writeFileSync(join(project, '.gitignore'), 'node_modules\n_scratch\n');
  writeFileSync(join(project, 'package.json'), '{"name":"stub","version":"1.0.0"}\n');
  writeFileSync(join(project, 'package-lock.json'), '{}\n');
  writeFileSync(join(project, 'scripts/ci-npm-ci.sh'), FAKE_INSTALL);
  writeFileSync(join(project, 'scripts/sync-dist.js'), '');
  writeFileSync(join(project, 'stub-vitest.mjs'), FAKE_VITEST);
  writeFileSync(join(project, 'scripts/run-related-tests.mjs'), FAKE_RELATED);

  const pidFile = join(root, 'pids');
  const snapshot = (behaviour: string): string => {
    writeFileSync(join(project, 'behaviour'), `${behaviour} ${pidFile}\n`);
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'add', '-A');
    git(project, 'commit', '-qm', behaviour, '--allow-empty');
    const commit = git(project, 'rev-parse', 'HEAD');
    const pack = execFileSync('git', ['pack-objects', '--revs', '--stdout', '--quiet'], {
      cwd: project, input: `${commit}\n`, maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync('bash', [script, 'receive', commit, 'none'], { input: pack });
    return commit;
  };
  const pids = (): number[] => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split(' ').map(Number) : []);
  return { base, pidFile, pids, project, script, snapshot };
}

function startRun(script: string, name: string, commit: string) {
  // Unique, like a real run's: suites overlapping on one machine share a systemd user manager.
  const id = `${name}-${process.pid}`;
  const child = spawn('bash', [script, 'run', id, commit, '0', '0'], { stdio: 'pipe' });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  const finished = new Promise<void>(resolve => child.on('close', () => resolve()));
  const result = (): Record<string, unknown> | null => {
    const line = output.split('\n').find(text => text.startsWith('AIO_REMOTE_RESULT '));
    return line ? JSON.parse(line.slice('AIO_REMOTE_RESULT '.length)) : null;
  };
  return { child, finished, id, result, output: () => output };
}

const LIMIT = 60_000;

describe.runIf(hasUserSystemd())('remote-run.sh on a real machine', () => {
  it('runs a snapshot and reports its fingerprint, then hands back the report', async () => {
    const machine = setUp();
    const commit = machine.snapshot('pass');
    const run = startRun(machine.script, 'pass-run', commit);
    run.child.stdin.write('');
    await run.finished;

    expect(run.output()).toContain('stub vitest running');
    expect(run.result()).toMatchObject({
      status: 'ok', exit: 0, tree: git(machine.project, 'rev-parse', 'HEAD^{tree}'), node: process.version,
    });
    const report = execFileSync('bash', [machine.script, 'fetch', run.id], { maxBuffer: 16 * 1024 * 1024 });
    expect(JSON.parse(gunzipSync(report).toString()).numTotalTests).toBe(1);
    expect(existsSync(join(machine.base, 'runs', run.id))).toBe(false);
  }, LIMIT);

  it('passes on the suite\'s own exit code', async () => {
    const machine = setUp();
    const run = startRun(machine.script, 'fail-run', machine.snapshot('fail'));
    await run.finished;
    expect(run.result()).toMatchObject({ status: 'ok', exit: 1 });
  }, LIMIT);

  it('leaves nothing behind when a run finishes normally, even a detached child', async () => {
    const machine = setUp();
    const run = startRun(machine.script, 'leftover-run', machine.snapshot('pass'));
    await run.finished;
    const [, detached] = machine.pids();
    expect(await waitFor(() => !isAlive(detached))).toBe(true);
  }, LIMIT);

  it('kills everything the run started, detached children included, when the connection closes', async () => {
    const machine = setUp();
    const run = startRun(machine.script, 'dropped-run', machine.snapshot('hang'));
    expect(await waitFor(() => machine.pids().length === 2)).toBe(true);
    const [vitest, detached] = machine.pids();
    expect(isAlive(vitest) && isAlive(detached)).toBe(true);

    run.child.stdin.end();

    expect(await waitFor(() => !isAlive(vitest) && !isAlive(detached))).toBe(true);
    await run.finished;
    expect(run.result()).toMatchObject({ status: 'setup-failed' });
  }, LIMIT);

  it('frees its slot when a run dies, so the next run gets it', async () => {
    const machine = setUp();
    const first = startRun(machine.script, 'dying-run', machine.snapshot('hang'));
    expect(await waitFor(() => machine.pids().length === 2)).toBe(true);
    process.kill(machine.pids()[0], 'SIGKILL');
    await first.finished;
    expect(first.result()).toMatchObject({ status: 'ok' });

    rmSync(machine.pidFile);
    const second = startRun(machine.script, 'next-run', machine.snapshot('pass'));
    await second.finished;

    expect(second.output()).toContain('slot 1');
    expect(second.result()).toMatchObject({ status: 'ok', exit: 0 });
  }, LIMIT);

  it('reports no slot when all of them stay busy past the wait', async () => {
    const machine = setUp(2);
    const commit = machine.snapshot('pass');
    mkdirSync(join(machine.base, 'slots'), { recursive: true });
    const locks = [1, 2, 3].map(slot => join(machine.base, `slots/${slot}.lock`));
    const holders = locks.map(lock => spawn('flock', ['-o', lock, 'sleep', '30'], { stdio: 'ignore' }));
    const isHeld = (lock: string): boolean => spawnSync('flock', ['-n', lock, 'true']).status !== 0;
    expect(await waitFor(() => locks.every(isHeld))).toBe(true);

    const run = startRun(machine.script, 'busy-run', commit);
    await run.finished;
    for (const holder of holders) holder.kill('SIGKILL');

    expect(run.result()).toMatchObject({ status: 'no-slot' });
  }, LIMIT);

  it('runs only the related tests when given a list, keeping awkward names as data', async () => {
    const machine = setUp();
    const commit = machine.snapshot('pass');
    const files = ['src/a $(touch pwned);b.ts', "src/it's.ts"];
    const id = `related-run-${process.pid}`;
    execFileSync('bash', [machine.script, 'related', id], { input: JSON.stringify(files) });
    const child = spawn('bash', [machine.script, 'run', id, commit, '0', '0'], { stdio: 'pipe' });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    await new Promise<void>(resolve => child.on('close', () => resolve()));

    expect(output).toContain('stub related running');
    expect(output).not.toContain('stub vitest running');
    expect(output).toContain('"status":"ok"');
    const report = execFileSync('bash', [machine.script, 'fetch', id], { maxBuffer: 16 * 1024 * 1024 });
    expect(JSON.parse(gunzipSync(report).toString()).testResults.map((suite: { name: string }) => suite.name)).toEqual(files);
    expect(existsSync(join(machine.base, 'slots/1/repo/pwned'))).toBe(false);
  }, LIMIT);

  it('passes on the related run\'s own exit code', async () => {
    const machine = setUp();
    const commit = machine.snapshot('pass');
    const id = `related-fail-${process.pid}`;
    execFileSync('bash', [machine.script, 'related', id], { input: JSON.stringify(['fails.ts']) });
    const child = spawn('bash', [machine.script, 'run', id, commit, '0', '0'], { stdio: 'pipe' });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    await new Promise<void>(resolve => child.on('close', () => resolve()));
    expect(output).toContain('"exit":3');
  }, LIMIT);

  it('names a setup fault rather than reporting tests', async () => {
    const machine = setUp();
    writeFileSync(join(machine.project, 'scripts/ci-npm-ci.sh'), 'exit 1\n');
    const run = startRun(machine.script, 'broken-run', machine.snapshot('pass'));
    await run.finished;
    expect(run.result()).toMatchObject({ status: 'setup-failed', reason: 'npm ci failed' });
  }, LIMIT);
});
