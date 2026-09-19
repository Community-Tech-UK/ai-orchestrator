/**
 * Installer-mirrored CLI copies.
 *
 * Some CLIs install themselves twice on purpose: `npm i -g @xai-official/grok`
 * leaves the usual shim in the node bin dir, then its postinstall unpacks the
 * same versioned binary into `$GROK_HOME/bin` (default `~/.grok/bin`) and
 * appends that directory to the shell profile. Both copies are on PATH, at the
 * same version, on every install — so counting the second as a redundant or
 * conflicting install is a false positive no user can ever clear.
 *
 * This module owns the scanned-install shapes and the rules for reading them:
 * which copies are separate installs, which versions were actually read, and
 * when copies genuinely conflict.
 */

import { realpathSync } from 'fs';
import { getLogger } from '../logging/logger';
import {
  getInstallerMirrorDirs,
  isInstallerMirrorPath,
  type CliRegistryEntry,
  type CliType,
} from './cli-registry';

const logger = getLogger('CliInstallMirrors');

/**
 * Resolve a path the way the OS sees it, falling back to the input when it
 * cannot resolve (e.g. the directory does not exist). Uses the native
 * resolver deliberately: Node's JS `realpathSync` keeps the caller's casing,
 * while `realpathSync.native` returns the casing actually on disk — which is
 * what makes `/USERS/X/.GROK/bin` match `~/.grok/bin` on a case-insensitive
 * volume (the macOS default).
 */
function resolvePath(value: string | undefined): string {
  if (!value) return '';
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/**
 * Whether `installPath` sits in a directory this CLI's own installer
 * maintains (see `CliRegistryEntry.installerMirrorDirs`) — the copies a
 * reinstall refreshes and a user must not delete by hand. Matches the literal
 * and the resolved form of both sides: grok's postinstall writes to
 * `realpath($HOME)/.grok`, so a symlinked home never matches literally.
 */
export function isInstallerOwnedPath(
  config: CliRegistryEntry,
  installPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const declared = getInstallerMirrorDirs(config, env, platform);
  if (declared.length === 0) return false;
  const mirrorDirs = [
    ...declared,
    ...getInstallerMirrorDirs(config, { ...env, HOME: resolvePath(env['HOME']) }, platform),
  ];
  return isInstallerMirrorPath(installPath, mirrorDirs, platform)
    || isInstallerMirrorPath(resolvePath(installPath), mirrorDirs, platform);
}

/**
 * One concrete installation of a CLI found on disk.
 */
export interface CliInstall {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
  /**
   * True when this copy sits in a directory the CLI's own installer maintains
   * *and* reports the same version as the install found first outside those
   * directories (the active one) — e.g. the
   * `~/.grok/bin` binary `@xai-official/grok`'s postinstall writes beside its
   * npm shim. One installation reached by a second PATH entry: listed for
   * transparency, never counted as a redundant or conflicting install.
   *
   * Deliberately not a path. Which copy wrote this one is not knowable from a
   * version match — with a third copy in play, naming one would be a guess
   * printed as fact — and no caller needs it: the copies it belongs to are
   * the untagged rows immediately above it.
   */
  installerCopy?: true;
}

/**
 * A shadow report — emitted when a CLI has more than one separate install on
 * disk reporting different versions. Copies the installer maintains itself
 * (`CliInstall.installerCopy`) are excluded: they duplicate a version already
 * listed, so they can neither conflict nor be usefully removed.
 *
 * `installs` is ordered by the scan's search priority, so the first entry is
 * the copy to treat as current and to point an update at. It is not a promise
 * about what a shell resolves: a user's PATH may order these directories
 * differently.
 */
export interface CliShadowReport {
  cli: CliType;
  installs: CliInstall[];
  activePath?: string;
  activeVersion?: string;
}

/**
 * Tags each copy in a directory the CLI's own installer maintains (see
 * `CliRegistryEntry.installerMirrorDirs`) that duplicates the version of the
 * install found first outside those directories. The copy keeps its row — a diagnostics page should never hide a
 * binary that is on disk — but `installerCopy` tells every consumer it is one
 * installation seen twice, not a second install.
 *
 * Without this, every npm-installed grok looks like two redundant copies
 * forever: the npm shim plus the `~/.grok/bin` binary its own postinstall
 * writes. A copy at any other version is left untagged, so a
 * half-finished update still surfaces as a real version conflict, and a copy
 * in a mirror dir that is the only install (native installer, no npm shim) is
 * left untagged too — it *is* the install.
 *
 * Tagged copies move to the end of the list, so the first row is always one
 * of the installs they duplicate: the copy to report as current and to point
 * an update at.
 */
export function tagInstallerMirrors(
  config: CliRegistryEntry,
  installs: CliInstall[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliInstall[] {
  if (installs.length < 2) return installs;
  if (getInstallerMirrorDirs(config, env, platform).length === 0) return installs;

  const inMirrorDir = (install: CliInstall): boolean =>
    isInstallerOwnedPath(config, install.path, env, platform);

  // The version to match: the first readable copy outside the installer's own
  // directories — the one that ends up active. Matching any outside copy
  // instead would let a stale installer copy hide behind a stale leftover at
  // the same old version, dropping it from the conflict report so the user
  // needed a second round to discover it. An unprobed version is not
  // evidence of a match, so it cannot be the reference either.
  const reference = installs.find((install) => !inMirrorDir(install) && install.version)?.version;
  if (!reference) return installs;

  const tagged = installs.map((install): CliInstall => {
    if (!inMirrorDir(install) || install.version !== reference) return install;
    logger.debug('CLI copy is an installer-maintained duplicate of a listed install', {
      cli: config.name,
      path: install.path,
      version: install.version,
    });
    return { ...install, installerCopy: true };
  });

  return [
    ...tagged.filter((install) => !install.installerCopy),
    ...tagged.filter((install) => install.installerCopy),
  ];
}

/**
 * The installs that are genuinely separate copies — installer-maintained
 * duplicates excluded. Every main-process "how many copies are there, and do
 * they agree?" decision is made on this list. CLI Health necessarily
 * re-applies the same `installerCopy` predicate to the rows it receives over
 * IPC, since the renderer cannot import this module.
 */
export function independentInstalls(installs: CliInstall[]): CliInstall[] {
  return installs.filter((install) => !install.installerCopy);
}

/**
 * The distinct versions actually read from these copies. A copy whose
 * `--version` probe failed contributes nothing: unknown is not the same as
 * different, and treating it as a distinct version made a transient probe
 * failure (they happen under fork pressure at startup) flash a "they report
 * different versions" warning that the next scan silently cleared.
 */
export function knownInstallVersions(installs: CliInstall[]): string[] {
  return [...new Set(installs.flatMap((install) => (install.version ? [install.version] : [])))];
}

/**
 * Builds the shadow report for a scanned install list: null unless at least
 * two separate copies are known to disagree on version, which is the only
 * case where the wrong binary can silently win on PATH. Installer copies are
 * excluded from the report so repair advice never tells the user to delete a
 * copy their installer recreates.
 */
export function buildShadowReport(type: CliType, installs: CliInstall[]): CliShadowReport | null {
  const separate = independentInstalls(installs);
  if (separate.length < 2) return null;
  if (knownInstallVersions(separate).length < 2) return null;

  return {
    cli: type,
    installs: separate,
    activePath: separate[0]?.path,
    activeVersion: separate[0]?.version,
  };
}
