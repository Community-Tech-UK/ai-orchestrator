import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Warn about untracked modules without making another session's work a CI error. */
export function listTrackedTypeScriptAndWarn(repoRoot: string, isTestSource: (path: string) => boolean, maxLines: number): string[] {
  const list = (args: string[]) => execFileSync('git', ['ls-files', '-z', ...args, '*.ts'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  const tracked = list(['--cached']);
  const trackedSet = new Set(tracked);
  for (const path of new Set(list(['-co', '--exclude-standard']))) {
    if (trackedSet.has(path) || isTestSource(path)) continue;
    try {
      const content = readFileSync(resolve(repoRoot, path), 'utf8').replace(/\n$/, '');
      const lines = content ? content.split('\n').length : 0;
      if (lines > maxLines) console.warn(`UNTRACKED WARNING: ${path} has ${lines} lines (limit: ${maxLines}). Refactor before staging.`);
    } catch { /* Files can disappear while another worker edits them. */ }
  }
  return tracked;
}
