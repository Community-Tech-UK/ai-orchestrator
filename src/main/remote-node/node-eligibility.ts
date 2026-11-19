import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';

type SignInProvider = 'claude' | 'codex';

/** Folders compare the way the worker checks them: either slash, and case ignored on a Windows drive. */
function folderParts(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** True when the folder is one of the computer's allowed folders, or inside one. */
export function nodeHasFolder(capabilities: Pick<WorkerNodeCapabilities, 'workingDirectories'>, folder: string): boolean {
  const wanted = folderParts(folder);
  return capabilities.workingDirectories.some(root => {
    const allowed = folderParts(root);
    return allowed !== '' && (wanted === allowed || wanted.startsWith(`${allowed}/`));
  });
}

/**
 * What the computer last reported about one account's sign-in. A worker reports its tool's default sign-in and every
 * account with a home there, so an account it doesn't list isn't signed in there. `unreported` covers a worker that
 * hasn't sent its sign-ins yet; `unknown` is a check that couldn't read the answer. Neither is proof it can run there.
 */
export function nodeSignInState(
  capabilities: Pick<WorkerNodeCapabilities, 'signIns'>,
  provider: SignInProvider,
  profileId: string,
): 'signed-in' | 'signed-out' | 'unknown' | 'unreported' {
  if (!capabilities.signIns) return 'unreported';
  return capabilities.signIns.find(entry => entry.provider === provider && entry.profileId === profileId)?.state ?? 'signed-out';
}
