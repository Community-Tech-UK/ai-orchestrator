import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import type {
  IosPhysicalDeviceInfo,
  IosSigningErrorKind,
  IosSigningSummary,
  IosSimulatorRuntimeInfo,
  WorkerNodeIosAutomationSummary,
} from '../../shared/types/worker-node.types';
import { runProbeCommand, type ProbeCommandResult, type ProbeCommandRunner } from '../probe-command';

const gunzipAsync = promisify(gunzip);

interface SigningFinding { kind: IosSigningErrorKind; message: string }

export const IOS_READINESS_CACHE_MS = 5 * 60_000;
const XCODEBUILD_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_FOLDERS_SCANNED = 20;
const MAX_LOG_BYTES = 50 * 1024 * 1024;
/** Decompressed size cap, so a small gzip bomb cannot exhaust the worker. */
const MAX_LOG_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const MAX_DIRECTORIES_PER_ROOT = 3_000;
const MAX_LISTED = 64;
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'Pods', 'Library']);

export interface IosReadinessInput {
  /** The worker's project folders; build logs under them count. */
  workingDirectories: readonly string[];
  /** The worker's own config folder (default ~/.orchestrator). */
  configDir?: string;
}

export interface IosReadinessDeps {
  runCommand?: ProbeCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
  homeDir?: string;
  tmpDir?: string;
}

interface ResolvedDeps {
  runCommand: ProbeCommandRunner;
  platform: NodeJS.Platform;
  now: () => number;
  homeDir: string;
  tmpDir: string;
}

function resolveDeps(deps: IosReadinessDeps): ResolvedDeps {
  return {
    runCommand: deps.runCommand ?? runProbeCommand,
    platform: deps.platform ?? process.platform,
    now: deps.now ?? Date.now,
    homeDir: deps.homeDir ?? os.homedir(),
    tmpDir: deps.tmpDir ?? os.tmpdir(),
  };
}

// ---------------------------------------------------------------------------
// Cache: whole block, 5 minutes, one probe in flight. Callers on the connect path never wait.
// ---------------------------------------------------------------------------

let cache: { expiresAt: number; value: WorkerNodeIosAutomationSummary | undefined } | undefined;
let inFlight: Promise<WorkerNodeIosAutomationSummary | undefined> | undefined;
/** Scan result per build log, keyed by path, modified time and size, so an unchanged log is never unpacked twice. */
let logResults = new Map<string, SigningFinding | null>();

/**
 * Last known iOS readiness. Synchronous so it can sit on the awaited connect path: it returns the cached block (or
 * undefined before the first probe finishes) and refreshes in the background when the cache is old.
 */
export function getCachedIosAutomation(
  input: IosReadinessInput,
  deps: IosReadinessDeps = {},
): WorkerNodeIosAutomationSummary | undefined {
  const resolved = resolveDeps(deps);
  if (resolved.platform !== 'darwin') return undefined;
  if (!cache || cache.expiresAt <= resolved.now()) {
    refreshIosAutomation(input, deps).catch(() => undefined);
  }
  return cache?.value;
}

/** Probe now unless a probe is already running or the cache is fresh. */
export function refreshIosAutomation(
  input: IosReadinessInput,
  deps: IosReadinessDeps = {},
): Promise<WorkerNodeIosAutomationSummary | undefined> {
  const resolved = resolveDeps(deps);
  if (resolved.platform !== 'darwin') return Promise.resolve(undefined);
  if (cache && cache.expiresAt > resolved.now()) return Promise.resolve(cache.value);
  if (inFlight) return inFlight;
  inFlight = probeIosAutomation(input, deps)
    .then((value) => {
      cache = { expiresAt: resolved.now() + IOS_READINESS_CACHE_MS, value };
      return value;
    })
    .finally(() => { inFlight = undefined; });
  return inFlight;
}

export function resetIosReadinessForTesting(): void {
  cache = undefined;
  inFlight = undefined;
  logResults = new Map();
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Read this Mac's iOS test readiness. Undefined when this is not macOS or Xcode is not selected. A command that
 * failed or timed out goes in `problems` instead of being read as "not installed".
 */
export async function probeIosAutomation(
  input: IosReadinessInput,
  deps: IosReadinessDeps = {},
): Promise<WorkerNodeIosAutomationSummary | undefined> {
  const d = resolveDeps(deps);
  if (d.platform !== 'darwin') return undefined;
  const problems: string[] = [];

  const select = await d.runCommand('/usr/bin/xcode-select', ['-p'], COMMAND_TIMEOUT_MS);
  const selected = select.exitCode === 0 ? select.stdout.trim() : '';
  if (!selected) {
    // Exit non-zero means Xcode is simply not selected. Anything else means we could not tell.
    if (select.exitCode !== null && !select.timedOut) return undefined;
    if (select.notFound) return undefined;
    problems.push(describeFailure('xcode-select -p', select));
  }

  const version = selected ? await readXcodeVersion(d, problems) : {};
  const licenceAccepted = version.xcodeVersion ? await readLicenceAccepted(d, problems) : false;
  const [runtimes, devices, signing] = await Promise.all([
    readRuntimes(d, problems),
    readDevices(d, problems),
    readSigning(d, input, problems),
  ]);

  const ready = Boolean(version.xcodeVersion)
    && licenceAccepted
    && (runtimes.some((runtime) => runtime.isAvailable) || devices.some((device) => device.pairingState === 'paired'));

  return {
    xcodePath: selected,
    ...version,
    licenceAccepted,
    runtimes,
    devices,
    signing,
    problems,
    checkedAt: d.now(),
    ready,
  };
}

function describeFailure(command: string, result: ProbeCommandResult): string {
  if (result.timedOut) return `${command} did not answer in time`;
  if (result.notFound) return `${command} is not available on this computer`;
  const firstLine = (result.stderr || result.stdout).split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const detail = firstLine.trim().slice(0, 200);
  return `${command} failed${result.exitCode !== null ? ` (exit ${result.exitCode})` : ''}${detail ? `: ${detail}` : ''}`;
}

export function parseXcodeVersion(output: string): { xcodeVersion?: string; xcodeBuild?: string } {
  const version = /^Xcode\s+(\S+)/m.exec(output)?.[1];
  const build = /^Build version\s+(\S+)/m.exec(output)?.[1];
  return {
    ...(version ? { xcodeVersion: version } : {}),
    ...(build ? { xcodeBuild: build } : {}),
  };
}

async function readXcodeVersion(d: ResolvedDeps, problems: string[]): Promise<{ xcodeVersion?: string; xcodeBuild?: string }> {
  const result = await d.runCommand('/usr/bin/xcodebuild', ['-version'], XCODEBUILD_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    problems.push(describeFailure('xcodebuild -version', result));
    return {};
  }
  return parseXcodeVersion(result.stdout);
}

async function readLicenceAccepted(d: ResolvedDeps, problems: string[]): Promise<boolean> {
  const result = await d.runCommand('/usr/bin/xcodebuild', ['-license', 'check'], XCODEBUILD_TIMEOUT_MS);
  if (result.exitCode === 0) return true;
  // A timeout or missing tool says nothing about the licence; a plain non-zero exit means it needs accepting.
  if (result.timedOut || result.exitCode === null) problems.push(describeFailure('xcodebuild -license check', result));
  return false;
}

export function parseSimulatorRuntimes(json: string): IosSimulatorRuntimeInfo[] | undefined {
  try {
    const parsed = JSON.parse(json) as { runtimes?: unknown };
    if (!Array.isArray(parsed.runtimes)) return undefined;
    const runtimes: IosSimulatorRuntimeInfo[] = [];
    for (const raw of parsed.runtimes) {
      const row = raw as { name?: unknown; version?: unknown; isAvailable?: unknown; identifier?: unknown };
      if (typeof row.name !== 'string') continue;
      const identifier = typeof row.identifier === 'string' ? row.identifier : '';
      if (!/^iOS\b/.test(row.name) && !identifier.includes('.iOS-')) continue;
      runtimes.push({
        name: row.name,
        version: typeof row.version === 'string' ? row.version : '',
        isAvailable: row.isAvailable === true,
      });
    }
    return runtimes.slice(0, MAX_LISTED);
  } catch {
    return undefined;
  }
}

async function readRuntimes(d: ResolvedDeps, problems: string[]): Promise<IosSimulatorRuntimeInfo[]> {
  const result = await d.runCommand('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], COMMAND_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    problems.push(describeFailure('xcrun simctl list runtimes', result));
    return [];
  }
  const runtimes = parseSimulatorRuntimes(result.stdout);
  if (!runtimes) problems.push('xcrun simctl list runtimes gave output Harness could not read');
  return runtimes ?? [];
}

export function parsePhysicalDevices(json: string): IosPhysicalDeviceInfo[] | undefined {
  try {
    const parsed = JSON.parse(json) as { result?: { devices?: unknown } };
    const rows = parsed.result?.devices;
    if (!Array.isArray(rows)) return undefined;
    const devices: IosPhysicalDeviceInfo[] = [];
    for (const raw of rows) {
      const row = raw as {
        deviceProperties?: { name?: unknown; osVersionNumber?: unknown; developerModeStatus?: unknown };
        connectionProperties?: { pairingState?: unknown; tunnelState?: unknown };
        hardwareProperties?: { reality?: unknown; platform?: unknown; udid?: unknown; marketingName?: unknown };
      };
      if (row.hardwareProperties?.reality !== 'physical') continue;
      const udid = row.hardwareProperties.udid;
      const name = row.deviceProperties?.name;
      if (typeof udid !== 'string' || typeof name !== 'string') continue;
      const mode = row.deviceProperties?.developerModeStatus;
      const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
      devices.push({
        name,
        udid,
        ...(text(row.hardwareProperties.platform) ? { platform: text(row.hardwareProperties.platform) } : {}),
        ...(text(row.hardwareProperties.marketingName) ? { marketingName: text(row.hardwareProperties.marketingName) } : {}),
        ...(text(row.deviceProperties?.osVersionNumber) ? { osVersion: text(row.deviceProperties?.osVersionNumber) } : {}),
        ...(text(row.connectionProperties?.pairingState) ? { pairingState: text(row.connectionProperties?.pairingState) } : {}),
        ...(text(row.connectionProperties?.tunnelState) ? { tunnelState: text(row.connectionProperties?.tunnelState) } : {}),
        developerMode: mode === 'enabled' || mode === 'disabled' ? mode : 'unknown',
      });
    }
    return devices.slice(0, MAX_LISTED);
  } catch {
    return undefined;
  }
}

async function readDevices(d: ResolvedDeps, problems: string[]): Promise<IosPhysicalDeviceInfo[]> {
  let workDir: string | undefined;
  try {
    workDir = await fs.promises.mkdtemp(path.join(d.tmpDir, 'aio-devicectl-'));
    const outFile = path.join(workDir, 'devices.json');
    const result = await d.runCommand('/usr/bin/xcrun', ['devicectl', 'list', 'devices', '--json-output', outFile], COMMAND_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      problems.push(describeFailure('xcrun devicectl list devices', result));
      return [];
    }
    const devices = parsePhysicalDevices(await fs.promises.readFile(outFile, 'utf8'));
    if (!devices) problems.push('xcrun devicectl list devices gave output Harness could not read');
    return devices ?? [];
  } catch (error) {
    problems.push(`xcrun devicectl list devices could not be read: ${(error as Error).message.slice(0, 200)}`);
    return [];
  } finally {
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Signing: Apple account in Xcode, and the newest signing error in build logs
// ---------------------------------------------------------------------------

export function hasAppleAccount(defaultsOutput: string): boolean {
  return /\bidentifier\s*=/.test(defaultsOutput);
}

const SIGNING_PATTERNS: readonly { kind: IosSigningErrorKind; pattern: RegExp }[] = [
  { kind: 'licence_agreement', pattern: /PLA Update available|Program License Agreement/ },
  { kind: 'no_account', pattern: /No Accounts: Add a new account/ },
  { kind: 'no_profiles', pattern: /No profiles for '([^']{1,200})' were found/ },
  { kind: 'no_team', pattern: /requires a development team/ },
  { kind: 'no_certificate', pattern: /No signing certificate/ },
];

export function signingErrorMessage(kind: IosSigningErrorKind, detail?: string): string {
  switch (kind) {
    case 'licence_agreement':
      return "Apple's Program License Agreement needs accepting. Sign in at developer.apple.com/account and accept it.";
    case 'no_profiles':
      return `Xcode found no signing profile${detail ? ` for ${detail}` : ''}. Open the project in Xcode, choose a team under Signing & Capabilities and let Xcode create the profile.`;
    case 'no_team':
      return 'The app has no development team set. In Xcode, choose a team under Signing & Capabilities.';
    case 'no_certificate':
      return 'No signing certificate was found. In Xcode, open Settings > Accounts, pick the team and choose Manage Certificates.';
    case 'no_account':
      return 'No Apple account is signed in to Xcode. In Xcode, open Settings > Accounts and add one.';
  }
}

export function findSigningError(text: string): SigningFinding | undefined {
  for (const { kind, pattern } of SIGNING_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { kind, message: signingErrorMessage(kind, match[1]) };
  }
  return undefined;
}

async function readSigning(d: ResolvedDeps, input: IosReadinessInput, problems: string[]): Promise<IosSigningSummary> {
  const account = await d.runCommand(
    '/usr/bin/defaults',
    ['read', 'com.apple.dt.Xcode', 'DVTDeveloperAccountManagerAppleIDLists'],
    COMMAND_TIMEOUT_MS,
  );
  let appleAccountPresent: boolean | undefined;
  if (account.timedOut || account.notFound) {
    problems.push(describeFailure('defaults read com.apple.dt.Xcode', account));
  } else {
    // A missing key exits non-zero: no account has ever been added.
    appleAccountPresent = account.exitCode === 0 && hasAppleAccount(account.stdout);
  }

  let lastError: IosSigningSummary['lastError'];
  try {
    lastError = await findNewestSigningError(d, input);
  } catch (error) {
    problems.push(`Xcode build logs could not be read: ${(error as Error).message.slice(0, 200)}`);
  }
  return {
    ...(appleAccountPresent !== undefined ? { appleAccountPresent } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

/** Find `Logs/Build` folders: Xcode's DerivedData, plus a bounded, cheap walk of the given roots. */
async function findBuildLogFolders(d: ResolvedDeps, input: IosReadinessInput): Promise<string[]> {
  const folders = new Set<string>();
  const derivedData = path.join(d.homeDir, 'Library', 'Developer', 'Xcode', 'DerivedData');
  for (const entry of await readDirectories(derivedData)) {
    folders.add(path.join(derivedData, entry, 'Logs', 'Build'));
  }
  const roots = [...input.workingDirectories, input.configDir ?? path.join(d.homeDir, '.orchestrator')];
  for (const root of new Set(roots)) {
    await walkForBuildLogFolders(root, folders);
  }
  return [...folders];
}

async function readDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Breadth-first so shallow folders are found first; symlinks are not followed. */
async function walkForBuildLogFolders(root: string, found: Set<string>): Promise<void> {
  let queue: string[] = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_WALK_DEPTH && queue.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of queue) {
      if (visited >= MAX_DIRECTORIES_PER_ROOT) return;
      visited += 1;
      for (const name of await readDirectories(directory)) {
        const child = path.join(directory, name);
        if (name === 'Logs') {
          found.add(path.join(child, 'Build'));
        } else if (!SKIPPED_DIRECTORY_NAMES.has(name)) {
          next.push(child);
        }
      }
    }
    queue = next;
  }
}

/**
 * The newest build log in each `Logs/Build` folder says how that project stands now, so a project whose newest build is
 * clean counts as resolved. Of the folders that still show an error, the most recent one is reported.
 */
async function findNewestSigningError(d: ResolvedDeps, input: IosReadinessInput): Promise<IosSigningSummary['lastError']> {
  const newestPerFolder: { file: string; mtimeMs: number; size: number }[] = [];
  for (const folder of await findBuildLogFolders(d, input)) {
    let names: string[];
    try {
      names = await fs.promises.readdir(folder);
    } catch {
      continue;
    }
    let newest: { file: string; mtimeMs: number; size: number } | undefined;
    for (const name of names) {
      if (!name.endsWith('.xcactivitylog')) continue;
      const file = path.join(folder, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch { /* vanished while listing */ }
    }
    if (newest && newest.size <= MAX_LOG_BYTES) newestPerFolder.push(newest);
  }
  newestPerFolder.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const seen = new Map<string, SigningFinding | null>();
  let found: IosSigningSummary['lastError'];
  for (const log of newestPerFolder.slice(0, MAX_FOLDERS_SCANNED)) {
    const key = `${log.file}|${log.mtimeMs}|${log.size}`;
    let result = logResults.get(key);
    if (result === undefined) {
      try {
        const compressed = await fs.promises.readFile(log.file);
        const text = (await gunzipAsync(compressed, { maxOutputLength: MAX_LOG_TEXT_BYTES })).toString('latin1');
        result = findSigningError(text) ?? null;
      } catch {
        result = null; // not gzip, still being written, or too large once unpacked
      }
    }
    seen.set(key, result);
    if (!found && result) found = { ...result, seenAt: Math.round(log.mtimeMs), logPath: log.file };
  }
  logResults = seen; // keep only logs that still exist, so the cache cannot grow without bound
  return found;
}
