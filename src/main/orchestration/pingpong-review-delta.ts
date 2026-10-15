import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultGitRunner } from './loop-diff';
export interface ReviewedFile { path: string; contentHash: string }
export function snapshotReviewedFiles(cwd: string, files: readonly string[]): ReviewedFile[] | null {
  if (files.length > 500) return null;
  const top = defaultGitRunner(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0 || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  const snapshot: ReviewedFile[] = [];
  for (const file of new Set(files)) {
    const target = path.resolve(root, file);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
      snapshot.push({ path: file, contentHash: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      snapshot.push({ path: file, contentHash: 'removed' });
    }
  }
  return snapshot;
}
export function reviewDelta(previous: readonly ReviewedFile[] | undefined, current: readonly ReviewedFile[] | null, round: number): { changed: string[]; unchanged: string[]; note: string } | null {
  if (!previous?.length || !current) return null;
  const hashes = new Map(previous.map((file) => [file.path, file.contentHash]));
  const changed = current.filter((file) => hashes.get(file.path) !== file.contentHash).map((file) => file.path);
  const unchanged = current.filter((file) => hashes.get(file.path) === file.contentHash).map((file) => file.path);
  return { changed, unchanged, note: `Changed since your last review (round ${round}): ${changed.join(', ') || '(none)'}. Reviewed before and unchanged: ${unchanged.join(', ') || '(none)'}. Read any file a finding depends on.` };
}
