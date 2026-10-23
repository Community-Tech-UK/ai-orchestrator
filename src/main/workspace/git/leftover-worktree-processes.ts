import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isInsideOrEqual } from '../../util/path-helpers';
const exec = promisify(execFile);

/** CWD inspection is deliberately fail-closed where the OS cannot report it. */
export async function checkWorktreeProcesses(folder: string): Promise<{ checked: boolean; live: boolean }> {
  if (process.platform === 'win32') return { checked: false, live: false };
  try {
    const { stdout, stderr } = await exec('lsof', ['-a', '-d', 'cwd', '-F0pn'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (stderr.trim() || !stdout.includes('n/')) return { checked: false, live: false };
    const paths = stdout.split('\0').map(field => field.replace(/^\n/, '')).filter(field => field.startsWith('n/'));
    return { checked: true, live: paths.some(field => isInsideOrEqual(folder, field.slice(1))) };
  } catch { return { checked: false, live: false }; }
}
