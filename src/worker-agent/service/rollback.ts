import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { servicePaths } from './paths';

export async function listVersions(): Promise<string[]> {
  const paths = servicePaths();
  try {
    const entries = await fs.readdir(paths.versionedBinDir);
    return entries.sort();
  } catch {
    return [];
  }
}

export async function activateVersion(version: string): Promise<void> {
  const paths = servicePaths();
  const target = path.join(paths.versionedBinDir, version);
  try {
    await fs.access(target);
  } catch {
    throw new Error(`Version ${version} not installed`);
  }
  try {
    await fs.unlink(paths.currentBinLink);
  } catch {
    /* ignore */
  }
  await fs.symlink(
    target,
    paths.currentBinLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}
