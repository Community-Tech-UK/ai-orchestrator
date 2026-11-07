import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'zlib';
import type { ProbeCommandResult, ProbeCommandRunner } from '../probe-command';
import {
  findSigningError,
  getCachedIosAutomation,
  probeIosAutomation,
  refreshIosAutomation,
  resetIosReadinessForTesting,
} from './ios-readiness';

const ok = (stdout = ''): ProbeCommandResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, notFound: false });
const failed = (exitCode: number, stderr = ''): ProbeCommandResult => ({ exitCode, stdout: '', stderr, timedOut: false, notFound: false });
const timedOut: ProbeCommandResult = { exitCode: null, stdout: '', stderr: '', timedOut: true, notFound: false };

const RUNTIMES = JSON.stringify({
  runtimes: [
    { name: 'iOS 27.2', version: '27.2', isAvailable: true, identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2' },
    { name: 'watchOS 12', version: '12.0', isAvailable: true, identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-12-0' },
  ],
});
const DEVICES = JSON.stringify({
  result: {
    devices: [
      {
        deviceProperties: { name: 'James iPhone', osVersionNumber: '27.1', developerModeStatus: 'enabled' },
        connectionProperties: { pairingState: 'paired', tunnelState: 'disconnected' },
        hardwareProperties: { reality: 'physical', platform: 'iOS', udid: 'UDID-1', marketingName: 'iPhone 17' },
      },
      {
        deviceProperties: { name: 'Simulated' },
        connectionProperties: { pairingState: 'paired' },
        hardwareProperties: { reality: 'simulated', platform: 'iOS', udid: 'UDID-2' },
      },
    ],
  },
});

interface Setup { accepts?: boolean; account?: ProbeCommandResult; devices?: string; xcodeSelect?: ProbeCommandResult }

function runner(setup: Setup = {}): ProbeCommandRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const key = `${path.basename(file)} ${args.join(' ')}`;
    if (key === 'xcode-select -p') return setup.xcodeSelect ?? ok('/Applications/Xcode.app/Contents/Developer\n');
    if (key === 'xcodebuild -version') return ok('Xcode 27.2\nBuild version 27B52\n');
    if (key === 'xcodebuild -license check') return setup.accepts === false ? failed(1) : ok();
    if (key === 'xcrun simctl list runtimes --json') return ok(RUNTIMES);
    if (key.startsWith('xcrun devicectl list devices --json-output ')) {
      fs.writeFileSync(args[args.length - 1]!, setup.devices ?? DEVICES);
      return ok();
    }
    if (key.startsWith('defaults read')) return setup.account ?? ok('{ "IDE.Identifiers.Prod" = ( { identifier = "abc"; } ); }');
    throw new Error(`unexpected command ${key}`);
  }) as unknown as ProbeCommandRunner & ReturnType<typeof vi.fn>;
}

describe('ios-readiness', () => {
  let home: string;

  beforeEach(() => {
    resetIosReadinessForTesting();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-ready-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const input = () => ({ workingDirectories: [path.join(home, 'work')], configDir: path.join(home, 'cfg') });
  const deps = (run: ProbeCommandRunner) => ({ runCommand: run, platform: 'darwin' as const, homeDir: home });

  function writeLog(dir: string, name: string, text: string, mtime: Date): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, gzipSync(Buffer.from(text, 'latin1')));
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  it('is undefined off macOS and never runs a command', async () => {
    const run = runner();
    expect(await probeIosAutomation(input(), { runCommand: run, platform: 'linux' })).toBeUndefined();
    expect(getCachedIosAutomation(input(), { runCommand: run, platform: 'win32' })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('is undefined when Xcode is not selected, but a timeout is recorded as a problem', async () => {
    expect(await probeIosAutomation(input(), deps(runner({ xcodeSelect: failed(2) })))).toBeUndefined();
    const result = await probeIosAutomation(input(), deps(runner({ xcodeSelect: timedOut })));
    expect(result?.ready).toBe(false);
    expect(result?.problems[0]).toContain('did not answer in time');
  });

  it('reads Xcode, licence, iOS runtimes, physical devices and the Apple account', async () => {
    const result = await probeIosAutomation(input(), deps(runner()));
    expect(result).toMatchObject({
      xcodePath: '/Applications/Xcode.app/Contents/Developer',
      xcodeVersion: '27.2',
      xcodeBuild: '27B52',
      licenceAccepted: true,
      runtimes: [{ name: 'iOS 27.2', version: '27.2', isAvailable: true }],
      devices: [{
        name: 'James iPhone', udid: 'UDID-1', platform: 'iOS', marketingName: 'iPhone 17', osVersion: '27.1',
        pairingState: 'paired', tunnelState: 'disconnected', developerMode: 'enabled',
      }],
      signing: { appleAccountPresent: true },
      problems: [],
      ready: true,
    });
  });

  it('is not ready when the licence is not accepted, and says no account when the key is missing', async () => {
    const result = await probeIosAutomation(input(), deps(runner({ accepts: false, account: failed(1, 'does not exist') })));
    expect(result?.licenceAccepted).toBe(false);
    expect(result?.ready).toBe(false);
    expect(result?.signing.appleAccountPresent).toBe(false);
    expect(result?.problems).toEqual([]);
  });

  it('is ready on a paired device alone, and not on an unpaired one', async () => {
    const noRuntimes = (devices: string): ProbeCommandRunner => {
      const base = runner({ devices });
      return (async (file, args, ms) => (args.includes('runtimes') ? ok('{"runtimes":[]}') : base(file, args, ms))) as ProbeCommandRunner;
    };
    expect((await probeIosAutomation(input(), deps(noRuntimes(DEVICES))))?.ready).toBe(true);
    const unpaired = DEVICES.replace('"paired"', '"unpaired"');
    expect((await probeIosAutomation(input(), deps(noRuntimes(unpaired))))?.ready).toBe(false);
  });

  it('records a timed-out command instead of treating the thing as absent', async () => {
    const base = runner();
    const run = (async (file, args, ms) => (args.includes('runtimes') ? timedOut : base(file, args, ms))) as ProbeCommandRunner;
    const result = await probeIosAutomation(input(), deps(run));
    expect(result?.runtimes).toEqual([]);
    expect(result?.problems).toEqual(['xcrun simctl list runtimes did not answer in time']);
  });

  it('removes the devicectl temporary folder', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-ready-tmp-'));
    try {
      await probeIosAutomation(input(), { ...deps(runner()), tmpDir: tmp });
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds the licence block in a gzipped build log under the config folder', async () => {
    const logDir = path.join(home, 'cfg', '_scratch', 'signcheck-dd', 'Logs', 'Build');
    const file = writeLog(logDir, 'a.xcactivitylog', 'noise\nPLA Update available\nAgreement', new Date(1_700_000_000_000));
    const result = await probeIosAutomation(input(), deps(runner()));
    expect(result?.signing.lastError).toEqual({
      kind: 'licence_agreement',
      message: "Apple's Program License Agreement needs accepting. Sign in at developer.apple.com/account and accept it.",
      seenAt: 1_700_000_000_000,
      logPath: file,
    });
  });

  it('reports the newest matching log across DerivedData and working folders, and ignores oversized walks', async () => {
    writeLog(path.join(home, 'Library/Developer/Xcode/DerivedData/App-abc/Logs/Build'), 'old.xcactivitylog',
      'Program License Agreement', new Date(1_700_000_000_000));
    writeLog(path.join(home, 'work', 'proj', 'dd', 'Logs', 'Build'), 'new.xcactivitylog',
      "error: No profiles for 'com.example.app' were found", new Date(1_700_000_100_000));
    // Too deep to be found (more than six folders below the root).
    writeLog(path.join(home, 'work', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'Logs', 'Build'), 'deep.xcactivitylog',
      'requires a development team', new Date(1_700_000_200_000));
    const result = await probeIosAutomation(input(), deps(runner()));
    expect(result?.signing.lastError?.kind).toBe('no_profiles');
    expect(result?.signing.lastError?.message).toContain('com.example.app');
    expect(result?.signing.lastError?.seenAt).toBe(1_700_000_100_000);
  });

  it('counts a project as resolved when its newest build log is clean', async () => {
    const dir = path.join(home, 'cfg', 'Logs', 'Build');
    writeLog(dir, 'old-error.xcactivitylog', 'Program License Agreement', new Date(1_000));
    writeLog(dir, 'new-clean.xcactivitylog', 'Build succeeded', new Date(2_000));
    expect((await probeIosAutomation(input(), deps(runner())))?.signing.lastError).toBeUndefined();
  });

  it('reports the newest error among projects whose newest build still fails', async () => {
    writeLog(path.join(home, 'cfg', 'a', 'Logs', 'Build'), 'a.xcactivitylog', 'requires a development team', new Date(1_000));
    writeLog(path.join(home, 'cfg', 'b', 'Logs', 'Build'), 'b.xcactivitylog', 'No signing certificate', new Date(2_000));
    writeLog(path.join(home, 'cfg', 'c', 'Logs', 'Build'), 'c.xcactivitylog', 'Build succeeded', new Date(3_000));
    expect((await probeIosAutomation(input(), deps(runner())))?.signing.lastError?.kind).toBe('no_certificate');
  });

  it('does not unpack an unchanged log again, and does when it changes', async () => {
    const dir = path.join(home, 'cfg', 'Logs', 'Build');
    const file = writeLog(dir, 'a.xcactivitylog', 'Program License Agreement', new Date(1_000));
    const spy = vi.spyOn(fs.promises, 'readFile');
    try {
      const reads = () => spy.mock.calls.filter((call) => call[0] === file).length;
      await probeIosAutomation(input(), deps(runner()));
      await probeIosAutomation(input(), deps(runner()));
      expect(reads()).toBe(1);
      writeLog(dir, 'a.xcactivitylog', 'No signing certificate', new Date(5_000));
      expect((await probeIosAutomation(input(), deps(runner())))?.signing.lastError?.kind).toBe('no_certificate');
      expect(reads()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('recognises each signing error', () => {
    expect(findSigningError('requires a development team')?.kind).toBe('no_team');
    expect(findSigningError('No signing certificate "iOS Development" found')?.kind).toBe('no_certificate');
    expect(findSigningError('No Accounts: Add a new account in Accounts settings')?.kind).toBe('no_account');
    expect(findSigningError('There were No Accounts found in the cache')).toBeUndefined();
    expect(findSigningError('all fine')).toBeUndefined();
  });

  it('caches for five minutes, runs one probe at a time and never makes the caller wait', async () => {
    let now = 1_000_000;
    const run = runner();
    const d = { ...deps(run), now: () => now };
    expect(getCachedIosAutomation(input(), d)).toBeUndefined(); // first call: probe starts, nothing yet
    const first = await refreshIosAutomation(input(), d); // joins the probe already running
    expect(first?.ready).toBe(true);
    const calls = run.mock.calls.length;
    expect(getCachedIosAutomation(input(), d)).toBe(first);
    expect(run.mock.calls.length).toBe(calls);
    now += 5 * 60_000 + 1;
    expect(getCachedIosAutomation(input(), d)).toBe(first); // stale value returned while refreshing
    await refreshIosAutomation(input(), d);
    expect(run.mock.calls.length).toBeGreaterThan(calls);
  });
});
