import { toSecretWorkspaceId } from './secret-workspace-key';
import { getWorkspaceSecretStore } from './workspace-secret-store';

type WorkingDirectoryLookup = (instanceId: string) => string | undefined;

let workingDirectoryLookup: WorkingDirectoryLookup | undefined;

export function setWorkspaceSecretWorkingDirectoryLookup(
  lookup: WorkingDirectoryLookup,
): void {
  workingDirectoryLookup = lookup;
}

export function _resetWorkspaceSecretFillLookupForTesting(): void {
  workingDirectoryLookup = undefined;
}

/**
 * Resolve a `secret://` reference for browser.fill_secret.
 * Looks up the instance working directory, then decrypts in-process.
 * Errors never include the plaintext.
 */
export function resolveWorkspaceSecretForFill(input: {
  instanceId?: string;
  reference: string;
}): string {
  if (!input.instanceId) {
    throw new Error('A session is required to resolve a workspace secret');
  }
  const cwd = workingDirectoryLookup?.(input.instanceId);
  if (!cwd) {
    throw new Error('This session has no working directory');
  }
  return getWorkspaceSecretStore().resolve(input.reference, {
    workspaceId: toSecretWorkspaceId(cwd),
    purpose: 'browser.fill_secret',
    instanceId: input.instanceId,
  });
}
