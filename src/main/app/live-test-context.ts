import { constants, accessSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export interface HarnessLiveTestContext {
  schemaVersion: 1;
  mode: 'dev' | 'packaged';
  tree: string;
  dataPath: string;
  executablePath: string;
  port: number;
  root: string;
}

let context: HarnessLiveTestContext | null = null;

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Where an owned profile may live: /tmp/aio-lt-* on Unix, and on a native Windows copy (scripts/remote-checks/windows-copy.js)
 * <user profile>\.aio-devapps\data\aio-lt-*. scripts/remote-checks/live-test-copy.js applies the same rule when it makes the profile.
 */
export function isOwnedProfilePath(dataPath: string, platform: NodeJS.Platform = process.platform, home: string = homedir()): boolean {
  if (platform === 'win32') {
    const prefix = win32.join(home, '.aio-devapps', 'data', 'aio-lt-').toLowerCase();
    return win32.isAbsolute(dataPath) && win32.normalize(dataPath).toLowerCase().startsWith(prefix);
  }
  return dataPath.startsWith(`${realpathSync('/tmp')}/aio-lt-`);
}

function canonical(file: string): string {
  const resolved = resolve(file);
  const real = realpathSync(file);
  if (process.platform === 'win32') {
    // Windows paths are case-insensitive, and /tmp does not exist there.
    if (real.toLowerCase() !== resolved.toLowerCase()) throw new Error('Live-test paths must be canonical, without symlinked children');
    return real;
  }
  // /tmp itself is an OS alias on macOS, but no test-owned child may be a link.
  const normalized = resolved.replace(/^\/tmp(?=\/|$)/, realpathSync('/tmp'));
  if (real !== normalized) throw new Error('Live-test paths must be canonical, without symlinked children');
  return real;
}

function normalPath(file: string): string {
  try { return realpathSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(normalPath(dirname(file)), file.slice(dirname(file).length + 1));
  }
}

/** Called before application imports. A flag alone never turns production into a test target. */
export function initializeHarnessLiveTest(options: {
  appDataPath: string; isPackaged: boolean; env: Record<string, string | undefined>; execPath: string;
}): HarnessLiveTestContext | null {
  context = null;
  const { env } = options;
  const profile = env['AIO_LIVETEST_USER_DATA_PATH'];
  const ownerFile = env['AIO_LIVETEST_OWNER_FILE'];
  if (!env['AIO_LIVETEST'] && !profile && !ownerFile) return null;
  if (env['AIO_LIVETEST'] !== '1' || !profile || !ownerFile || env['AIO_STARTUP_SMOKE'] === '1') {
    throw new Error('Live-test mode requires its explicit profile and ownership receipt, without startup smoke');
  }
  if (!isAbsolute(profile) || !isAbsolute(ownerFile)) throw new Error('Live-test paths must be absolute');
  const dataPath = canonical(profile);
  if (!isOwnedProfilePath(dataPath)) {
    throw new Error(process.platform === 'win32'
      ? 'Live-test profile must be under .aio-devapps\\data\\aio-lt-' : 'Live-test profile must be under /tmp/aio-lt-');
  }
  for (const normal of ['harness', 'harness-dev'].map(name => normalPath(join(options.appDataPath, name)))) {
    if (contains(normal, dataPath) || contains(dataPath, normal)) throw new Error('Live-test profile must not overlap normal app data');
  }
  const receipt = canonical(ownerFile);
  const root = dirname(receipt);
  for (const file of [root, receipt, dataPath]) {
    const stat = lstatSync(file);
    // Windows has no permission bits: its folders under the user's profile are private to that user by inheritance.
    if ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Live-test ownership and profile must be private to the current user');
    }
  }
  const raw = JSON.parse(readFileSync(receipt, 'utf8')) as Partial<HarnessLiveTestContext>;
  const mode = options.isPackaged ? 'packaged' : 'dev';
  if (raw.schemaVersion !== 1 || raw.mode !== mode) throw new Error('Live-test package mode does not match its owner');
  if (raw.dataPath !== dataPath || typeof raw.tree !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.tree)
    || !Number.isInteger(raw.port) || raw.port! < 1024 || raw.port! > 65535) {
    throw new Error('Invalid live-test profile or snapshot ownership');
  }
  const executablePath = realpathSync(options.execPath);
  if (raw.executablePath !== executablePath) throw new Error('Live-test executable does not match its owner');
  if (options.isPackaged && !contains(root, executablePath)) throw new Error('Packaged live-test executable must be in its owned copy');
  const marker = JSON.parse(readFileSync(canonical(join(dataPath, '.aio-livetest-profile.json')), 'utf8')) as Partial<HarnessLiveTestContext>;
  if (marker.schemaVersion !== 1 || marker.mode !== mode || marker.dataPath !== dataPath) {
    throw new Error('Live-test profile has no matching ownership marker');
  }
  context = { schemaVersion: 1, mode, tree: raw.tree, dataPath, executablePath, port: raw.port!, root };
  return context;
}

export function isHarnessLiveTest(): boolean { return context !== null; }

/** The verified, owner-checked profile folder of a live-test copy; null in every other app. */
export function harnessLiveTestDataPath(): string | null { return context?.dataPath ?? null; }

/** Folder inside the owned profile that holds test-only stand-ins. The runner empties it on every start. */
export const LIVE_TEST_OVERRIDES_DIR = 'live-test-overrides';
const CLAUDE_STAND_IN_FILE = 'claude';

/**
 * The stand-in Claude CLI a live test placed in its own profile, or null when there is none or this
 * is not an owned live-test run. A stand-in that is present but not safe throws: running the real
 * CLI instead would spend the user's real allowance, so there is no quiet fallback.
 */
export function resolveLiveTestClaudeStandIn(): string | null {
  if (!context) return null;
  const file = join(context.dataPath, LIVE_TEST_OVERRIDES_DIR, CLAUDE_STAND_IN_FILE);
  if (!lstatOrNull(file)) return null;
  // The profile must still be the one this process was started for.
  const marker = JSON.parse(readFileSync(join(context.dataPath, '.aio-livetest-profile.json'), 'utf8')) as Partial<HarnessLiveTestContext>;
  if (marker.schemaVersion !== 1 || marker.mode !== context.mode || marker.dataPath !== context.dataPath) {
    throw new Error('Live-test profile no longer matches its ownership marker; refusing its Claude stand-in');
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) {
    throw new Error('Live-test Claude stand-in must be a plain file owned by this user and not writable by others');
  }
  accessSync(file, constants.X_OK);
  const real = realpathSync(file);
  if (!contains(context.dataPath, real)) throw new Error('Live-test Claude stand-in must live inside its profile');
  return real;
}

function lstatOrNull(file: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Safe metadata only, emitted by the real main process, never supplied by a CDP client. */
export function writeHarnessLiveTestReceipt(runtime: { pid: number; isPackaged: boolean; version: string; ready: boolean }): void {
  if (!context) return;
  const file = join(context.root, 'runtime.json');
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...context, ...runtime, application: 'Harness', observedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
