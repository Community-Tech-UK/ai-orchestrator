import { execFile } from 'node:child_process';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { getLogger } from '../logging/logger';

const exec = promisify(execFile);
const logger = getLogger('AttachmentsIgnore');
const pending = new Map<string, Promise<void>>();

/** Best effort local Git configuration. Never modifies a tracked ignore file. */
export async function ensureAttachmentsIgnored(workingDirectory: string): Promise<void> {
  try {
    const git = (args: string[]) => exec('git', args, { cwd: workingDirectory, timeout: 5000, maxBuffer: 64 * 1024 });
    const tree = await git(['rev-parse', '--is-inside-work-tree']).catch(() => null);
    if (tree?.stdout.trim() !== 'true') return;
    try {
      await git(['check-ignore', '-q', '.claude-attachments/']);
      return;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    // Handles .git files in linked worktrees and subdirectory working folders.
    const path = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])).stdout.trim();
    const previous = pending.get(path) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (!(await lstat(dirname(path))).isDirectory()) throw new Error('Git exclude parent is not a directory');
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat && !stat.isFile()) throw new Error('Git exclude is not a regular file');
      const text = stat ? await readFile(path, 'utf8') : '';
      if (text.split(/\r?\n/).some((line) => line.trim() === '.claude-attachments/')) return;
      await appendFile(path, `${text && !text.endsWith('\n') ? '\n' : ''}.claude-attachments/\n`);
    });
    pending.set(path, current);
    try { await current; } finally { if (pending.get(path) === current) pending.delete(path); }
  } catch {
    logger.warn('Could not add the local attachment ignore rule; attachment delivery continues');
  }
}
