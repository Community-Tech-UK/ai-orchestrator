import * as fs from 'fs';
import * as os from 'os';
import type { HostReadinessCheck, WorkerNodeHostReadiness } from '../shared/types/worker-node.types';
import * as path from 'path';
import type { LocalNetworkState } from './local-network-evidence';
import { runProbeCommand, type ProbeCommandResult, type ProbeCommandRunner } from './probe-command';


export const HOST_READINESS_CACHE_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 10_000;
const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface HostReadinessInput {
  /** What the worker learned about macOS Local Network access. */
  localNetwork: LocalNetworkState;
  /** Program name macOS lists under Local Network. Default: the running program's file name. */
  binaryName?: string;
}

export interface HostReadinessDeps {
  runCommand?: ProbeCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** The account the worker runs as. */
  username?: () => string;
  fileExists?: (file: string) => boolean;
}

interface ResolvedDeps {
  runCommand: ProbeCommandRunner;
  platform: NodeJS.Platform;
  now: () => number;
  username: () => string;
  fileExists: (file: string) => boolean;
}

function resolveDeps(deps: HostReadinessDeps): ResolvedDeps {
  return {
    runCommand: deps.runCommand ?? runProbeCommand,
    platform: deps.platform ?? process.platform,
    now: deps.now ?? Date.now,
    username: deps.username ?? (() => os.userInfo().username),
    fileExists: deps.fileExists ?? ((file) => fs.existsSync(file)),
  };
}

type CommandChecks = Exclude<HostReadinessCheck['id'], 'local_network'>;
type CachedCheck = HostReadinessCheck & { id: CommandChecks };

const CHECK_ORDER: readonly HostReadinessCheck['id'][] = [
  'sleep_on_power', 'remote_login_access', 'local_network', 'tailscale_running', 'filevault',
];

// ---------------------------------------------------------------------------
// Individual checks (pure parsers are exported for tests)
// ---------------------------------------------------------------------------

/** The `sleep` minutes in the AC Power section of `pmset -g custom`, or undefined when there is none. */
export function parseAcSleepMinutes(output: string): number | undefined {
  let inAc = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\S.*:\s*$/.test(line)) {
      inAc = /^AC Power:/i.test(line);
      continue;
    }
    if (!inAc) continue;
    const match = /^\s*sleep\s+(\d+)\b/.exec(line);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function couldNotCheck(id: CommandChecks, what: string): CachedCheck {
  return { id, status: 'unknown', summary: `Could not check ${what}.`, needsAdmin: false };
}

async function checkSleep(d: ResolvedDeps): Promise<CachedCheck> {
  const result = await d.runCommand('/usr/bin/pmset', ['-g', 'custom'], COMMAND_TIMEOUT_MS);
  const minutes = result.exitCode === 0 ? parseAcSleepMinutes(result.stdout) : undefined;
  if (minutes === undefined) return couldNotCheck('sleep_on_power', 'whether this Mac sleeps on power');
  if (minutes === 0) {
    return { id: 'sleep_on_power', status: 'ok', summary: 'This Mac does not sleep while on power.', needsAdmin: false };
  }
  return {
    id: 'sleep_on_power',
    status: 'problem',
    summary: `This Mac sleeps after ${minutes} minute${minutes === 1 ? '' : 's'} on power, so jobs stop.`,
    fix: 'sudo pmset -c sleep 0',
    needsAdmin: true,
  };
}

async function checkRemoteLogin(d: ResolvedDeps): Promise<CachedCheck> {
  const group = await d.runCommand('/usr/sbin/dseditgroup', ['-o', 'read', 'com.apple.access_ssh'], COMMAND_TIMEOUT_MS);
  if (group.timedOut || group.notFound) return couldNotCheck('remote_login_access', 'who may sign in over Remote Login');
  if (group.exitCode !== 0) {
    // No access group: Remote Login, when it is on, lets every account in.
    return { id: 'remote_login_access', status: 'ok', summary: 'Remote Login is not limited to particular accounts.', needsAdmin: false };
  }
  const user = d.username();
  const member = await d.runCommand('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', user, 'com.apple.access_ssh'], COMMAND_TIMEOUT_MS);
  if (member.timedOut || member.notFound) return couldNotCheck('remote_login_access', 'who may sign in over Remote Login');
  if (/^\s*yes\b/i.test(member.stdout)) {
    return { id: 'remote_login_access', status: 'ok', summary: `${user} may sign in over Remote Login.`, needsAdmin: false };
  }
  return {
    id: 'remote_login_access',
    status: 'problem',
    summary: `Remote Login is limited to certain accounts and ${user} is not one of them, so nobody can reach this Mac as ${user} over SSH.`,
    fix: `sudo dseditgroup -o edit -a ${user} -t user com.apple.access_ssh`,
    needsAdmin: true,
  };
}

function checkLocalNetwork(input: HostReadinessInput): HostReadinessCheck {
  switch (input.localNetwork) {
    case 'blocked':
      return {
        id: 'local_network',
        status: 'problem',
        summary: 'macOS is blocking this computer from reaching Harness.',
        fix: `Turn on ${input.binaryName || path.basename(process.execPath)} under System Settings > Privacy & Security > Local Network.`,
        needsAdmin: false,
      };
    case 'reachable':
      return { id: 'local_network', status: 'ok', summary: 'macOS lets this computer reach Harness on the home network.', needsAdmin: false };
    default:
      return { id: 'local_network', status: 'unknown', summary: 'Local Network access has not been tested yet.', needsAdmin: false };
  }
}

function findTailscaleCli(d: ResolvedDeps): string {
  return d.fileExists(TAILSCALE_APP_CLI) ? TAILSCALE_APP_CLI : 'tailscale';
}

async function checkTailscale(d: ResolvedDeps): Promise<CachedCheck> {
  const result = await d.runCommand(findTailscaleCli(d), ['status', '--json'], COMMAND_TIMEOUT_MS);
  if (result.notFound) {
    return {
      id: 'tailscale_running',
      status: 'note',
      summary: 'Tailscale is not installed, so this computer can only reach Harness on the same network.',
      needsAdmin: false,
    };
  }
  if (result.timedOut) return couldNotCheck('tailscale_running', 'whether Tailscale is running');
  // A stopped backend can exit non-zero while still printing JSON.
  let backendState: unknown;
  try {
    backendState = (JSON.parse(result.stdout) as { BackendState?: unknown }).BackendState;
  } catch { /* not JSON: the CLI could not reach Tailscale */ }
  if (backendState === 'Running') {
    return { id: 'tailscale_running', status: 'ok', summary: 'Tailscale is running.', needsAdmin: false };
  }
  return {
    id: 'tailscale_running',
    status: 'problem',
    summary: 'Tailscale is installed but not running, so Harness cannot be reached away from the home network.',
    fix: 'Open Tailscale and sign in.',
    needsAdmin: false,
  };
}

async function checkFileVault(d: ResolvedDeps): Promise<CachedCheck> {
  const result = await d.runCommand('/usr/bin/fdesetup', ['status'], COMMAND_TIMEOUT_MS);
  if (result.exitCode !== 0 && !/FileVault is (On|Off)/i.test(result.stdout)) {
    return couldNotCheck('filevault', 'whether FileVault is on');
  }
  if (/FileVault is On/i.test(result.stdout)) {
    return {
      id: 'filevault',
      status: 'note',
      summary: 'FileVault is on, so after a restart someone must log in on this Mac before the worker starts.',
      needsAdmin: false,
    };
  }
  if (/FileVault is Off/i.test(result.stdout)) {
    return { id: 'filevault', status: 'ok', summary: 'FileVault is off, so a restart does not wait at the disk unlock screen.', needsAdmin: false };
  }
  return couldNotCheck('filevault', 'whether FileVault is on');
}

// ---------------------------------------------------------------------------
// Running them: command checks cached 10 minutes with one run in flight; Local Network is derived each time
// ---------------------------------------------------------------------------

let cache: { expiresAt: number; checks: CachedCheck[] } | undefined;
let inFlight: Promise<CachedCheck[]> | undefined;

function assemble(commandChecks: CachedCheck[], input: HostReadinessInput, now: number): WorkerNodeHostReadiness {
  const all: HostReadinessCheck[] = [...commandChecks, checkLocalNetwork(input)];
  all.sort((left, right) => CHECK_ORDER.indexOf(left.id) - CHECK_ORDER.indexOf(right.id));
  return { checks: all, checkedAt: now };
}

function refreshCommandChecks(d: ResolvedDeps, force: boolean): Promise<CachedCheck[]> {
  if (!force && cache && cache.expiresAt > d.now()) return Promise.resolve(cache.checks);
  if (inFlight) return inFlight;
  inFlight = Promise.all([checkSleep(d), checkRemoteLogin(d), checkTailscale(d), checkFileVault(d)])
    .then((checks) => {
      cache = { expiresAt: d.now() + HOST_READINESS_CACHE_MS, checks };
      return checks;
    })
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

/**
 * Run every host check (macOS only; undefined elsewhere). Command results are cached for 10 minutes; pass
 * `force` for an on-demand run such as the installer's.
 */
export async function checkHostReadiness(
  input: HostReadinessInput,
  deps: HostReadinessDeps = {},
  options: { force?: boolean } = {},
): Promise<WorkerNodeHostReadiness | undefined> {
  const d = resolveDeps(deps);
  if (d.platform !== 'darwin') return undefined;
  const checks = await refreshCommandChecks(d, options.force === true);
  return assemble(checks, input, d.now());
}

/**
 * Last known result without waiting, for the heartbeat. Undefined until the first run finishes; refreshes in the
 * background when the cache is old. Local Network always reflects `input`.
 */
export function getCachedHostReadiness(
  input: HostReadinessInput,
  deps: HostReadinessDeps = {},
): WorkerNodeHostReadiness | undefined {
  const d = resolveDeps(deps);
  if (d.platform !== 'darwin') return undefined;
  if (!cache || cache.expiresAt <= d.now()) refreshCommandChecks(d, false).catch(() => undefined);
  return cache ? assemble(cache.checks, input, d.now()) : undefined;
}

/** Open the Tailscale app, the one fix that needs no administrator password. */
export async function openTailscaleApp(deps: HostReadinessDeps = {}): Promise<{ ok: boolean; message: string }> {
  const d = resolveDeps(deps);
  if (d.platform !== 'darwin') return { ok: false, message: 'Tailscale can only be opened this way on a Mac.' };
  const result: ProbeCommandResult = await d.runCommand('/usr/bin/open', ['-a', 'Tailscale'], COMMAND_TIMEOUT_MS);
  if (result.exitCode === 0) {
    return { ok: true, message: 'Opened Tailscale. Sign in there if it asks.' };
  }
  return { ok: false, message: 'Could not open Tailscale. Open it by hand and sign in.' };
}

export function resetHostReadinessForTesting(): void {
  cache = undefined;
  inFlight = undefined;
}
