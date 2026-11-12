import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** The parts of aio-ios that need no test Mac: which app a folder is, the redirect's choices, and setting it up. The
 * shim's own tests need a Mac's /bin/sh, so they are in remote-ios.darwin.spec.ts. */

interface App { id: string; repository: string; folder: string; matches?: string[] }
interface Machine { host: string; label: string; platform: string; paused: boolean; ssh?: string }
interface Decision { code: number; message: string | null; log: Record<string, unknown> | null }
type Found = { app: App; root: string } | { choices: string[] } | null;

const require = createRequire(import.meta.url);
const { APPS, findApp } = require('./apps.js') as {
  APPS: App[];
  findApp(cwd: string, options?: { appId?: string; home?: string; apps?: App[] }): Found;
};
const { SimArgsRefused, mapSimArgs } = require('./sim-args.js') as {
  SimArgsRefused: new (message: string) => Error;
  mapSimArgs(args: string[], cwd: string): { remoteArgs: string[]; inputs: { local: string; name: string }[]; outputs: { name: string; local: string }[] };
};
const { decide } = require('./redirect.js') as {
  decide(options: {
    tool: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; home?: string; apps?: App[];
    check?: (machine: Machine) => { ok: boolean; reason: string | null };
  }): Decision;
};
const { findTestMac, markUnusable, probe } = require('./test-mac.js') as {
  findTestMac(env: NodeJS.ProcessEnv): { machine?: Machine; reason?: string };
  markUnusable(machine: Machine, reason: string, options: { env: NodeJS.ProcessEnv; now?: number }): void;
  probe(machine: Machine, options: { env: NodeJS.ProcessEnv; now?: number; run?: (...args: unknown[]) => { status: number } }): { ok: boolean; reason: string | null };
};
const { main, parse, recipeText, sessionName } = require('./aio-ios.js') as {
  main(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; home: string; apps: App[]; write: (text: string) => void }): Promise<number>;
  parse(argv: string[]): { action: string; options: Record<string, unknown>; args: string[] };
  recipeText(app: object | null, options: { commit?: string; options: Record<string, unknown> }): string;
  sessionName(env: NodeJS.ProcessEnv): string;
};
const { install, remove } = require('./setup.js') as {
  install(options: { home: string; repo?: string }): string[];
  remove(options: { home: string }): string[];
};

const temps: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-ios-spec-')));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A home folder holding a git repository at `work/<name>`, with the given folders in it. */
function homeWithRepo(name: string, folders: string[] = []): { home: string; repo: string } {
  const home = temp();
  const repo = join(home, 'work', name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  for (const folder of folders) mkdirSync(join(repo, folder), { recursive: true });
  return { home, repo };
}

const shop: App = { id: 'shop', repository: 'work/shop', folder: '.' };
const brandA: App = { id: 'brand-a', repository: 'work/brands', folder: 'frontend', matches: ['frontend/ios'] };
const brandB: App = { id: 'brand-b', repository: 'work/brands', folder: 'frontend', matches: ['frontend/ios-b'] };
const apps = [shop, brandA, brandB];

describe('findApp', () => {
  it('finds a listed repository by its real git folder, from anywhere inside it', () => {
    const { home, repo } = homeWithRepo('shop', ['ios/App']);
    expect(findApp(join(repo, 'ios/App'), { home, apps })).toEqual({ app: shop, root: repo });
  });

  it('knows nothing of a repository that is not listed, or a copy elsewhere with the same name', () => {
    const { home, repo } = homeWithRepo('other');
    expect(findApp(repo, { home, apps })).toBeNull();
    const elsewhere = homeWithRepo('shop');
    expect(findApp(elsewhere.repo, { home, apps })).toBeNull();
    expect(findApp(temp(), { home, apps })).toBeNull();
  });

  it('chooses between apps in one repository by folder, and asks when the folder does not say', () => {
    const { home, repo } = homeWithRepo('brands', ['frontend/ios/App', 'frontend/ios-b/App']);
    expect(findApp(join(repo, 'frontend/ios/App'), { home, apps })).toMatchObject({ app: brandA });
    expect(findApp(join(repo, 'frontend/ios-b'), { home, apps })).toMatchObject({ app: brandB });
    expect(findApp(join(repo, 'frontend'), { home, apps })).toEqual({ choices: ['brand-a', 'brand-b'] });
    expect(findApp(repo, { home, apps, appId: 'brand-b' })).toMatchObject({ app: brandB });
    expect(findApp(repo, { home, apps, appId: 'shop' })).toEqual({ choices: ['brand-a', 'brand-b'] });
  });

  it('never sends anything under work/ebrd, even if it were listed', async () => {
    const { home, repo } = homeWithRepo('ebrd/portal');
    expect(findApp(repo, { home, apps: [{ id: 'portal', repository: 'work/ebrd/portal', folder: '.' }] })).toBeNull();
    // Simulator commands need no app, so they check on their own, before anything is sent.
    let output = '';
    const code = await main(['sim', 'io', 'booted', 'screenshot', 'a.png'], { cwd: repo, env: {}, home, apps, write: (text) => { output += text; } });
    expect([code, output]).toEqual([2, 'aio-ios: nothing under ~/work/ebrd goes to the test Mac\n']);
  });

  it('lists nothing under work/ebrd, and only Capacitor apps with a scheme and bundle id', () => {
    expect(APPS.filter(app => app.repository.startsWith('work/ebrd'))).toEqual([]);
    for (const app of APPS as (App & { scheme?: string; bundleId?: string; xcode?: object })[]) {
      expect(app.scheme && app.bundleId && app.xcode, app.id).toBeTruthy();
    }
    expect(new Set(APPS.map(app => app.id)).size).toBe(APPS.length);
  });
});

describe('mapSimArgs', () => {
  it('swaps the device, whatever was named, for the session\'s simulator there', () => {
    expect(mapSimArgs(['openurl', 'booted', 'https://x.test/a b'], '/w').remoteArgs).toEqual(['openurl', '@DEVICE@', 'https://x.test/a b']);
    expect(mapSimArgs(['privacy', 'ABC-123', 'grant', 'photos', 'com.x'], '/w').remoteArgs)
      .toEqual(['privacy', '@DEVICE@', 'grant', 'photos', 'com.x']);
    expect(mapSimArgs(['launch', '--terminate-running-process', 'booted', 'com.x', '--flag'], '/w').remoteArgs)
      .toEqual(['launch', '--terminate-running-process', '@DEVICE@', 'com.x', '--flag']);
    expect(mapSimArgs(['list', 'devices'], '/w').remoteArgs).toEqual(['list', 'devices']);
  });

  it('marks files to make for copying back to the paths named here', () => {
    const mapped = mapSimArgs(['io', 'booted', 'screenshot', '--type=png', 'shots/a.png'], '/work/app');
    expect(mapped.remoteArgs).toEqual(['io', '@DEVICE@', 'screenshot', '--type=png', '@OUT@/1-a.png']);
    expect(mapped.outputs).toEqual([{ name: '1-a.png', local: '/work/app/shots/a.png' }]);
  });

  it('sends the files simctl reads, and refuses a file that is not here', () => {
    const dir = temp();
    writeFileSync(join(dir, 'payload.apns'), '{}');
    const mapped = mapSimArgs(['push', 'booted', 'com.x', 'payload.apns'], dir);
    expect(mapped.remoteArgs).toEqual(['push', '@DEVICE@', 'com.x', '@IN@/1-payload.apns']);
    expect(mapped.inputs).toEqual([{ local: join(dir, 'payload.apns'), name: '1-payload.apns' }]);
    expect(() => mapSimArgs(['push', 'booted', 'com.x', 'missing.apns'], dir)).toThrow(SimArgsRefused);
  });

  it('refuses what is off the list or waits for the app to quit', () => {
    for (const args of [['erase', 'booted'], ['boot', 'x'], ['spawn', 'booted', 'log', 'stream'], ['io', 'booted', 'enumerate'],
      ['launch', '--console', 'booted', 'com.x'], ['io', 'booted', 'screenshot'], []]) {
      expect(() => mapSimArgs(args, '/w'), args.join(' ')).toThrow(SimArgsRefused);
    }
  });
});

describe('the aio-ios command line', () => {
  it('reads options after the command, and leaves the rest of sim to simctl', () => {
    expect(parse(['run', '--fresh', '--wait', '45', '--app', 'shop'])).toMatchObject({
      action: 'run', options: { fresh: true, waitSeconds: 45, app: 'shop' }, args: [],
    });
    expect(parse(['sim', '--seconds', '5', 'io', 'booted', 'recordVideo', 'a.mov'])).toMatchObject({
      options: { seconds: 5 }, args: ['io', 'booted', 'recordVideo', 'a.mov'],
    });
    expect(parse(['test', '--env', 'A=b c', '--env', 'B=', 'flows/a.yaml'])).toMatchObject({ options: { env: ['A=b c', 'B='] }, args: ['flows/a.yaml'] });
    expect(parse([]).action).toBe('help');
  });

  it('refuses mistakes rather than guessing', () => {
    for (const argv of [['deploy'], ['test'], ['sim'], ['test', '--env', 'no-equals', 'a.yaml'], ['build', 'extra'], ['run', '--wait', '0'], ['logs', '--seconds', 'x'], ['build', '--app']]) {
      expect(() => parse(argv), argv.join(' ')).toThrow();
    }
  });

  it('names the session safely, and calls a person in Terminal one session', () => {
    expect(sessionName({ AI_ORCHESTRATOR_INSTANCE_ID: 'abc-123' })).toBe('abc-123');
    expect(sessionName({ AI_ORCHESTRATOR_INSTANCE_ID: '../x y;rm' })).toBe('_x_y_rm');
    expect(sessionName({})).toBe('terminal');
  });

  it('writes a recipe a shell reads back exactly, quotes and all', () => {
    const app = {
      id: 'shop', folder: "it's here", xcode: { project: 'ios/App/App.xcodeproj' }, scheme: 'App', bundleId: 'com.x',
      nodeVersion: '24', installInputs: ['package-lock.json'], install: 'echo install', web: 'echo web', sync: 'echo sync',
    };
    const text = recipeText(app, { commit: 'abc', options: { fresh: true, waitSeconds: 30, seconds: null } });
    const out = execFileSync('bash', ['-c', `eval "$1"; printf '%s|' "$APP_DIR" "$XCODE_KIND" "$XCODE_PATH" "$FRESH_INSTALL" "$LOG_SECONDS"; recipe_web`, '_', text], { encoding: 'utf8' });
    expect(out).toBe("it's here|project|ios/App/App.xcodeproj|1|30|web\n");
  });
});

describe('finding the test Mac', () => {
  function checksDir(config: object | null): NodeJS.ProcessEnv {
    const dir = temp();
    if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    return { AIO_REMOTE_CHECKS_DIR: dir, AIO_REMOTE_IOS_DIR: join(dir, 'ios') };
  }
  const pc = { host: 'pc', label: 'the Windows PC' };
  const mac = { host: 'ct-test-mac', label: 'the test Mac', platform: 'darwin' };

  it('takes the first Mac in the test machine list, and respects its pause', () => {
    expect(findTestMac(checksDir({ ...pc, moreMachines: [mac] })).machine?.host).toBe('ct-test-mac');
    expect(findTestMac(checksDir({ ...pc, moreMachines: [{ ...mac, paused: true }] })).reason).toBe('the test Mac is paused');
    expect(findTestMac(checksDir(pc)).reason).toBe('no test Mac is in the test machine list');
    expect(findTestMac(checksDir(null)).reason).toBe('no test machines are set up');
  });

  it('asks once a minute at most, and remembers a job\'s fault for ten minutes', () => {
    const env = checksDir({ ...pc, moreMachines: [mac] });
    const machine = findTestMac(env).machine!;
    let calls = 0;
    const run = () => {
      calls += 1;
      return { status: 255 };
    };
    expect(probe(machine, { env, now: 0, run })).toEqual({ ok: false, reason: 'the test Mac could not be reached' });
    expect(probe(machine, { env, now: 59_000, run }).ok).toBe(false);
    expect(calls).toBe(1);
    expect(probe(machine, { env, now: 61_000, run: () => ({ status: 0 }) })).toEqual({ ok: true, reason: null });
    markUnusable(machine, 'its simulator would not start', { env, now: 100_000 });
    expect(probe(machine, { env, now: 100_000 + 9 * 60_000, run: () => ({ status: 0 }) }))
      .toEqual({ ok: false, reason: 'its simulator would not start' });
    expect(probe(machine, { env, now: 100_000 + 11 * 60_000, run: () => ({ status: 0 }) }).ok).toBe(true);
  });
});

describe('the redirect', () => {
  const testMacConfig = (): NodeJS.ProcessEnv => {
    const dir = temp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ host: 'pc', label: 'the PC', moreMachines: [{ host: 'm', label: 'the test Mac', platform: 'darwin' }] }));
    return { AIO_REMOTE_CHECKS_DIR: dir, AI_ORCHESTRATOR_INSTANCE_ID: 'session-1' };
  };
  const answering = () => ({ ok: true, reason: null });
  const away = () => ({ ok: false, reason: 'the test Mac could not be reached' });

  it('points simulator work in a listed app at the matching aio-ios command', () => {
    const { home, repo } = homeWithRepo('shop');
    const env = testMacConfig();
    const ask = (tool: string, args: string[]) => decide({ tool, args, cwd: repo, env, home, apps, check: answering });
    expect(ask('xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', 'build'])).toEqual({
      code: 64, log: null,
      message: 'iPhone builds and simulators run on the test Mac. Use: aio-ios build   (aio-ios help lists the commands)',
    });
    expect(ask('xcrun', ['simctl', 'io', 'booted', 'screenshot', '/tmp/a b.png']).message).toContain("Use: aio-ios sim io booted screenshot '/tmp/a b.png'");
    expect(ask('xcrun', ['--sdk', 'iphonesimulator', 'simctl', 'install', 'booted', 'App.app']).message).toContain('Use: aio-ios run');
    expect(ask('xcrun', ['simctl', 'spawn', 'booted', 'log', 'stream']).message).toContain('Use: aio-ios logs');
    expect(ask('maestro', ['--udid', 'X', 'test', '.maestro/login.yaml']).message).toContain('Use: aio-ios test .maestro/login.yaml');
    expect(ask('maestro', ['test', '.maestro', '-e', 'CORE_ACTION=Add a drink', '--format', 'junit', '--output', 'r.xml']).message)
      .toContain("Use: aio-ios test --env 'CORE_ACTION=Add a drink' .maestro   (");
    expect(ask('maestro', ['hierarchy']).message).toContain('Use: aio-ios test <flow files>');
  });

  it('counts only simulator builds as xcodebuild work for the test Mac', () => {
    const { home, repo } = homeWithRepo('shop');
    const env = testMacConfig();
    const redirected = (args: string[]) => decide({ tool: 'xcodebuild', args, cwd: repo, env, home, apps, check: answering }).code === 64;
    for (const args of [
      ['-scheme', 'App', 'build'], ['-scheme', 'App'], ['-sdk', 'iphonesimulator', 'build'], ['clean', 'build', '-scheme', 'App'],
      ['-destination', 'platform=iOS Simulator,name=iPhone 18 Pro', 'build'], ['-destination', 'id=0AF4ED72-83DE-48E0-B491-CD96C696373C', 'build'],
    ]) expect(redirected(args), args.join(' ')).toBe(true);
    for (const args of [
      ['-destination', 'generic/platform=iOS', 'build'], ['-destination', 'id=00008120-001A2B3C4D5E6F7A', 'build'], ['-sdk', 'iphoneos', 'build'],
      ['clean'], ['test', '-destination', 'platform=iOS Simulator,name=iPhone 18 Pro'], ['build-for-testing'],
      ['-create-xcframework', '-framework', 'A.framework', '-output', 'A.xcframework'],
    ]) expect(redirected(args), args.join(' ')).toBe(false);
  });

  it('asks for --app when the repository has several apps and the folder does not say which', () => {
    const { home, repo } = homeWithRepo('brands', ['frontend']);
    const decision = decide({ tool: 'xcodebuild', args: ['build'], cwd: join(repo, 'frontend'), env: testMacConfig(), home, apps, check: answering });
    expect(decision.message).toContain('Use: aio-ios build --app <brand-a|brand-b>');
  });

  it('runs App Store builds, quick queries and other tools here without a word', () => {
    const { home, repo } = homeWithRepo('shop');
    const env = testMacConfig();
    for (const [tool, args] of [
      ['xcodebuild', ['-scheme', 'App', 'archive']], ['xcodebuild', ['-exportArchive', '-archivePath', 'x']], ['xcodebuild', ['-version']],
      ['xcodebuild', ['-showBuildSettings']], ['xcodebuild', ['-scheme', 'Mac', '-destination', 'platform=macOS', 'build']],
      ['xcrun', ['--find', 'clang']], ['xcrun', ['altool', '--upload-app']], ['xcrun', ['-sdk', 'simctl', 'clang']], ['xcrun', ['simctl', 'help']],
      ['maestro', ['--version']], ['maestro', ['check-syntax', 'a.yaml']],
    ] as [string, string[]][]) {
      expect(decide({ tool, args, cwd: repo, env, home, apps, check: answering }), `${tool} ${args.join(' ')}`).toEqual({ code: 0, message: null, log: null });
    }
  });

  it('runs here, saying why, when the test Mac is away or James asked, and logs it as iPhone work that ran here', () => {
    const { home, repo } = homeWithRepo('shop');
    const env = testMacConfig();
    expect(decide({ tool: 'xcodebuild', args: ['build'], cwd: repo, env, home, apps, check: away })).toEqual({
      code: 0,
      message: 'xcodebuild: running on this Mac because the test Mac could not be reached.',
      log: { project: 'shop', kind: 'ios', action: 'xcodebuild', ranOn: 'mac', exitCode: null, fellBackBecause: 'the test Mac could not be reached' },
    });
    const asked = decide({ tool: 'xcodebuild', args: ['build'], cwd: repo, env: { ...env, AIO_IOS_LOCAL: '1' }, home, apps, check: answering });
    expect(asked).toMatchObject({ code: 0, log: { fellBackBecause: 'AIO_IOS_LOCAL=1 asked for it' } });
  });

  it('runs an unlisted repository\'s builds here, saying so, without logging them as iPhone work', () => {
    const { home, repo } = homeWithRepo('mac-app');
    expect(decide({ tool: 'xcodebuild', args: ['build'], cwd: repo, env: testMacConfig(), home, apps, check: answering })).toEqual({
      code: 0, log: null,
      message: "xcodebuild: running on this Mac because this repository isn't on the test Mac's list (scripts/remote-ios/apps.js in ai-orchestrator).",
    });
  });
});

describe('setup', () => {
  it('links aio-ios and the redirect, copies the shim, leaves a stranger\'s file alone, and takes it all away again', () => {
    const home = temp();
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'maestro'), '#!/bin/sh\necho mine\n');
    const lines = install({ home });
    expect(lines.some(line => line.startsWith('left ') && line.includes('maestro'))).toBe(true);
    expect(lstatSync(join(home, '.local', 'bin', 'aio-ios')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(home, '.local', 'bin', 'aio-ios'))).toBe(realpathSync(join(__dirname, 'aio-ios.js')));
    expect(readFileSync(join(home, '.local', 'bin', 'xcrun'), 'utf8')).toBe(readFileSync(join(__dirname, 'shim.sh'), 'utf8'));
    expect(lstatSync(join(home, '.local', 'bin', 'xcodebuild')).mode & 0o111).toBeTruthy();
    install({ home });
    remove({ home });
    expect(existsSync(join(home, '.local', 'bin', 'xcrun'))).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'aio-ios'))).toBe(false);
    expect(readFileSync(join(home, '.local', 'bin', 'maestro'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });
});
