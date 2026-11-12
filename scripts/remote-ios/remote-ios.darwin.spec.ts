import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * aio-ios end to end, with the real remote-ios.sh. "ssh" runs each command on this Mac in a folder standing in for
 * the test Mac's home, where xcrun, xcodebuild and maestro are stand-ins that say what they were asked. It needs what
 * a Mac has: perl, lsof, shasum and PlistBuddy, so it is in scripts/remote-checks/mac-only.js. The redirect's own tests
 * are here too, for the same reason.
 */

interface Main {
  main(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; home: string; apps: object[]; write: (text: string) => void }): Promise<number>;
}
const require = createRequire(import.meta.url);
const { main } = require('./aio-ios.js') as Main;

const UDID = '0000AAAA-1111-2222-3333-444455556666';

const FAKE_SSH = `#!/bin/bash
cmd="\${!#}"
echo "$cmd" >> "$FAKE_DIR/ssh.log"
[ -f "$FAKE_DIR/unreachable" ] && exit 255
cd "$FAKE_DIR/home" || exit 255
export HOME="$FAKE_DIR/home" PATH="$FAKE_DIR/bin:$PATH" AIO_IOS_MAESTRO="$FAKE_DIR/bin/maestro"
export AIO_IOS_SLOT_WAIT_SECONDS=4 AIO_IOS_IDLE_SECONDS=30
exec bash -c "$cmd"
`;

const FAKE_XCRUN = `#!/bin/bash
echo "xcrun $*" >> "$FAKE_DIR/xcrun.log"
[ "$1" = simctl ] || exit 1
shift
case "$1" in
  list)
    case "$2" in
      devices) [ -f "$FAKE_DIR/sim" ] && echo "    $(cat "$FAKE_DIR/sim") (${UDID}) (Booted) " ;;
      devicetypes) printf '%s\\n' 'iPhone 18 Pro (com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)' 'iPhone 9 Pro (com.apple.CoreSimulator.SimDeviceType.iPhone-9-Pro)' ;;
      runtimes) echo 'iOS 27.2 (27.2 - 24B8117) - com.apple.CoreSimulator.SimRuntime.iOS-27-2' ;;
    esac
    ;;
  create) echo "$2" > "$FAKE_DIR/sim"; echo "${UDID}" ;;
  io) printf 'png' > "\${!#}"; echo "Wrote screenshot" ;;
  spawn) echo 'app log line'; exec sleep 600 ;;
  push) [ -f "\${!#}" ] && cp "\${!#}" "$FAKE_DIR/pushed" ;;
esac
exit 0
`;

const FAKE_XCODEBUILD = `#!/bin/bash
echo "xcodebuild $*" >> "$FAKE_DIR/xcodebuild.log"
[ "$1" = -version ] && { echo 'Xcode 27.2'; exit 0; }
behaviour="$(cat "$FAKE_DIR/xcodebuild-behaviour" 2>/dev/null)"
dd=''
while [ $# -gt 0 ]; do [ "$1" = -derivedDataPath ] && dd="$2"; shift; done
echo compiling
if [ "$behaviour" = fail ]; then echo '/x/App.swift:1:1: error: boom'; exit 65; fi
if [ "$behaviour" = leave-child ]; then
  perl -e 'use POSIX; setsid(); exec "sleep", "300"' &
  echo $! > "$FAKE_DIR/child-pid"
fi
app="$dd/Build/Products/Debug-iphonesimulator/App.app"
mkdir -p "$app"
rm -f "$app/Info.plist"
/usr/libexec/PlistBuddy -c 'Add CFBundleIdentifier string com.example.shop' -c 'Add CFBundleExecutable string Shop' "$app/Info.plist" >/dev/null
`;

const FAKE_MAESTRO = `#!/bin/bash
echo "maestro $*" >> "$FAKE_DIR/maestro.log"
while [ $# -gt 0 ]; do [ "$1" = --output ] && printf '<testsuites/>' > "$2"; shift; done
echo 'flow passed'
`;

const shop = {
  id: 'shop', repository: 'work/shop', folder: '.', installInputs: ['package.json'],
  install: 'echo installed', web: 'echo web-built', sync: 'echo synced',
  xcode: { project: 'ios/App/App.xcodeproj' }, scheme: 'App', bundleId: 'com.example.shop',
};

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A test Mac standing in, and this Mac's home with the shop app's repository in it. */
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-ios-darwin-')));
  temps.push(dir);
  for (const sub of ['bin', 'home', 'checks', 'mac-home/work/shop']) mkdirSync(join(dir, sub), { recursive: true });
  const write = (name: string, text: string) => writeFileSync(join(dir, 'bin', name), text, { mode: 0o755 });
  write('ssh', FAKE_SSH);
  write('xcrun', FAKE_XCRUN);
  write('xcodebuild', FAKE_XCODEBUILD);
  write('maestro', FAKE_MAESTRO);
  writeFileSync(join(dir, 'checks', 'config.json'), JSON.stringify({
    host: 'pc', label: 'the PC',
    moreMachines: [{ host: 'fake-mac', label: 'the test Mac', platform: 'darwin', ssh: join(dir, 'bin', 'ssh') }],
  }));
  const repo = join(dir, 'mac-home', 'work', 'shop');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'package.json'), '{}');
  mkdirSync(join(repo, 'flows'));
  writeFileSync(join(repo, 'flows', 'login.yaml'), 'appId: ${APP_ID}\n---\n- launchApp\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'first']);
  process.env['FAKE_DIR'] = dir;
  const env = {
    ...process.env, FAKE_DIR: dir, AIO_REMOTE_CHECKS_DIR: join(dir, 'checks'), AIO_REMOTE_IOS_DIR: join(dir, 'ios-state'),
    AI_ORCHESTRATOR_INSTANCE_ID: 'session-a',
  };
  const remote = join(dir, 'home', 'remote-ios');
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  const aio = async (argv: string[], options: { cwd?: string; session?: string } = {}) => {
    let output = '';
    const code = await main(argv, {
      cwd: options.cwd ?? repo, env: { ...env, AI_ORCHESTRATOR_INSTANCE_ID: options.session ?? 'session-a' },
      home: join(dir, 'mac-home'), apps: [shop], write: (text) => { output += text; },
    });
    return { code, output };
  };
  return { dir, repo, remote, env, read, aio };
}

const runDirs = (repo: string) => readdirSync(join(repo, '_scratch', 'aio-ios')).filter(name => name !== '.gitignore');

describe.runIf(process.platform === 'darwin')('aio-ios with the real remote-ios.sh', () => {
  it('builds the files on disk, launches the app and brings the screenshot back', async () => {
    const { repo, remote, read, aio, env } = world();
    writeFileSync(join(repo, 'uncommitted.txt'), 'new');
    const { code, output } = await aio(['run']);
    expect(code, output).toBe(0);
    expect(output).toContain('[aio-ios] installing packages');
    expect(output).toContain('com.example.shop is running on the test Mac');
    expect(readFileSync(join(remote, 'apps', 'shop', 'checkout', 'uncommitted.txt'), 'utf8')).toBe('new');
    expect(read('xcodebuild.log')).toContain(`-project ./ios/App/App.xcodeproj -scheme App -configuration Debug -destination id=${UDID}`);
    expect(read('xcodebuild.log')).toContain('CODE_SIGNING_ALLOWED=NO build');
    expect(read('xcrun.log')).toContain(`simctl create aio-ios-slot-1 com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2`);
    expect(read('xcrun.log')).toContain(`simctl launch --terminate-running-process ${UDID} com.example.shop`);
    const [run] = runDirs(repo);
    expect(readFileSync(join(repo, '_scratch', 'aio-ios', run!, 'screenshot.png'), 'utf8')).toBe('png');
    // What comes back never shows in, or goes out with, the app's repository.
    expect(execFileSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' })).toBe('?? uncommitted.txt\n');
    const logged = readFileSync(join(env.AIO_REMOTE_CHECKS_DIR!, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(logged).toEqual([expect.objectContaining({ project: 'shop', kind: 'ios', action: 'run', ranOn: 'fake-mac', exitCode: 0 })]);
    expect(readdirSync(join(remote, 'jobs'))).toEqual([]);

    // The second build installs nothing again.
    const again = await aio(['build']);
    expect(again.code).toBe(0);
    expect(again.output).not.toContain('installing packages');

    // Another app the session ran earlier is taken off the simulator before this one goes on.
    writeFileSync(join(remote, 'slots', '1', 'apps'), 'com.example.shop\ncom.earlier.app\n');
    expect((await aio(['run'])).code).toBe(0);
    expect(read('xcrun.log')).toContain(`simctl uninstall ${UDID} com.earlier.app`);
    expect(read('xcrun.log')).not.toContain(`simctl uninstall ${UDID} com.example.shop`);
    expect(readFileSync(join(remote, 'slots', '1', 'apps'), 'utf8')).toBe('com.example.shop\n');
  }, 60_000);

  it('passes a failed build\'s exit code and errors back, with its full log', async () => {
    const { repo, aio, dir } = world();
    writeFileSync(join(dir, 'xcodebuild-behaviour'), 'fail');
    const { code, output } = await aio(['build']);
    expect(code).toBe(65);
    expect(output).toContain('/x/App.swift:1:1: error: boom');
    expect(output).toContain('FAILED at xcodebuild (exit 65)');
    const [run] = runDirs(repo);
    expect(readFileSync(join(repo, '_scratch', 'aio-ios', run!, 'xcodebuild.log'), 'utf8')).toContain('compiling');
  }, 60_000);

  it('runs simctl on the session\'s simulator, sending and copying back the files named', async () => {
    const { repo, aio, read } = world();
    expect((await aio(['build'])).code).toBe(0);
    writeFileSync(join(repo, 'payload.apns'), '{"aps":{}}');
    const pushed = await aio(['sim', 'push', 'booted', 'com.example.shop', 'payload.apns']);
    expect(pushed.code, pushed.output).toBe(0);
    expect(read('pushed')).toBe('{"aps":{}}');
    const shot = await aio(['sim', 'io', 'booted', 'screenshot', 'shots/now.png']);
    expect(shot.code, shot.output).toBe(0);
    expect(readFileSync(join(repo, 'shots', 'now.png'), 'utf8')).toBe('png');
    expect(read('xcrun.log')).toContain(`simctl io ${UDID} screenshot`);
    const refused = await aio(['sim', 'erase', 'booted']);
    expect(refused.code).toBe(2);
  }, 60_000);

  it('asks a session with no simulator there to start one first', async () => {
    const { aio } = world();
    const { code, output } = await aio(['sim', 'openurl', 'booted', 'https://x.test']);
    expect(code).toBe(1);
    expect(output).toContain('Start with: aio-ios run');
  }, 30_000);

  it('runs Maestro flows from the repository, and refuses flows outside it', async () => {
    const { repo, aio, read } = world();
    const { code, output } = await aio(['test', '--env', 'CORE_ACTION=Add a drink', 'flows/login.yaml']);
    expect(code, output).toBe(0);
    expect(read('maestro.log')).toContain(`--udid ${UDID} test -e APP_ID=com.example.shop -e CORE_ACTION=Add a drink --format JUNIT`);
    expect(read('maestro.log')).toMatch(/ flows\/login\.yaml\n$/);
    const [run] = runDirs(repo);
    expect(readFileSync(join(repo, '_scratch', 'aio-ios', run!, 'maestro-report.xml'), 'utf8')).toBe('<testsuites/>');
    expect((await aio(['test', '/etc/hosts'])).code).toBe(2);
  }, 60_000);

  it('refuses a repository that isn\'t listed without contacting the test Mac', async () => {
    const { dir, aio, read } = world();
    const other = join(dir, 'mac-home', 'work', 'other');
    mkdirSync(other, { recursive: true });
    execFileSync('git', ['init', '-q', other]);
    const { code, output } = await aio(['build'], { cwd: other });
    expect(code).toBe(2);
    expect(output).toContain("isn't in an app on the test Mac's list");
    expect(read('ssh.log')).toBe('');
  }, 30_000);

  it('says the test Mac is away, and remembers it so the redirect lets work run here', async () => {
    const { dir, aio, env } = world();
    writeFileSync(join(dir, 'unreachable'), '');
    const { code, output } = await aio(['build']);
    expect(code).toBe(75);
    expect(output).toContain('the test Mac could not be reached');
    expect(JSON.parse(readFileSync(join(env.AIO_REMOTE_IOS_DIR!, 'test-mac.json'), 'utf8'))).toMatchObject({ host: 'fake-mac', ok: false });
  }, 30_000);

  it('waits while another session holds the simulator, and takes it over once that session has gone quiet', async () => {
    const { remote, aio, read, env } = world();
    mkdirSync(join(remote, 'slots', '1'), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(remote, 'slots', '1', 'lease'), `session-b ${now}\n`);
    const busy = await aio(['build']);
    expect(busy.code).toBe(75);
    expect(busy.output).toContain('waiting for the iPhone simulator: another session is using it');
    expect(busy.output).toContain("the test Mac's simulator stayed busy with another session");
    // A busy simulator isn't the test Mac failing, so other sessions' commands keep going there.
    expect(existsSync(join(env.AIO_REMOTE_IOS_DIR!, 'test-mac.json'))).toBe(false);

    writeFileSync(join(remote, 'slots', '1', 'lease'), `session-b ${now - 120}\n`);
    writeFileSync(join(remote, 'slots', '1', 'apps'), 'com.other.app\n');
    const taken = await aio(['build']);
    expect(taken.code, taken.output).toBe(0);
    expect(read('xcrun.log')).toContain(`simctl uninstall ${UDID} com.other.app`);
    expect(readFileSync(join(remote, 'slots', '1', 'lease'), 'utf8')).toMatch(/^session-a /);
  }, 60_000);

  it('cleans up what a job leaves behind, and stop ends a running job and frees the simulator', async () => {
    const { dir, remote, aio, read } = world();
    writeFileSync(join(dir, 'xcodebuild-behaviour'), 'leave-child');
    expect((await aio(['run'])).code).toBe(0);
    const child = Number(read('child-pid').trim());
    expect(child).toBeGreaterThan(0);
    expect(() => process.kill(child, 0)).toThrow();

    const logs = aio(['logs', '--seconds', '600']);
    for (let tries = 0; tries < 100 && !read('xcrun.log').includes('spawn'); tries += 1) await new Promise(done => setTimeout(done, 100));
    const stopped = await aio(['stop']);
    expect(stopped.output).toMatch(/stopped job .*\nfreed simulator slot 1\n/);
    const ended = await logs;
    expect(ended.code).toBe(1);
    expect(ended.output).toContain('ended by aio-ios stop');
    expect(existsSync(join(remote, 'slots', '1', 'lease'))).toBe(false);
    expect(read('xcrun.log')).toContain(`simctl uninstall ${UDID} com.example.shop`);
    expect((await aio(['status'])).output).toContain('slot 1: free');
  }, 90_000);
});

/** A home folder of its own for each shim test. */
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-ios-shim-')));
  temps.push(dir);
  return dir;
}

// The redirect only ever runs on a Mac, and relies on its /bin/sh setting `_`: Linux's dash doesn't.
describe.runIf(process.platform === 'darwin')('shim.sh', () => {
  /** A PATH with the shim as xcrun first, then a real-looking xcrun that says what it got. */
  function shimmed(): { bin: string; path: string; home: string } {
    const home = temp();
    const bin = join(home, '.local', 'bin');
    const real = join(home, 'real');
    mkdirSync(bin, { recursive: true });
    mkdirSync(real);
    writeFileSync(join(bin, 'xcrun'), readFileSync(join(__dirname, 'shim.sh')), { mode: 0o755 });
    writeFileSync(join(real, 'xcrun'), '#!/bin/sh\necho "real xcrun $* decided=${AIO_IOS_DECIDED:-}"\n', { mode: 0o755 });
    return { bin, home, path: `${bin}:${real}:/usr/bin:/bin` };
  }
  /** As an agent's shell runs it: by name, found on PATH. */
  const run = (env: NodeJS.ProcessEnv, args: string[]) => spawnSync('/bin/sh', ['-c', 'xcrun "$@"', 'sh', ...args], { env, encoding: 'utf8' });
  /** As a program runs it: straight from Node, the way Capacitor's CLI or an MCP server would. */
  const runFromNode = (env: NodeJS.ProcessEnv, args: string[]) => spawnSync(join(env['HOME']!, '.local', 'bin', 'xcrun'), args, { env, encoding: 'utf8' });
  function withHelper(answer: number): NodeJS.ProcessEnv {
    const { path, home } = shimmed();
    mkdirSync(join(home, '.ai-orchestrator', 'remote-ios'), { recursive: true });
    writeFileSync(join(home, '.ai-orchestrator', 'remote-ios', 'redirect.js'), `console.error("use aio-ios"); process.exitCode = ${answer};`);
    return { PATH: `${path}:${process.execPath.replace(/\/node$/, '')}`, HOME: home, AI_ORCHESTRATOR_INSTANCE_ID: 's' };
  }

  it('runs the real tool unchanged outside a Harness session, and for anything but simctl inside one', () => {
    const { path, home } = shimmed();
    expect(run({ PATH: path, HOME: home }, ['simctl', 'list']).stdout).toBe('real xcrun simctl list decided=\n');
    expect(run({ PATH: path, HOME: home, AI_ORCHESTRATOR_INSTANCE_ID: 's' }, ['--find', 'clang']).stdout).toBe('real xcrun --find clang decided=\n');
  });

  it('asks the redirect inside a session: 64 stops, anything else runs the real tool and tells its children', () => {
    const env = withHelper(64);
    const helper = join(env['HOME']!, '.ai-orchestrator', 'remote-ios', 'redirect.js');
    const stopped = run(env, ['simctl', 'install', 'booted', 'A.app']);
    expect([stopped.status, stopped.stdout, stopped.stderr]).toEqual([64, '', 'use aio-ios\n']);
    writeFileSync(helper, 'process.exitCode = 0;');
    expect(run(env, ['simctl', 'list']).stdout).toBe('real xcrun simctl list decided=1\n');
    rmSync(helper);
    expect(run(env, ['simctl', 'list']).stdout).toBe('real xcrun simctl list decided=1\n');
  });

  it('lets tools that start Xcode themselves, Fastlane lanes and Xcode build steps through without asking', () => {
    const env = withHelper(64);
    expect(runFromNode(env, ['simctl', 'install', 'booted', 'A.app'])).toMatchObject({ status: 0, stdout: 'real xcrun simctl install booted A.app decided=\n', stderr: '' });
    expect(run({ ...env, FASTLANE_LANE_NAME: 'build' }, ['simctl', 'list']).stdout).toBe('real xcrun simctl list decided=\n');
    expect(run({ ...env, XCODE_VERSION_ACTUAL: '2720' }, ['simctl', 'list']).stdout).toBe('real xcrun simctl list decided=\n');
    expect(run(env, ['simctl', 'list']).status).toBe(64);
  });

  it('skips another copy of itself further along PATH', () => {
    const { path, home } = shimmed();
    const other = join(home, 'other-bin');
    mkdirSync(other);
    writeFileSync(join(other, 'xcrun'), readFileSync(join(__dirname, 'shim.sh')), { mode: 0o755 });
    expect(run({ PATH: `${join(home, '.local', 'bin')}:${other}:${path}`, HOME: home }, ['x']).stdout).toBe('real xcrun x decided=\n');
  });

  it('never finds itself, even through a second PATH entry for its own folder', () => {
    const { bin, path, home } = shimmed();
    expect(run({ PATH: `${bin}:${path}`, HOME: home }, ['x']).stdout).toBe('real xcrun x decided=\n');
    chmodSync(join(home, 'real', 'xcrun'), 0o644);
    // /usr/bin has the system's own xcrun, so it stays off this PATH.
    const missing = run({ PATH: `${bin}:${join(home, 'real')}:/bin`, HOME: home }, ['x']);
    expect([missing.status, missing.stderr]).toEqual([127, 'xcrun: command not found\n']);
  });
});
