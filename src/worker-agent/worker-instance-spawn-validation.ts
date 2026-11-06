import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpawnParams } from './local-instance-manager';

/** Validate the account on the worker before spawning or replacing a Copilot session. */
export async function assertWorkerCopilotBinding(route: {
  profileId: string;
  expectedLogin?: string | null;
  host?: string;
}): Promise<void> {
  const { CopilotAccountBindingService } = await import(
    '../main/providers/copilot/copilot-account-binding-service'
  );
  const status = await new CopilotAccountBindingService().checkBinding(
    {
      id: route.profileId,
      label: route.profileId,
      expectedLogin: route.expectedLogin ?? null,
      host: route.host ?? 'github.com',
      accountKind: 'personal',
      scopePolicy: 'default-eligible',
      automationPolicy: 'allow-routed',
      isDefault: false,
      createdAt: 0,
      updatedAt: 0,
    },
    'worker',
  );
  if (status.state === 'authenticated') {
    return;
  }
  const remedy = status.state === 'identity-mismatch'
    ? `it is signed in as a different GitHub identity here${status.observedLogin ? ` (${status.observedLogin})` : ''}`
    : status.state === 'unauthenticated'
      ? 'it is not signed in on this node'
      : `its state could not be read on this node (${status.errorCode ?? 'unavailable'})`;
  throw new Error(
    `GitHub Copilot account "${route.profileId}" cannot run on this node: ${remedy}. `
    + 'Sign in for that account on this node, or place the session elsewhere.',
  );
}

export function validateWorkerSpawnDirectories(params: SpawnParams, allowedDirs: string[]): void {
  // Enforce working directory sandboxing
  const resolved = path.resolve(params.workingDirectory);
  const isAllowed = allowedDirs.some((allowed) =>
    isPathInsideAllowedDirectory(resolved, allowed)
  );
  if (!isAllowed) {
    throw new Error(
      `Working directory "${params.workingDirectory}" is not in allowed working directories: ${allowedDirs.join(', ')}`,
    );
  }

  for (const directory of params.additionalDirectories ?? []) {
    const insideRoot = path.isAbsolute(directory) && allowedDirs.some((allowed) => {
      try { return isPathInsideAllowedDirectory(fs.realpathSync(directory), fs.realpathSync(allowed)); }
      catch { return false; }
    });
    if (!insideRoot) {
      throw new Error('Additional working directory is not in allowed working directories.');
    }
  }
}


function isPathInsideAllowedDirectory(resolvedPath: string, allowedDir: string): boolean {
  const [candidate, allowed] = process.platform === 'win32'
    ? [resolvedPath.toLowerCase(), allowedDir.toLowerCase()]
    : [resolvedPath, allowedDir];
  return candidate === allowed || candidate.startsWith(allowed + path.sep);
}
