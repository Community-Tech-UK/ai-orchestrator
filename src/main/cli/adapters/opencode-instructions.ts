import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** OpenCode silently ignores unreadable instruction files; never start with missing Harness rules. */
export function ensureOpenCodeInstructions(stateRoot: string, instructions: string): string {
  const directory = join(stateRoot, 'opencode-instructions');
  const path = join(directory, `${createHash('sha256').update(instructions).digest('hex')}.md`);
  const matches = (): boolean => { try { return readFileSync(path, 'utf8') === instructions; } catch { return false; } };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!matches()) {
      // A missing or damaged file is rewritten whole: write beside it, then rename over it.
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, instructions, { mode: 0o600 });
      renameSync(temporary, path);
    }
    if (!matches()) throw new Error('Instruction file contents differ');
  } catch {
    // Raw filesystem errors contain private paths. The content is never logged.
    throw new Error('OpenCode could not read the Harness instructions file. Check that the Harness data folder is writable.');
  }
  return path;
}
