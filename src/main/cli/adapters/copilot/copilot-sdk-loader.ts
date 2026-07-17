/**
 * WS14 — runtime discovery of the Copilot SDK bundled INSIDE the user's
 * installed `@github/copilot` CLI package.
 *
 * History: the old standalone `@github/copilot-sdk` 0.x wrapper was removed
 * for ESM/packaging fragility and version skew against the CLI (see the
 * copilot-cli-adapter header). This loader takes a different route: the CLI
 * package itself ships a CJS-requireable SDK at `<pkg>/copilot-sdk/index.js`
 * (verified against @github/copilot 1.0.x), version-matched with the CLI by
 * construction. We never add an npm dependency — the SDK is resolved from the
 * SAME tree as the `copilot` binary the adapter would spawn, so client and
 * server can't skew.
 *
 * Every failure path returns null (server mode unavailable → callers keep the
 * exec-per-message path, verbatim today's behavior).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../../../logging/logger';
import { getDefaultCopilotCliLaunch } from '../../copilot-cli-launch';

const logger = getLogger('CopilotSdkLoader');

/**
 * The narrow, structurally-typed surface we use. The real SDK classes are
 * runtime-discovered, so we type only what we call — anything else is `unknown`.
 */
export interface CopilotSdkSessionLike {
  on(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  sessionId?: string;
}

export interface CopilotSdkClientLike {
  createSession(config: Record<string, unknown>): Promise<CopilotSdkSessionLike>;
  resumeSession(sessionId: string, config: Record<string, unknown>): Promise<CopilotSdkSessionLike>;
  /** Resolves with an array of teardown errors (SDK 1.x signature). */
  stop(): Promise<unknown>;
  forceStop?(): Promise<unknown>;
}

export interface LoadedCopilotSdk {
  /** Constructor for the SDK client (spawns/connects to the CLI runtime itself). */
  CopilotClient: new (options?: Record<string, unknown>) => CopilotSdkClientLike;
  /** SDK path actually loaded — recorded for diagnostics. */
  sdkPath: string;
  /** The @github/copilot package version the SDK was loaded from. */
  packageVersion: string;
  /** Resolved CLI binary the package tree belongs to. */
  cliPath: string;
}

let cached: LoadedCopilotSdk | null | undefined;

export function _resetCopilotSdkLoaderForTesting(): void {
  cached = undefined;
}

/** Walk up from a file path to the enclosing `@github/copilot` package root. */
export function findCopilotPackageRoot(startFile: string, maxLevels = 8): string | null {
  let dir = path.dirname(startFile);
  for (let i = 0; i < maxLevels; i++) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name === '@github/copilot') return dir;
    } catch {
      // No/invalid package.json at this level — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate and require the bundled SDK. Cached after the first attempt (both
 * success and failure) — call `_resetCopilotSdkLoaderForTesting()` to re-probe.
 */
export function loadCopilotSdk(
  launch: { command: string; argsPrefix: string[] } = getDefaultCopilotCliLaunch(),
): LoadedCopilotSdk | null {
  if (cached !== undefined) return cached;
  cached = tryLoad(launch);
  return cached;
}

function tryLoad(launch: { command: string; argsPrefix: string[] }): LoadedCopilotSdk | null {
  try {
    // Only the standalone `copilot` binary carries the bundled SDK; the
    // `gh copilot` wrapper (non-empty argsPrefix) does not expose it.
    if (launch.argsPrefix.length > 0 || !path.isAbsolute(launch.command)) {
      logger.info('Copilot SDK unavailable: no standalone copilot binary resolved', {
        command: launch.command,
      });
      return null;
    }

    // Follow the bin symlink into the real package tree — this is what keeps
    // the loaded SDK version-matched with the binary that actually runs.
    const realBin = fs.realpathSync(launch.command);
    const packageRoot = findCopilotPackageRoot(realBin);
    if (!packageRoot) {
      logger.info('Copilot SDK unavailable: @github/copilot package root not found', { realBin });
      return null;
    }

    const sdkPath = path.join(packageRoot, 'copilot-sdk', 'index.js');
    if (!fs.existsSync(sdkPath)) {
      logger.info('Copilot SDK unavailable: bundled copilot-sdk/index.js missing (older CLI?)', {
        packageRoot,
      });
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require(sdkPath) as { CopilotClient?: unknown };
    if (typeof sdk.CopilotClient !== 'function') {
      logger.warn('Copilot SDK unavailable: bundle does not export a CopilotClient constructor', {
        sdkPath,
      });
      return null;
    }

    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'),
    ) as { version?: string };

    const loaded: LoadedCopilotSdk = {
      CopilotClient: sdk.CopilotClient as LoadedCopilotSdk['CopilotClient'],
      sdkPath,
      packageVersion: pkg.version ?? 'unknown',
      cliPath: launch.command,
    };
    logger.info('Copilot bundled SDK loaded', {
      sdkPath,
      packageVersion: loaded.packageVersion,
    });
    return loaded;
  } catch (error) {
    logger.warn('Copilot SDK load failed — server mode disabled, exec fallback stays active', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
