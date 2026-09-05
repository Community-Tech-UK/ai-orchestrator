/**
 * N6 — notice when the running process is older than the build on disk.
 *
 * This is the LT-012 class of bug, and it has already cost this project three
 * days: `build:main` was silently failing, Electron kept running a stale
 * `dist/main`, and both `tsc --noEmit` invocations stayed green throughout
 * because neither reads `tsconfig.electron.json`. Nothing told anyone.
 *
 * The detection is deliberately dumb. At boot we fingerprint the compiled entry
 * point; later we fingerprint it again. If it changed, the bytes on disk are no
 * longer the bytes this process loaded, so a restart is needed to pick them up.
 * That is exactly the question a developer wants answered — "am I looking at my
 * change?" — and it needs no build-script cooperation, no version file, and no
 * agreement from anything that might itself be stale.
 *
 * Deliberately NOT a hash of the whole tree: cost on every poll, and it would
 * report skew for an unrelated asset the running process never loaded. The
 * entry point is rewritten by every real build of the main process.
 */

import fs from 'fs';
import path from 'path';

/** What we compare. `null` means "could not establish", never "unchanged". */
export interface BuildFingerprint {
  /** Modification time of the compiled entry point, in ms. */
  mtimeMs: number;
  /** Size in bytes — catches a rewrite that preserves mtime. */
  size: number;
}

export type BuildSkew =
  | { kind: 'same' }
  | { kind: 'skewed'; bootedAt: BuildFingerprint; onDisk: BuildFingerprint }
  /** Either fingerprint is unavailable, so we must not claim either answer. */
  | { kind: 'unknown'; reason: string };

/** The compiled entry point Electron actually loads. */
export const MAIN_ENTRY_RELATIVE = path.join('dist', 'main', 'index.js');

export function readBuildFingerprint(
  appRoot: string,
  entryRelative: string = MAIN_ENTRY_RELATIVE,
): BuildFingerprint | null {
  try {
    const stat = fs.statSync(path.join(appRoot, entryRelative));
    if (!stat.isFile()) return null;
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // Missing or unreadable: in a packaged app there is no `dist/main` to watch,
    // and that is not skew. Callers treat null as "cannot tell".
    return null;
  }
}

/**
 * Compare the fingerprint captured at boot with the one on disk now.
 *
 * Fails open in the honest direction: an unreadable or absent build reports
 * `unknown`, never `same`. A guard that quietly says "you are up to date" when
 * it cannot tell is worse than no guard — that is the shape of the original bug.
 */
export function detectBuildSkew(
  bootedAt: BuildFingerprint | null,
  onDisk: BuildFingerprint | null,
): BuildSkew {
  if (!bootedAt) return { kind: 'unknown', reason: 'no build fingerprint was captured at boot' };
  if (!onDisk) return { kind: 'unknown', reason: 'the compiled entry point is missing or unreadable' };
  if (bootedAt.mtimeMs === onDisk.mtimeMs && bootedAt.size === onDisk.size) {
    return { kind: 'same' };
  }
  return { kind: 'skewed', bootedAt, onDisk };
}

/** Operator-facing wording. Kept here so it is testable and consistent. */
export function describeBuildSkew(skew: BuildSkew): string | null {
  if (skew.kind !== 'skewed') return null;
  return 'The main process has been rebuilt since this app started. '
    + 'Restart to run the new build — until then you are looking at the old one.';
}
