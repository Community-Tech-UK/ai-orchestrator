import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeCommandResult, ProbeCommandRunner } from './probe-command';
import {
  checkHostReadiness,
  getCachedHostReadiness,
  openTailscaleApp,
  parseAcSleepMinutes,
  resetHostReadinessForTesting,
} from './host-readiness';

const ok = (stdout = ''): ProbeCommandResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, notFound: false });
const failed = (exitCode: number, stdout = ''): ProbeCommandResult => ({ exitCode, stdout, stderr: '', timedOut: false, notFound: false });
const missing: ProbeCommandResult = { exitCode: null, stdout: '', stderr: '', timedOut: false, notFound: true };
const timedOut: ProbeCommandResult = { exitCode: null, stdout: '', stderr: '', timedOut: true, notFound: false };

const PMSET = (ac: number) => `Battery Power:\n lowpowermode         0\n sleep                1\n displaysleep         2\nAC Power:\n lowpowermode         0\n sleep                ${ac}\n displaysleep         10\n`;

interface Setup {
  pmset?: ProbeCommandResult;
  group?: ProbeCommandResult;
  member?: ProbeCommandResult;
  tailscale?: ProbeCommandResult;
  fdesetup?: ProbeCommandResult;
}

function runner(setup: Setup = {}): ProbeCommandRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const key = `${file.split('/').pop()} ${args.join(' ')}`;
    if (key === 'pmset -g custom') return setup.pmset ?? ok(PMSET(0));
    if (key === 'dseditgroup -o read com.apple.access_ssh') return setup.group ?? failed(56);
    if (key.startsWith('dseditgroup -o checkmember')) return setup.member ?? ok('yes james is a member of com.apple.access_ssh');
    if (key === 'Tailscale status --json' || key === 'tailscale status --json') {
      return setup.tailscale ?? ok('{"BackendState":"Running"}');
    }
    if (key === 'fdesetup status') return setup.fdesetup ?? ok('FileVault is Off.\n');
    if (key === 'open -a Tailscale') return ok();
    throw new Error(`unexpected command ${key}`);
  }) as unknown as ProbeCommandRunner & ReturnType<typeof vi.fn>;
}

const deps = (run: ProbeCommandRunner, extra: object = {}) =>
  ({ runCommand: run, platform: 'darwin' as const, username: () => 'james', fileExists: () => true, ...extra });
const byId = (result: Awaited<ReturnType<typeof checkHostReadiness>>, id: string) =>
  result?.checks.find((check) => check.id === id);

describe('host-readiness', () => {
  beforeEach(() => resetHostReadinessForTesting());

  it('is undefined off macOS and runs nothing', async () => {
    const run = runner();
    expect(await checkHostReadiness({ localNetwork: 'unknown' }, { runCommand: run, platform: 'win32' })).toBeUndefined();
    expect(getCachedHostReadiness({ localNetwork: 'unknown' }, { runCommand: run, platform: 'linux' })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('parses the AC Power sleep value only', () => {
    expect(parseAcSleepMinutes(PMSET(0))).toBe(0);
    expect(parseAcSleepMinutes(PMSET(15))).toBe(15);
    expect(parseAcSleepMinutes('Battery Power:\n sleep 1\n')).toBeUndefined();
  });

  it('reports a healthy Mac with FileVault off as all ok, in order', async () => {
    const result = await checkHostReadiness({ localNetwork: 'reachable' }, deps(runner()));
    expect(result?.checks.map((check) => `${check.id}:${check.status}`)).toEqual([
      'sleep_on_power:ok', 'remote_login_access:ok', 'local_network:ok', 'tailscale_running:ok', 'filevault:ok',
    ]);
  });

  it('flags sleep on power with the admin fix', async () => {
    const check = byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner({ pmset: ok(PMSET(1)) }))), 'sleep_on_power');
    expect(check).toEqual({
      id: 'sleep_on_power', status: 'problem', needsAdmin: true,
      summary: 'This Mac sleeps after 1 minute on power, so jobs stop.', fix: 'sudo pmset -c sleep 0',
    });
  });

  it('checks Remote Login access only when the group exists', async () => {
    const noGroup = byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner())), 'remote_login_access');
    expect(noGroup?.status).toBe('ok');
    const notMember = byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner({ group: ok('x'), member: ok('no james is NOT a member') }), {}), { force: true }), 'remote_login_access');
    expect(notMember).toMatchObject({
      status: 'problem', needsAdmin: true, fix: 'sudo dseditgroup -o edit -a james -t user com.apple.access_ssh',
    });
    const member = byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner({ group: ok('x') })), { force: true }), 'remote_login_access');
    expect(member?.status).toBe('ok');
  });

  it('turns the Local Network evidence into a check without needing admin', async () => {
    const run = runner();
    const blocked = byId(await checkHostReadiness({ localNetwork: 'blocked', binaryName: 'aio-worker' }, deps(run)), 'local_network');
    expect(blocked).toEqual({
      id: 'local_network', status: 'problem', needsAdmin: false,
      summary: 'macOS is blocking this computer from reaching Harness.',
      fix: 'Turn on aio-worker under System Settings > Privacy & Security > Local Network.',
    });
    expect(byId(await checkHostReadiness({ localNetwork: 'blocked' }, deps(run)), 'local_network')?.fix).toContain(`Turn on ${path.basename(process.execPath)} under`);
    expect(byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(run)), 'local_network')?.status).toBe('unknown');
  });

  it('separates Tailscale running, stopped, missing and unanswered', async () => {
    const status = async (tailscale: ProbeCommandResult, extra: object = {}) =>
      byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner({ tailscale }), extra), { force: true }), 'tailscale_running');
    expect((await status(ok('{"BackendState":"Running"}')))?.status).toBe('ok');
    expect(await status(failed(1, '{"BackendState":"Stopped"}'))).toMatchObject({ status: 'problem', fix: 'Open Tailscale and sign in.', needsAdmin: false });
    expect((await status(ok('The Tailscale GUI failed to start')))?.status).toBe('problem');
    expect((await status(missing, { fileExists: () => false }))?.status).toBe('note');
    expect((await status(timedOut))?.status).toBe('unknown');
  });

  it('notes FileVault when it is on', async () => {
    const check = byId(await checkHostReadiness({ localNetwork: 'unknown' }, deps(runner({ fdesetup: ok('FileVault is On.\n') }))), 'filevault');
    expect(check).toMatchObject({ status: 'note', needsAdmin: false });
    expect(check?.summary).toContain('someone must log in');
  });

  it('caches command checks for ten minutes but keeps Local Network fresh', async () => {
    let now = 5_000_000;
    const run = runner();
    const d = deps(run, { now: () => now });
    await checkHostReadiness({ localNetwork: 'unknown' }, d);
    const calls = run.mock.calls.length;
    const again = await checkHostReadiness({ localNetwork: 'blocked' }, d);
    expect(run.mock.calls.length).toBe(calls);
    expect(byId(again, 'local_network')?.status).toBe('problem');
    now += 10 * 60_000 + 1;
    await checkHostReadiness({ localNetwork: 'unknown' }, d);
    expect(run.mock.calls.length).toBeGreaterThan(calls);
  });

  it('answers the heartbeat from cache without waiting, then has a value', async () => {
    const run = runner();
    const d = deps(run);
    expect(getCachedHostReadiness({ localNetwork: 'unknown' }, d)).toBeUndefined();
    await checkHostReadiness({ localNetwork: 'unknown' }, d); // joins the run already started
    expect(getCachedHostReadiness({ localNetwork: 'unknown' }, d)?.checks).toHaveLength(5);
  });

  it('opens Tailscale only on a Mac', async () => {
    const run = runner();
    expect((await openTailscaleApp(deps(run))).ok).toBe(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Tailscale'], expect.any(Number));
    expect((await openTailscaleApp({ runCommand: run, platform: 'win32' })).ok).toBe(false);
  });
});
