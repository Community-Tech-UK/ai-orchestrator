import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getLogger } from '../logging/logger';

const logger = getLogger('SessionWatcherInstructions');

/** Only the start of the file: standing rules such as "translate, don't converse" sit at the top. */
export const WATCHER_PROJECT_INSTRUCTIONS_CHARS = 2_000;
/** Bytes read from each file: enough for the characters kept, so a huge file costs no more than a small one. */
const READ_BYTES = 8_192;
const INSTRUCTION_FILE = 'CLAUDE.md';
/** A line that is only an import, as Claude reads it: `@AGENTS.md`. */
const IMPORT_LINE = /^@(\S+)$/;

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

/** The start of a plain file, or '' when there is none. Anything but a plain file (a FIFO, say) is never opened. */
async function readStart(path: string): Promise<string> {
  try {
    if (!(await stat(path)).isFile()) return '';
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(READ_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Most folders have no instruction file. Anything else is worth a line, but the judge still runs without it.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') logger.warn('Could not read a project instruction file', { code: code ?? 'unknown' });
    return '';
  }
}

async function realPathOrEmpty(path: string): Promise<string> {
  try { return await realpath(path); } catch { return ''; }
}

/**
 * The start of the instruction file the session's agent follows in its folder, so the judge knows rules the
 * conversation never states (a folder that translates every message, say). A line that only imports a file
 * inside the folder, after following links, is replaced by that file, one level deep. Empty when there is no file.
 */
export async function readWatcherProjectInstructions(workingDirectory: string): Promise<string> {
  if (!isAbsolute(workingDirectory)) return '';
  const root = await realPathOrEmpty(workingDirectory);
  if (!root) return '';
  const text = await readStart(join(root, INSTRUCTION_FILE));
  const lines: string[] = [];
  let length = 0;
  for (const line of text.split('\n')) {
    if (length >= WATCHER_PROJECT_INSTRUCTIONS_CHARS) break;
    const target = IMPORT_LINE.exec(line.trim())?.[1];
    const imported = target ? await realPathOrEmpty(resolve(root, target)) : '';
    const expanded = imported && isInside(root, imported) ? await readStart(imported) : line;
    lines.push(expanded);
    length += expanded.length + 1;
  }
  return lines.join('\n').trim().slice(0, WATCHER_PROJECT_INSTRUCTIONS_CHARS);
}
