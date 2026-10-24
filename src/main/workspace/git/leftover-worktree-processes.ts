import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isInsideOrEqual } from '../../util/path-helpers';
const exec = promisify(execFile);

/** Every process's working folder from `lsof -F0pn`, or null where the OS cannot report it. */
async function readProcessFolders(): Promise<Array<{ pid: number; folder: string }> | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout, stderr } = await exec('lsof', ['-a', '-d', 'cwd', '-F0pn'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr.trim() || !stdout.includes('n/')) return null;
    const entries: Array<{ pid: number; folder: string }> = [];
    let pid: number | null = null;
    for (const field of stdout.split('\0').map(part => part.replace(/^\n/, ''))) {
      if (field.startsWith('p')) pid = Number(field.slice(1));
      else if (field.startsWith('n/') && pid !== null && Number.isSafeInteger(pid)) entries.push({ pid, folder: field.slice(1) });
    }
    return entries;
  } catch { return null; }
}

/** CWD inspection is deliberately fail-closed where the OS cannot report it. */
export async function checkWorktreeProcesses(folder: string): Promise<{ checked: boolean; live: boolean }> {
  const entries = await readProcessFolders();
  if (!entries) return { checked: false, live: false };
  return { checked: true, live: entries.some(entry => isInsideOrEqual(folder, entry.folder)) };
}

/** Pids whose working folder is `folder` or inside it; null when that cannot be read. */
export async function listFolderProcessPids(folder: string): Promise<Set<number> | null> {
  const entries = await readProcessFolders();
  if (!entries) return null;
  return new Set(entries.filter(entry => isInsideOrEqual(folder, entry.folder)).map(entry => entry.pid));
}
