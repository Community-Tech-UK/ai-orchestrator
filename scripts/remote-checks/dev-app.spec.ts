import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { main, parse, readSigningPassword } = require('./dev-app.js') as {
  readSigningPassword(input: Readable & { isTTY?: boolean }, timeoutMs?: number): Promise<Buffer>;
  main(argv: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; write?: (text: string) => void; commonDir?: string;
    answers?: (port: number, waitMs?: number) => Promise<boolean>;
  }): Promise<number>;
  parse(argv: string[]): { action: string; options: { port: number | null; data: string | null; command: string[]; mode: string; checkedTree: string | null } };
};

const LIMIT = 60_000;
const NOT_RUN = 69;
const STAY_HERE = 75;

/**
 * Stands in for `ssh` to the test Mac. `bases` and `receive` go to the real remote-run.sh, so the snapshot really
 * travels; the dev-app commands are acted out per scenario.
 */
const FAKE_SSH = String.raw`#!/bin/bash
# The commands run with this process's environment, not the one given to main(), so the fake finds its folder itself.
FAKE_DIR="$(cd "$(dirname "$0")" && pwd)"
cmd="${'$'}{!#}"
echo "$cmd" >> "$FAKE_DIR/ssh.log"
scenario="$(cat "$FAKE_DIR/scenario")"
cd "$FAKE_DIR/home" || exit 255
case "$cmd" in
  *' devapp-start '*)
    cat > "$FAKE_DIR/start-data"
    echo '[dev app] building on the far Mac'
    case "$scenario" in
      busy) echo 'AIO_REMOTE_RESULT {"status":"busy","reason":"the test Mac already runs as many Harness copies as it takes"}' ;;
      failed) echo 'AIO_REMOTE_RESULT {"status":"failed","reason":"npm run build:main failed"}' ;;
      taken) echo 'AIO_REMOTE_RESULT {"status":"taken","reason":"another live test already has a Harness copy on that debugging port"}' ;;
      lost) exit 255 ;;
      *) echo 'AIO_REMOTE_RESULT {"status":"ready","reason":""}' ;;
    esac
    ;;
  # A real tunnel lasts as long as the copy; this one lasts until the test ends it.
  *' devapp-hold '*) [ "$scenario" = no-tunnel ] && exit 255; echo held; exec sleep 30 ;;
  *' devapp-stop '*) echo "stopped the Harness copy on port ${'$'}{cmd##* }" ;;
  *)
    [ "$scenario" = unreachable ] && exit 255
    exec bash -c "$cmd"
    ;;
esac
`;

const temps: string[] = [];
const tunnels = new Set<number>();
afterEach(() => {
  for (const pid of tunnels) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  tunnels.clear();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function setUp(config: Record<string, unknown> | null = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-app-')));
  temps.push(base);
  const root = join(base, 'harness');
  const fake = join(base, 'fake');
  const dir = join(base, 'remote-checks');
  mkdirSync(root);
  mkdirSync(join(fake, 'home'), { recursive: true });
  mkdirSync(dir);
  writeFileSync(join(root, '.nvmrc'), '24\n');
  writeFileSync(join(root, 'a.ts'), 'committed\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  writeFileSync(join(root, 'a.ts'), 'changed, not committed\n');
  const ssh = join(fake, 'ssh');
  writeFileSync(ssh, FAKE_SSH);
  chmodSync(ssh, 0o755);
  if (config) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      host: 'far', label: 'the test Mac', ssh, platform: 'darwin', useThisMac: false, ...config,
    }));
  }
  return { base, root, fake, dir };
}

type Setup = ReturnType<typeof setUp>;

async function run(setup: Setup, argv: string[], { scenario = 'pass', cwd = setup.root, answers = true } = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  let output = '';
  const code = await main(argv, {
    cwd,
    env: { ...process.env, AIO_REMOTE_CHECKS_DIR: setup.dir },
    write: (text) => { output += text; },
    commonDir: join(setup.root, '.git'),
    answers: async () => answers,
  });
  const sshLog = existsSync(join(setup.fake, 'ssh.log')) ? readFileSync(join(setup.fake, 'ssh.log'), 'utf8') : '';
  const stateDir = join(setup.dir, 'dev-apps');
  for (const name of existsSync(stateDir) ? readdirSync(stateDir).filter(file => file.endsWith('.json')) : []) {
    const { tunnelPid } = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as { tunnelPid?: number };
    if (tunnelPid) tunnels.add(tunnelPid);
  }
  return { code, output, sshLog };
}

function runLog(setup: Setup): Array<Record<string, unknown>> {
  const file = join(setup.dir, 'runs.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

describe('dev-app arguments', () => {
  it('only accepts bounded noninteractive signing input for explicit packaged launches', async () => {
    expect(() => parse(['start', '--port', '9877', '--data', '/tmp/aio-lt-owned', '--signing-password-stdin'])).toThrow(/packaged/);
    await expect(readSigningPassword(Object.assign(Readable.from([]), { isTTY: true }))).rejects.toThrow(/secure pipe/);
    for (const input of ['', 'x'.repeat(4097), 'placeholder']) {
      const read = readSigningPassword(Readable.from([Buffer.from(input)]));
      if (input === 'placeholder') expect((await read).toString()).toBe('placeholder');
      else await expect(read).rejects.toThrow(/1 to 4096/);
    }
    await expect(readSigningPassword(new Readable({ read() { /* no bytes */ } }), 10)).rejects.toThrow(/timed out/);
  });
  it('accepts an explicit package and a checked snapshot, refusing malformed tree identities', () => {
    expect(parse(['start', '--port', '9877', '--data', '/tmp/aio-lt-owned', '--packaged', '--checked-tree', 'a'.repeat(40)]).options)
      .toMatchObject({ mode: 'packaged', checkedTree: 'a'.repeat(40) });
    expect(() => parse(['start', '--port', '9877', '--data', '/tmp/aio-lt-owned', '--checked-tree', 'bad;tree'])).toThrow(/tree/);
    expect(() => parse(['stop', '--port', '9877', '--packaged'])).toThrow();
  });
  it('takes a port and a data folder of its own under /tmp/aio-lt-', () => {
    expect(parse(['start', '--port', '9444', '--data', '/tmp/aio-lt-batch1']).options).toMatchObject({ port: 9444, data: '/tmp/aio-lt-batch1' });
    expect(() => parse(['start', '--port', '9444', '--data', '/Users/someone'])).toThrow(/\/tmp\/aio-lt-/);
    expect(() => parse(['start', '--port', '9444', '--data', '/tmp/aio-lt-x/../../etc'])).toThrow(/\/tmp\/aio-lt-/);
    expect(() => parse(['start', '--port', '80', '--data', '/tmp/aio-lt-a'])).toThrow(/1024 to 65535/);
    expect(() => parse(['launch'])).toThrow(/no dev-app launch/);
  });

  it('keeps everything after the options as the shell command', () => {
    expect(parse(['shell', '--port', '9444', '--', 'ls', '-la']).options.command).toEqual(['ls', '-la']);
    expect(parse(['shell', '--port', '9444', 'tail -n 5 app.log']).options.command).toEqual(['tail -n 5 app.log']);
    expect(() => parse(['shell', '--port', '9444'])).toThrow(/needs a command/);
  });
});

describe('dev-app start', () => {
  it('runs the exact checked index tree and reports actual packaged provenance', async () => {
    const setup = setUp();
    const tree = git(setup.root, 'rev-parse', 'HEAD^{tree}');
    const result = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-checked', '--packaged', '--checked-tree', tree]);
    expect(result.code).toBe(0);
    expect(result.sshLog).toMatch(/devapp-start \d+ [a-f0-9]+ packaged/);
    const line = result.output.split('\n').find(row => row.startsWith('AIO_DEV_APP_RECEIPT '));
    expect(JSON.parse(line!.slice('AIO_DEV_APP_RECEIPT '.length))).toMatchObject({ tree, root: setup.root, mode: 'packaged', computer: 'ct-test-mac' });
    const store = join(setup.fake, 'home/remote-checks/repo.git');
    expect(git(store, 'show', `${tree}:a.ts`)).toBe('committed');
  }, LIMIT);

  it('sends nothing when the actual checked tree does not match', async () => {
    const setup = setUp();
    const result = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-checked', '--checked-tree', 'a'.repeat(40)]);
    expect(result.code).toBe(1);
    expect(result.output).toContain('checked tree');
    expect(result.sshLog).toBe('');
  });
  it('sends the files on disk, starts the copy there with the data folder as data, and connects the port here', async () => {
    const setup = setUp();
    const port = await freePort();
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec']);
    expect(output).toContain('[dev app] building on the far Mac');
    expect(code).toBe(0);
    expect(output).toContain(`Harness is running on the test Mac, reached here at http://127.0.0.1:${port}`);
    // The folder name went as data, never inside the command.
    expect(readFileSync(join(setup.fake, 'start-data'), 'utf8')).toBe('/tmp/aio-lt-spec');
    expect(sshLog).not.toContain('aio-lt-spec');
    const started = sshLog.split('\n').find(line => line.includes(' devapp-start '))!;
    const commit = started.split(' ').at(-3)!;
    // The snapshot holds the uncommitted edit, and it reached the far store.
    const store = join(setup.fake, 'home/remote-checks/repo.git');
    expect(git(store, 'show', `${commit}:a.ts`)).toBe('changed, not committed');
    expect(sshLog).toContain(` devapp-hold ${port}`);
    const state = JSON.parse(readFileSync(join(setup.dir, 'dev-apps', `${port}.json`), 'utf8'));
    expect(state).toMatchObject({ host: 'far', port, data: '/tmp/aio-lt-spec', tree: git(store, 'rev-parse', `${commit}^{tree}`) });
    expect(runLog(setup)).toEqual([expect.objectContaining({ kind: 'dev-app', ranOn: 'far', exitCode: 0 })]);
  }, LIMIT);

  it('is not run when the test Mac is full and this Mac is switched off for test work', async () => {
    const setup = setUp();
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'busy' });
    expect(code).toBe(NOT_RUN);
    expect(output).toContain('Not run: the test Mac already runs as many Harness copies as it takes');
    expect(runLog(setup)).toEqual([expect.objectContaining({ kind: 'dev-app', ranOn: 'none', exitCode: NOT_RUN })]);
  }, LIMIT);

  it('says to start it here when the test Mac is away and this Mac takes test work', async () => {
    const setup = setUp({ useThisMac: true });
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'unreachable' });
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('the test Mac could not be reached. Start Harness on this Mac instead');
  }, LIMIT);

  it('is not run when the test Mac is paused, and asks nothing of it', async () => {
    const setup = setUp({ paused: true });
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(NOT_RUN);
    expect(output).toContain('Not run: the test Mac is paused');
    expect(sshLog).toBe('');
  });

  it('starts it here when no test machines are set up', async () => {
    const setup = setUp(null);
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('no test machines are set up');
  });

  it('only takes no test Mac to mean none, never a Linux test machine', async () => {
    const setup = setUp({ platform: 'linux' });
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(NOT_RUN);
    expect(output).toContain('no test Mac is in the test machine list');
  });

  it('fails, saying why, when the copy does not build', async () => {
    const setup = setUp();
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'failed' });
    expect(code).toBe(1);
    expect(output).toContain('Harness did not start on the test Mac: npm run build:main failed');
  }, LIMIT);

  it('stops the far copy when the connection back to it does not open', async () => {
    const setup = setUp();
    const port = await freePort();
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'], { scenario: 'no-tunnel' });
    expect(code).toBe(1);
    expect(output).toContain('the connection to it from here did not work');
    expect(sshLog).toContain(` devapp-stop ${port}`);
    expect(existsSync(join(setup.dir, 'dev-apps', `${port}.json`))).toBe(false);
  }, LIMIT);

  it('joins its own running copy, reusing the connection already here', async () => {
    const setup = setUp();
    const port = await freePort();
    expect((await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'])).code).toBe(0);
    const again = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec']);
    expect(again.code).toBe(0);
    // Same files and an answering port: the second start opened no second tunnel.
    expect(again.sshLog.split('\n').filter(line => line.includes(' devapp-hold ')).length).toBe(1);
  }, LIMIT);

  it('says to run it again when the connection drops while Harness starts', async () => {
    const setup = setUp();
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'lost' });
    expect(code).toBe(1);
    expect(output).toContain('Run the same command again: it joins the copy if it is still starting');
  }, LIMIT);

  it('leaves another live test\'s copy on the same port alone', async () => {
    const setup = setUp();
    const port = await freePort();
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'], { scenario: 'taken' });
    expect(code).toBe(1);
    expect(output).toContain('another live test already has a Harness copy on that debugging port, for another data folder');
    expect(sshLog).not.toContain('devapp-stop');
    expect(sshLog).not.toContain('devapp-hold');
  }, LIMIT);

  it('sends nothing when the port is already in use here by something else', async () => {
    const setup = setUp();
    const holder = createServer();
    const port = await new Promise<number>(resolve => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as { port: number }).port)));
    try {
      const { code, output, sshLog } = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec']);
      expect(code).toBe(1);
      expect(output).toContain(`port ${port} is in use on this Mac`);
      expect(sshLog).toBe('');
    } finally {
      await new Promise(resolve => holder.close(resolve));
    }
  });

  it('refuses a folder outside Harness', async () => {
    const setup = setUp();
    const other = join(setup.base, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    const { code, output } = await run(setup, ['start', '--port', '9444', '--data', '/tmp/aio-lt-spec'], { cwd: other });
    expect(code).toBe(2);
    expect(output).toContain('run it from inside a Harness checkout');
  });
});

describe('dev-app stop', () => {
  it('stops the copy on the machine it started on and forgets it here', async () => {
    const setup = setUp();
    const port = await freePort();
    expect((await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'])).code).toBe(0);
    const { code, output } = await run(setup, ['stop', '--port', String(port)]);
    expect(code).toBe(0);
    expect(output).toContain(`stopped the Harness copy on port ${port}`);
    expect(existsSync(join(setup.dir, 'dev-apps', `${port}.json`))).toBe(false);
  }, LIMIT);
});

describe('remote-run.sh dev-app commands', () => {
  function farMachine() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-app-far-')));
    temps.push(base);
    copyFileSync(join(__dirname, 'remote-run.sh'), join(base, 'remote-run.sh'));
    return (args: string[], input = '') => spawnSync('bash', [join(base, 'remote-run.sh'), ...args], { input, encoding: 'utf8' });
  }

  it('refuses a data folder that is not a copy\'s own, a port out of range and a commit that is not one', () => {
    const far = farMachine();
    expect(far(['devapp-start', '9444', 'abc123'], '/Users/someone').status).toBe(4);
    expect(far(['devapp-start', '9444', 'abc123'], '/tmp/aio-lt-a b').status).toBe(4);
    expect(far(['devapp-start', '80', 'abc123'], '/tmp/aio-lt-a').status).toBe(4);
    expect(far(['devapp-start', '9444', 'not;hex'], '/tmp/aio-lt-a').status).toBe(4);
    expect(far(['devapp-start', '9444', 'abc123', 'dev', '1'], '/tmp/aio-lt-a\nplaceholder').status).toBe(4);
  });

  it('reports no copies, and stops one that is not there without complaint', () => {
    const far = farMachine();
    expect(far(['devapp-status']).stdout).toContain('no Harness copies here');
    const stopped = far(['devapp-stop', '9444']);
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain('stopped the Harness copy on port 9444');
    expect(far(['devapp-shell', '9444'], 'echo hi').status).toBe(3);
  });

  /**
   * A far machine holding copies whose jobs are stand-ins: processes named as a copy's job is, which these tests own.
   * Every case ends before a job would start (taken or full), so nothing is built, here or on a Mac.
   */
  function farWithCopies() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-app-far-')));
    temps.push(base);
    copyFileSync(join(__dirname, 'remote-run.sh'), join(base, 'remote-run.sh'));
    const repo = join(base, 'repo.git');
    git(base, 'init', '-q', '--bare', repo);
    const emptyTree = git(repo, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    const commit = git(repo, 'commit-tree', emptyTree, '-m', 'snapshot');
    const standIns: ChildProcess[] = [];
    const copy = (port: number, data: string, alive = true, mode = 'dev') => {
      const dir = join(base, 'devapps/apps', String(port));
      mkdirSync(join(dir, 'repo'), { recursive: true });
      writeFileSync(join(dir, 'data'), `${data}\n`);
      writeFileSync(join(dir, 'tree'), `${emptyTree}\n`);
      writeFileSync(join(dir, 'mode'), `${mode}\n`);
      writeFileSync(join(dir, 'state'), 'ready\n');
      writeFileSync(join(dir, 'started'), `${Math.floor(Date.now() / 1000)}\n`);
      if (alive) {
        // Two commands, so bash stays and keeps the job's name in its command line rather than becoming `sleep`.
        const job = spawn('bash', ['-c', 'sleep 60; true', 'devapp-job', String(port)], { detached: true, stdio: 'ignore' });
        standIns.push(job);
        writeFileSync(join(dir, 'pid'), `${job.pid}\n`);
      } else {
        writeFileSync(join(dir, 'pid'), '999999\n');
      }
      return dir;
    };
    const start = (port: number, data: string, mode = 'dev') => spawnSync('bash', [join(base, 'remote-run.sh'), 'devapp-start', String(port), commit, mode], {
      input: data, encoding: 'utf8',
    });
    // A stopped stand-in stays a zombie until this process collects it, so its exit event is the proof.
    const exits = (job: ChildProcess) => new Promise<boolean>((resolve) => {
      if (job.exitCode !== null || job.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), 5_000);
      job.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    const endAll = () => { for (const job of standIns) { try { process.kill(-job.pid!, 'SIGKILL'); } catch { /* gone */ } } };
    return { base, copy, start, standIns, exits, endAll };
  }

  it('leaves a live copy for another data folder alone, saying the port is taken', () => {
    const far = farWithCopies();
    try {
      far.copy(9444, '/tmp/aio-lt-theirs');
      const started = far.start(9444, '/tmp/aio-lt-mine');
      expect(started.stdout).toContain('AIO_REMOTE_RESULT {"status":"taken"');
      expect(far.standIns[0].exitCode).toBeNull();
      expect(far.standIns[0].signalCode).toBeNull();
      expect(existsSync(join(far.base, 'devapps/apps/9444'))).toBe(true);
      expect(existsSync(join(far.base, 'devapps/start.lock'))).toBe(false);
    } finally {
      far.endAll();
    }
  }, LIMIT);

  it('never joins or replaces a profile running in a different package mode', () => {
    const far = farWithCopies();
    try {
      far.copy(9444, '/tmp/aio-lt-mine');
      expect(far.start(9444, '/tmp/aio-lt-mine', 'packaged').stdout).toContain('different package mode');
      expect(far.start(9445, '/tmp/aio-lt-mine', 'packaged').stdout).toContain('different package mode');
      expect(far.standIns[0].exitCode).toBeNull();
      expect(far.standIns[0].signalCode).toBeNull();
      expect(existsSync(join(far.base, 'devapps/apps/9444'))).toBe(true);
    } finally { far.endAll(); }
  }, LIMIT);

  it('is full at three live copies, after removing the folders of copies whose job has ended', () => {
    const far = farWithCopies();
    try {
      far.copy(9441, '/tmp/aio-lt-a');
      far.copy(9442, '/tmp/aio-lt-b');
      far.copy(9443, '/tmp/aio-lt-c');
      const ended = far.copy(9450, '/tmp/aio-lt-ended', false);
      const started = far.start(9444, '/tmp/aio-lt-d');
      expect(started.stdout).toContain('AIO_REMOTE_RESULT {"status":"busy"');
      expect(existsSync(ended)).toBe(false);
      expect(existsSync(join(far.base, 'devapps/start.lock'))).toBe(false);
    } finally {
      far.endAll();
    }
  }, LIMIT);

  it('stops the same data folder\'s earlier copy on another port, as a resumed job has a new port', async () => {
    const far = farWithCopies();
    try {
      const earlier = far.copy(9445, '/tmp/aio-lt-mine');
      far.copy(9441, '/tmp/aio-lt-a');
      far.copy(9442, '/tmp/aio-lt-b');
      far.copy(9443, '/tmp/aio-lt-c');
      const started = far.start(9444, '/tmp/aio-lt-mine');
      expect(started.stdout).toContain("stopping this data folder's earlier copy on port 9445");
      expect(existsSync(earlier)).toBe(false);
      expect(await far.exits(far.standIns[0])).toBe(true);
      // The three others still fill the machine, so this start goes no further.
      expect(started.stdout).toContain('AIO_REMOTE_RESULT {"status":"busy"');
    } finally {
      far.endAll();
    }
  }, LIMIT);

  it('serves the built screens, with index.html for routes and anything outside the folder', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-app-serve-')));
    temps.push(base);
    mkdirSync(join(base, 'site/assets'), { recursive: true });
    writeFileSync(join(base, 'site/index.html'), '<html>home</html>');
    writeFileSync(join(base, 'site/assets/a.js'), 'console.log(1)');
    writeFileSync(join(base, 'secret.txt'), 'outside');
    const server = spawn('bash', [join(__dirname, 'remote-run.sh'), 'devapp-serve', join(base, 'site'), join(base, 'port')], { stdio: 'ignore' });
    try {
      const portFile = join(base, 'port');
      for (let tries = 0; tries < 100 && !existsSync(portFile); tries += 1) await new Promise(resolve => setTimeout(resolve, 100));
      const at = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`;
      const script = await fetch(`${at}/assets/a.js`);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(await script.text()).toBe('console.log(1)');
      expect(await (await fetch(`${at}/skills/deep-link`)).text()).toBe('<html>home</html>');
      expect(await (await fetch(`${at}/%2e%2e/secret.txt`)).text()).toBe('<html>home</html>');
    } finally {
      server.kill();
    }
  }, LIMIT);
});
