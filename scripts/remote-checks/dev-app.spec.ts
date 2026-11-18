import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface Load { load: number; cores: number; copies: number; limit: number }
const { main, parse, readSigningPassword } = require('./dev-app.js') as {
  readSigningPassword(input: Readable & { isTTY?: boolean }, timeoutMs?: number): Promise<Buffer>;
  main(argv: string[], options: {
    cwd?: string; env?: NodeJS.ProcessEnv; write?: (text: string) => void; commonDir?: string;
    answers?: (port: number, waitMs?: number) => Promise<boolean>; localLoad?: () => Load;
  }): Promise<number>;
  parse(argv: string[]): { action: string; options: { port: number | null; data: string | null; command: string[]; mode: string; needs: string[]; checkedTree: string | null } };
};

const LIMIT = 60_000;
const STAY_HERE = 75;
const QUIET: Load = { load: 1, cores: 10, copies: 0, limit: 3 };
const LOADED: Load = { load: 40, cores: 10, copies: 0, limit: 3 };

/**
 * Stands in for `ssh` to the test machines. `bases` and `receive` go to the real remote-run.sh, so the snapshot really
 * travels; the dev-app commands are acted out per scenario. A scenario ending `-<host>` applies to that host only.
 * `devapp-load` answers from `load-<host>` (quiet, with no copy there, when there is none), and a `load-<host>.next`
 * replaces it after one look. A script in `after-look-<host>` runs once, after that host's first look. A copy that
 * started (or whose start lost its connection) is kept in `copy-<host>` until a stop, and `devapp-load` reports it.
 * `devapp-providers` answers with the result line in `tools-<host>` (nothing installed when there is none), a
 * `tools-<host>.next` replacing it after one look, and an `ask-fails-<host>` file makes the next ask fail once.
 */
const FAKE_SSH = String.raw`#!/bin/bash
# The commands run with this process's environment, not the one given to main(), so the fake finds its folder itself.
FAKE_DIR="$(cd "$(dirname "$0")" && pwd)"
cmd="${'$'}{!#}"
host="${'$'}{@: -2:1}"
echo "$host: $cmd" >> "$FAKE_DIR/ssh.log"
scenario="$(cat "$FAKE_DIR/scenario")"
cd "$FAKE_DIR/home" || exit 255
case "$scenario" in unreachable | "unreachable-$host") exit 255 ;; esac
case "$cmd" in
  *' devapp-load '*)
    bash -c "${'$'}{cmd% && bash *}" || exit 1
    load='{"load":1,"cores":10,"copies":0,"limit":3}'
    [ -f "$FAKE_DIR/load-$host" ] && load="$(cat "$FAKE_DIR/load-$host")"
    [ -f "$FAKE_DIR/load-$host.next" ] && mv "$FAKE_DIR/load-$host.next" "$FAKE_DIR/load-$host"
    [ -f "$FAKE_DIR/after-look-$host" ] && { bash "$FAKE_DIR/after-look-$host"; rm -f "$FAKE_DIR/after-look-$host"; }
    copy=null
    [ -f "$FAKE_DIR/copy-$host" ] && copy="$(cat "$FAKE_DIR/copy-$host")"
    echo "AIO_REMOTE_RESULT ${'$'}{load%\}},\"copy\":$copy}"
    ;;
  *' devapp-providers')
    bash -c "${'$'}{cmd% && bash *}" || exit 1
    if [ -f "$FAKE_DIR/ask-fails-$host" ]; then rm -f "$FAKE_DIR/ask-fails-$host"; exit 255; fi
    tools='{"installed":[]}'
    [ -f "$FAKE_DIR/tools-$host" ] && tools="$(cat "$FAKE_DIR/tools-$host")"
    [ -f "$FAKE_DIR/tools-$host.next" ] && mv "$FAKE_DIR/tools-$host.next" "$FAKE_DIR/tools-$host"
    echo "AIO_REMOTE_RESULT $tools"
    ;;
  *' devapp-start '*)
    cat > "$FAKE_DIR/start-data"
    echo "[dev app] building on $host"
    set -- ${'$'}{cmd#* devapp-start }
    case "$scenario" in pass | lost)
      printf '{"tree":"%s","data":"%s","mode":"%s"}' "$(git -C remote-checks/repo.git rev-parse "$2^{tree}")" \
        "$(cat "$FAKE_DIR/start-data")" "$3" > "$FAKE_DIR/copy-$host" ;;
    esac
    case "$scenario" in
      busy | "busy-$host") echo 'AIO_REMOTE_RESULT {"status":"busy","reason":"the test Mac already runs as many Harness copies as it takes"}' ;;
      failed | failed-cleanup) echo 'AIO_REMOTE_RESULT {"status":"failed","reason":"npm run build:main failed"}' ;;
      taken) echo 'AIO_REMOTE_RESULT {"status":"taken","reason":"another live test already has a Harness copy on that debugging port"}' ;;
      lost) exit 255 ;;
      *) echo 'AIO_REMOTE_RESULT {"status":"ready","reason":""}' ;;
    esac
    ;;
  # A real tunnel lasts as long as the copy; this one lasts until the test ends it.
  *' devapp-hold '*) [ "$scenario" = no-tunnel ] && exit 255; echo held; exec sleep 30 ;;
  *' devapp-stop '*) [ "$scenario" = failed-cleanup ] && exit 255; rm -f "$FAKE_DIR/copy-$host"; echo "stopped the Harness copy on port ${'$'}{cmd##* }" ;;
  *) exec bash -c "$cmd" ;;
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

/**
 * `config` is the test Mac's entry. With `pc`, the Windows PC's Linux space is the file's top-level machine, as it is
 * on James's Mac, and the test Mac follows it in `moreMachines`.
 */
function setUp(config: Record<string, unknown> | null = {}, { pc = false, liveTestFiles = true } = {}) {
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
  // What a checkout needs for a live-test copy; a branch cut before these landed has neither.
  if (liveTestFiles) {
    for (const file of ['scripts/remote-checks/live-test-copy.js', 'src/main/app/live-test-context.ts']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '// stand-in\n');
    }
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  writeFileSync(join(root, 'a.ts'), 'changed, not committed\n');
  const ssh = join(fake, 'ssh');
  writeFileSync(ssh, FAKE_SSH);
  chmodSync(ssh, 0o755);
  if (config) {
    const mac = { host: 'far', label: 'the test Mac', ssh, platform: 'darwin', ...config };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(pc
      ? { host: 'pc', label: 'the Windows PC', ssh, nodeName: 'windows-pc', useThisMac: false, moreMachines: [mac] }
      : { useThisMac: false, ...mac }));
  }
  return { base, root, fake, dir };
}

type Setup = ReturnType<typeof setUp>;

async function run(setup: Setup, argv: string[], {
  scenario = 'pass', cwd = setup.root, answers = true, here = QUIET, localLoad = () => here,
  onWrite = (_text: string) => { /* optional scheduler observation */ },
} = {}) {
  writeFileSync(join(setup.fake, 'scenario'), scenario);
  let output = '';
  const code = await main(argv, {
    cwd,
    env: { ...process.env, AIO_REMOTE_CHECKS_DIR: setup.dir, AIO_DEVAPP_RECHECK_MS: '20' },
    write: (text) => { output += text; onWrite(text); },
    commonDir: join(setup.root, '.git'),
    answers: async () => answers,
    localLoad,
  });
  const sshLog = existsSync(join(setup.fake, 'ssh.log')) ? readFileSync(join(setup.fake, 'ssh.log'), 'utf8') : '';
  const stateDir = join(setup.dir, 'dev-apps');
  for (const name of existsSync(stateDir) ? readdirSync(stateDir).filter(file => file.endsWith('.json')) : []) {
    const { tunnelPid } = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as { tunnelPid?: number };
    if (tunnelPid) tunnels.add(tunnelPid);
  }
  return { code, output, sshLog };
}

function setLoad(setup: Setup, host: string, load: Load, next?: Load) {
  writeFileSync(join(setup.fake, `load-${host}`), JSON.stringify(load));
  if (next) writeFileSync(join(setup.fake, `load-${host}.next`), JSON.stringify(next));
}

function setTools(setup: Setup, host: string, installed: string[] | string, next?: string[] | string) {
  const line = (value: string[] | string) => (typeof value === 'string' ? value : JSON.stringify({ installed: value }));
  writeFileSync(join(setup.fake, `tools-${host}`), line(installed));
  if (next) writeFileSync(join(setup.fake, `tools-${host}.next`), line(next));
}

function runLog(setup: Setup): Record<string, unknown>[] {
  const file = join(setup.dir, 'runs.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

describe('dev-app arguments', () => {
  it('accepts remote-only for start and rejects it as an option for other actions', () => {
    expect(parse(['start', '--port', '9444', '--data', '/tmp/aio-lt-owned', '--remote-only']).options)
      .toMatchObject({ remoteOnly: true });
    for (const action of ['stop', 'status', 'shell']) {
      expect(() => parse([action, '--port', '9444', '--remote-only'])).toThrow(/doesn't take --remote-only/);
    }
    expect(parse(['shell', '--port', '9444', '--', 'echo', '--remote-only']).options.command)
      .toEqual(['echo', '--remote-only']);
  });
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
    expect(parse(['start', '--port', '9877', '--data', '/tmp/aio-lt-owned', '--mac']).options).toMatchObject({ macOnly: true, mode: 'dev' });
    expect(() => parse(['stop', '--port', '9877', '--mac'])).toThrow();
  });
  it('takes the AI tools a start needs from a fixed list, once each, for start only', () => {
    const start = ['start', '--port', '9877', '--data', '/tmp/aio-lt-owned'];
    expect(parse(start).options.needs).toEqual([]);
    expect(parse([...start, '--needs', 'codex,copilot,codex']).options.needs).toEqual(['codex', 'copilot']);
    expect(() => parse([...start, '--needs', 'codex,notatool'])).toThrow(/not notatool/);
    expect(() => parse([...start, '--needs', 'codex;rm'])).toThrow(/comma-separated list/);
    expect(() => parse([...start, '--needs'])).toThrow(/comma-separated list/);
    expect(() => parse([...start, '--needs', ''])).toThrow(/comma-separated list/);
    expect(() => parse(['stop', '--port', '9877', '--needs', 'codex'])).toThrow(/doesn't take --needs/);
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
    // The test Mac has no paired name in the config, so its host names it.
    const setup = setUp({ host: 'ct-test-mac' });
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
  describe('when the check needs AI tools installed', () => {
    const NEEDS = ['--needs', 'codex,copilot'];
    const argv = async () => ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec', ...NEEDS];

    it('starts on a computer that has them, naming what the copy needed in its receipt', async () => {
      const setup = setUp({ host: 'ct-test-mac' });
      setTools(setup, 'ct-test-mac', ['claude', 'codex', 'copilot']);
      const { code, output, sshLog } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(sshLog).toMatch(/^ct-test-mac: .* devapp-providers$/m);
      const line = output.split('\n').find(row => row.startsWith('AIO_DEV_APP_RECEIPT '));
      expect(JSON.parse(line!.slice('AIO_DEV_APP_RECEIPT '.length))).toMatchObject({ computer: 'ct-test-mac', needs: ['codex', 'copilot'] });
    }, LIMIT);

    it('passes a computer that lacks one, though it comes first in the order', async () => {
      const setup = setUp({}, { pc: true });
      setTools(setup, 'far', ['claude', 'codex']);
      setTools(setup, 'pc', ['codex', 'copilot']);
      const { code, output, sshLog } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(output).toContain('Harness is running on the Windows PC');
      expect(sshLog).not.toMatch(/^far: .* devapp-start /m);
    }, LIMIT);

    it('sends nothing and exits 3 naming what each computer lacks when none has them all', async () => {
      const setup = setUp({}, { pc: true });
      setTools(setup, 'far', ['claude']);
      setTools(setup, 'pc', ['codex']);
      const { code, output, sshLog } = await run(setup, await argv());
      expect(code).toBe(3);
      expect(output).toContain('no computer has codex and copilot installed: the test Mac lacks codex and copilot; the Windows PC lacks copilot.');
      expect(output).toContain('Nothing was sent.');
      expect(output).toContain('only checks installation');
      expect(sshLog).not.toMatch(/ (receive|devapp-load|devapp-start|devapp-hold) /);
      expect(existsSync(join(setup.dir, 'dev-apps'))).toBe(false);
      expect(runLog(setup)).toEqual([expect.objectContaining({ kind: 'dev-app', ranOn: 'none', exitCode: 3 })]);
    }, LIMIT);

    it('never falls back to this Mac, even when it is free and the computer that has them is busy', async () => {
      const setup = setUp();
      setTools(setup, 'far', ['codex', 'copilot']);
      setLoad(setup, 'far', LOADED, QUIET);
      const { code, output } = await run(setup, await argv(), { here: QUIET });
      expect(code).toBe(0);
      expect(output).toContain('waiting for a remote computer that can run this copy (the test Mac is busy');
      expect(output).toContain('Harness is running on the test Mac');
    }, LIMIT);

    it('waits for a computer that could not be asked rather than counting it out', async () => {
      const setup = setUp();
      setTools(setup, 'far', 'not a result line', ['codex', 'copilot']);
      const { code, output } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(output).toContain('the test Mac could not be asked what is installed');
      expect(output).toContain('Harness is running on the test Mac');
    }, LIMIT);

    it('treats a failed ask as unknown, not as missing', async () => {
      const setup = setUp();
      setTools(setup, 'far', ['codex', 'copilot']);
      writeFileSync(join(setup.fake, 'ask-fails-far'), '');
      const { code, output } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(output).toContain('the test Mac could not be asked what is installed');
    }, LIMIT);

    it('stops this profile\'s older copy on a computer that lacks them, before starting where they are', async () => {
      const setup = setUp({}, { pc: true });
      setTools(setup, 'far', ['codex', 'copilot']);
      writeFileSync(join(setup.fake, 'copy-pc'), JSON.stringify({ tree: 'old', data: '/tmp/aio-lt-spec', mode: 'dev' }));
      const { code, sshLog } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(sshLog).toMatch(/^pc: .* devapp-stop \d+$/m);
      expect(existsSync(join(setup.fake, 'copy-pc'))).toBe(false);
    }, LIMIT);

    it('leaves a copy on a computer that could not be asked running', async () => {
      const setup = setUp({}, { pc: true });
      setTools(setup, 'far', ['codex', 'copilot']);
      setTools(setup, 'pc', 'not a result line');
      writeFileSync(join(setup.fake, 'copy-pc'), JSON.stringify({ tree: 'old', data: '/tmp/aio-lt-spec', mode: 'dev' }));
      const { code, sshLog } = await run(setup, await argv());
      expect(code).toBe(0);
      expect(sshLog).not.toMatch(/ devapp-stop /);
      expect(existsSync(join(setup.fake, 'copy-pc'))).toBe(true);
    }, LIMIT);

    it('asks nothing about tools when none are needed', async () => {
      const setup = setUp();
      const { code, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
      expect(code).toBe(0);
      expect(sshLog).not.toContain('devapp-providers');
    }, LIMIT);
  });
  it.each([
    ['scripts/remote-checks/live-test-copy.js', []],
    ['src/main/app/live-test-context.ts', []],
    ['scripts/remote-checks/live-test-copy.js', ['--checked-tree']],
  ])('refuses a checkout without %s before anything is sent (%j)', async (missing, flags) => {
    const setup = setUp();
    git(setup.root, 'rm', '-q', missing);
    git(setup.root, 'commit', '-qm', 'branch cut before the live-test files landed');
    const checked = flags.length ? ['--checked-tree', git(setup.root, 'rev-parse', 'HEAD^{tree}')] : [];
    const result = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-stale', ...checked]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`no ${missing}`);
    expect(result.output).toContain('merge main');
    expect(result.sshLog).toBe('');
    expect(existsSync(join(setup.fake, 'start-data'))).toBe(false);
  }, LIMIT);

  it('refuses a checkout with neither live-test file, naming the first one', async () => {
    const setup = setUp(undefined, { liveTestFiles: false });
    const result = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-stale']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('no scripts/remote-checks/live-test-copy.js');
    expect(result.sshLog).toBe('');
  }, LIMIT);

  it('sends the files on disk, starts the copy there with the data folder as data, and connects the port here', async () => {
    const setup = setUp();
    const port = await freePort();
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec']);
    expect(output).toContain('[dev app] building on far');
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

  it('tries the test Mac before the PC, though the PC comes first in the config', async () => {
    const setup = setUp({}, { pc: true });
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the test Mac');
    expect(sshLog).not.toMatch(/^pc: .* devapp-start /m);
  }, LIMIT);

  it('starts it on the PC when the test Mac is busy, naming the PC in the receipt', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED);
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the Windows PC');
    expect(sshLog).not.toMatch(/^far: .* devapp-start /m);
    const line = output.split('\n').find(row => row.startsWith('AIO_DEV_APP_RECEIPT '))!;
    expect(JSON.parse(line.slice('AIO_DEV_APP_RECEIPT '.length))).toMatchObject({ computer: 'windows-pc', mode: 'dev' });
    expect(runLog(setup)).toEqual([expect.objectContaining({ kind: 'dev-app', ranOn: 'pc', exitCode: 0 })]);
  }, LIMIT);

  it('moves on to the PC when the test Mac turns the copy away for having as many as it takes', async () => {
    const setup = setUp({}, { pc: true });
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'busy-far' });
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the Windows PC');
  }, LIMIT);

  it('never sends a signed package to the PC or this Mac: it waits for the test Mac', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED, QUIET);
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec', '--packaged']);
    expect(output).toContain('waiting for a remote computer that can run this copy (the test Mac is busy (load 40 on 10 processors))');
    expect(output).not.toContain('Start Harness on this Mac');
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the test Mac');
    expect(sshLog).not.toMatch(/^pc: .* devapp-start /m);
  }, LIMIT);

  it('leaves a busy computer\'s copy in the other mode for devapp-start to refuse, never stopping it', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED);
    setLoad(setup, 'pc', { load: 60, cores: 32, copies: 1, limit: 3 });
    writeFileSync(join(setup.fake, 'copy-pc'), '{"tree":"x","data":"/tmp/aio-lt-spec","mode":"packaged"}');
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'taken' });
    expect(code).toBe(1);
    expect(output).toContain('for another data folder, so it was left alone');
    expect(sshLog).toMatch(/^pc: .* devapp-start /m);
    expect(sshLog).not.toMatch(/ devapp-stop /m);
  }, LIMIT);

  it('stops its earlier copy on a now-paused computer, so its tunnel here closes, before starting elsewhere', async () => {
    const setup = setUp({}, { pc: true });
    const port = await freePort();
    const argv = ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'];
    expect((await run(setup, argv)).code).toBe(0);
    // A stand-in for the tunnel: it holds the port here for as long as the far copy lives, as a real one does.
    for (const pid of tunnels) process.kill(pid);
    tunnels.clear();
    const copyFile = join(setup.fake, 'copy-far');
    const holder = spawn(process.execPath, ['-e', `const fs = require('fs');
      require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('held'));
      setInterval(() => { if (!fs.existsSync(${JSON.stringify(copyFile)})) process.exit(0); }, 100);`]);
    await new Promise(resolve => holder.stdout!.once('data', resolve));
    const record = join(setup.dir, 'dev-apps', `${port}.json`);
    writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), tunnelPid: holder.pid }));
    const config = join(setup.dir, 'config.json');
    const paused = JSON.parse(readFileSync(config, 'utf8'));
    paused.moreMachines[0].paused = true;
    writeFileSync(config, JSON.stringify(paused));
    writeFileSync(join(setup.root, 'a.ts'), 'changed again\n');
    const { code, output, sshLog } = await run(setup, argv);
    expect(output).toContain("stopping this test's older copy on the test Mac, before starting elsewhere");
    expect(sshLog).toMatch(new RegExp(`^far: .* devapp-stop ${port}$`, 'm'));
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the Windows PC');
    expect(holder.exitCode).toBe(0);
  }, LIMIT);

  it('never signals a process a stale record names', async () => {
    const setup = setUp(null);
    const port = await freePort();
    const other = spawn('sleep', ['300']);
    mkdirSync(join(setup.dir, 'dev-apps'), { recursive: true });
    writeFileSync(join(setup.dir, 'dev-apps', `${port}.json`), JSON.stringify({ host: 'far', port, root: setup.root, tunnelPid: other.pid }));
    try {
      expect((await run(setup, ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'])).code).toBe(STAY_HERE);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally {
      other.kill();
    }
  }, LIMIT);

  it('stops a moved copy where it now is, though the record here still names its old computer', async () => {
    const setup = setUp({}, { pc: true });
    const port = await freePort();
    const argv = ['start', '--port', String(port), '--data', '/tmp/aio-lt-spec'];
    expect((await run(setup, argv)).code).toBe(0);
    for (const pid of tunnels) process.kill(pid);
    tunnels.clear();
    writeFileSync(join(setup.root, 'a.ts'), 'changed again\n');
    setLoad(setup, 'far', LOADED);
    expect((await run(setup, argv, { scenario: 'lost' })).code).toBe(1);
    expect(JSON.parse(readFileSync(join(setup.dir, 'dev-apps', `${port}.json`), 'utf8'))).toMatchObject({ host: 'far' });
    const { code, sshLog } = await run(setup, ['stop', '--port', String(port)]);
    expect(code).toBe(0);
    expect(sshLog.split('\n').filter(line => / devapp-stop /.test(line)).at(-1)).toMatch(/^pc: /);
    expect(existsSync(join(setup.fake, 'copy-pc'))).toBe(false);
  }, LIMIT);

  it('skips the PC for a check that needs a signed-in AI tool', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED);
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec', '--mac']);
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('the test Mac is busy (load 40 on 10 processors). Start Harness on this Mac instead');
    expect(sshLog).not.toMatch(/^pc: .* devapp-start /m);
  }, LIMIT);

  it('uses this Mac when the test Mac and the PC are both busy and this Mac is not', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED);
    setLoad(setup, 'pc', { load: 2, cores: 32, copies: 3, limit: 3 });
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('the Windows PC already runs as many Harness copies as it takes (3)');
    expect(output).toContain('Start Harness on this Mac instead');
    expect(runLog(setup)).toEqual([expect.objectContaining({ kind: 'dev-app', ranOn: 'none', exitCode: STAY_HERE })]);
  }, LIMIT);

  it('keeps looking while every computer is busy, and starts the copy once one is free', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED, QUIET);
    setLoad(setup, 'pc', { load: 60, cores: 32, copies: 0, limit: 3 });
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { here: LOADED });
    expect(output).toContain('every computer is busy (the test Mac is busy (load 40 on 10 processors); the Windows PC is busy '
      + '(load 60 on 32 processors); this Mac is busy (load 40 on 10 processors))');
    expect(output).toContain('Leave this running');
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the test Mac');
    expect(runLog(setup)).toEqual([expect.objectContaining({ ranOn: 'far', exitCode: 0, waitedMs: 20 })]);
  }, LIMIT);

  it.each(['', '--mac', '--packaged'])('remote-only waits for a suitable remote without reading local load (%s)', async (mode) => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED, QUIET);
    // For Mac-only launches the PC is free but ineligible. For dev launches both remotes are initially busy.
    if (!mode) setLoad(setup, 'pc', { load: 2, cores: 32, copies: 3, limit: 3 });
    const { code, output, sshLog } = await run(setup, [
      'start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec', '--remote-only', ...(mode ? [mode] : []),
    ], { localLoad: () => { throw new Error('remote-only must not inspect this Mac'); } });
    expect(code).toBe(0);
    expect(output).toContain('waiting for a remote computer that can run this copy');
    expect(output).toContain('the test Mac is busy');
    expect(output).not.toContain('Start Harness on this Mac');
    expect(output).toContain('Harness is running on the test Mac');
    expect(sshLog.match(/^far: .* devapp-load /gm)).toHaveLength(2);
    if (mode) expect(sshLog).not.toMatch(/^pc: .* devapp-start /m);
    expect(runLog(setup)).toEqual([expect.objectContaining({ ranOn: 'far', exitCode: 0, waitedMs: 20 })]);
  }, LIMIT);

  it.each(['unreachable', 'paused', 'not-configured'])('remote-only retries when a remote is %s', async (condition) => {
    const setup = setUp(condition === 'not-configured' ? null : { paused: condition === 'paused' });
    const { code, output } = await run(setup, [
      'start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec', '--remote-only',
    ], {
      scenario: condition === 'unreachable' ? 'unreachable' : 'pass',
      localLoad: () => { throw new Error('remote-only must not inspect this Mac'); },
      onWrite: text => {
        if (!text.includes('Looking again')) return;
        // Restore availability only after the scheduler has reported its actual first-pass reason.
        writeFileSync(join(setup.fake, 'scenario'), 'pass');
        writeFileSync(join(setup.dir, 'config.json'), JSON.stringify({
          host: 'far', label: 'the test Mac', platform: 'darwin', ssh: join(setup.fake, 'ssh'),
        }));
      },
    });
    expect(code).toBe(0);
    expect(output).not.toContain('every computer is busy');
    expect(output).toContain(condition === 'unreachable' ? 'the test Mac could not be reached'
      : condition === 'paused' ? 'no unpaused remote computer supports this launch' : 'no test machines are set up');
    expect(runLog(setup)).toEqual([expect.objectContaining({ ranOn: 'far', exitCode: 0, waitedMs: 20 })]);
  }, LIMIT);

  it('joins its copy on a busy computer later in the order when a cut-off start is run again with the same files', async () => {
    const setup = setUp({}, { pc: true });
    const argv = ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'];
    setLoad(setup, 'far', LOADED);
    expect((await run(setup, argv, { scenario: 'lost' })).code).toBe(1);
    setLoad(setup, 'far', QUIET);
    setLoad(setup, 'pc', { load: 60, cores: 32, copies: 1, limit: 3 });
    const { code, output, sshLog } = await run(setup, argv);
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the Windows PC');
    expect(sshLog).not.toMatch(/^far: .* devapp-start /m);
  }, LIMIT);

  it('moves a changed copy off a busy computer, stopping the old one there, rather than building there', async () => {
    const setup = setUp({}, { pc: true });
    const argv = ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'];
    setLoad(setup, 'far', LOADED);
    expect((await run(setup, argv, { scenario: 'lost' })).code).toBe(1);
    writeFileSync(join(setup.root, 'a.ts'), 'changed again\n');
    setLoad(setup, 'far', QUIET);
    setLoad(setup, 'pc', { load: 60, cores: 32, copies: 1, limit: 3 });
    const { code, output, sshLog } = await run(setup, argv);
    expect(output).toContain("stopping this test's older copy on the Windows PC, which is busy");
    expect(sshLog).toMatch(/^pc: .* devapp-stop /m);
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the test Mac');
  }, LIMIT);

  it('reads the config again each time round, so a computer paused during the wait is passed by', async () => {
    const setup = setUp({}, { pc: true });
    setLoad(setup, 'far', LOADED, QUIET);
    setLoad(setup, 'pc', { load: 60, cores: 32, copies: 0, limit: 3 }, QUIET);
    const config = join(setup.dir, 'config.json');
    const paused = JSON.parse(readFileSync(config, 'utf8'));
    paused.moreMachines[0].paused = true;
    writeFileSync(join(setup.dir, 'paused.json'), JSON.stringify(paused));
    // Both are busy at the first look and quiet at the second; the test Mac is paused in between.
    writeFileSync(join(setup.fake, 'after-look-pc'), `cp '${join(setup.dir, 'paused.json')}' '${config}'\n`);
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { here: LOADED });
    expect(output).toContain('every computer is busy');
    expect(code).toBe(0);
    expect(output).toContain('Harness is running on the Windows PC');
    expect(sshLog.match(/^far: .* devapp-load /gm)).toHaveLength(1);
  }, LIMIT);

  it('says to start it here when the test Mac is out of reach', async () => {
    // With "Use this Mac when the others are busy or away" off, as on James's Mac: live-test copies may still come here.
    const setup = setUp();
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'unreachable' });
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('the test Mac could not be reached. Start Harness on this Mac instead');
  }, LIMIT);

  it('passes a paused test Mac by without asking anything of it', async () => {
    const setup = setUp({ paused: true });
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('Start Harness on this Mac instead');
    expect(sshLog).toBe('');
  });

  it('starts it here when no test machines are set up', async () => {
    const setup = setUp(null);
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec']);
    expect(code).toBe(STAY_HERE);
    expect(output).toContain('no test machines are set up');
  });

  it('fails, saying why, when the copy does not build', async () => {
    const setup = setUp();
    const { code, output, sshLog } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'failed' });
    expect(code).toBe(1);
    expect(output).toContain('Harness did not start on the test Mac: npm run build:main failed');
    expect(sshLog).toContain(' devapp-stop ');
  }, LIMIT);

  it('reports cleanup that could not be confirmed after a failed build', async () => {
    const setup = setUp();
    const { code, output } = await run(setup, ['start', '--port', String(await freePort()), '--data', '/tmp/aio-lt-spec'], { scenario: 'failed-cleanup' });
    expect(code).toBe(1);
    expect(output).toContain('cleanup of the failed copy could not be confirmed');
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

describe('dev-app stop and shell without a record here', () => {
  it('asks each computer which has the copy, and stops it there', async () => {
    const setup = setUp({}, { pc: true });
    writeFileSync(join(setup.fake, 'copy-pc'), '{"tree":"x","data":"/tmp/aio-lt-spec","mode":"dev"}');
    const port = await freePort();
    const { code, sshLog } = await run(setup, ['stop', '--port', String(port)]);
    expect(code).toBe(0);
    expect(sshLog).toMatch(new RegExp(`^pc: .* devapp-stop ${port}$`, 'm'));
    expect(sshLog).not.toMatch(/^far: .* devapp-stop /m);
    writeFileSync(join(setup.fake, 'copy-pc'), '{"tree":"x","data":"/tmp/aio-lt-spec","mode":"dev"}');
    expect((await run(setup, ['shell', '--port', String(port), 'true'])).sshLog).toMatch(/^pc: .* devapp-shell /m);
  }, LIMIT);

  it('says there was nothing to stop when every computer answers without the copy', async () => {
    const setup = setUp({}, { pc: true });
    const { code, output } = await run(setup, ['stop', '--port', String(await freePort())]);
    expect(code).toBe(0);
    expect(output).toContain('so there was nothing to stop');
  }, LIMIT);

  it('fails, naming it, when a computer that might have the copy cannot be reached', async () => {
    const setup = setUp({}, { pc: true });
    const { code, output } = await run(setup, ['stop', '--port', String(await freePort())], { scenario: 'unreachable-pc' });
    expect(code).toBe(1);
    expect(output).toContain('the Windows PC could not be reached to look for the copy');
    expect(output).not.toContain('nothing to stop');
  }, LIMIT);
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

  it('says how busy the machine is: its 5-minute load, processors and live copies', () => {
    const far = farMachine();
    expect(far(['devapp-load']).status).toBe(4);
    const line = far(['devapp-load', '9444']).stdout.trim();
    expect(line.startsWith('AIO_REMOTE_RESULT ')).toBe(true);
    const load = JSON.parse(line.slice('AIO_REMOTE_RESULT '.length)) as Load;
    expect(load.load).toBeGreaterThanOrEqual(0);
    expect(load.cores).toBeGreaterThan(0);
    expect(load).toMatchObject({ copies: 0, limit: 3, copy: null });
  });

  describe('devapp-providers', () => {
    const TOOLS = ['claude', 'codex', 'copilot', 'gemini', 'agy', 'opencode', 'cursor-agent', 'grok'];
    const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const stub = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, name), 0o755);
    };
    /** A login shell that starts with only the system's folders on its PATH, whatever the machine running this has. */
    function farWithHome(homeName: string) {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'dev-app-far-')));
      temps.push(base);
      copyFileSync(join(__dirname, 'remote-run.sh'), join(base, 'remote-run.sh'));
      const home = join(base, homeName);
      mkdirSync(home);
      const loginShell = join(base, 'login-shell');
      // Called as `<shell> -l -c <command> <argument 0>`, the way the script calls the account's shell.
      writeFileSync(loginShell, '#!/bin/bash\n[ "$1 $2" = "-l -c" ] || exit 64\nexec env -i PATH=/usr/bin:/bin HOME="$HOME" /bin/bash -c "$3" "$4"\n');
      chmodSync(loginShell, 0o755);
      const ask = () => {
        const ran = spawnSync('bash', [join(base, 'remote-run.sh'), 'devapp-providers'], { encoding: 'utf8', env: { ...process.env, HOME: home, SHELL: loginShell } });
        expect(ran.status).toBe(0);
        const line = ran.stdout.trim();
        expect(line.startsWith('AIO_REMOTE_RESULT ')).toBe(true);
        return (JSON.parse(line.slice('AIO_REMOTE_RESULT '.length)) as { installed: string[] }).installed;
      };
      /** What is on the folders this machine always has, which the test can't empty. */
      const alreadyThere = TOOLS.filter(name => SYSTEM_DIRS.some(dir => existsSync(join(dir, name))));
      return { home, ask, alreadyThere };
    }

    it('names the tools found on the login shell\'s PATH and the usual install folders, in a fixed order', () => {
      const far = farWithHome('home');
      stub(join(far.home, '.local/bin'), 'codex');
      stub(join(far.home, '.volta/bin'), 'grok');
      stub(join(far.home, '.nvm/versions/node/v24.0.0/bin'), 'copilot');
      const expected = TOOLS.filter(name => ['codex', 'grok', 'copilot'].includes(name) || far.alreadyThere.includes(name));
      expect(far.ask()).toEqual(expected);
    });

    it('does not name a tool that is not there, or a file that is not executable', () => {
      const far = farWithHome('home');
      mkdirSync(join(far.home, '.local/bin'), { recursive: true });
      writeFileSync(join(far.home, '.local/bin/gemini'), 'not executable\n');
      expect(far.ask()).toEqual(far.alreadyThere);
    });

    it('leaves out an install folder whose name could break the script written around it', () => {
      const far = farWithHome('home with space');
      stub(join(far.home, '.local/bin'), 'opencode');
      expect(far.ask()).toEqual(far.alreadyThere);
    });
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
