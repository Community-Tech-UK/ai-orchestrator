import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Folders too broad to index as one workspace: the filesystem root, the home
 * folder and its parent, `~/work`, and the system temp folder (`/tmp`,
 * `/private/tmp`). Indexing one of these walks every project and cache
 * beneath it; a session started in the home folder once grew codemem.sqlite
 * to ~97 GB, mostly free pages left behind when the oversized index was
 * pruned.
 */
export function isBroadWorkspaceRoot(workspacePath: string, homeDir = os.homedir()): boolean {
  const normalized = path.resolve(workspacePath);
  if (normalized === path.parse(normalized).root) {
    return true;
  }

  const home = path.resolve(homeDir);
  return (
    normalized === home
    || normalized === path.dirname(home)
    || normalized === path.join(home, 'work')
    || normalized === '/private/tmp'
    || normalized === '/tmp'
  );
}
