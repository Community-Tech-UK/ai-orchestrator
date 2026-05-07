/**
 * RTK runtime helper.
 *
 * Locates the rtk binary (bundled with our app, or system-installed if newer)
 * and exposes a typed API around `rtk rewrite`. The hook script
 * (src/main/cli/hooks/rtk-defer-hook.mjs) and the analytics reader both
 * use this module to find the binary.
 *
 * The RTK rewrite contract (from rtk's src/hooks/rewrite_cmd.rs):
 *   exit 0 + stdout: rewrite found, allow auto-allow
 *   exit 1:          no RTK equivalent, pass through unchanged
 *   exit 2:          deny rule matched, defer to native deny handling
 *   exit 3 + stdout: ask rule matched, rewrite but require user prompt
 *
 * In v1 we run with feature flag off by default. Flip via AppSettings.rtk.enabled
 * or ORCHESTRATOR_RTK_ENABLED=1.
 */

import { app } from 'electron';
import { existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

import { getLogger } from '../../logging/logger';

const logger = getLogger('RtkRuntime');

/** Pinned by scripts/fetch-rtk-binaries.js. */
export const RTK_BUNDLED_VERSION = '0.39.0';
/** Minimum acceptable system-installed rtk version. Their `rtk rewrite` API was added in 0.23.0. */
export const RTK_MIN_VERSION = '0.23.0';
/** Default timeout for rtk rewrite invocations — RTK benchmarks <10ms; 2s is generous safety margin. */
const REWRITE_TIMEOUT_MS = 2_000;

export type RtkRewriteResult =
  | { kind: 'allow'; rewritten: string }
  | { kind: 'passthrough' }
  | { kind: 'deny' }
  | { kind: 'ask'; rewritten: string }
  | { kind: 'error'; reason: string };

export interface RtkRuntimeOptions {
  /** When true, never fall back to system rtk — only use bundled. Defaults to false. */
  bundledOnly?: boolean;
  /** Override for testing; resolves binary at this absolute path. */
  binaryPathOverride?: string;
}

export interface RtkRuntime {
  /** True if a usable rtk binary was located. */
  isAvailable(): boolean;
  /** Absolute path to the rtk binary that will be invoked. Throws if not available. */
  binaryPath(): string;
  /** Source of the binary (bundled within the app vs. system-installed on PATH). */
  binarySource(): 'bundled' | 'system' | 'override' | 'none';
  /** Version reported by `rtk --version`, or null if not detected. */
  version(): string | null;
  /** Run `rtk rewrite <cmd>` synchronously and return the typed result. */
  rewrite(cmd: string): RtkRewriteResult;
}

/**
 * Compare two semver-ish version strings. Returns:
 *   negative if a < b, zero if equal, positive if a > b.
 * Tolerates pre-release suffixes by stripping anything after a hyphen.
 */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number(n) || 0);
  const av = norm(a);
  const bv = norm(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parse `rtk x.y.z` or `rtk x.y.z (commit)` into "x.y.z", or null if unparseable. */
export function parseVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

interface ResolvedBinary {
  path: string;
  source: 'bundled' | 'system' | 'override';
  version: string;
}

/**
 * Compute the path where electron-builder places the bundled rtk binary
 * for the current process platform/arch.
 *
 * Production:
 *   process.resourcesPath/rtk/<platform>-<arch>/rtk[.exe]
 * Development:
 *   <repo>/resources/rtk/<platform>-<arch>/rtk[.exe]
 */
function getBundledBinaryCandidate(): string {
  const filename = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  const subdir = `${process.platform}-${process.arch}`;

  if (app?.isPackaged) {
    const base =
      typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
        ? process.resourcesPath
        : path.join(process.cwd(), 'resources');
    return path.join(base, 'rtk', subdir, filename);
  }
  // Dev mode: app may not be initialised yet during early test runs
  let projectRoot: string;
  try {
    projectRoot = app?.getAppPath?.() ?? process.cwd();
  } catch {
    projectRoot = process.cwd();
  }
  return path.join(projectRoot, 'resources', 'rtk', subdir, filename);
}

/**
 * Probe `rtk --version` at a given path. Returns parsed version or null on failure.
 */
function probeVersion(binaryPath: string): string | null {
  try {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    if (result.status !== 0) return null;
    return parseVersion(result.stdout || '');
  } catch {
    return null;
  }
}

/**
 * Locate `rtk` on PATH using `which` / `where` and return its absolute path.
 * Returns null if not found.
 */
function findSystemBinary(): string | null {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(command, ['rtk'], { encoding: 'utf8', timeout: 1_000 });
    if (result.status !== 0) return null;
    const firstLine = (result.stdout || '').split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!firstLine) return null;
    const resolved = firstLine.trim();
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which rtk binary to use, in priority order:
 *   1. Override path (testing)
 *   2. System rtk if version >= max(MIN_VERSION, BUNDLED_VERSION) and !bundledOnly
 *   3. Bundled rtk if version >= MIN_VERSION
 *   4. None
 */
function resolveBinary(opts: RtkRuntimeOptions): ResolvedBinary | null {
  if (opts.binaryPathOverride) {
    if (!existsSync(opts.binaryPathOverride)) {
      logger.warn('rtk binary override does not exist', { path: opts.binaryPathOverride });
      return null;
    }
    const version = probeVersion(opts.binaryPathOverride);
    if (!version) {
      logger.warn('rtk binary override did not respond to --version', { path: opts.binaryPathOverride });
      return null;
    }
    if (compareVersions(version, RTK_MIN_VERSION) < 0) {
      logger.warn('rtk binary override is below minimum version', {
        path: opts.binaryPathOverride,
        version,
        minimumVersion: RTK_MIN_VERSION,
      });
      return null;
    }
    return { path: opts.binaryPathOverride, source: 'override', version };
  }

  let systemCandidate: ResolvedBinary | null = null;
  if (!opts.bundledOnly) {
    const systemPath = findSystemBinary();
    if (systemPath) {
      const version = probeVersion(systemPath);
      if (version && compareVersions(version, RTK_MIN_VERSION) >= 0) {
        systemCandidate = { path: systemPath, source: 'system', version };
      }
    }
  }

  let bundledCandidate: ResolvedBinary | null = null;
  const bundledPath = getBundledBinaryCandidate();
  if (existsSync(bundledPath)) {
    try {
      // Sanity check: must be a regular file, not a stale directory.
      if (statSync(bundledPath).isFile()) {
        const version = probeVersion(bundledPath);
        if (version && compareVersions(version, RTK_MIN_VERSION) >= 0) {
          bundledCandidate = { path: bundledPath, source: 'bundled', version };
        }
      }
    } catch (err) {
      logger.warn('rtk bundled binary stat failed', {
        path: bundledPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Prefer system rtk only if it's at least as new as our bundled version.
  if (
    systemCandidate &&
    bundledCandidate &&
    compareVersions(systemCandidate.version, bundledCandidate.version) >= 0
  ) {
    return systemCandidate;
  }
  if (bundledCandidate) return bundledCandidate;
  if (systemCandidate) return systemCandidate;
  return null;
}

class RtkRuntimeImpl implements RtkRuntime {
  private readonly resolved: ResolvedBinary | null;

  constructor(opts: RtkRuntimeOptions) {
    this.resolved = resolveBinary(opts);
    if (this.resolved) {
      logger.info('rtk runtime resolved', {
        path: this.resolved.path,
        source: this.resolved.source,
        version: this.resolved.version,
      });
    } else {
      logger.info('rtk runtime not available — feature will be disabled');
    }
  }

  isAvailable(): boolean {
    return this.resolved !== null;
  }

  binaryPath(): string {
    if (!this.resolved) {
      throw new Error('rtk binary is not available; check isAvailable() first');
    }
    return this.resolved.path;
  }

  binarySource(): 'bundled' | 'system' | 'override' | 'none' {
    return this.resolved?.source ?? 'none';
  }

  version(): string | null {
    return this.resolved?.version ?? null;
  }

  rewrite(cmd: string): RtkRewriteResult {
    if (!this.resolved) {
      return { kind: 'error', reason: 'rtk binary not available' };
    }
    if (typeof cmd !== 'string' || cmd.length === 0) {
      return { kind: 'error', reason: 'empty command' };
    }
    try {
      const result = spawnSync(this.resolved.path, ['rewrite', cmd], {
        encoding: 'utf8',
        timeout: REWRITE_TIMEOUT_MS,
        env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
      });
      if (result.error) {
        return { kind: 'error', reason: result.error.message };
      }
      // spawnSync returns null status on signal/timeout
      if (result.status === null) {
        const signal = result.signal ?? 'unknown';
        return { kind: 'error', reason: `rtk rewrite was terminated (signal=${signal})` };
      }
      const stdout = (result.stdout || '').toString().trim();
      switch (result.status) {
        case 0:
          if (!stdout) return { kind: 'error', reason: 'rtk rewrite exited 0 with empty stdout' };
          return { kind: 'allow', rewritten: stdout };
        case 1:
          return { kind: 'passthrough' };
        case 2:
          return { kind: 'deny' };
        case 3:
          if (!stdout) return { kind: 'error', reason: 'rtk rewrite exited 3 with empty stdout' };
          return { kind: 'ask', rewritten: stdout };
        default:
          return { kind: 'error', reason: `rtk rewrite exited with unexpected code ${result.status}` };
      }
    } catch (err) {
      return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

let instance: RtkRuntime | null = null;
let instanceOpts: RtkRuntimeOptions | null = null;

/** Lazy singleton. Subsequent calls reuse the resolved binary. */
export function getRtkRuntime(opts: RtkRuntimeOptions = {}): RtkRuntime {
  // If options change between calls (e.g. bundledOnly toggled), rebuild.
  const same =
    instance &&
    instanceOpts &&
    instanceOpts.bundledOnly === opts.bundledOnly &&
    instanceOpts.binaryPathOverride === opts.binaryPathOverride;
  if (!same) {
    instance = new RtkRuntimeImpl(opts);
    instanceOpts = { ...opts };
  }
  return instance!;
}

/** Test-only: clear the cached singleton. */
export function _resetForTesting(): void {
  instance = null;
  instanceOpts = null;
}
