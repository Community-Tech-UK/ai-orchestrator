/**
 * Derives the node-local Copilot CLI state directory for one account profile.
 *
 * This is the only place a Copilot home path is produced. No renderer, agent,
 * or remote caller ever supplies a filesystem path — they supply a profile ID,
 * and every node derives its own home beneath its own AIO state root.
 *
 * Two containment checks, not one:
 *
 *  - before `mkdir`, so a crafted ID can never create a directory outside the
 *    profiles root; and
 *  - after `mkdir`, via `realpath`, so a *pre-existing symlink* at
 *    `<root>/<id>` cannot redirect the profile's state (and therefore its
 *    account selection) somewhere else.
 *
 * The legacy profile is deliberately exempt from the profiles root: it points
 * at the pre-existing `copilot-cli-home` directory (or the exact
 * `AI_ORCHESTRATOR_COPILOT_HOME` override) so a single-account install keeps
 * working with no file movement.
 */

import { mkdirSync, realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import {
  COPILOT_LEGACY_PROFILE_ID,
  COPILOT_PROFILE_ID_PATTERN,
} from '../../../../shared/types/copilot-account.types';
import {
  getCopilotOrchestratorHome,
  getCopilotStateRoot,
} from '../adapter-spawn-helpers';

export const COPILOT_PROFILES_ROOT_DIR = 'copilot-cli-profiles';

/**
 * State root for all non-legacy Copilot profile homes. Not created eagerly.
 *
 * Realpath'd when it already exists so this agrees with the value
 * {@link resolveCopilotProfileHome} returns — on macOS the userData path can
 * sit behind a symlink (`/var` → `/private/var`), and a caller comparing an
 * un-resolved root against a resolved home would wrongly conclude the home had
 * escaped.
 */
export function getCopilotProfilesRoot(): string {
  const root = join(getCopilotStateRoot(), COPILOT_PROFILES_ROOT_DIR);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Path-boundary containment. `startsWith(parent)` alone would accept
 * `/a/bc` as inside `/a/b`; requiring the separator makes the comparison a
 * real ancestry test. Mirrors the idiom in src/main/security/path-validator.ts.
 */
export function isDirectChildOf(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  if (normalizedChild === normalizedParent) {
    return false;
  }
  const prefix = normalizedParent.endsWith(sep) ? normalizedParent : normalizedParent + sep;
  if (!normalizedChild.startsWith(prefix)) {
    return false;
  }
  const remainder = normalizedChild.slice(prefix.length);
  return remainder.length > 0 && !remainder.includes(sep);
}

/**
 * Re-validate the ID inside the resolver rather than trusting the caller. The
 * schema already rejects unsafe IDs at the settings/IPC boundary; this is the
 * last line before a path is built, and it is the one that runs on a remote
 * worker where the caller is another machine.
 */
export function assertSafeCopilotProfileId(profileId: string): void {
  if (!COPILOT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error(
      `Invalid Copilot account profile ID: profile IDs must be lowercase safe slugs.`,
    );
  }
}

export interface ResolveCopilotProfileHomeOptions {
  /** The legacy profile keeps the pre-existing `copilot-cli-home` directory. */
  isLegacy?: boolean;
  /** Skip directory creation — used by read-only callers (Doctor, binding checks). */
  createIfMissing?: boolean;
}

/**
 * Resolve (and by default create) the node-local Copilot home for a profile.
 *
 * @throws when the ID is unsafe, or when the resolved/realpath'd directory is
 *         not a direct child of the profiles root.
 */
export function resolveCopilotProfileHome(
  profileId: string,
  options: ResolveCopilotProfileHomeOptions = {},
): string {
  assertSafeCopilotProfileId(profileId);

  if (options.isLegacy || profileId === COPILOT_LEGACY_PROFILE_ID) {
    // Byte-identical to the pre-multi-profile behaviour, including the
    // AI_ORCHESTRATOR_COPILOT_HOME override.
    return getCopilotOrchestratorHome();
  }

  const root = getCopilotProfilesRoot();
  const home = resolve(join(root, profileId));
  if (!isDirectChildOf(root, home)) {
    throw new Error(
      `Refusing to use a Copilot profile home outside the profiles root for profile ${profileId}.`,
    );
  }

  if (options.createIfMissing === false) {
    return home;
  }

  // Wrapped so a raw fs error can never carry the path out of here. Node's
  // messages embed it verbatim (`EACCES: permission denied, mkdir '<real
  // path>'`), and this throw escapes to callers that are NOT the Copilot IPC
  // handlers — the mobile gateway returns `err.message` over the network to the
  // paired phone, and the channel router posts it into a Discord channel that
  // may be shared. Scrubbing at those egress points would be one more list to
  // keep in sync; refusing to build the message here fixes every surface at
  // once, including logs.
  let realHome: string;
  try {
    mkdirSync(home, { recursive: true });
    // A symlink already sitting at <root>/<id> survives mkdir(recursive)
    // without error, so re-assert containment against the real target.
    realHome = realpathSync(home);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `Could not prepare the Copilot profile home for ${profileId}`
      + `${code ? ` (${code})` : ''}. Check the Harness data directory is writable.`,
    );
  }
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  if (!isDirectChildOf(realRoot, realHome)) {
    throw new Error(
      `Copilot profile home for ${profileId} resolves outside the profiles root; refusing to use it.`,
    );
  }
  return realHome;
}
