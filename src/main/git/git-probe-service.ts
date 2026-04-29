import * as fs from 'fs/promises';
import * as path from 'path';

export async function findGitRoot(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);

  while (true) {
    try {
      const stat = await fs.stat(path.join(current, '.git'));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Continue walking upward.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function isGitRepository(startDirectory: string): Promise<boolean> {
  return (await findGitRoot(startDirectory)) !== null;
}
